import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { rm, mkdir, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { makeScratchDir } from '@/shared/scratch.js';
import { getGlobalImageAssetsDir } from '@/shared/image-attachments.js';
import { agentRunProfilesDb, closeConnection, initializeDatabase, projectsDb } from '@/modules/database/index.js';
import {
  acceptanceEvidenceMatches,
  configureSwarmAbortFns,
  configureSwarmRuntimes,
  looksLikeReviewApproval,
  parseMemberFindings,
  parseOrchestratorPlan,
  parseSynthesis,
  stepRequiresSourceChanges,
} from '@/modules/swarm/swarm-agent.service.js';
import {
  pickReassignmentSeatForTest,
  setSwarmTestExecutor,
  splitWaveByScope,
  swarmService,
} from '@/modules/swarm/swarm.service.js';
import { swarmDb } from '@/modules/swarm/swarm.repository.js';
import type { SwarmAgentSpec, SwarmPlanStep } from '@/modules/swarm/swarm.types.js';
import { runService } from '@/modules/runs/index.js';
import { workspaceService } from '@/modules/workspaces/index.js';
import { chatRunRegistry } from '@/modules/websocket/index.js';

function runGit(
  repoPath: string,
  args: string[],
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync('git', args, { cwd: repoPath, encoding: 'utf8' });
  return {
    status: result.status,
    stdout: String(result.stdout ?? '').trim(),
    stderr: String(result.stderr ?? '').trim(),
  };
}

async function initGitRepo(dir: string): Promise<void> {
  assert.equal(runGit(dir, ['init', '-b', 'main']).status, 0);
  assert.equal(runGit(dir, ['config', 'user.email', 'test@example.com']).status, 0);
  assert.equal(runGit(dir, ['config', 'user.name', 'Test Runner']).status, 0);
  await writeFile(path.join(dir, 'README.md'), 'initial\n');
  assert.equal(runGit(dir, ['add', '.']).status, 0);
  assert.equal(runGit(dir, ['commit', '-m', 'initial']).status, 0);
}

async function withDatabase(callback: (root: string) => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const root = await makeScratchDir('swarm-');
  closeConnection();
  process.env.DATABASE_PATH = path.join(root, 'auth.db');
  await initializeDatabase();
  try {
    await callback(root);
  } finally {
    setSwarmTestExecutor(null);
    configureSwarmRuntimes({});
    configureSwarmAbortFns({});
    chatRunRegistry.clearAll();
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(root, { recursive: true, force: true });
  }
}

function planFixture(goal: string) {
  return {
    summary: `Plan for “${goal}”.`,
    strategy: 'Explore, implement, review.',
    costNotes: 'Cheap explorers, stronger implementers.',
    generatedAt: new Date().toISOString(),
    steps: [
      {
        id: 'step-1',
        title: 'Explore the codebase',
        kind: 'explorer',
        prompt: 'Map the codebase.',
        wave: 1,
      },
      {
        id: 'step-2',
        title: 'Implement changes',
        kind: 'implementer',
        prompt: 'Implement the changes.',
        wave: 2,
      },
    ],
  };
}

function installFastPipeline(opts: {
  requireApproval?: boolean;
  requirePlanApproval?: boolean;
  failMember?: boolean;
} = {}): void {
  setSwarmTestExecutor(async (swarmId) => {
    const swarm = swarmDb.get(swarmId);
    if (!swarm) return;

    if (opts.requirePlanApproval || swarm.approval_status === 'plan_pending') {
      swarmDb.update(swarmId, {
        status: 'awaiting_plan_approval',
        approvalStatus: 'plan_pending',
        plan: planFixture(swarm.goal),
      });
      // Block until the operator approves or rejects (bounded).
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        const cur = swarmDb.get(swarmId);
        if (cur && cur.status !== 'awaiting_plan_approval') break;
        await new Promise((r) => setTimeout(r, 20));
      }
      const after = swarmDb.get(swarmId);
      if (!after) return;
      if (after.status === 'failed' || after.status === 'aborted') return;
    }

    const members = swarmDb.listMembers(swarmId);
    const findings = [];
    for (const member of members) {
      let runId = member.run_id;
      if (!runId) {
        const attemptRun = runService.create({
          source: 'swarm',
          projectId: swarm.project_id,
          parentRunId: swarm.parent_run_id,
          rootRunId: swarm.parent_run_id,
          provider: member.provider,
          model: member.model,
          title: `Test attempt: ${member.label ?? member.role}`,
          trigger: `swarm-test:${swarmId}`,
          status: 'running',
          meta: { swarmId, memberId: member.member_id },
        });
        runId = attemptRun.run_id;
        swarmDb.updateMember(member.member_id, { runId, status: 'running' });
      }
      if (opts.failMember) {
        swarmDb.updateMember(member.member_id, {
          status: 'failed',
          error: 'simulated failure',
          finished: true,
        });
        if (runId) {
          try {
            runService.markTerminal(runId, {
              status: 'failed',
              errorSummary: 'simulated failure',
            });
          } catch {
            /* optional */
          }
        }
        findings.push({
          memberId: member.member_id,
          role: member.role,
          summary: 'simulated failure',
          at: new Date().toISOString(),
        });
        continue;
      }
      const summary = `${member.role} finding: inspect auth on routes for “${swarm.goal}”.`;
      swarmDb.updateMember(member.member_id, {
        status: 'succeeded',
        findingsSummary: summary,
        finished: true,
      });
      if (runId) {
        try {
          runService.markTerminal(runId, { status: 'succeeded' });
        } catch {
          /* optional */
        }
      }
      findings.push({
        memberId: member.member_id,
        role: member.role,
        summary,
        at: new Date().toISOString(),
      });
    }

    const synthesis = {
      summary: `Orchestrator handoff for “${swarm.goal}”.`,
      completed: members.map((m) => `${m.role} step`),
      remaining: [] as string[],
      recommendations: ['Add regression tests', 'Lock down webhook retries'],
      risks: ['Auth gap on new routes'],
      memberCount: members.length,
      generatedAt: new Date().toISOString(),
      actionItems: [
        {
          title: 'Add webhook timeout bounds',
          prompt: 'Bound webhook retries and timeouts',
          priority: 'high' as const,
        },
        {
          title: 'Cover auth failure paths',
          prompt: 'Add unit tests for auth failure paths',
          priority: 'medium' as const,
        },
      ],
    };

    if (opts.requireApproval || swarm.approval_status === 'pending') {
      swarmDb.update(swarmId, {
        status: 'awaiting_approval',
        approvalStatus: 'pending',
        findings,
        synthesis,
      });
      if (swarm.parent_run_id) {
        try {
          runService.updateStatus(swarm.parent_run_id, 'waiting_permission');
        } catch {
          /* optional */
        }
      }
    } else {
      const handoff = swarmService.notifyHandoffComplete(swarmId, synthesis);
      swarmDb.update(swarmId, {
        status: 'succeeded',
        findings,
        synthesis: handoff,
        finished: true,
      });
      if (swarm.parent_run_id) {
        try {
          runService.markTerminal(swarm.parent_run_id, { status: 'succeeded' });
        } catch {
          /* optional */
        }
      }
    }
  });
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 3000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('waitFor timed out');
}

test('parseMemberFindings extracts structured JSON', () => {
  const parsed = parseMemberFindings(
    JSON.stringify({
      summary: 'Looks mostly good',
      findings: ['Missing tests on auth-health'],
      recommendations: ['Add unit tests'],
      risks: ['Token leak risk'],
      severity: 'warning',
    }),
  );
  assert.equal(parsed.summary, 'Looks mostly good');
  assert.equal(parsed.findings[0], 'Missing tests on auth-health');
  assert.equal(parsed.severity, 'warning');
});

test('acceptanceEvidenceMatches accepts numbered, verbatim, and paraphrased echoes', () => {
  const criterion =
    'A numbered defect list for the Stats frontend, each entry giving file:path, what is wrong, and a severity';

  const met = (echoed: string) =>
    acceptanceEvidenceMatches(criterion, 2, { criterion: echoed, met: true, evidence: 'x' });

  // Numbered references (criteria are presented to the agent as a 1-based list).
  assert.equal(met('3'), true);
  assert.equal(met('#3'), true);
  assert.equal(met('criterion 3'), true);
  assert.equal(met('2'), false);

  // Verbatim and substring echoes still work.
  assert.equal(met(criterion), true);
  assert.equal(met('A numbered defect list for the Stats frontend'), true);

  // Paraphrase with strong token overlap (weaker models reword long criteria).
  assert.equal(
    met('Numbered defect list covering the Stats frontend with file:path, what is wrong, and severity for each entry'),
    true,
  );

  // Unrelated evidence and unmet entries never match.
  assert.equal(met('Confirmed the sidebar wiring is complete'), false);
  assert.equal(
    acceptanceEvidenceMatches(criterion, 2, { criterion: '3', met: false, evidence: 'x' }),
    false,
  );
});

test('reviewer and explorer steps never require a source diff', () => {
  assert.equal(stepRequiresSourceChanges('reviewer', true), false);
  assert.equal(stepRequiresSourceChanges('explorer', true), false);
  assert.equal(stepRequiresSourceChanges('tester', undefined), false);
  assert.equal(stepRequiresSourceChanges('implementer', true), true);
  assert.equal(stepRequiresSourceChanges('implementer', undefined), false);
  assert.equal(stepRequiresSourceChanges('implementer', false), false);
});

test('looksLikeReviewApproval recognizes SHIP and rejects NO-SHIP', () => {
  assert.equal(looksLikeReviewApproval('SHIP. Independently reviewed the dirty tree.'), true);
  assert.equal(looksLikeReviewApproval('LGTM — ready to merge'), true);
  assert.equal(looksLikeReviewApproval('NO-SHIP. Two HIGH defects remain.'), false);
});

test('parseOrchestratorPlan strips requiresChanges from reviewer steps', () => {
  const parsed = parseOrchestratorPlan(
    JSON.stringify({
      summary: 'Implement then review',
      strategy: 'One writer, one check',
      steps: [
        {
          id: 'impl',
          title: 'Implement',
          kind: 'implementer',
          prompt: 'Write the change',
          requiresChanges: true,
        },
        {
          id: 'rev',
          title: 'Review',
          kind: 'reviewer',
          prompt: 'Review the tree',
          requiresChanges: true,
        },
      ],
    }),
    [],
  );
  assert.equal(parsed.steps.find((step) => step.id === 'impl')?.requiresChanges, true);
  assert.equal(parsed.steps.find((step) => step.id === 'rev')?.requiresChanges, false);
});

test('parseSynthesis extracts action items', () => {
  const parsed = parseSynthesis(
    JSON.stringify({
      summary: 'Ship with fixes',
      recommendations: ['Fix A'],
      risks: ['R1'],
      actionItems: [{ title: 'Fix A', prompt: 'Do A', priority: 'high' }],
    }),
    [],
  );
  assert.equal(parsed.actionItems[0]?.title, 'Fix A');
  assert.equal(parsed.actionItems[0]?.priority, 'high');
});

test('swarm start with agents roster stores per-agent provider and effort', async () => {
  await withDatabase(async (root) => {
    installFastPipeline({ requireApproval: false });
    const projectPath = path.join(root, 'project');
    await mkdir(projectPath, { recursive: true });
    const projectId = projectsDb.createProjectPath(projectPath).project!.project_id;

    const started = swarmService.start({
      projectId,
      goal: 'Cost-aware multi-agent goal',
      agents: [
        {
          kind: 'orchestrator',
          label: 'Lead',
          provider: 'claude',
          effort: 'medium',
          permissionMode: 'bypassPermissions',
        },
        {
          kind: 'explorer',
          label: 'Scout',
          provider: 'grok',
          effort: 'low',
          permissionMode: 'bypassPermissions',
        },
        {
          kind: 'implementer',
          label: 'Builder',
          provider: 'claude',
          effort: 'high',
          permissionMode: 'acceptEdits',
        },
      ],
      skills: ['project-memory'],
      requireApproval: false,
    });

    assert.equal(started.members?.length, 3);
    assert.ok(started.skills?.includes('project-memory'));
    const scout = started.members?.find((m) => m.label === 'Scout');
    assert.equal(scout?.provider, 'grok');
    assert.equal(scout?.effort, 'low');
    assert.equal(scout?.permission_mode, 'bypassPermissions');

    await waitFor(() => swarmDb.get(started.swarm_id)?.status === 'succeeded');
    const all = swarmService.list(null, 10);
    assert.ok(all.some((s) => s.swarm_id === started.swarm_id));
  });
});

