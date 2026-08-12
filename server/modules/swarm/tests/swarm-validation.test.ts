import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { rm, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { agentRunProfilesDb, closeConnection, initializeDatabase, projectsDb } from '@/modules/database/index.js';
import { interruptsService } from '@/modules/interrupt-queue/index.js';
import { runService } from '@/modules/runs/index.js';
import {
  chatRunRegistry,
  configureSwarmAbortFns,
  configureSwarmRuntimes,
} from '@/modules/swarm/swarm-agent.service.js';
import { configureSwarmPermissionResolver, swarmPermissionBroker } from '@/modules/swarm/swarm-permission-broker.service.js';
import {
  announcedPorts,
  configureSwarmValidationAppBooter,
  configureSwarmValidationBrowser,
  configureSwarmValidationCommandRunner,
  defaultSwarmValidationAppBooter,
} from '@/modules/swarm/swarm-validation.service.js';
import { setSwarmTestExecutor, swarmService } from '@/modules/swarm/swarm.service.js';
import { swarmDb } from '@/modules/swarm/swarm.repository.js';
import { makeScratchDir } from '@/shared/scratch.js';

function runGit(repoPath: string, args: string[]): number | null {
  return spawnSync('git', args, { cwd: repoPath, encoding: 'utf8' }).status;
}

async function initGitRepo(dir: string, packageJson?: Record<string, unknown>): Promise<void> {
  assert.equal(runGit(dir, ['init', '-b', 'main']), 0);
  assert.equal(runGit(dir, ['config', 'user.email', 'test@example.com']), 0);
  assert.equal(runGit(dir, ['config', 'user.name', 'Test Runner']), 0);
  await writeFile(path.join(dir, 'README.md'), 'initial\n');
  if (packageJson) {
    await writeFile(path.join(dir, 'package.json'), `${JSON.stringify(packageJson, null, 2)}\n`);
  }
  assert.equal(runGit(dir, ['add', '.']), 0);
  assert.equal(runGit(dir, ['commit', '-m', 'initial']), 0);
}

async function withDatabase(callback: (root: string) => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const root = await makeScratchDir('swarm-validation-');
  closeConnection();
  process.env.DATABASE_PATH = path.join(root, 'auth.db');
  await initializeDatabase();
  try {
    await callback(root);
  } finally {
    setSwarmTestExecutor(null);
    configureSwarmRuntimes({});
    configureSwarmAbortFns({});
    configureSwarmPermissionResolver(null);
    configureSwarmValidationCommandRunner(null);
    configureSwarmValidationBrowser(null);
    configureSwarmValidationAppBooter(null);
    swarmPermissionBroker.clearAll();
    chatRunRegistry.clearAll();
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(root, { recursive: true, force: true });
  }
}

async function waitFor(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.ok(check(), 'condition not reached in time');
}

type SinkWriter = { setSessionId(id: string): void; send(message: unknown): void };

/**
 * Standard fake claude runtime: plan → one implementer step; handoff emits
 * verificationTargets; validation-remediation replans return the configured
 * steps; worker returns a simple findings report.
 */
function installStandardClaudeRuntime(
  opts: { verificationTargets?: string[]; remediationSteps?: unknown[] | null } = {},
): { remediationPrompts: string[] } {
  const remediationPrompts: string[] = [];
  configureSwarmRuntimes({
    claude: async (prompt, _options, writer) => {
      const sink = writer as SinkWriter;
      sink.setSessionId(`native-${Math.random().toString(36).slice(2)}`);
      const output = prompt.includes('VALIDATION GATE FAILED')
        ? (() => {
            remediationPrompts.push(prompt);
            return JSON.stringify({ steps: opts.remediationSteps ?? [] });
          })()
        : prompt.includes('"strategy"')
          ? JSON.stringify({
              summary: 'One step plan',
              strategy: 'Single implementer wave',
              steps: [
                { id: 'w1', title: 'Make the change', kind: 'implementer', assignTo: 'Builder', wave: 1, dependsOn: [], prompt: 'Change it' },
              ],
            })
          : prompt.includes('"completed"')
            ? JSON.stringify({
                summary: 'All done.',
                completed: ['Make the change'],
                remaining: [],
                recommendations: [],
                risks: [],
                verificationTargets: opts.verificationTargets ?? ['/'],
              })
            : JSON.stringify({ summary: 'Changed.', findings: [], recommendations: [], risks: [], severity: 'info' });
      sink.send({ kind: 'stream_delta', provider: 'claude', sessionId: null, content: output });
      sink.send({ kind: 'complete', provider: 'claude', sessionId: null, exitCode: 0, success: true });
    },
  });
  return { remediationPrompts };
}

function installFakeValidationSeams(opts: {
  failScript?: string | null;
  /** Fail the failing script only this many times (default: always). */
  failTimes?: number;
  browserAvailable?: boolean;
}): { commands: string[]; capturedUrls: string[] } {
  const commands: string[] = [];
  const capturedUrls: string[] = [];
  let failCount = 0;
  configureSwarmValidationCommandRunner(async ({ command, args }) => {
    const full = `${command} ${args.join(' ')}`;
    commands.push(full);
    const failing =
      opts.failScript &&
      args.join(' ') === `run ${opts.failScript}` &&
      (opts.failTimes === undefined || failCount < opts.failTimes);
    if (failing) {
      failCount += 1;
      return { code: 1, stdout: '', stderr: `simulated ${opts.failScript} failure: src/broken.ts:1 unexpected token` };
    }
    return { code: 0, stdout: 'ok', stderr: '' };
  });
  configureSwarmValidationAppBooter(async () => ({
    ok: true,
    app: { baseUrl: 'http://127.0.0.1:59999', stop: async () => undefined, log: 'fake boot' },
  }));
  configureSwarmValidationBrowser(
    opts.browserAvailable === false
      ? async () => null
      : async () => ({
          capture: async (url: string) => {
            capturedUrls.push(url);
            return Buffer.from('fake-png');
          },
          renderPdf: async () => Buffer.from('%PDF-1.4 fake swarm report'),
          close: async () => undefined,
        }),
  );
  return { commands, capturedUrls };
}

const WORKTREE_PACKAGE_JSON = {
  name: 'fixture',
  version: '1.0.0',
  scripts: {
    lint: 'echo lint',
    test: 'echo test',
    'dev:isolated': 'echo dev',
  },
};

// ————————————————————————————————————————————————————————————————————————
// B. Pre-PR stability gate
// ————————————————————————————————————————————————————————————————————————

test('validation gate green: PR finalization runs and report artifacts are written', async () => {
  await withDatabase(async (root) => {
    setSwarmTestExecutor(null);
    const projectPath = path.join(root, 'repo');
    await mkdir(projectPath, { recursive: true });
    await initGitRepo(projectPath, WORKTREE_PACKAGE_JSON);
    const projectId = projectsDb.createProjectPath(projectPath).project!.project_id;
    installStandardClaudeRuntime({ verificationTargets: ['/settings'] });
    const seams = installFakeValidationSeams({});

    const started = swarmService.start({
      projectId,
      goal: 'Green validation gate',
      agents: [
        { kind: 'orchestrator', label: 'Lead', provider: 'claude' },
        { kind: 'implementer', label: 'Builder', provider: 'claude' },
      ],
      requireApproval: false,
      requirePlanApproval: false,
    });
    await waitFor(() => {
      const status = swarmService.get(started.swarm_id)?.status;
      return status === 'succeeded' || status === 'failed';
    });

    const done = swarmService.get(started.swarm_id)!;
    assert.equal(done.status, 'succeeded');

    // Static checks ran for defined scripts only.
    assert.ok(seams.commands.includes('npm run lint'));
    assert.ok(seams.commands.includes('npm run test'));
    assert.ok(!seams.commands.some((c) => c.includes('run typecheck')));

    // Smoke visited the orchestrator's verification target.
    assert.ok(seams.capturedUrls.some((url) => url.endsWith('/settings')), seams.capturedUrls.join(','));

    // Validation summary persisted on the handoff.
    assert.equal(done.synthesis?.validation?.passed, true);
    const checkById = new Map(done.synthesis!.validation!.checks.map((c) => [c.id, c.status]));
    assert.equal(checkById.get('static:lint'), 'passed');
    assert.equal(checkById.get('static:typecheck'), 'skipped');
    assert.equal(checkById.get('smoke:boot'), 'passed');
    assert.equal(checkById.get('report:pdf'), 'passed');

    // Report artifacts live under the PRIMARY project (survive worktree cleanup).
    const report = swarmService.validationReport(started.swarm_id)!;
    assert.ok(report.pdfPath && existsSync(report.pdfPath), 'expected report.pdf');
    assert.ok(report.htmlPath && existsSync(report.htmlPath), 'expected report.html');
    assert.ok(report.summaryPath && existsSync(report.summaryPath), 'expected summary.json');
    assert.ok(report.dir.startsWith(path.join(projectPath, 'tmp', 'cloudcli', 'swarm-reports')));
    assert.ok(existsSync(path.join(report.dir, 'screens', 'shot-01.png')));

    // Phase 4 ran: PR creation was attempted (no origin remote in the fixture,
    // so it records a prError instead of a URL — proving the gate let it pass).
    assert.ok(done.synthesis?.prError, 'expected finalizeSwarmPullRequest to have run');
  });
});

test('validation gate failure: PR is still attempted, swarm failed, interrupt raised, report exists', async () => {
  await withDatabase(async (root) => {
    setSwarmTestExecutor(null);
    const projectPath = path.join(root, 'repo');
    await mkdir(projectPath, { recursive: true });
    await initGitRepo(projectPath, WORKTREE_PACKAGE_JSON);
    const projectId = projectsDb.createProjectPath(projectPath).project!.project_id;
    installStandardClaudeRuntime();
    installFakeValidationSeams({ failScript: 'test' });

    const started = swarmService.start({
      projectId,
      goal: 'Failing validation gate',
      agents: [
        { kind: 'orchestrator', label: 'Lead', provider: 'claude' },
        { kind: 'implementer', label: 'Builder', provider: 'claude' },
      ],
      requireApproval: false,
      requirePlanApproval: false,
      validationMaxAttempts: 1,
    });
    await waitFor(() => {
      const status = swarmService.get(started.swarm_id)?.status;
      return status === 'succeeded' || status === 'failed';
    });

    const done = swarmService.get(started.swarm_id)!;
    assert.equal(done.status, 'failed');
    assert.match(done.last_error ?? '', /Pre-PR validation failed/);
    assert.equal(done.synthesis?.validation?.passed, false);

    // A red gate no longer discards the work: the publish phase DID run (there
    // is no git remote in the fixture, so it records prError instead of a URL).
    assert.ok(
      done.synthesis?.prError || done.pr_url,
      'finalizeSwarmPullRequest must run even when the gate is red',
    );

    // Interrupt points at the report.
    assert.ok(done.interrupt_id, 'expected a validation-failure interrupt');
    const interrupt = interruptsService.get(done.interrupt_id!);
    assert.equal(interrupt?.kind, 'ci_failed');
    assert.equal(interrupt?.href, `/api/swarm/${started.swarm_id}/report`);

    // Failure summary is on the blackboard and the report exists.
    assert.ok(done.blackboard.some((m) => m.content.includes('Validation FAILED')));
    assert.ok(
      done.blackboard.some((m) => m.content.includes('opening the PR anyway')),
      'the red-gate publish decision must be narrated',
    );
    const report = swarmService.validationReport(started.swarm_id)!;
    assert.ok(report.htmlPath && existsSync(report.htmlPath));
  });
});

test('validation gate failure with prOnRedValidation=false blocks the PR entirely', async () => {
  await withDatabase(async (root) => {
    setSwarmTestExecutor(null);
    const projectPath = path.join(root, 'repo');
    await mkdir(projectPath, { recursive: true });
    await initGitRepo(projectPath, WORKTREE_PACKAGE_JSON);
    const projectId = projectsDb.createProjectPath(projectPath).project!.project_id;
    installStandardClaudeRuntime();
    installFakeValidationSeams({ failScript: 'test' });

    const started = swarmService.start({
      projectId,
      goal: 'Strict block on red',
      agents: [
        { kind: 'orchestrator', label: 'Lead', provider: 'claude' },
        { kind: 'implementer', label: 'Builder', provider: 'claude' },
      ],
      requireApproval: false,
      requirePlanApproval: false,
      validationMaxAttempts: 1,
      prOnRedValidation: false,
    });
    await waitFor(() => {
      const status = swarmService.get(started.swarm_id)?.status;
      return status === 'succeeded' || status === 'failed';
    });

    const done = swarmService.get(started.swarm_id)!;
    assert.equal(done.status, 'failed');
    assert.equal(done.pr_url, null);
    assert.ok(!done.synthesis?.prError, 'finalizeSwarmPullRequest must not have run');
    assert.ok(done.interrupt_id, 'expected a validation-failure interrupt');
  });
});

test('validation gate degrades gracefully when playwright is unavailable', async () => {
  await withDatabase(async (root) => {
    setSwarmTestExecutor(null);
    const projectPath = path.join(root, 'repo');
    await mkdir(projectPath, { recursive: true });
    await initGitRepo(projectPath, WORKTREE_PACKAGE_JSON);
    const projectId = projectsDb.createProjectPath(projectPath).project!.project_id;
    installStandardClaudeRuntime();
    installFakeValidationSeams({ browserAvailable: false });

    const started = swarmService.start({
      projectId,
      goal: 'Degraded validation gate',
      agents: [
        { kind: 'orchestrator', label: 'Lead', provider: 'claude' },
        { kind: 'implementer', label: 'Builder', provider: 'claude' },
      ],
      requireApproval: false,
      requirePlanApproval: false,
    });
    await waitFor(() => {
      const status = swarmService.get(started.swarm_id)?.status;
      return status === 'succeeded' || status === 'failed';
    });

    const done = swarmService.get(started.swarm_id)!;
    // Missing tooling degrades — it must NOT fail the gate.
    assert.equal(done.status, 'succeeded');
    assert.equal(done.synthesis?.validation?.passed, true);
    assert.equal(done.synthesis?.validation?.degraded, true);
    const checkById = new Map(done.synthesis!.validation!.checks.map((c) => [c.id, c.status]));
    assert.equal(checkById.get('smoke:boot'), 'degraded');
    assert.equal(checkById.get('report:pdf'), 'degraded');
    assert.equal(checkById.get('static:lint'), 'passed');

    const report = swarmService.validationReport(started.swarm_id)!;
    assert.ok(report.htmlPath && existsSync(report.htmlPath), 'HTML fallback report expected');
    assert.equal(report.pdfPath, null);
  });
});

// ————————————————————————————————————————————————————————————————————————
// Validation remediation loop
// ————————————————————————————————————————————————————————————————————————

test('remediation loop: gate fails once, fix step runs, gate passes, PR proceeds with attempt history', async () => {
  await withDatabase(async (root) => {
    setSwarmTestExecutor(null);
    const projectPath = path.join(root, 'repo');
    await mkdir(projectPath, { recursive: true });
    await initGitRepo(projectPath, WORKTREE_PACKAGE_JSON);
    const projectId = projectsDb.createProjectPath(projectPath).project!.project_id;
    const runtime = installStandardClaudeRuntime({
      remediationSteps: [
        { id: 'fix-1', title: 'Fix failing test', kind: 'implementer', assignTo: 'Builder', prompt: 'Fix the failing test' },
      ],
    });
    // `npm run test` fails on the first gate attempt only.
    installFakeValidationSeams({ failScript: 'test', failTimes: 1 });

    const started = swarmService.start({
      projectId,
      goal: 'Remediate then pass',
      agents: [
        { kind: 'orchestrator', label: 'Lead', provider: 'claude' },
        { kind: 'implementer', label: 'Builder', provider: 'claude' },
      ],
      requireApproval: false,
      requirePlanApproval: false,
    });
    await waitFor(() => {
      const status = swarmService.get(started.swarm_id)?.status;
      return status === 'succeeded' || status === 'failed';
    }, 15_000);

    const done = swarmService.get(started.swarm_id)!;
    assert.equal(done.status, 'succeeded');

    // Attempt history recorded on the summary.
    const attempts = done.synthesis?.validation?.attempts ?? [];
    assert.equal(attempts.length, 2);
    assert.equal(attempts[0]!.passed, false);
    assert.ok(attempts[0]!.failedChecks.some((label) => label.includes('test')));
    assert.deepEqual(attempts[0]!.remediationSteps, ['Fix failing test']);
    assert.equal(attempts[1]!.passed, true);
    assert.equal(done.synthesis?.validation?.passed, true);

    // Remediation prompt carried the gate evidence and the reviewer guardrail.
    assert.equal(runtime.remediationPrompts.length, 1);
    assert.match(runtime.remediationPrompts[0]!, /simulated test failure/);
    assert.match(runtime.remediationPrompts[0]!, /reviewer-only step is NOT acceptable/i);
    const replanAttempt = swarmDb
      .listAttempts(started.swarm_id)
      .find((attempt) => attempt.phase === 'validation-replan');
    assert.ok(replanAttempt?.run_id, 'validation replan must have a canonical child run');
    assert.notEqual(replanAttempt!.run_id, 'validation-remediation-replan');
    assert.ok(runService.get(replanAttempt!.run_id!), 'validation replan child run must be persisted');

    // Narration + persisted remediation step + PR phase ran.
    const board = done.blackboard.map((m) => m.content);
    assert.ok(board.some((c) => c.includes('[validation] attempt 1 failed: test — replanning remediation')), board.join('\n'));
    assert.ok(board.some((c) => c.includes('[validation] remediation attempt 1: 1 step(s) dispatched')));
    assert.ok(board.some((c) => c.includes('[validation] attempt 2 passed')));
    const remediationStep = done.plan?.steps.find((s) => s.id === 'remediate-1-1');
    assert.equal(remediationStep?.status, 'succeeded');
    assert.ok(done.synthesis?.prError, 'expected finalizeSwarmPullRequest to have run');
  });
});

test('remediation loop: attempts exhausted still publishes (failed + PR attempt + interrupt + history)', async () => {
  await withDatabase(async (root) => {
    setSwarmTestExecutor(null);
    const projectPath = path.join(root, 'repo');
    await mkdir(projectPath, { recursive: true });
    await initGitRepo(projectPath, WORKTREE_PACKAGE_JSON);
    const projectId = projectsDb.createProjectPath(projectPath).project!.project_id;
    installStandardClaudeRuntime({
      remediationSteps: [
        { id: 'fix-1', title: 'Attempt a fix', kind: 'implementer', assignTo: 'Builder', prompt: 'Try to fix it' },
      ],
    });
    // The check keeps failing no matter what remediation runs.
    installFakeValidationSeams({ failScript: 'lint' });

    const started = swarmService.start({
      projectId,
      goal: 'Never passes validation',
      agents: [
        { kind: 'orchestrator', label: 'Lead', provider: 'claude' },
        { kind: 'implementer', label: 'Builder', provider: 'claude' },
      ],
      requireApproval: false,
      requirePlanApproval: false,
      validationMaxAttempts: 2,
    });
    await waitFor(() => {
      const status = swarmService.get(started.swarm_id)?.status;
      return status === 'succeeded' || status === 'failed';
    }, 15_000);

    const done = swarmService.get(started.swarm_id)!;
    assert.equal(done.status, 'failed');
    assert.match(done.last_error ?? '', /Pre-PR validation failed: validation failed after 2 attempt/);

    const attempts = done.synthesis?.validation?.attempts ?? [];
    assert.equal(attempts.length, 2);
    assert.equal(attempts[0]!.passed, false);
    assert.deepEqual(attempts[0]!.remediationSteps, ['Attempt a fix']);
    assert.equal(attempts[1]!.passed, false);
    assert.equal(attempts[1]!.remediationSteps, undefined);

    assert.ok(done.interrupt_id);
    const interrupt = interruptsService.get(done.interrupt_id!);
    assert.equal(interrupt?.kind, 'ci_failed');
    assert.match(interrupt?.body ?? '', /Attempts: #1 failed/);

    const board = done.blackboard.map((m) => m.content);
    assert.ok(board.some((c) => c.includes('[validation] attempt 2 failed: lint — attempt budget exhausted (2)')), board.join('\n'));
    // Exhaustion publishes rather than discards: the branch + report become the
    // input to a follow-up swarm.
    assert.ok(
      done.synthesis?.prError || done.pr_url,
      'PR phase must run after remediation is exhausted',
    );
  });
});

test('remediation loop: replan with no viable steps fails terminally with a clear reason', async () => {
  await withDatabase(async (root) => {
    setSwarmTestExecutor(null);
    const projectPath = path.join(root, 'repo');
    await mkdir(projectPath, { recursive: true });
    await initGitRepo(projectPath, WORKTREE_PACKAGE_JSON);
    const projectId = projectsDb.createProjectPath(projectPath).project!.project_id;
    // Orchestrator returns an empty remediation plan.
    installStandardClaudeRuntime({ remediationSteps: [] });
    installFakeValidationSeams({ failScript: 'test' });

    const started = swarmService.start({
      projectId,
      goal: 'Unfixable validation failure',
      agents: [
        { kind: 'orchestrator', label: 'Lead', provider: 'claude' },
        { kind: 'implementer', label: 'Builder', provider: 'claude' },
      ],
      requireApproval: false,
      requirePlanApproval: false,
    });
    await waitFor(() => {
      const status = swarmService.get(started.swarm_id)?.status;
      return status === 'succeeded' || status === 'failed';
    }, 15_000);

    const done = swarmService.get(started.swarm_id)!;
    assert.equal(done.status, 'failed');
    assert.match(done.last_error ?? '', /no viable implementer steps/);
    const attempts = done.synthesis?.validation?.attempts ?? [];
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0]!.passed, false);
    assert.ok(done.blackboard.some((m) => m.content.includes('orchestrator produced no viable implementer steps')));
    assert.ok(done.interrupt_id, 'interrupt still raised on terminal validation failure');
  });
});

