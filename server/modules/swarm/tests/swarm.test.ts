import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { rm, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { makeScratchDir } from '@/shared/scratch.js';
import { closeConnection, initializeDatabase, projectsDb } from '@/modules/database/index.js';
import {
  parseMemberFindings,
  parseSynthesis,
} from '@/modules/swarm/swarm-agent.service.js';
import { setSwarmTestExecutor, swarmService } from '@/modules/swarm/swarm.service.js';
import { swarmDb } from '@/modules/swarm/swarm.repository.js';
import { runService } from '@/modules/runs/index.js';
import { workspaceService } from '@/modules/workspaces/index.js';

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
        assignTo: 'Explorer',
        prompt: 'Map the codebase.',
        wave: 1,
      },
      {
        id: 'step-2',
        title: 'Implement changes',
        kind: 'implementer',
        assignTo: 'Implementer',
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
      if (opts.failMember) {
        swarmDb.updateMember(member.member_id, {
          status: 'failed',
          error: 'simulated failure',
          finished: true,
        });
        if (member.run_id) {
          try {
            runService.markTerminal(member.run_id, {
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
      if (member.run_id) {
        try {
          runService.markTerminal(member.run_id, { status: 'succeeded' });
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

test('complete-member updates findings', async () => {
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
    const updated = swarmService.completeMember(
      started.swarm_id,
      member.member_id,
      'Custom tester finding: cover timeout paths.',
    );
    assert.ok(updated.findings.some((f) => f.summary.includes('Custom tester')));
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