test('swarm start persists goal attachments and drops paths outside the upload store', async () => {
  await withDatabase(async (root) => {
    installFastPipeline({ requireApproval: false });
    const projectPath = path.join(root, 'project');
    await mkdir(projectPath, { recursive: true });
    const projectId = projectsDb.createProjectPath(projectPath).project!.project_id;

    const assetsDir = getGlobalImageAssetsDir();
    await mkdir(assetsDir, { recursive: true });
    const fileName = `swarm-prd-${Date.now()}.md`;
    const assetPath = path.join(assetsDir, fileName);
    await writeFile(assetPath, '# PRD\n\nShip swarm goal attachments.\n');

    try {
      const started = swarmService.start({
        projectId,
        goal: 'Implement the attached PRD',
        agents: [
          {
            kind: 'orchestrator',
            label: 'Lead',
            provider: 'claude',
            permissionMode: 'bypassPermissions',
          },
        ],
        attachments: [
          { path: assetPath, name: 'prd.md', mimeType: 'text/markdown', size: 32 },
          { path: '/etc/passwd', name: 'evil.txt' },
          { path: path.join(root, 'outside.pdf'), name: 'outside.pdf' },
        ],
        requireApproval: false,
      });

      assert.equal(started.attachments.length, 1);
      assert.equal(started.attachments[0].name, 'prd.md');
      assert.equal(started.attachments[0].mimeType, 'text/markdown');
      assert.ok(started.attachments[0].path.includes(fileName));

      const reloaded = swarmDb.get(started.swarm_id);
      assert.equal(reloaded?.attachments.length, 1);
      assert.equal(reloaded?.attachments[0].name, 'prd.md');

      await waitFor(() => swarmDb.get(started.swarm_id)?.status === 'succeeded');
    } finally {
      await unlink(assetPath).catch(() => undefined);
    }
  });
});

test('swarm start returns running then pipeline completes with synthesis', async () => {
  await withDatabase(async (root) => {
    installFastPipeline({ requireApproval: false });
    const projectPath = path.join(root, 'project');
    await mkdir(projectPath, { recursive: true });
    const projectId = projectsDb.createProjectPath(projectPath).project!.project_id;

    const started = swarmService.start({
      projectId,
      goal: 'Ship workflow graph safely',
      roles: [
        { role: 'planner', label: 'Planner' },
        { role: 'security', label: 'Security' },
      ],
      requireApproval: false,
      provider: 'claude',
    });

    // Pipeline is async; fast test executor may finish before start() returns.
    assert.ok(
      ['planning', 'running', 'handing_off', 'succeeded'].includes(started.status),
    );
    assert.ok(started.parent_run_id);
    assert.equal(runService.get(started.parent_run_id!)?.source, 'swarm');
    assert.equal(started.members?.length, 2);

    await waitFor(() => swarmDb.get(started.swarm_id)?.status === 'succeeded');

    const swarm = swarmService.get(started.swarm_id)!;
    assert.equal(swarm.status, 'succeeded');
    assert.ok(swarm.synthesis?.summary);
    // Handoff-only: never creates Kanban tasks.
    assert.equal(swarm.synthesis?.tasksCreated ?? 0, 0);
    assert.equal(swarm.synthesis?.createdTaskIds?.length ?? 0, 0);
    for (const member of swarm.members ?? []) {
      assert.equal(member.status, 'succeeded');
      assert.ok(member.findings_summary);
      assert.ok(member.run_id);
      assert.equal(runService.get(member.run_id!)?.parent_run_id, swarm.parent_run_id);
    }
  });
});

test('swarm approval gate: approve acknowledges handoff without tasks', async () => {
  await withDatabase(async (root) => {
    installFastPipeline({ requireApproval: true });
    const projectPath = path.join(root, 'project');
    await mkdir(projectPath, { recursive: true });
    const projectId = projectsDb.createProjectPath(projectPath).project!.project_id;

    const started = swarmService.start({
      projectId,
      goal: 'Needs human approval',
      roles: [{ role: 'tester', label: 'Tester', focus: 'edge cases' }],
      requireApproval: true,
      provider: 'claude',
    });

    await waitFor(() => swarmDb.get(started.swarm_id)?.status === 'awaiting_approval');

    const swarm = swarmService.get(started.swarm_id)!;
    assert.equal(swarm.status, 'awaiting_approval');
    assert.equal(swarm.approval_status, 'pending');
    assert.ok(swarm.synthesis?.summary);

    const approved = swarmService.approve(swarm.swarm_id);
    assert.equal(approved.status, 'succeeded');
    assert.equal(approved.approval_status, 'approved');
    assert.equal(approved.synthesis?.tasksCreated ?? 0, 0);
    assert.equal(approved.synthesis?.createdTaskIds?.length ?? 0, 0);
    assert.ok(approved.synthesis?.summary);
  });
});

test('swarm roster enforces exactly one orchestrator', async () => {
  await withDatabase(async (root) => {
    installFastPipeline({ requireApproval: false });
    const projectPath = path.join(root, 'project');
    await mkdir(projectPath, { recursive: true });
    const projectId = projectsDb.createProjectPath(projectPath).project!.project_id;

    const started = swarmService.start({
      projectId,
      goal: 'One orchestrator only',
      agents: [
        { kind: 'orchestrator', label: 'Lead A', provider: 'claude' },
        { kind: 'orchestrator', label: 'Lead B', provider: 'grok' },
        { kind: 'explorer', label: 'Scout 1', provider: 'grok', effort: 'low' },
        { kind: 'explorer', label: 'Scout 2', provider: 'claude', effort: 'low' },
        { kind: 'implementer', label: 'Builder', provider: 'claude', effort: 'high' },
      ],
      requireApproval: false,
    });

    const orch = (started.roles ?? []).filter((r) => r.kind === 'orchestrator');
    assert.equal(orch.length, 1);
    assert.equal(orch[0]?.label, 'Lead A');
    // Second orchestrator demoted; workers preserved.
    assert.ok((started.roles ?? []).length >= 4);
    const explorers = (started.roles ?? []).filter((r) => r.kind === 'explorer');
    assert.equal(explorers.length, 2);

    await waitFor(() => swarmDb.get(started.swarm_id)?.status === 'succeeded');
  });
});

test('swarm reject marks failed without tasks', async () => {
  await withDatabase(async (root) => {
    installFastPipeline({ requireApproval: true });
    const projectPath = path.join(root, 'project');
    await mkdir(projectPath, { recursive: true });
    const projectId = projectsDb.createProjectPath(projectPath).project!.project_id;
    const started = swarmService.start({
      projectId,
      goal: 'Reject me',
      roles: [{ role: 'docs' }],
      requireApproval: true,
      provider: 'claude',
    });
    await waitFor(() => swarmDb.get(started.swarm_id)?.status === 'awaiting_approval');
    const rejected = swarmService.reject(started.swarm_id);
    assert.equal(rejected.status, 'failed');
    assert.equal(rejected.approval_status, 'rejected');
    assert.equal(rejected.synthesis?.createdTaskIds?.length ?? 0, 0);
  });
});

test('swarm ensureSwarmWorkspace allocates git worktree and feature branch', async () => {
  await withDatabase(async (root) => {
    installFastPipeline({ requireApproval: false });
    const projectPath = path.join(root, 'repo');
    await mkdir(projectPath, { recursive: true });
    await initGitRepo(projectPath);
    const projectId = projectsDb.createProjectPath(projectPath).project!.project_id;

    const started = swarmService.start({
      projectId,
      goal: 'Ship worktree isolation for agent swarm',
      agents: [
        { kind: 'orchestrator', label: 'Lead', provider: 'claude' },
        { kind: 'implementer', label: 'Builder', provider: 'claude' },
      ],
      requireApproval: false,
    });

    const { workspace, workPath } = await swarmService.ensureSwarmWorkspace(started.swarm_id, {
      projectId,
      projectPath,
      goal: started.goal,
      parentRunId: started.parent_run_id,
    });

    assert.equal(workspace.mode, 'git_worktree');
    assert.ok(workspace.feature_branch?.startsWith('swarm/'));
    assert.ok(workPath.includes('.cloudcli') || workPath.includes('worktrees'));

    const refreshed = swarmService.get(started.swarm_id)!;
    assert.equal(refreshed.workspace_id, workspace.workspace_id);
    assert.equal(refreshed.feature_branch, workspace.feature_branch);

    // Dirty file in worktree → finalize records PR error without remote (no push).
    await writeFile(path.join(workPath, 'swarm-note.txt'), 'from test\n');
    const handoff = await swarmService.finalizeSwarmPullRequest(started.swarm_id, {
      summary: 'Worktree isolation verified in test.',
      completed: ['allocated worktree'],
      remaining: [],
      recommendations: [],
      risks: [],
      memberCount: 1,
      generatedAt: new Date().toISOString(),
    });
    assert.equal(handoff.workspaceId, workspace.workspace_id);
    assert.ok(handoff.featureBranch);
    // No origin remote in the fixture — push should fail and surface prError.
    assert.ok(handoff.prError);
    assert.ok(!handoff.prUrl);

    await workspaceService.discard(workspace.workspace_id, { deleteBranch: true });
    await waitFor(() => swarmDb.get(started.swarm_id)?.status === 'succeeded');
  });
});