test('remediation loop: validateBeforePr=false bypasses the gate entirely', async () => {
  await withDatabase(async (root) => {
    setSwarmTestExecutor(null);
    const projectPath = path.join(root, 'repo');
    await mkdir(projectPath, { recursive: true });
    await initGitRepo(projectPath, WORKTREE_PACKAGE_JSON);
    const projectId = projectsDb.createProjectPath(projectPath).project!.project_id;
    installStandardClaudeRuntime();
    // Would fail every attempt — but the gate must never run at all.
    const seams = installFakeValidationSeams({ failScript: 'lint' });

    const started = swarmService.start({
      projectId,
      goal: 'Gate opt-out',
      agents: [
        { kind: 'orchestrator', label: 'Lead', provider: 'claude' },
        { kind: 'implementer', label: 'Builder', provider: 'claude' },
      ],
      requireApproval: false,
      requirePlanApproval: false,
      validateBeforePr: false,
    });
    await waitFor(() => swarmService.get(started.swarm_id)?.status === 'succeeded');
    const done = swarmService.get(started.swarm_id)!;
    assert.equal(done.status, 'succeeded');
    assert.equal(seams.commands.length, 0, 'no validation commands may run');
    assert.equal(done.synthesis?.validation, undefined);
    assert.ok(!done.blackboard.some((m) => m.content.includes('[validation]')));
  });
});