test('swarm opens a real (non-draft) PR and stops without merging to base', async () => {
  await withDatabase(async (root) => {
    installFastPipeline({ requireApproval: false });
    const projectPath = path.join(root, 'repo');
    await mkdir(projectPath, { recursive: true });
    await initGitRepo(projectPath);

    // Fork checkout: fetch URL names the fork (what gh must target) while pushes
    // go to a local bare repo, so the test needs no network.
    const originPath = path.join(root, 'origin.git');
    runGit(root, ['init', '--bare', originPath]);
    runGit(projectPath, ['remote', 'add', 'origin', 'https://github.com/me/fork.git']);
    runGit(projectPath, ['remote', 'set-url', '--push', 'origin', originPath]);

    // Stub `gh` on PATH: records argv, returns a PR URL. This exercises the real
    // runCli/spawn path rather than a seam, so the actual argv is asserted.
    const binDir = path.join(root, 'bin');
    await mkdir(binDir, { recursive: true });
    const argvLog = path.join(root, 'gh-argv.txt');
    await writeFile(
      path.join(binDir, 'gh'),
      `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a" >> ${JSON.stringify(argvLog)}; done\n` +
        `printf 'https://github.com/me/fork/pull/42\\n'\n`,
      { mode: 0o755 },
    );
    const previousPath = process.env.PATH;
    process.env.PATH = `${binDir}:${previousPath ?? ''}`;

    try {
      const projectId = projectsDb.createProjectPath(projectPath).project!.project_id;
      const started = swarmService.start({
        projectId,
        goal: 'Open a real PR from the swarm worktree',
        agents: [{ kind: 'orchestrator', label: 'Lead', provider: 'claude' }],
        requireApproval: false,
      });

      const { workspace, workPath } = await swarmService.ensureSwarmWorkspace(started.swarm_id, {
        projectId,
        projectPath,
        goal: started.goal,
        parentRunId: started.parent_run_id,
      });

      const baseSha = runGit(projectPath, ['rev-parse', 'HEAD']).stdout;
      await writeFile(path.join(workPath, 'agent-change.txt'), 'work from the swarm\n');

      const handoff = await swarmService.finalizeSwarmPullRequest(started.swarm_id, {
        summary: 'Swarm finished its work.',
        completed: ['did the thing'],
        remaining: [],
        recommendations: [],
        risks: [],
        memberCount: 1,
        generatedAt: new Date().toISOString(),
      });

      assert.equal(handoff.prError, null);
      assert.equal(handoff.prUrl, 'https://github.com/me/fork/pull/42');
      assert.equal(handoff.prNumber, 42);

      const argv = (await import('node:fs/promises'))
        .readFile(argvLog, 'utf8')
        .then((raw) => raw.split('\n').filter(Boolean));
      const args = await argv;

      // The whole point: a ready-for-review PR, never a draft.
      assert.ok(!args.includes('--draft'), 'swarm PR must not be a draft');
      assert.deepEqual(args.slice(0, 2), ['pr', 'create']);
      // Pinned to the fork we pushed to; unpinned, gh resolves the upstream parent.
      assert.equal(args[args.indexOf('--repo') + 1], 'me/fork');
      assert.equal(args[args.indexOf('--base') + 1], 'main');
      assert.equal(args[args.indexOf('--head') + 1], workspace.feature_branch);

      // The branch really reached the remote — otherwise the PR has no head.
      const remoteBranches = spawnSync('git', ['branch', '--list', workspace.feature_branch!], {
        cwd: originPath,
        encoding: 'utf8',
      });
      assert.match(String(remoteBranches.stdout), new RegExp(workspace.feature_branch!));

      // The swarm stops at the PR: base branch is untouched and the worktree
      // survives so a human can check it out and test.
      assert.equal(runGit(projectPath, ['rev-parse', 'HEAD']).stdout, baseSha);
      assert.equal(runGit(projectPath, ['rev-parse', '--abbrev-ref', 'HEAD']).stdout, 'main');
      assert.equal(workspaceService.get(workspace.workspace_id)?.status, 'active');

      await workspaceService.discard(workspace.workspace_id, { deleteBranch: true });
      await waitFor(() => swarmDb.get(started.swarm_id)?.status === 'succeeded');
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  });
});

test('finalizeSwarmPullRequest skips push and PR when the worktree has no diff from base', async () => {
  await withDatabase(async (root) => {
    installFastPipeline({ requireApproval: false });
    const projectPath = path.join(root, 'repo');
    await mkdir(projectPath, { recursive: true });
    await initGitRepo(projectPath);

    const originPath = path.join(root, 'origin.git');
    runGit(root, ['init', '--bare', originPath]);
    runGit(projectPath, ['remote', 'add', 'origin', originPath]);

    const projectId = projectsDb.createProjectPath(projectPath).project!.project_id;
    const started = swarmService.start({
      projectId,
      goal: 'Explore only, no write step ever ran',
      agents: [{ kind: 'orchestrator', label: 'Lead', provider: 'claude' }],
      requireApproval: false,
    });

    const { workspace } = await swarmService.ensureSwarmWorkspace(started.swarm_id, {
      projectId,
      projectPath,
      goal: started.goal,
      parentRunId: started.parent_run_id,
    });

    // No file written in the worktree — a plan whose write step was blocked
    // or never dispatched leaves the branch byte-identical to base.
    const handoff = await swarmService.finalizeSwarmPullRequest(started.swarm_id, {
      summary: 'Nothing to hand off.',
      completed: [],
      remaining: [],
      recommendations: [],
      risks: [],
      memberCount: 1,
      generatedAt: new Date().toISOString(),
    });

    assert.equal(handoff.pushed, false);
    assert.match(handoff.prError ?? '', /no changes to submit/i);
    assert.equal(handoff.prUrl, undefined);

    // The push must never have happened — the remote has no such branch.
    const remoteBranches = spawnSync('git', ['branch', '--list', workspace.feature_branch!], {
      cwd: originPath,
      encoding: 'utf8',
    });
    assert.equal(String(remoteBranches.stdout).trim(), '');

    await workspaceService.discard(workspace.workspace_id, { deleteBranch: true });
    await waitFor(() => swarmDb.get(started.swarm_id)?.status === 'succeeded');
  });
});

test('complete-member rejects stale completion after handoff', async () => {
  await withDatabase(async (root) => {
    installFastPipeline({ requireApproval: true });
    const projectPath = path.join(root, 'project');
    await mkdir(projectPath, { recursive: true });
    const projectId = projectsDb.createProjectPath(projectPath).project!.project_id;
    const started = swarmService.start({
      projectId,
      goal: 'Manual member update',
      roles: [{ role: 'tester', label: 'Tester' }],
      requireApproval: true,
      provider: 'claude',
    });
    await waitFor(() => (swarmDb.get(started.swarm_id)?.members?.length ?? 0) > 0);
    const member = swarmService.get(started.swarm_id)!.members![0];
    await waitFor(() => swarmService.get(started.swarm_id)?.status === 'awaiting_approval');
    assert.throws(
      () => swarmService.completeMember(
        started.swarm_id,
        member.member_id,
        'Custom tester finding: cover timeout paths.',
      ),
      /not allowed/i,
    );
  });
});

test('swarm plan-approval gate stores config and pauses at awaiting_plan_approval', async () => {
  await withDatabase(async (root) => {
    installFastPipeline({ requirePlanApproval: true });
    const projectPath = path.join(root, 'project');
    await mkdir(projectPath, { recursive: true });
    const projectId = projectsDb.createProjectPath(projectPath).project!.project_id;

    const started = swarmService.start({
      projectId,
      goal: 'Needs plan approval before workers run',
      roles: [{ role: 'tester', label: 'Tester' }],
      requirePlanApproval: true,
      provider: 'claude',
    });

    assert.equal(started.config?.requirePlanApproval, true);
    await waitFor(() => swarmDb.get(started.swarm_id)?.status === 'awaiting_plan_approval');
    const paused = swarmService.get(started.swarm_id)!;
    assert.equal(paused.approval_status, 'plan_pending');
    assert.ok(paused.plan);
  });
});

test('swarm approvePlan resumes the pipeline and runs workers', async () => {
  await withDatabase(async (root) => {
    installFastPipeline({ requirePlanApproval: true });
    const projectPath = path.join(root, 'project');
    await mkdir(projectPath, { recursive: true });
    const projectId = projectsDb.createProjectPath(projectPath).project!.project_id;

    const started = swarmService.start({
      projectId,
      goal: 'Plan ok — let workers run',
      agents: [
        { kind: 'orchestrator', label: 'Lead', provider: 'claude' },
        { kind: 'implementer', label: 'Builder', provider: 'claude' },
      ],
      requirePlanApproval: true,
    });

    await waitFor(() => swarmService.get(started.swarm_id)?.status === 'awaiting_plan_approval');
    const approved = swarmService.approvePlan(started.swarm_id);
    assert.equal(approved.approval_status, 'approved');

    await waitFor(() => swarmService.get(started.swarm_id)?.status === 'succeeded');
    const done = swarmService.get(started.swarm_id)!;
    assert.equal(done.status, 'succeeded');
    assert.equal(done.approval_status, 'approved');
    for (const member of done.members ?? []) {
      assert.equal(member.status, 'succeeded');
    }
  });
});

test('swarm reject-plan fails without dispatching workers', async () => {
  await withDatabase(async (root) => {
    installFastPipeline({ requirePlanApproval: true });
    const projectPath = path.join(root, 'project');
    await mkdir(projectPath, { recursive: true });
    const projectId = projectsDb.createProjectPath(projectPath).project!.project_id;

    const started = swarmService.start({
      projectId,
      goal: 'Plan rejected',
      roles: [{ role: 'implementer', label: 'Builder' }],
      requirePlanApproval: true,
      provider: 'claude',
    });

    await waitFor(() => swarmService.get(started.swarm_id)?.status === 'awaiting_plan_approval');
    const rejected = swarmService.rejectPlan(started.swarm_id);
    assert.equal(rejected.status, 'failed');
    assert.equal(rejected.approval_status, 'rejected');

    await waitFor(() => swarmService.get(started.swarm_id)?.status === 'failed');
    const done = swarmService.get(started.swarm_id)!;
    assert.equal(done.status, 'failed');
    assert.equal(done.synthesis?.createdTaskIds?.length ?? 0, 0);
  });
});

test('swarm approve-plan requires the paused state', async () => {
  await withDatabase(async (root) => {
    installFastPipeline({ requireApproval: true });
    const projectPath = path.join(root, 'project');
    await mkdir(projectPath, { recursive: true });
    const projectId = projectsDb.createProjectPath(projectPath).project!.project_id;
    const started = swarmService.start({
      projectId,
      goal: 'Not paused on plan',
      roles: [{ role: 'tester', label: 'Tester' }],
      requireApproval: true,
      provider: 'claude',
    });
    await waitFor(() => swarmService.get(started.swarm_id)?.status === 'awaiting_approval');
    assert.throws(() => swarmService.approvePlan(started.swarm_id), /awaiting plan approval/i);
  });
});

test('swarm abort force-kills a running swarm', async () => {
  await withDatabase(async (root) => {
    installFastPipeline({ requirePlanApproval: true });
    const projectPath = path.join(root, 'project');
    await mkdir(projectPath, { recursive: true });
    const projectId = projectsDb.createProjectPath(projectPath).project!.project_id;
    const started = swarmService.start({
      projectId,
      goal: 'Abort mid-plan',
      roles: [{ role: 'implementer', label: 'Builder' }],
      requirePlanApproval: true,
      provider: 'claude',
    });
    await waitFor(() => swarmService.get(started.swarm_id)?.status === 'awaiting_plan_approval');
    await swarmService.abort(started.swarm_id);
    const aborted = swarmService.get(started.swarm_id)!;
    assert.equal(aborted.status, 'aborted');
    if (started.parent_run_id) {
      assert.equal(runService.get(started.parent_run_id)?.status, 'aborted');
    }
  });
});

test('swarm withUsage rollup aggregates tokens and cost across member runs', async () => {
  await withDatabase(async (root) => {
    installFastPipeline({ requireApproval: false });
    const projectPath = path.join(root, 'project');
    await mkdir(projectPath, { recursive: true });
    const projectId = projectsDb.createProjectPath(projectPath).project!.project_id;
    const started = swarmService.start({
      projectId,
      goal: 'Cost rollup',
      agents: [
        { kind: 'orchestrator', label: 'Lead', provider: 'claude' },
        { kind: 'explorer', label: 'Scout', provider: 'grok' },
      ],
      requireApproval: false,
      provider: 'claude',
    });

    await waitFor(() => swarmService.get(started.swarm_id)?.status === 'succeeded');
    const swarm = swarmService.get(started.swarm_id)!;
    const members = swarm.members ?? [];
    assert.ok(members.length > 0);
    for (const m of members) {
      if (m.run_id) {
        runService.attachUsage(m.run_id, { input: 100, output: 50, total: 150, costUsdEstimate: 0.01 });
      }
    }
    const withUsage = swarmService.withUsage(swarm);
    assert.ok(withUsage.usage);
    assert.equal(withUsage.usage!.totalTokens, 150 * members.length);
    assert.equal(withUsage.usage!.memberRuns.length, members.length);
    assert.ok(withUsage.usage!.memberRuns[0]!.tokens >= 150);
    assert.ok((withUsage.usage!.totalDurationMs ?? 0) >= 0);
    assert.ok(withUsage.usage!.memberRuns[0]!.stepId !== undefined);
  });
});

test('runWaveWithConcurrency caps parallel execution', async () => {
  const service = swarmService;
  const order: number[] = [];
  let active = 0;
  let peak = 0;
  await service.runWaveWithConcurrency(
    [1, 2, 3, 4, 5],
    async (step) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 30));
      active -= 1;
      order.push(step);
      return step * 2;
    },
    2,
  );
  assert.equal(peak, 2);
  assert.deepEqual(order.sort((a, b) => a - b), [1, 2, 3, 4, 5]);
});

test('production pipeline uses fake provider runtime and serializes worktree writers', async () => {
  await withDatabase(async (root) => {
    setSwarmTestExecutor(null);
    const projectPath = path.join(root, 'repo');
    await mkdir(projectPath, { recursive: true });
    await initGitRepo(projectPath);
    const projectId = projectsDb.createProjectPath(projectPath).project!.project_id;
    let activeWriters = 0;
    let peakWriters = 0;
    const runtimePaths: string[] = [];
    configureSwarmRuntimes({
      claude: async (prompt, options, writer) => {
        const output = prompt.includes('"strategy"')
          ? JSON.stringify({
              summary: 'Implement twice safely',
              strategy: 'Two writer steps in one wave',
              steps: [
                { id: 'write-1', title: 'First write', kind: 'implementer', assignTo: 'Builder', wave: 1, dependsOn: [], prompt: 'First change' },
                { id: 'write-2', title: 'Second write', kind: 'implementer', assignTo: 'Builder', wave: 1, dependsOn: [], prompt: 'Second change' },
              ],
            })
          : prompt.includes('"completed"')
            ? JSON.stringify({ summary: 'Both writer attempts completed.', completed: ['First write', 'Second write'], remaining: [], recommendations: [], risks: [] })
            : JSON.stringify({ summary: 'Writer completed.', findings: ['isolated workspace'], recommendations: [], risks: [], severity: 'info' });
        const isWriter = prompt.includes('## Your assigned step') && !prompt.includes('Replan failed');
        if (isWriter) {
          activeWriters += 1;
          peakWriters = Math.max(peakWriters, activeWriters);
          runtimePaths.push(String(options.cwd ?? ''));
          await new Promise((resolve) => setTimeout(resolve, 40));
          activeWriters -= 1;
        }
        const sink = writer as { setSessionId(id: string): void; send(message: unknown): void };
        sink.setSessionId(`native-${Math.random().toString(36).slice(2)}`);
        sink.send({ kind: 'stream_delta', provider: 'claude', sessionId: null, content: output });
        sink.send({ kind: 'complete', provider: 'claude', sessionId: null, exitCode: 0, success: true });
      },
    });

    const started = swarmService.start({
      projectId,
      goal: 'Exercise the real production swarm pipeline',
      agents: [
        { kind: 'orchestrator', label: 'Lead', provider: 'claude' },
        { kind: 'implementer', label: 'Builder', provider: 'claude' },
      ],
      requireApproval: false,
      requirePlanApproval: false,
      validateBeforePr: false,
      maxConcurrency: 8,
    });
    await waitFor(() => swarmService.get(started.swarm_id)?.status === 'succeeded', 10_000);
    const done = swarmService.get(started.swarm_id)!;
    assert.equal(peakWriters, 1);
    assert.equal(done.plan?.steps.filter((step) => step.status === 'succeeded').length, 2);
    assert.ok(runtimePaths.every((cwd) => cwd && path.resolve(cwd) !== path.resolve(projectPath)));
    assert.deepEqual(
      swarmDb.listAttempts(started.swarm_id).filter((attempt) => attempt.phase === 'execute').map((attempt) => attempt.status),
      ['succeeded', 'succeeded'],
    );
  });
});

test('production pipeline auto-inits a non-git project into a mergeable git_worktree workspace', async () => {
  await withDatabase(async (root) => {
    setSwarmTestExecutor(null);
    const projectPath = path.join(root, 'plain-project');
    await mkdir(projectPath, { recursive: true });
    await writeFile(path.join(projectPath, 'app.txt'), 'before\n');
    const projectId = projectsDb.createProjectPath(projectPath).project!.project_id;
    let workerCwd = '';

    configureSwarmRuntimes({
      claude: async (prompt, options, writer) => {
        const sink = writer as { setSessionId(id: string): void; send(message: unknown): void };
        sink.setSessionId(`native-${Math.random().toString(36).slice(2)}`);
        let output: string;
        if (prompt.includes('"strategy"')) {
          output = JSON.stringify({
            summary: 'Edit the source file',
            strategy: 'One implementation step',
            steps: [{
              id: 'edit-source',
              title: 'Edit source',
              kind: 'implementer',
              assignTo: 'Builder',
              wave: 1,
              dependsOn: [],
              requiresChanges: true,
              acceptanceCriteria: ['The source file is updated'],
              prompt: 'Update app.txt.',
            }],
          });
        } else if (prompt.includes('"completed"')) {
          output = JSON.stringify({
            summary: 'Source edit completed.',
            completed: ['Edit source'],
            remaining: [],
            recommendations: [],
            risks: [],
          });
        } else {
          workerCwd = String(options.cwd ?? '');
          await writeFile(path.join(workerCwd, 'app.txt'), 'after\n');
          output = JSON.stringify({
            summary: 'Updated app.txt.',
            findings: ['Source was changed in the isolated copy.'],
            changedFiles: ['app.txt'],
            verification: ['read back app.txt'],
            acceptance: [{ criterion: '1', met: true, evidence: 'app.txt contains after' }],
            recommendations: [],
            risks: [],
            severity: 'info',
          });
        }
        sink.send({ kind: 'stream_delta', provider: 'claude', sessionId: null, content: output });
        sink.send({ kind: 'complete', provider: 'claude', sessionId: null, exitCode: 0, success: true });
      },
    });

    const started = swarmService.start({
      projectId,
      goal: 'Edit a non-git project safely',
      agents: [
        { kind: 'orchestrator', label: 'Lead', provider: 'claude' },
        { kind: 'implementer', label: 'Builder', provider: 'claude' },
      ],
      requireApproval: false,
      requirePlanApproval: false,
      validateBeforePr: false,
    });
    await waitFor(() => swarmService.get(started.swarm_id)?.status === 'succeeded', 10_000);
    const done = swarmService.get(started.swarm_id)!;
    assert.equal(workspaceService.get(done.workspace_id!)?.mode, 'git_worktree');
    assert.equal(runGit(projectPath, ['rev-parse', '--is-inside-work-tree']).stdout, 'true');
    assert.equal(done.plan?.steps[0]?.status, 'succeeded');
    assert.ok(workerCwd && path.resolve(workerCwd) !== path.resolve(projectPath));
  });
});

test('a reviewer/agent that honestly reports unmet acceptance criteria is "needs_changes", not "failed"', async () => {
  await withDatabase(async (root) => {
    setSwarmTestExecutor(null);
    const projectPath = path.join(root, 'repo');
    await mkdir(projectPath, { recursive: true });
    await initGitRepo(projectPath);
    const projectId = projectsDb.createProjectPath(projectPath).project!.project_id;
    let workerRuns = 0;

    configureSwarmRuntimes({
      claude: async (prompt, options, writer) => {
        const sink = writer as { setSessionId(id: string): void; send(message: unknown): void };
        sink.setSessionId(`native-${Math.random().toString(36).slice(2)}`);
        let output: string;
        if (prompt.includes('"strategy"')) {
          output = JSON.stringify({
            summary: 'Edit the source file',
            strategy: 'One implementation step',
            steps: [{
              id: 'edit-source',
              title: 'Edit source',
              kind: 'implementer',
              assignTo: 'Builder',
              wave: 1,
              dependsOn: [],
              requiresChanges: true,
              acceptanceCriteria: ['The source file compiles cleanly'],
              prompt: 'Update app.txt.',
            }],
          });
        } else if (prompt.includes('"completed"')) {
          output = JSON.stringify({
            summary: 'Source edit completed.',
            completed: ['Edit source'],
            remaining: [],
            recommendations: [],
            risks: [],
          });
        } else {
          workerRuns += 1;
          const cwd = String(options.cwd ?? '');
          await writeFile(path.join(cwd, 'app.txt'), `after-${workerRuns}\n`);
          // First attempt: agent ran cleanly and honestly reports the
          // criterion is not met yet. Second attempt: it is met.
          const met = workerRuns > 1;
          output = JSON.stringify({
            summary: met ? 'Updated app.txt and verified it compiles.' : 'Updated app.txt but it does not compile yet.',
            findings: ['Edited the isolated worktree.'],
            changedFiles: ['app.txt'],
            verification: ['read back app.txt'],
            acceptance: [{ criterion: '1', met, evidence: met ? 'compiles cleanly' : 'still fails to compile' }],
            recommendations: [],
            risks: [],
            severity: 'info',
          });
        }
        sink.send({ kind: 'stream_delta', provider: 'claude', sessionId: null, content: output });
        sink.send({ kind: 'complete', provider: 'claude', sessionId: null, exitCode: 0, success: true });
      },
    });

    const started = swarmService.start({
      projectId,
      goal: 'Edit a file and self-grade against acceptance criteria',
      agents: [
        { kind: 'orchestrator', label: 'Lead', provider: 'claude' },
        { kind: 'implementer', label: 'Builder', provider: 'claude' },
      ],
      requireApproval: false,
      requirePlanApproval: false,
      validateBeforePr: false,
    });
    await waitFor(() => swarmService.get(started.swarm_id)?.status === 'succeeded', 10_000);
    const done = swarmService.get(started.swarm_id)!;
    assert.equal(workerRuns, 2, 'expected the honest first attempt to be retried');
    assert.equal(done.plan?.steps[0]?.status, 'succeeded');

    const attempts = swarmDb.listAttempts(started.swarm_id, 'edit-source');
    assert.equal(attempts.length, 2);
    // The run that crashed vs the run that honestly reported "not ready yet"
    // must not collapse into the same status — only the latter is a verdict.
    assert.equal(attempts[0].status, 'needs_changes');
    assert.equal(attempts[1].status, 'succeeded');
    assert.match(attempts[0].error ?? '', /Acceptance evidence missing or unmet/);

    const members = swarmDb.listMembers(started.swarm_id);
    const firstAttemptMember = members.find((m) => m.error && /Acceptance evidence missing or unmet/.test(m.error));
    assert.ok(firstAttemptMember, 'expected a member record carrying the unmet-criteria error');
    assert.equal(firstAttemptMember!.status, 'needs_changes');
  });
});

test('reviewer changes dispatch an implementer correction and then an independent re-review', async () => {
  await withDatabase(async (root) => {
    setSwarmTestExecutor(null);
    const projectPath = path.join(root, 'repo');
    await mkdir(projectPath, { recursive: true });
    await initGitRepo(projectPath);
    const projectId = projectsDb.createProjectPath(projectPath).project!.project_id;
    let reviewerRuns = 0;
    let correctionRuns = 0;
    let replanRuns = 0;

    configureSwarmRuntimes({
      claude: async (prompt, options, writer) => {
        const sink = writer as { setSessionId(id: string): void; send(message: unknown): void };
        sink.setSessionId(`native-${Math.random().toString(36).slice(2)}`);
        let output: string;
        if (prompt.includes('"strategy"')) {
          output = JSON.stringify({
            summary: 'Implement and review',
            strategy: 'One writer followed by one reviewer',
            steps: [
              {
                id: 'implement-buggy',
                title: 'Implement source',
                kind: 'implementer',
                assignTo: 'Builder',
                wave: 1,
                dependsOn: [],
                requiresChanges: true,
                acceptanceCriteria: ['Source implementation exists'],
                prompt: 'Create app.txt.',
              },
              {
                id: 'review-source',
                title: 'Review source',
                kind: 'reviewer',
                assignTo: 'Reviewer',
                wave: 2,
                dependsOn: ['implement-buggy'],
                acceptanceCriteria: ['The implementation is release-ready'],
                prompt: 'Review app.txt and request changes if it contains buggy.',
              },
            ],
          });
        } else if (prompt.includes('SUPERVISOR TICK') || prompt.includes('Replan failed steps')) {
          replanRuns += 1;
          // Deliberately return the wrong role. Policy must coerce a reviewer
          // verdict onto an implementer until a real diff lands.
          output = JSON.stringify({
            action: 'dispatch',
            kind: 'reviewer',
            assignTo: 'Reviewer',
            title: 'Apply requested fixes',
            prompt: 'Replace buggy with fixed in app.txt.',
            reason: 'Reviewer asked for changes',
          });
        } else if (prompt.includes('"completed"')) {
          output = JSON.stringify({
            summary: 'Implementation corrected and independently re-reviewed.',
            completed: ['Implement source', 'Review source'],
            remaining: [],
            recommendations: [],
            risks: [],
          });
        } else if (
          prompt.includes('Implement the changes requested by the reviewer')
          || prompt.includes('Implement the changes requested by reviewer step')
        ) {
          correctionRuns += 1;
          await writeFile(path.join(String(options.cwd ?? ''), 'app.txt'), 'fixed\n');
          output = JSON.stringify({
            summary: 'Applied the requested fix.',
            findings: [],
            changedFiles: ['app.txt'],
            verification: ['read app.txt'],
            acceptance: [{ criterion: '1', met: true, evidence: 'The implementation is now release-ready' }],
            recommendations: [],
            risks: [],
            severity: 'info',
          });
        } else if (prompt.includes('Review app.txt')) {
          reviewerRuns += 1;
          const met = reviewerRuns > 1;
          output = JSON.stringify({
            summary: met ? 'Approved after correction.' : 'Changes requested: app.txt is buggy.',
            findings: met ? [] : ['app.txt still contains buggy'],
            changedFiles: [],
            verification: ['read app.txt'],
            acceptance: [{ criterion: '1', met, evidence: met ? 'fixed content verified' : 'buggy content found' }],
            recommendations: met ? [] : ['Replace buggy with fixed'],
            risks: met ? [] : ['release blocker'],
            severity: met ? 'info' : 'critical',
          });
        } else {
          await writeFile(path.join(String(options.cwd ?? ''), 'app.txt'), 'buggy\n');
          output = JSON.stringify({
            summary: 'Created the initial implementation.',
            findings: [],
            changedFiles: ['app.txt'],
            verification: ['read app.txt'],
            acceptance: [{ criterion: '1', met: true, evidence: 'Source implementation exists' }],
            recommendations: [],
            risks: [],
            severity: 'info',
          });
        }
        sink.send({ kind: 'stream_delta', provider: 'claude', sessionId: null, content: output });
        sink.send({ kind: 'complete', provider: 'claude', sessionId: null, exitCode: 0, success: true });
      },
    });

    const started = swarmService.start({
      projectId,
      goal: 'Implement source and resolve reviewer feedback automatically',
      agents: [
        { kind: 'orchestrator', label: 'Lead', provider: 'claude' },
        { kind: 'implementer', label: 'Builder', provider: 'claude' },
        { kind: 'reviewer', label: 'Reviewer', provider: 'claude' },
      ],
      requireApproval: false,
      requirePlanApproval: false,
      validateBeforePr: false,
      stepMaxAttempts: 3,
      maxReplanRounds: 2,
    });
    await waitFor(() => ['succeeded', 'failed', 'aborted'].includes(swarmService.get(started.swarm_id)?.status ?? ''), 10_000);
    const done = swarmService.get(started.swarm_id)!;
    assert.equal(
      done.status,
      'succeeded',
      JSON.stringify({
        status: done.status,
        lastError: done.last_error,
        ticks: done.goalCard?.ticksUsed,
        decisions: done.goalCard?.decisions,
        steps: done.plan?.steps.map((step) => `${step.id}:${step.kind}:${step.status}`),
      }),
    );
    assert.equal(reviewerRuns, 2, 'reviewer should run once before and once after correction');
    assert.equal(correctionRuns, 1, 'changes requested should dispatch exactly one implementer correction');
    assert.equal(replanRuns, 2, 'supervisor ticks once to implement and once to re-review');
    assert.ok(
      (done.members ?? []).some((member) => member.kind === 'implementer' && member.step_id?.startsWith('supervise-')),
      'the correction must run as an implementer even if the orchestrator returned a reviewer step',
    );
    assert.ok(done.plan?.steps.some((step) => step.kind === 'reviewer' && step.id.startsWith('supervise-') && step.status === 'succeeded'));
    assert.equal(done.goalCard?.mode, 'supervisor');
    assert.ok((done.goalCard?.decisions.length ?? 0) >= 2);
    assert.equal(done.status, 'succeeded');
  });
});