// ————————————————————————————————————————————————————————————————————————
// A. Auto-roster from swarm-tagged agent profiles
// ————————————————————————————————————————————————————————————————————————

function installAutoRosterRuntime(planSteps: unknown[]): void {
  configureSwarmRuntimes({
    claude: async (prompt, _options, writer) => {
      const sink = writer as SinkWriter;
      sink.setSessionId(`native-${Math.random().toString(36).slice(2)}`);
      const output = prompt.includes('"strategy"')
        ? JSON.stringify({ summary: 'Auto plan', strategy: 'Profiles', steps: planSteps })
        : prompt.includes('"completed"')
          ? JSON.stringify({ summary: 'Done', completed: [], remaining: [], recommendations: [], risks: [] })
          : JSON.stringify({ summary: 'Did the step.', findings: [], recommendations: [], risks: [], severity: 'info' });
      sink.send({ kind: 'stream_delta', provider: 'claude', sessionId: null, content: output });
      sink.send({ kind: 'complete', provider: 'claude', sessionId: null, exitCode: 0, success: true });
    },
  });
}

test('auto-roster: orchestrator staffs seats from swarm-tagged profiles by profileId', async () => {
  await withDatabase(async (root) => {
    setSwarmTestExecutor(null);
    const projectPath = path.join(root, 'repo');
    await mkdir(projectPath, { recursive: true });
    await initGitRepo(projectPath);
    const projectId = projectsDb.createProjectPath(projectPath).project!.project_id;

    const scout = agentRunProfilesDb.create({
      name: 'Scout Profile',
      provider: 'claude',
      effort: 'low',
      permissionMode: 'plan',
      swarmRoles: ['explorer'],
    });
    const builder = agentRunProfilesDb.create({
      name: 'Builder Profile',
      provider: 'claude',
      model: 'claude-test-model',
      effort: 'high',
      permissionMode: 'acceptEdits',
      swarmRoles: ['implementer'],
    });

    installAutoRosterRuntime([
      { id: 's1', title: 'Explore', kind: 'explorer', wave: 1, dependsOn: [], prompt: 'Look around', profileId: scout.profile_id },
      { id: 's2', title: 'Implement', kind: 'implementer', wave: 2, dependsOn: ['s1'], prompt: 'Do it', profileId: builder.profile_id },
    ]);

    // Only a goal + orchestrator seat: auto-roster is implied.
    const started = swarmService.start({
      projectId,
      goal: 'Auto-staff the roster',
      agents: [{ kind: 'orchestrator', label: 'Lead', provider: 'claude' }],
      requireApproval: false,
      requirePlanApproval: false,
      validateBeforePr: false,
    });
    assert.equal(started.config?.autoRoster, true);

    await waitFor(() => swarmService.get(started.swarm_id)?.status === 'succeeded');
    const done = swarmService.get(started.swarm_id)!;

    // Seats persisted from the profile picks (UI roster renders these).
    const workerRoles = done.roles.filter((seat) => seat.kind !== 'orchestrator');
    assert.deepEqual(
      workerRoles.map((seat) => [seat.label, seat.kind]).sort(),
      [['Builder Profile', 'implementer'], ['Scout Profile', 'explorer']],
    );

    // Members carry the profile's provider/model/effort/permission mode.
    const builderMember = done.members!.find((m) => m.label === 'Builder Profile');
    assert.ok(builderMember);
    assert.equal(builderMember!.provider, 'claude');
    assert.equal(builderMember!.model, 'claude-test-model');
    assert.equal(builderMember!.effort, 'high');
    assert.equal(builderMember!.permission_mode, 'acceptEdits');
    assert.equal(builderMember!.status, 'succeeded');

    // Plan steps were bound to the created seats.
    assert.equal(done.plan?.steps.find((s) => s.id === 's2')?.assignTo, 'Builder Profile');
    assert.ok(done.blackboard.some((m) => m.content.includes('Auto-selected 2 seat(s)')));
  });
});