test('resume from failure preserves the workspace and skips completed planning', async () => {
  await withDatabase(async (root) => {
    setSwarmTestExecutor(null);
    const projectPath = path.join(root, 'repo');
    await mkdir(projectPath, { recursive: true });
    await initGitRepo(projectPath);
    const projectId = projectsDb.createProjectPath(projectPath).project!.project_id;
    let recovering = false;
    let planRuns = 0;
    let workerRuns = 0;

    configureSwarmRuntimes({
      claude: async (prompt, _options, writer) => {
        const sink = writer as { setSessionId(id: string): void; send(message: unknown): void };
        sink.setSessionId(`native-${Math.random().toString(36).slice(2)}`);
        if (prompt.includes('"strategy"')) {
          planRuns += 1;
          sink.send({ kind: 'stream_delta', provider: 'claude', sessionId: null, content: JSON.stringify({
            summary: 'One durable step',
            strategy: 'Run once and resume if it fails',
            steps: [{
              id: 'durable-step',
              title: 'Durable implementation',
              kind: 'implementer',
              assignTo: 'Builder',
              wave: 1,
              dependsOn: [],
              prompt: 'Complete the durable step.',
            }],
          }) });
          sink.send({ kind: 'complete', provider: 'claude', sessionId: null, exitCode: 0, success: true });
          return;
        }
        if (prompt.includes('SUPERVISOR TICK') || prompt.includes('Replan failed steps')) {
          sink.send({
            kind: 'stream_delta',
            provider: 'claude',
            sessionId: null,
            content: JSON.stringify(
              recovering
                ? {
                    action: 'dispatch',
                    kind: 'implementer',
                    title: 'Resume durable step',
                    prompt: 'Complete the durable step.',
                    reason: 'Continue from the checkpoint',
                  }
                : { action: 'blocked', reason: 'simulated provider failure' },
            ),
          });
          sink.send({ kind: 'complete', provider: 'claude', sessionId: null, exitCode: 0, success: true });
          return;
        }
        if (prompt.includes('"completed"')) {
          sink.send({ kind: 'stream_delta', provider: 'claude', sessionId: null, content: JSON.stringify({
            summary: recovering ? 'Recovered from the checkpoint.' : 'Still unresolved.',
            completed: recovering ? ['Durable implementation'] : [],
            remaining: recovering ? [] : ['Durable implementation'],
            recommendations: [],
            risks: [],
          }) });
          sink.send({ kind: 'complete', provider: 'claude', sessionId: null, exitCode: 0, success: true });
          return;
        }
        workerRuns += 1;
        if (!recovering) {
          sink.send({ kind: 'complete', provider: 'claude', sessionId: null, exitCode: 1, success: false, error: 'simulated provider failure' });
          return;
        }
        sink.send({ kind: 'stream_delta', provider: 'claude', sessionId: null, content: JSON.stringify({
          summary: 'Completed after resume.',
          findings: [],
          changedFiles: [],
          verification: ['checkpoint state inspected'],
          acceptance: [],
          recommendations: [],
          risks: [],
          severity: 'info',
        }) });
        sink.send({ kind: 'complete', provider: 'claude', sessionId: null, exitCode: 0, success: true });
      },
    });

    const started = swarmService.start({
      projectId,
      goal: 'Resume a failed swarm without repeating completed phases',
      agents: [
        { kind: 'orchestrator', label: 'Lead', provider: 'claude' },
        { kind: 'implementer', label: 'Builder', provider: 'claude' },
      ],
      requireApproval: false,
      requirePlanApproval: false,
      validateBeforePr: false,
      stepMaxAttempts: 1,
      maxReplanRounds: 1,
    });
    await waitFor(() => swarmService.get(started.swarm_id)?.status === 'failed', 10_000);
    const failed = swarmService.get(started.swarm_id)!;
    const workspaceId = failed.workspace_id;
    assert.equal(planRuns, 1);
    assert.equal(workerRuns, 1);

    recovering = true;
    const resumed = await swarmService.resumeFromFailure(started.swarm_id);
    assert.equal(resumed.status, 'running');
    await waitFor(() => ['succeeded', 'failed', 'aborted'].includes(swarmService.get(started.swarm_id)?.status ?? ''), 10_000);
    const done = swarmService.get(started.swarm_id)!;
    assert.equal(done.status, 'succeeded', done.last_error ?? done.status);
    assert.equal(done.workspace_id, workspaceId, 'resume must reuse the original isolated workspace');
    assert.equal(planRuns, 1, 'the persisted plan must not be regenerated');
    assert.ok(workerRuns >= 2, `expected the failed attempt plus a resumed worker, got ${workerRuns}`);
    assert.equal(done.goalCard?.mode, 'supervisor');
    assert.ok(done.blackboard.some((message) => message.content.includes('[resume] continuing from the last failure checkpoint')));
  });
});

test('autonomous mode keeps replanning across multiple rounds instead of giving up after one', async () => {
  await withDatabase(async (root) => {
    setSwarmTestExecutor(null);
    const projectPath = path.join(root, 'repo');
    await mkdir(projectPath, { recursive: true });
    await initGitRepo(projectPath);
    const projectId = projectsDb.createProjectPath(projectPath).project!.project_id;
    let workerAttempts = 0;
    let replanRounds = 0;

    configureSwarmRuntimes({
      claude: async (prompt, options, writer) => {
        const sink = writer as { setSessionId(id: string): void; send(message: unknown): void };
        sink.setSessionId(`native-${Math.random().toString(36).slice(2)}`);
        let output: string;
        if (prompt.includes('"strategy"')) {
          output = JSON.stringify({
            summary: 'Edit the source file',
            strategy: 'One implementation step, 1 attempt each — must replan to recover',
            steps: [{
              id: 'edit-source',
              title: 'Edit source',
              kind: 'implementer',
              assignTo: 'Builder',
              wave: 1,
              dependsOn: [],
              requiresChanges: true,
              acceptanceCriteria: ['The source file compiles cleanly'],
              prompt: 'Update app.txt.',
            }],
          });
        } else if (prompt.includes('SUPERVISOR TICK') || prompt.includes('Replan failed steps')) {
          replanRounds += 1;
          output = JSON.stringify({
            action: 'dispatch',
            kind: 'implementer',
            assignTo: 'Builder',
            title: `Retry edit source (round ${replanRounds})`,
            prompt: 'Try again; write app.txt so it compiles.',
            reason: 'Keep implementing until the file compiles',
          });
        } else if (prompt.includes('"completed"')) {
          output = JSON.stringify({
            summary: 'Source edit completed.',
            completed: ['Edit source'],
            remaining: [],
            recommendations: [],
            risks: [],
          });
        } else {
          workerAttempts += 1;
          const cwd = String(options.cwd ?? '');
          await writeFile(path.join(cwd, 'app.txt'), `after-${workerAttempts}\n`);
          // Attempts 1 and 2 (initial + round-1 replan) honestly report the
          // criterion unmet; only the 3rd attempt (round-2 replan) succeeds —
          // this can only resolve if the swarm survives past one replan round.
          const met = workerAttempts >= 3;
          output = JSON.stringify({
            summary: met ? 'Compiles cleanly now.' : 'Still does not compile.',
            findings: ['Edited the isolated worktree.'],
            changedFiles: ['app.txt'],
            verification: ['read back app.txt'],
            acceptance: [{ criterion: '1', met, evidence: met ? 'compiles cleanly' : 'still fails to compile' }],
            recommendations: [],
            risks: [],
            severity: 'info',
          });
        }
        sink.send({ kind: 'stream_delta', provider: 'claude', sessionId: null, content: output });
        sink.send({ kind: 'complete', provider: 'claude', sessionId: null, exitCode: 0, success: true });
      },
    });

    const started = swarmService.start({
      projectId,
      goal: 'Edit a file that needs two rounds of orchestrator replanning to resolve',
      agents: [
        { kind: 'orchestrator', label: 'Lead', provider: 'claude' },
        { kind: 'implementer', label: 'Builder', provider: 'claude' },
      ],
      requireApproval: false,
      requirePlanApproval: false,
      validateBeforePr: false,
      autonomous: true,
      stepMaxAttempts: 1,
      maxReplanRounds: 2,
    });
    await waitFor(() => ['succeeded', 'failed', 'aborted'].includes(swarmService.get(started.swarm_id)?.status ?? ''), 10_000);
    const done = swarmService.get(started.swarm_id)!;
    assert.equal(
      done.status,
      'succeeded',
      JSON.stringify({
        status: done.status,
        lastError: done.last_error,
        ticks: done.goalCard?.ticksUsed,
        decisions: done.goalCard?.decisions,
        steps: done.plan?.steps.map((step) => `${step.id}:${step.kind}:${step.status}`),
      }),
    );
    assert.equal(workerAttempts, 3, 'expected the initial attempt plus two supervisor-tick attempts');
    assert.equal(replanRounds, 2, 'expected exactly two supervisor ticks, not one');

    const steps = done.plan?.steps ?? [];
    assert.equal(new Set(steps.map((s) => s.id)).size, steps.length);
    assert.ok(steps.some((step) => step.id.startsWith('supervise-') && step.status === 'succeeded'));
    assert.equal(done.goalCard?.mode, 'supervisor');
    assert.equal(done.status, 'succeeded');
  });
});

test('production abort kills live provider run and cannot be overwritten by late completion', async () => {
  await withDatabase(async (root) => {
    setSwarmTestExecutor(null);
    const projectPath = path.join(root, 'repo');
    await mkdir(projectPath, { recursive: true });
    await initGitRepo(projectPath);
    const projectId = projectsDb.createProjectPath(projectPath).project!.project_id;
    let releaseWorker: (() => void) | null = null;
    const abortedProviderIds: string[] = [];
    configureSwarmAbortFns({
      claude: async (providerSessionId) => {
        abortedProviderIds.push(providerSessionId);
        releaseWorker?.();
        return true;
      },
    });
    configureSwarmRuntimes({
      claude: async (prompt, _options, writer) => {
        const sink = writer as { setSessionId(id: string): void; send(message: unknown): void };
        if (prompt.includes('"strategy"')) {
          sink.setSessionId('native-plan');
          sink.send({ kind: 'stream_delta', provider: 'claude', sessionId: null, content: JSON.stringify({
            summary: 'One blocking worker', strategy: 'Run it', steps: [
              { id: 'block', title: 'Blocking worker', kind: 'implementer', assignTo: 'Builder', wave: 1, dependsOn: [], prompt: 'Wait until aborted' },
            ],
          }) });
          sink.send({ kind: 'complete', provider: 'claude', sessionId: null, exitCode: 0, success: true });
          return;
        }
        sink.setSessionId('native-worker');
        await new Promise<void>((resolve) => { releaseWorker = resolve; });
        // Simulate a runtime that emits success after its abort handler returns.
        sink.send({ kind: 'stream_delta', provider: 'claude', sessionId: null, content: JSON.stringify({ summary: 'late success', findings: [], recommendations: [], risks: [], severity: 'info' }) });
        sink.send({ kind: 'complete', provider: 'claude', sessionId: null, exitCode: 0, success: true });
      },
    });
    const started = swarmService.start({
      projectId,
      goal: 'Abort the real worker',
      agents: [
        { kind: 'orchestrator', label: 'Lead', provider: 'claude' },
        { kind: 'implementer', label: 'Builder', provider: 'claude' },
      ],
      requirePlanApproval: false,
      validateBeforePr: false,
      requireApproval: false,
    });
    await waitFor(() => swarmService.get(started.swarm_id)?.members?.some((member) => member.status === 'running' && member.kind === 'implementer') === true, 10_000);
    const aborted = await swarmService.abort(started.swarm_id);
    assert.equal(aborted.status, 'aborted');
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(swarmService.get(started.swarm_id)?.status, 'aborted');
    assert.deepEqual(abortedProviderIds, ['native-worker']);
    assert.ok(!swarmDb.listAttempts(started.swarm_id).some((attempt) => attempt.phase === 'handoff'));
  });
});

test('idempotency key returns one swarm and one parent run', async () => {
  await withDatabase(async (root) => {
    installFastPipeline();
    const projectPath = path.join(root, 'project');
    await mkdir(projectPath, { recursive: true });
    const projectId = projectsDb.createProjectPath(projectPath).project!.project_id;
    const input = { projectId, goal: 'Exactly once', provider: 'claude', idempotencyKey: 'start-123' };
    const first = swarmService.start(input);
    const second = swarmService.start(input);
    assert.equal(second.swarm_id, first.swarm_id);
    assert.equal(second.parent_run_id, first.parent_run_id);
    assert.equal(swarmDb.list(projectId, 10, { includeArchived: true }).length, 1);
  });
});

test('user-selected bypassPermissions on an implementer reaches the runtime unmodified', async () => {
  await withDatabase(async (root) => {
    setSwarmTestExecutor(null);
    const projectPath = path.join(root, 'repo');
    await mkdir(projectPath, { recursive: true });
    await initGitRepo(projectPath);
    const projectId = projectsDb.createProjectPath(projectPath).project!.project_id;
    const workerModes: Array<string | undefined> = [];
    const orchestratorModes: Array<string | undefined> = [];
    configureSwarmRuntimes({
      claude: async (prompt, options, writer) => {
        const sink = writer as { setSessionId(id: string): void; send(message: unknown): void };
        sink.setSessionId(`native-${Math.random().toString(36).slice(2)}`);
        let output: string;
        if (prompt.includes('"strategy"')) {
          orchestratorModes.push(options.permissionMode as string | undefined);
          output = JSON.stringify({
            summary: 'One implementer step',
            strategy: 'Single wave',
            steps: [
              { id: 'w1', title: 'Do the change', kind: 'implementer', assignTo: 'Builder', wave: 1, dependsOn: [], prompt: 'Change it' },
            ],
          });
        } else if (prompt.includes('"completed"')) {
          orchestratorModes.push(options.permissionMode as string | undefined);
          output = JSON.stringify({ summary: 'Done', completed: ['Do the change'], remaining: [], recommendations: [], risks: [] });
        } else {
          workerModes.push(options.permissionMode as string | undefined);
          output = JSON.stringify({ summary: 'Changed.', findings: [], recommendations: [], risks: [], severity: 'info' });
        }
        sink.send({ kind: 'stream_delta', provider: 'claude', sessionId: null, content: output });
        sink.send({ kind: 'complete', provider: 'claude', sessionId: null, exitCode: 0, success: true });
      },
    });

    const started = swarmService.start({
      projectId,
      goal: 'Bypass permissions passthrough',
      agents: [
        { kind: 'orchestrator', label: 'Lead', provider: 'claude' },
        { kind: 'implementer', label: 'Builder', provider: 'claude', permissionMode: 'bypassPermissions' },
      ],
      requireApproval: false,
      requirePlanApproval: false,
      validateBeforePr: false,
    });
    await waitFor(() => swarmService.get(started.swarm_id)?.status === 'succeeded', 10_000);

    // The user's requested mode reaches buildHeadlessOptions unmodified.
    assert.deepEqual(workerModes, ['bypassPermissions']);
    // Orchestrator plan/handoff runs stay read-only by policy.
    assert.ok(orchestratorModes.length >= 2);
    assert.ok(orchestratorModes.every((mode) => mode === 'plan'), `orchestrator modes: ${orchestratorModes.join(',')}`);
    // The member row persists the honored mode.
    const implementer = swarmService.get(started.swarm_id)!.members!.find((m) => m.kind === 'implementer');
    assert.equal(implementer?.permission_mode, 'bypassPermissions');
  });
});

test('effort is dropped and persisted as null for a provider without supportsEffort', async () => {
  await withDatabase(async (root) => {
    setSwarmTestExecutor(null);
    const projectPath = path.join(root, 'repo');
    await mkdir(projectPath, { recursive: true });
    await initGitRepo(projectPath);
    const projectId = projectsDb.createProjectPath(projectPath).project!.project_id;
    const workerEfforts: Array<unknown> = [];
    const claudeRuntime = async (prompt: string, _options: Record<string, unknown>, writer: unknown) => {
      const sink = writer as { setSessionId(id: string): void; send(message: unknown): void };
      sink.setSessionId(`native-${Math.random().toString(36).slice(2)}`);
      const output = prompt.includes('"strategy"')
        ? JSON.stringify({
            summary: 'One cursor step',
            strategy: 'Single wave',
            steps: [
              { id: 'w1', title: 'Do the change', kind: 'implementer', assignTo: 'Builder', wave: 1, dependsOn: [], prompt: 'Change it' },
            ],
          })
        : JSON.stringify({ summary: 'Done', completed: ['Do the change'], remaining: [], recommendations: [], risks: [] });
      sink.send({ kind: 'stream_delta', provider: 'claude', sessionId: null, content: output });
      sink.send({ kind: 'complete', provider: 'claude', sessionId: null, exitCode: 0, success: true });
    };
    configureSwarmRuntimes({
      claude: claudeRuntime,
      cursor: async (_prompt, options, writer) => {
        const sink = writer as { setSessionId(id: string): void; send(message: unknown): void };
        sink.setSessionId(`cursor-${Math.random().toString(36).slice(2)}`);
        workerEfforts.push(options.effort);
        sink.send({
          kind: 'stream_delta',
          provider: 'cursor',
          sessionId: null,
          content: JSON.stringify({ summary: 'Changed.', findings: [], recommendations: [], risks: [], severity: 'info' }),
        });
        sink.send({ kind: 'complete', provider: 'cursor', sessionId: null, exitCode: 0, success: true });
      },
    });

    const started = swarmService.start({
      projectId,
      goal: 'Effort capability validation',
      agents: [
        { kind: 'orchestrator', label: 'Lead', provider: 'claude' },
        // cursor has supportsEffort=false — the requested effort must be dropped.
        { kind: 'implementer', label: 'Builder', provider: 'cursor', effort: 'high' },
      ],
      requireApproval: false,
      requirePlanApproval: false,
      validateBeforePr: false,
    });
    await waitFor(() => swarmService.get(started.swarm_id)?.status === 'succeeded', 10_000);

    // The runtime never sees the unsupported effort.
    assert.deepEqual(workerEfforts, [undefined]);
    // The member row stores null instead of the silently-dropped value.
    const done = swarmService.get(started.swarm_id)!;
    const implementer = done.members!.find((m) => m.kind === 'implementer');
    assert.equal(implementer?.effort, null);
    // The drop is observable on the blackboard.
    assert.ok(
      done.blackboard.some((m) => m.content.includes('[policy]') && m.content.includes('effort "high" dropped')),
      'expected a policy note about the dropped effort',
    );
  });
});

// ————————————————————————————————————————————————————————————————————————
// Per-task attempt budget: feedback retries + capability-aware reassignment
// ————————————————————————————————————————————————————————————————————————