test('auto-roster: unknown profileId falls back to the first tagged candidate', async () => {
  await withDatabase(async (root) => {
    setSwarmTestExecutor(null);
    const projectPath = path.join(root, 'repo');
    await mkdir(projectPath, { recursive: true });
    await initGitRepo(projectPath);
    const projectId = projectsDb.createProjectPath(projectPath).project!.project_id;

    agentRunProfilesDb.create({
      name: 'Only Builder',
      provider: 'claude',
      permissionMode: 'acceptEdits',
      swarmRoles: ['implementer'],
    });

    installAutoRosterRuntime([
      { id: 's1', title: 'Implement', kind: 'implementer', wave: 1, dependsOn: [], prompt: 'Do it', profileId: 'profile-does-not-exist' },
    ]);

    const started = swarmService.start({
      projectId,
      goal: 'Fallback on bad profile pick',
      agents: [{ kind: 'orchestrator', label: 'Lead', provider: 'claude' }],
      requireApproval: false,
      requirePlanApproval: false,
      validateBeforePr: false,
    });
    await waitFor(() => swarmService.get(started.swarm_id)?.status === 'succeeded');
    const done = swarmService.get(started.swarm_id)!;

    assert.equal(done.plan?.steps[0]?.assignTo, 'Only Builder');
    assert.ok(
      done.blackboard.some((m) => m.content.includes('[policy]') && m.content.includes('profile-does-not-exist')),
      'expected a fallback policy note on the blackboard',
    );
  });
});