test('a failing pinned-provider step is retried by the takeover seat provider and model', async () => {
  await withDatabase(async (root) => {
    setSwarmTestExecutor(null);
    const projectPath = path.join(root, 'repo');
    await mkdir(projectPath, { recursive: true });
    await initGitRepo(projectPath);
    const projectId = projectsDb.createProjectPath(projectPath).project!.project_id;

    /** Prompts seen by worker runs, in order. */
    const workerPrompts: string[] = [];
    let workerCalls = 0;
    let grokWorkerCalls = 0;
    let opencodeWorkerCalls = 0;
    let opencodeModel: unknown = null;
    configureSwarmRuntimes({
      claude: async (prompt, _options, writer) => {
        const sink = writer as { setSessionId(id: string): void; send(message: unknown): void };
        sink.setSessionId(`native-${Math.random().toString(36).slice(2)}`);
        const output = prompt.includes('"strategy"')
          ? JSON.stringify({
              summary: 'One step',
              strategy: 'Single implementer',
              steps: [
                { id: 'w1', title: 'Do the thing', kind: 'implementer', difficulty: 'medium', assignTo: 'Builder', provider: 'grok', model: 'grok-test-model', wave: 1, dependsOn: [], prompt: 'Do it' },
              ],
            })
          : prompt.includes('"completed"')
            ? JSON.stringify({ summary: 'Done.', completed: ['Do the thing'], remaining: [], recommendations: [], risks: [] })
            : JSON.stringify({ summary: 'Applied.', findings: [], recommendations: [], risks: [], severity: 'info' });
        sink.send({ kind: 'stream_delta', provider: 'claude', sessionId: null, content: output });
        sink.send({ kind: 'complete', provider: 'claude', sessionId: null, exitCode: 0, success: true });
      },
      grok: async (prompt, _options, writer) => {
        const sink = writer as { setSessionId(id: string): void; send(message: unknown): void };
        sink.setSessionId(`native-grok-${Math.random().toString(36).slice(2)}`);
        grokWorkerCalls += 1;
        workerCalls += 1;
        workerPrompts.push(prompt);
        sink.send({ kind: 'complete', provider: 'grok', sessionId: null, exitCode: 1, success: false, error: 'boom: could not apply the change' });
      },
      opencode: async (prompt, options, writer) => {
        const sink = writer as { setSessionId(id: string): void; send(message: unknown): void };
        sink.setSessionId(`native-opencode-${Math.random().toString(36).slice(2)}`);
        opencodeWorkerCalls += 1;
        workerCalls += 1;
        workerPrompts.push(prompt);
        opencodeModel = (options as { model?: unknown }).model;
        const output = JSON.stringify({ summary: 'Applied.', findings: [], recommendations: [], risks: [], severity: 'info' });
        sink.send({ kind: 'stream_delta', provider: 'opencode', sessionId: null, content: output });
        sink.send({ kind: 'complete', provider: 'opencode', sessionId: null, exitCode: 0, success: true });
      },
    });

    const started = swarmService.start({
      projectId,
      goal: 'Retry a failing step',
      agents: [
        { kind: 'orchestrator', label: 'Lead', provider: 'claude' },
        { kind: 'implementer', label: 'Builder', provider: 'grok', model: 'grok-test-model', level: 'medium' },
        { kind: 'implementer', label: 'Senior', provider: 'opencode', model: 'opencode-test-model', level: 'advanced' },
      ],
      requireApproval: false,
      requirePlanApproval: false,
      validateBeforePr: false,
      stepMaxAttempts: 3,
    });
    await waitFor(() => swarmService.get(started.swarm_id)?.status === 'succeeded', 15_000);
    const done = swarmService.get(started.swarm_id)!;

    // Two worker attempts on the SAME step, and the step ends succeeded.
    assert.equal(workerCalls, 2);
    assert.equal(grokWorkerCalls, 1, 'the pinned provider should only receive the first attempt');
    assert.equal(opencodeWorkerCalls, 1, 'the takeover must launch its own provider runtime');
    assert.equal(opencodeModel, 'opencode-test-model', 'the takeover must launch its own model');
    assert.equal(done.plan?.steps.find((s) => s.id === 'w1')?.status, 'succeeded');

    // The retry carried the first failure into the prompt.
    assert.ok(
      workerPrompts[1]?.includes('PREVIOUS ATTEMPTS AT THIS EXACT STEP FAILED'),
      'retry prompt must carry the failure feedback block',
    );
    assert.ok(
      workerPrompts[1]?.includes('Provider "grok" exited with a failure'),
      'retry prompt must quote the previous failure',
    );
    assert.ok(
      workerPrompts[1]?.includes('Attempt 1 by "Builder"'),
      'retry prompt must name the seat that failed',
    );

    // The retry went to the stronger untried seat, not back to the same one.
    assert.ok(
      workerPrompts[1]?.includes('DIFFERENT agent taking this step over'),
      'retry must be marked as a takeover',
    );
    const board = done.blackboard.map((m) => m.content);
    assert.ok(
      board.some((c) => c.includes('[retry]') && c.includes('reassigned to roster seat "Senior"')),
      board.join('\n'),
    );
    assert.ok(
      board.some((c) => c.includes('[retry] step w1 succeeded on attempt 2 with "Senior"')),
      board.join('\n'),
    );

    // Both attempts are durably recorded.
    const attempts = swarmDb
      .listAttempts(started.swarm_id)
      .filter((a) => a.phase === 'execute' && a.step_id === 'w1');
    assert.deepEqual(attempts.map((a) => a.status), ['failed', 'succeeded']);
    assert.equal(
      done.members?.some((member) => member.status === 'queued' || member.status === 'running') ?? false,
      false,
      'a terminal swarm must not retain live-looking roster rows',
    );
  });
});

test('a step that fails every attempt exhausts the budget and escalates to a replan', async () => {
  await withDatabase(async (root) => {
    setSwarmTestExecutor(null);
    const projectPath = path.join(root, 'repo');
    await mkdir(projectPath, { recursive: true });
    await initGitRepo(projectPath);
    const projectId = projectsDb.createProjectPath(projectPath).project!.project_id;

    let workerCalls = 0;
    let replanCalls = 0;
    configureSwarmRuntimes({
      claude: async (prompt, _options, writer) => {
        const sink = writer as { setSessionId(id: string): void; send(message: unknown): void };
        sink.setSessionId(`native-${Math.random().toString(36).slice(2)}`);
        if (prompt.includes('SUPERVISOR TICK') || prompt.includes('Replan failed steps')) {
          replanCalls += 1;
          sink.send({
            kind: 'stream_delta',
            provider: 'claude',
            sessionId: null,
            content: JSON.stringify({ action: 'blocked', reason: 'unrecoverable worker failure' }),
          });
          sink.send({ kind: 'complete', provider: 'claude', sessionId: null, exitCode: 0, success: true });
          return;
        }
        if (prompt.includes('## Your assigned step')) {
          workerCalls += 1;
          sink.send({ kind: 'complete', provider: 'claude', sessionId: null, exitCode: 1, success: false, error: 'always broken' });
          return;
        }
        const output = prompt.includes('"strategy"')
          ? JSON.stringify({
              summary: 'One step',
              strategy: 'Single implementer',
              steps: [
                { id: 'w1', title: 'Impossible', kind: 'implementer', difficulty: 'basic', assignTo: 'Builder', wave: 1, dependsOn: [], prompt: 'Do it' },
              ],
            })
          : JSON.stringify({ summary: 'Nothing landed.', completed: [], remaining: ['Impossible'], recommendations: [], risks: [] });
        sink.send({ kind: 'stream_delta', provider: 'claude', sessionId: null, content: output });
        sink.send({ kind: 'complete', provider: 'claude', sessionId: null, exitCode: 0, success: true });
      },
    });

    const started = swarmService.start({
      projectId,
      goal: 'Never succeeds',
      agents: [
        { kind: 'orchestrator', label: 'Lead', provider: 'claude' },
        { kind: 'implementer', label: 'Builder', provider: 'claude' },
      ],
      requireApproval: false,
      requirePlanApproval: false,
      validateBeforePr: false,
      stepMaxAttempts: 2,
    });
    await waitFor(
      () => ['succeeded', 'failed'].includes(swarmService.get(started.swarm_id)?.status ?? ''),
      15_000,
    );
    const done = swarmService.get(started.swarm_id)!;

    // Exactly the attempt budget, then one orchestrator supervisor tick.
    assert.equal(workerCalls, 2);
    assert.equal(replanCalls, 1);
    const board = done.blackboard.map((m) => m.content);
    assert.ok(
      board.some((c) => c.includes('[retry] step w1 exhausted its 2 attempt(s)')),
      board.join('\n'),
    );
    const superviseAttempt = swarmDb
      .listAttempts(started.swarm_id)
      .find((attempt) => attempt.phase === 'supervise');
    assert.ok(superviseAttempt?.run_id, 'supervisor tick must have a canonical child run');
    assert.ok(runService.get(superviseAttempt!.run_id!), 'supervisor child run must be persisted');
    assert.equal(done.goalCard?.mode, 'supervisor');
  });
});

test('auto-roster refuses to staff an advanced step with a basic profile', async () => {
  await withDatabase(async (root) => {
    setSwarmTestExecutor(null);
    const projectPath = path.join(root, 'repo');
    await mkdir(projectPath, { recursive: true });
    await initGitRepo(projectPath);
    const projectId = projectsDb.createProjectPath(projectPath).project!.project_id;

    const cheap = agentRunProfilesDb.create({
      name: 'Cheap Hands',
      provider: 'claude',
      permissionMode: 'acceptEdits',
      swarmRoles: ['implementer'],
      swarmLevel: 'basic',
    });
    const strong = agentRunProfilesDb.create({
      name: 'Deep Thinker',
      provider: 'claude',
      permissionMode: 'acceptEdits',
      swarmRoles: ['implementer'],
      swarmLevel: 'advanced',
    });

    configureSwarmRuntimes({
      claude: async (prompt, _options, writer) => {
        const sink = writer as { setSessionId(id: string): void; send(message: unknown): void };
        sink.setSessionId(`native-${Math.random().toString(36).slice(2)}`);
        const output = prompt.includes('"strategy"')
          ? JSON.stringify({
              summary: 'One hard step',
              strategy: 'Single implementer',
              steps: [
                {
                  id: 'w1',
                  title: 'Redesign the module',
                  kind: 'implementer',
                  difficulty: 'advanced',
                  // Deliberately under-staffed: a basic profile on an advanced step.
                  profileId: cheap.profile_id,
                  wave: 1,
                  dependsOn: [],
                  prompt: 'Redesign it',
                },
              ],
            })
          : prompt.includes('"completed"')
            ? JSON.stringify({ summary: 'Done.', completed: ['Redesign the module'], remaining: [], recommendations: [], risks: [] })
            : JSON.stringify({ summary: 'Redesigned.', findings: [], recommendations: [], risks: [], severity: 'info' });
        sink.send({ kind: 'stream_delta', provider: 'claude', sessionId: null, content: output });
        sink.send({ kind: 'complete', provider: 'claude', sessionId: null, exitCode: 0, success: true });
      },
    });

    const started = swarmService.start({
      projectId,
      goal: 'Level-aware staffing',
      orchestrator: { kind: 'orchestrator', label: 'Lead', provider: 'claude' },
      autoRoster: true,
      requireApproval: false,
      requirePlanApproval: false,
      validateBeforePr: false,
    });
    await waitFor(() => swarmService.get(started.swarm_id)?.status === 'succeeded', 15_000);
    const done = swarmService.get(started.swarm_id)!;

    // The step was promoted to the advanced profile, and the promotion is audited.
    const step = done.plan?.steps.find((s) => s.id === 'w1');
    assert.equal(step?.profileId, strong.profile_id);
    assert.equal(step?.difficulty, 'advanced');
    assert.equal(step?.assignTo, 'Deep Thinker');
    const seat = (done.roles ?? []).find((r) => r.label === 'Deep Thinker');
    assert.equal(seat?.level, 'advanced');
    assert.ok(
      done.blackboard.some((m) => m.content.includes('is level basic but the step is rated advanced')),
      done.blackboard.map((m) => m.content).join('\n'),
    );
  });
});

// ————————————————————————————————————————————————————————————————————————
// Plan sizing: real parallelism for read-only steps, scope-disjoint dispatch
// ————————————————————————————————————————————————————————————————————————

test('splitWaveByScope keeps disjoint same-kind steps together and separates overlapping ones', () => {
  const step = (id: string, kind: string, scope?: string[]): SwarmPlanStep => ({
    id,
    title: id,
    kind,
    prompt: id,
    dependsOn: [],
    wave: 1,
    ...(scope ? { scope } : {}),
  });

  // Genuinely disjoint file sets → one group, run together.
  const disjoint = splitWaveByScope([
    step('a', 'implementer', ['apps/web/src/cart/**']),
    step('b', 'implementer', ['apps/web/src/account/**']),
  ]);
  assert.equal(disjoint.groups.length, 1, 'disjoint scopes must share a group');
  assert.deepEqual(disjoint.conflicts, []);

  // Overlapping by path containment → separate groups, reported.
  const overlapping = splitWaveByScope([
    step('a', 'implementer', ['apps/web/src/cart/**']),
    step('b', 'implementer', ['apps/web/src/cart/page.tsx']),
  ]);
  assert.equal(overlapping.groups.length, 2, 'overlapping scopes must serialize');
  assert.equal(overlapping.conflicts.length, 1);
  assert.equal(overlapping.conflicts[0]!.step, 'b');
  assert.equal(overlapping.conflicts[0]!.against, 'a');

  // Undeclared scope = owns everything of its kind → serialize.
  const unscoped = splitWaveByScope([step('a', 'implementer'), step('b', 'implementer')]);
  assert.equal(unscoped.groups.length, 2, 'unscoped same-kind steps must serialize');
  assert.deepEqual(unscoped.conflicts[0]!.overlap, ['no declared scope']);

  // Different kinds never conflict with each other.
  const mixed = splitWaveByScope([step('a', 'explorer'), step('b', 'implementer')]);
  assert.equal(mixed.groups.length, 1);
  assert.deepEqual(mixed.conflicts, []);
});