test('auto-roster: no tagged profiles falls back to the default roster seats', async () => {
  await withDatabase(async (root) => {
    setSwarmTestExecutor(null);
    const projectPath = path.join(root, 'repo');
    await mkdir(projectPath, { recursive: true });
    await initGitRepo(projectPath);
    const projectId = projectsDb.createProjectPath(projectPath).project!.project_id;
    // No agent profiles exist in this database at all.
    assert.equal(agentRunProfilesDb.list().length, 0);

    installAutoRosterRuntime([
      { id: 's1', title: 'Implement', kind: 'implementer', wave: 1, dependsOn: [], prompt: 'Do it' },
    ]);

    const started = swarmService.start({
      projectId,
      goal: 'No profiles anywhere',
      agents: [{ kind: 'orchestrator', label: 'Lead', provider: 'claude' }],
      requireApproval: false,
      requirePlanApproval: false,
      validateBeforePr: false,
    });
    await waitFor(() => swarmService.get(started.swarm_id)?.status === 'succeeded');
    const done = swarmService.get(started.swarm_id)!;

    assert.equal(done.plan?.steps[0]?.assignTo, 'Implementer');
    assert.ok(done.roles.some((seat) => seat.kind === 'implementer' && seat.label === 'Implementer'));
    assert.ok(
      done.blackboard.some((m) => m.content.includes('no swarm-tagged agent profiles')),
      'expected a default-roster fallback note',
    );
  });
});

test('manual roster path is unchanged (no auto-roster, seats created at start)', async () => {
  await withDatabase(async (root) => {
    setSwarmTestExecutor(null);
    const projectPath = path.join(root, 'repo');
    await mkdir(projectPath, { recursive: true });
    await initGitRepo(projectPath);
    const projectId = projectsDb.createProjectPath(projectPath).project!.project_id;
    // Tagged profiles exist, but a full manual roster must ignore them.
    agentRunProfilesDb.create({
      name: 'Should Not Be Used',
      provider: 'claude',
      swarmRoles: ['implementer', 'explorer', 'reviewer'],
    });
    installStandardClaudeRuntime();

    const started = swarmService.start({
      projectId,
      goal: 'Manual roster stays manual',
      agents: [
        { kind: 'orchestrator', label: 'Lead', provider: 'claude' },
        { kind: 'implementer', label: 'Builder', provider: 'claude' },
      ],
      requireApproval: false,
      requirePlanApproval: false,
      validateBeforePr: false,
    });
    assert.equal(started.config?.autoRoster, false);
    // Manual worker seats exist immediately at start (before any plan runs).
    assert.ok(started.members!.some((m) => m.label === 'Builder' && m.kind === 'implementer'));

    await waitFor(() => swarmService.get(started.swarm_id)?.status === 'succeeded');
    const done = swarmService.get(started.swarm_id)!;
    assert.ok(!done.roles.some((seat) => seat.label === 'Should Not Be Used'));
    assert.equal(done.plan?.steps[0]?.assignTo, 'Builder');
  });
});