test('read-only steps run concurrently while writers stay serialized', async () => {
  await withDatabase(async (root) => {
    setSwarmTestExecutor(null);
    const projectPath = path.join(root, 'repo');
    await mkdir(projectPath, { recursive: true });
    await initGitRepo(projectPath);
    const projectId = projectsDb.createProjectPath(projectPath).project!.project_id;

    let activeExplorers = 0;
    let peakExplorers = 0;
    let activeWriters = 0;
    let peakWriters = 0;
    configureSwarmRuntimes({
      claude: async (prompt, _options, writer) => {
        const sink = writer as { setSessionId(id: string): void; send(message: unknown): void };
        sink.setSessionId(`native-${Math.random().toString(36).slice(2)}`);
        const isStep = prompt.includes('## Your assigned step');
        const isExplorer = isStep && prompt.includes('You are an Explorer agent');
        const isWriter = isStep && prompt.includes('You are an Implementation agent');
        if (isExplorer) {
          activeExplorers += 1;
          peakExplorers = Math.max(peakExplorers, activeExplorers);
          await new Promise((resolve) => setTimeout(resolve, 60));
          activeExplorers -= 1;
        }
        if (isWriter) {
          activeWriters += 1;
          peakWriters = Math.max(peakWriters, activeWriters);
          await new Promise((resolve) => setTimeout(resolve, 60));
          activeWriters -= 1;
        }
        const output = prompt.includes('"strategy"')
          ? JSON.stringify({
              summary: 'Two readers then two disjoint writers',
              strategy: 'Parallel explore, serialized writes',
              steps: [
                { id: 'e1', title: 'Map cart', kind: 'explorer', difficulty: 'basic', assignTo: 'Scout', wave: 1, dependsOn: [], scope: ['src/cart/**'], prompt: 'Map the cart' },
                { id: 'e2', title: 'Map account', kind: 'explorer', difficulty: 'basic', assignTo: 'Scout', wave: 1, dependsOn: [], scope: ['src/account/**'], prompt: 'Map the account' },
                { id: 'w1', title: 'Cart layout', kind: 'implementer', difficulty: 'medium', assignTo: 'Builder', wave: 2, dependsOn: ['e1'], scope: ['src/cart/**'], prompt: 'Do cart' },
                { id: 'w2', title: 'Account layout', kind: 'implementer', difficulty: 'medium', assignTo: 'Builder', wave: 2, dependsOn: ['e2'], scope: ['src/account/**'], prompt: 'Do account' },
              ],
            })
          : prompt.includes('"completed"')
            ? JSON.stringify({ summary: 'Done.', completed: ['all'], remaining: [], recommendations: [], risks: [] })
            : JSON.stringify({ summary: 'Step done.', findings: [], recommendations: [], risks: [], severity: 'info' });
        sink.send({ kind: 'stream_delta', provider: 'claude', sessionId: null, content: output });
        sink.send({ kind: 'complete', provider: 'claude', sessionId: null, exitCode: 0, success: true });
      },
    });

    const started = swarmService.start({
      projectId,
      goal: 'Parallel readers, serial writers',
      agents: [
        { kind: 'orchestrator', label: 'Lead', provider: 'claude' },
        { kind: 'explorer', label: 'Scout', provider: 'claude' },
        { kind: 'implementer', label: 'Builder', provider: 'claude' },
      ],
      requireApproval: false,
      requirePlanApproval: false,
      validateBeforePr: false,
      maxConcurrency: 4,
    });
    await waitFor(() => swarmService.get(started.swarm_id)?.status === 'succeeded', 20_000);
    const done = swarmService.get(started.swarm_id)!;

    // Read-only exploration is now genuinely concurrent...
    assert.equal(peakExplorers, 2, 'two read-only steps in one wave must overlap');
    // ...while writers still serialize on the single shared worktree, even
    // though their scopes are disjoint and they share a wave.
    assert.equal(peakWriters, 1, 'writers must never overlap in one worktree');
    assert.equal(done.plan?.steps.filter((s) => s.status === 'succeeded').length, 4);
  });
});

test('same-kind steps over one area are serialized with a [plan] warning, never dropped', async () => {
  await withDatabase(async (root) => {
    setSwarmTestExecutor(null);
    const projectPath = path.join(root, 'repo');
    await mkdir(projectPath, { recursive: true });
    await initGitRepo(projectPath);
    const projectId = projectsDb.createProjectPath(projectPath).project!.project_id;

    let peakExplorers = 0;
    let activeExplorers = 0;
    configureSwarmRuntimes({
      claude: async (prompt, _options, writer) => {
        const sink = writer as { setSessionId(id: string): void; send(message: unknown): void };
        sink.setSessionId(`native-${Math.random().toString(36).slice(2)}`);
        if (prompt.includes('You are an Explorer agent') && prompt.includes('## Your assigned step')) {
          activeExplorers += 1;
          peakExplorers = Math.max(peakExplorers, activeExplorers);
          await new Promise((resolve) => setTimeout(resolve, 60));
          activeExplorers -= 1;
        }
        const output = prompt.includes('"strategy"')
          ? JSON.stringify({
              summary: 'Two explorers on the same area',
              strategy: 'Redundant fan-out',
              steps: [
                { id: 'e1', title: 'Look at cart', kind: 'explorer', difficulty: 'basic', assignTo: 'Scout', wave: 1, dependsOn: [], scope: ['src/cart/**'], prompt: 'Look' },
                { id: 'e2', title: 'Also look at cart', kind: 'explorer', difficulty: 'basic', assignTo: 'Scout', wave: 1, dependsOn: [], scope: ['src/cart/page.tsx'], prompt: 'Look again' },
              ],
            })
          : prompt.includes('"completed"')
            ? JSON.stringify({ summary: 'Done.', completed: ['looked'], remaining: [], recommendations: [], risks: [] })
            : JSON.stringify({ summary: 'Looked.', findings: [], recommendations: [], risks: [], severity: 'info' });
        sink.send({ kind: 'stream_delta', provider: 'claude', sessionId: null, content: output });
        sink.send({ kind: 'complete', provider: 'claude', sessionId: null, exitCode: 0, success: true });
      },
    });

    const started = swarmService.start({
      projectId,
      goal: 'Redundant fan-out',
      agents: [
        { kind: 'orchestrator', label: 'Lead', provider: 'claude' },
        { kind: 'explorer', label: 'Scout', provider: 'claude' },
      ],
      requireApproval: false,
      requirePlanApproval: false,
      validateBeforePr: false,
      maxConcurrency: 4,
    });
    await waitFor(() => swarmService.get(started.swarm_id)?.status === 'succeeded', 20_000);
    const done = swarmService.get(started.swarm_id)!;

    // Overlapping scopes lose the concurrency they were never entitled to...
    assert.equal(peakExplorers, 1, 'overlapping same-kind steps must not overlap');
    // ...but both still run — nothing is discarded.
    assert.equal(done.plan?.steps.filter((s) => s.status === 'succeeded').length, 2);
    const board = done.blackboard.map((m) => m.content);
    assert.ok(
      board.some((c) => c.includes('[plan] steps e2 and e1 are both "explorer" over the same scope')),
      board.join('\n'),
    );
    // The sizing summary is auditable at a glance.
    assert.ok(
      board.some((c) => c.includes('[policy] Plan sizing: 2 step(s)') && c.includes('2 explorer')),
      board.join('\n'),
    );
  });
});

// ————————————————————————————————————————————————————————————————————————
// Implementer failure on a LEAN roster: a capable substitute must be found
// ————————————————————————————————————————————————————————————————————————

test('a failed implementer on a one-seat MANUAL roster is taken over by a capable profile', async () => {
  await withDatabase(async (root) => {
    setSwarmTestExecutor(null);
    const projectPath = path.join(root, 'repo');
    await mkdir(projectPath, { recursive: true });
    await initGitRepo(projectPath);
    const projectId = projectsDb.createProjectPath(projectPath).project!.project_id;

    // A genuinely different, equally-capable agent exists in the profile pool —
    // but the operator's manual roster does not include it.
    agentRunProfilesDb.create({
      name: 'Grok Builder',
      provider: 'grok',
      permissionMode: 'default',
      swarmRoles: ['implementer'],
      swarmLevel: 'medium',
    });

    const seatsUsed: string[] = [];
    let workerCalls = 0;
    const runtime = async (prompt: string, _options: unknown, writer: unknown, provider: string) => {
      const sink = writer as { setSessionId(id: string): void; send(message: unknown): void };
      sink.setSessionId(`native-${Math.random().toString(36).slice(2)}`);
      if (prompt.includes('## Your assigned step')) {
        workerCalls += 1;
        seatsUsed.push(provider);
        // Only the original claude seat fails; the substitute succeeds.
        if (provider === 'claude') {
          sink.send({ kind: 'complete', provider, sessionId: null, exitCode: 1, success: false });
          return;
        }
      }
      const output = prompt.includes('"strategy"')
        ? JSON.stringify({
            summary: 'One implementer',
            strategy: 'Lean plan',
            steps: [
              { id: 'w1', title: 'Do the work', kind: 'implementer', difficulty: 'medium', assignTo: 'Builder', wave: 1, dependsOn: [], scope: ['src/**'], prompt: 'Do it' },
            ],
          })
        : prompt.includes('"completed"')
          ? JSON.stringify({ summary: 'Done.', completed: ['Do the work'], remaining: [], recommendations: [], risks: [] })
          : JSON.stringify({ summary: 'Done it.', findings: [], recommendations: [], risks: [], severity: 'info' });
      sink.send({ kind: 'stream_delta', provider, sessionId: null, content: output });
      sink.send({ kind: 'complete', provider, sessionId: null, exitCode: 0, success: true });
    };
    configureSwarmRuntimes({
      claude: (p, o, w) => runtime(p as string, o, w, 'claude'),
      grok: (p, o, w) => runtime(p as string, o, w, 'grok'),
    });

    const started = swarmService.start({
      projectId,
      // Manual roster with exactly ONE implementer — the lean-plan norm.
      goal: 'Lean roster takeover',
      agents: [
        { kind: 'orchestrator', label: 'Lead', provider: 'claude' },
        { kind: 'implementer', label: 'Builder', provider: 'claude', level: 'medium' },
      ],
      requireApproval: false,
      requirePlanApproval: false,
      validateBeforePr: false,
      stepMaxAttempts: 2,
    });
    await waitFor(() => swarmService.get(started.swarm_id)?.status === 'succeeded', 20_000);
    const done = swarmService.get(started.swarm_id)!;

    // The step succeeded because a DIFFERENT agent took it over.
    assert.equal(workerCalls, 2);
    assert.deepEqual(seatsUsed, ['claude', 'grok'], 'the substitute must be a different agent');
    assert.equal(done.plan?.steps.find((s) => s.id === 'w1')?.status, 'succeeded');

    // The seat was added to the roster and the departure from the manual roster
    // is recorded, since the operator did not list it.
    assert.ok(
      (done.roles ?? []).some((seat) => seat.label === 'Grok Builder'),
      'the takeover seat must be persisted onto the roster',
    );
    const board = done.blackboard.map((m) => m.content);
    assert.ok(
      board.some((c) => c.includes('no untried implementer seat') && c.includes('Grok Builder')),
      board.join('\n'),
    );
  });
});

test('retry escalates to a stronger seat on the same provider, but never to a clone', () => {
  const step: SwarmPlanStep = {
    id: 's1',
    title: 's1',
    kind: 'implementer',
    prompt: 's1',
    dependsOn: [],
    difficulty: 'medium',
  };
  const failed: SwarmAgentSpec = {
    id: 'a',
    kind: 'implementer',
    label: 'Medium Claude',
    provider: 'claude',
    model: null,
    effort: 'medium',
    level: 'medium',
  };
  const clone: SwarmAgentSpec = { ...failed, id: 'b', label: 'Medium Claude Copy' };
  const stronger: SwarmAgentSpec = {
    id: 'c',
    kind: 'implementer',
    label: 'Strong Claude',
    provider: 'claude',
    model: null,
    effort: 'high',
    level: 'advanced',
  };

  const args = {
    swarmId: 'swarm-x',
    step,
    triedSeatIds: new Set(['a']),
    triedSignatures: new Set(['claude||medium']),
    maxTriedLevelRank: 2,
    autoRoster: false,
    defaultProvider: 'claude',
    defaultModel: null,
    failedSeat: failed,
  };

  // A same-provider, same-effort, same-level seat is a re-run, not a retry.
  assert.equal(
    pickReassignmentSeatForTest({ ...args, rosterRef: { current: [failed, clone] } }),
    null,
    'a clone of the failed agent must not be selected',
  );

  // The same provider at a strictly higher tier IS a real escalation.
  const escalated = pickReassignmentSeatForTest({
    ...args,
    rosterRef: { current: [failed, clone, stronger] },
  });
  assert.equal(escalated?.seat.label, 'Strong Claude');
});