// ————————————————————————————————————————————————————————————————————————
// Boot probe: honour the ports the dev server actually announced
// ————————————————————————————————————————————————————————————————————————

test('announcedPorts extracts the ports a dev server advertises', () => {
  // Real turbo/Next.js output: the injected PORT/VITE_PORT are ignored and the
  // app binds whatever each package hardcodes. Probing only our ports made a
  // healthy app ("Ready in 1519ms") fail as "did not answer HTTP".
  const turboLog = [
    '@app/admin:dev: > next dev -p 3020',
    '@app/admin:dev:    - Local:        http://localhost:3020',
    '@app/admin:dev:    - Network:      http://192.168.1.5:3020',
    '@app/storefront:dev:    - Local:        http://localhost:3000',
    '@app/storefront:dev: ✓ Ready in 1519ms',
  ].join('\n');
  assert.deepEqual(announcedPorts(turboLog).sort((a, b) => a - b), [3000, 3020]);

  // Plain node servers announce in prose.
  assert.deepEqual(announcedPorts('Server listening on port 8080'), [8080]);
  assert.deepEqual(announcedPorts('vite --port 5173 started'), [5173]);
  // Nothing to find stays empty rather than guessing.
  assert.deepEqual(announcedPorts('compiling...\nno server here'), []);
  // Out-of-range numbers are ignored.
  assert.deepEqual(announcedPorts('listening on port 99999'), []);
});

test('boot probe finds an app on an announced port it was not told about', async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  const realPort = typeof address === 'object' && address ? address.port : 0;
  assert.ok(realPort > 0);

  const root = await makeScratchDir('swarm-boot-probe-');
  try {
    // A "dev script" that ignores the injected ports and only announces its own.
    await writeFile(
      path.join(root, 'package.json'),
      `${JSON.stringify(
        {
          name: 'announcer',
          scripts: { dev: `node -e "console.log('  - Local: http://localhost:${realPort}'); setInterval(() => {}, 1000)"` },
        },
        null,
        2,
      )}\n`,
    );

    const boot = await defaultSwarmValidationAppBooter({
      cwd: root,
      script: 'dev',
      timeoutMs: 20_000,
      workspaceTmpDir: path.join(root, 'tmp'),
    });
    assert.equal(boot.ok, true, boot.ok ? '' : boot.error);
    if (boot.ok) {
      assert.equal(boot.app.baseUrl, `http://127.0.0.1:${realPort}`);
      await boot.app.stop();
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
