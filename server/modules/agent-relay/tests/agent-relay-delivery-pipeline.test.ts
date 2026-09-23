import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import {
  agentRelayService,
  configureAgentRelayRuntimes,
  configureRelayPermissionResolver,
} from '@/modules/agent-relay/index.js';
import { relayDeliveryService } from '@/modules/agent-relay/relay-delivery.service.js';
import { appConfigDb, closeConnection, initializeDatabase, projectsDb, sessionsDb } from '@/modules/database/index.js';
import { workspaceService } from '@/modules/workspaces/index.js';
import { chatRunRegistry } from '@/modules/websocket/index.js';
import { makeScratchDir } from '@/shared/scratch.js';

type RelayWriter = {
  setSessionId: (sessionId: string) => void;
  send: (message: unknown) => void;
};

function git(cwd: string, ...args: string[]) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return { status: result.status, stdout: String(result.stdout ?? '').trim() };
}

function relaySettings(overrides: Record<string, unknown> = {}): void {
  appConfigDb.set('agent_relay.settings', JSON.stringify({
    enabled: true,
    leadProviders: ['claude'],
    workerProviders: ['claude'],
    maxConcurrency: 4,
    defaultTimeoutMs: 60_000,
    defaultMode: 'isolated_write',
    installSkill: false,
    ...overrides,
  }));
}

async function withGitProject(run: (projectPath: string) => Promise<void>): Promise<void> {
  const previous = process.env.DATABASE_PATH;
  const root = await makeScratchDir('agent-relay-delivery-');
  const projectPath = path.join(root, 'project');
  closeConnection();
  process.env.DATABASE_PATH = path.join(root, 'auth.db');
  await initializeDatabase();
  await mkdir(projectPath, { recursive: true });
  git(projectPath, 'init', '-q', '-b', 'main');
  git(projectPath, 'config', 'user.email', 'relay@example.com');
  git(projectPath, 'config', 'user.name', 'Relay Test');
  await writeFile(path.join(projectPath, 'app.txt'), 'app base\n');
  await writeFile(path.join(projectPath, 'notes.txt'), 'notes base\n');
  await writeFile(path.join(projectPath, '.gitignore'), 'tmp/\n');
  git(projectPath, 'add', '.');
  git(projectPath, 'commit', '-qm', 'init');
  try {
    await run(projectPath);
  } finally {
    configureAgentRelayRuntimes({}, {});
    configureRelayPermissionResolver(null);
    chatRunRegistry.clearAll();
    closeConnection();
    if (previous === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previous;
    await rm(root, { recursive: true, force: true });
  }
}

async function until<T>(read: () => T | Promise<T>, done: (value: T) => boolean, attempts = 400): Promise<T> {
  let value = await read();
  for (let i = 0; i < attempts && !done(value); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    value = await read();
  }
  return value;
}

/**
 * Scratch projects under tmp/cloudcli are rehomed to the logical checkout for
 * session ownership, so lead-owned (read-only, never-finishing) jobs are
 * submitted against it, exactly as the orchestration tests do.
 */
function leadSession(): { id: string; projectPath: string } {
  const logical = projectsDb.createProjectPath(process.cwd()).project!.project_path;
  const id = `lead-${Date.now()}`;
  sessionsDb.createAppSession(id, 'claude', logical, { permissionMode: 'default' });
  return { id, projectPath: logical };
}

test('writer → auto-commit → auto verify → auto rehearse → land onto a dirty primary', async () => {
  await withGitProject(async (projectPath) => {
    relaySettings();
    configureAgentRelayRuntimes({
      claude: async (_command, options, writer) => {
        const relayWriter = writer as RelayWriter;
        relayWriter.setSessionId(`worker-${Date.now()}`);
        // The worker edits but "forgets" to commit.
        await writeFile(path.join(String(options.cwd), 'app.txt'), 'app by worker\n');
        relayWriter.send({
          kind: 'text',
          provider: 'claude',
          content: '<agent_relay_result>{"status":"completed","summary":"Updated app","evidence":[],"filesTouched":["app.txt"],"testsRun":[],"openQuestions":[]}</agent_relay_result>',
        });
        relayWriter.send({ kind: 'complete', provider: 'claude', exitCode: 0, success: true });
      },
    }, {});

    // The operator has unrelated uncommitted work in the primary.
    await writeFile(path.join(projectPath, 'notes.txt'), 'operator wip\n');

    const submitted = await agentRelayService.submitBatch({
      projectPath,
      tasks: [{ task: 'Update app.txt', provider: 'claude', mode: 'isolated_write', label: 'impl:app' }],
    });
    const relayId = submitted.jobs[0]!.relay_id;
    const finished = await until(() => agentRelayService.get(relayId), (job) => job?.status === 'completed');
    assert.equal(finished?.status, 'completed');

    const workspace = workspaceService.get(finished!.workspace_id!)!;
    assert.equal(git(workspace.root_path, 'status', '--porcelain').stdout, '', 'leftover edits were committed by the host');

    const state = await until(
      () => relayDeliveryService.deliveryState(agentRelayService.get(relayId)!),
      (value) => value?.stage === 'ready_to_land' || value?.stage === 'rehearsal_failed' || value?.stage === 'verify_failed',
    );
    assert.equal(state?.stage, 'ready_to_land');
    assert.equal(agentRelayService.summarize(agentRelayService.get(relayId)!).delivery?.stage, 'ready_to_land');

    const landed = await relayDeliveryService.land({ rehearsalId: state!.rehearsalId!, scope: { allowUnscoped: true } });
    const entry = landed.landed[0]!;
    assert.ok('commitSha' in entry && entry.commitSha, 'the worker change was committed on the primary');
    assert.equal(await readFile(path.join(projectPath, 'app.txt'), 'utf8'), 'app by worker\n');
    assert.equal(await readFile(path.join(projectPath, 'notes.txt'), 'utf8'), 'operator wip\n', 'operator work untouched');
    assert.deepEqual(git(projectPath, 'show', '--name-only', '--format=', 'HEAD').stdout.split('\n'), ['app.txt']);
    assert.equal(workspaceService.get(workspace.workspace_id)?.status, 'discarded', 'landed worktree is cleaned up');
    assert.equal(relayDeliveryService.deliveryState(agentRelayService.get(relayId)!)?.stage, 'landed');
  });
});

test('a lead cannot pick manual approval unless the operator allows it', async () => {
  await withGitProject(async () => {
    relaySettings({ defaultMode: 'read_only' });
    configureAgentRelayRuntimes({ claude: async () => new Promise(() => undefined) }, {});
    const lead = leadSession();
    const blocked = await agentRelayService.submitBatch({
      projectPath: lead.projectPath,
      sourceSessionId: lead.id,
      tasks: [{ task: 'inspect', provider: 'claude', mode: 'read_only', approvalPolicy: 'manual' }],
    });
    assert.equal(blocked.jobs[0]!.approval_policy, 'auto');
    assert.match(blocked.warnings[0] ?? '', /reserved for the operator/);

    relaySettings({ defaultMode: 'read_only', allowLeadManualApproval: true });
    const allowed = await agentRelayService.submitBatch({
      projectPath: lead.projectPath,
      sourceSessionId: lead.id,
      tasks: [{ task: 'inspect', provider: 'claude', mode: 'read_only', approvalPolicy: 'manual' }],
    });
    assert.equal(allowed.jobs[0]!.approval_policy, 'manual');
    assert.equal(allowed.warnings.length, 0);
    for (const job of [...blocked.jobs, ...allowed.jobs]) await agentRelayService.cancel(job.relay_id).catch(() => undefined);
  });
});

test('denied worker actions are recorded and returned to the lead; blocked is a status', async () => {
  await withGitProject(async (projectPath) => {
    relaySettings();
    const decisions: Array<{ requestId: string; allow: boolean }> = [];
    configureRelayPermissionResolver((requestId, decision) => decisions.push({ requestId, allow: decision.allow }));
    configureAgentRelayRuntimes({
      claude: async (_command, _options, writer) => {
        const relayWriter = writer as RelayWriter;
        relayWriter.setSessionId(`worker-deny-${Date.now()}`);
        relayWriter.send({
          kind: 'permission_request',
          provider: 'claude',
          requestId: 'req-push-1',
          toolName: 'Bash',
          input: { command: 'git push origin main' },
        });
        await new Promise((resolve) => setTimeout(resolve, 150));
        relayWriter.send({
          kind: 'text',
          provider: 'claude',
          content: '<agent_relay_result>{"status":"blocked","summary":"Push is for the lead","evidence":[],"filesTouched":[],"testsRun":[],"openQuestions":["Push the branch after review"]}</agent_relay_result>',
        });
        relayWriter.send({ kind: 'complete', provider: 'claude', exitCode: 0, success: true });
      },
    }, {});
    const submitted = await agentRelayService.submitBatch({
      projectPath,
      tasks: [{ task: 'Try to publish', provider: 'claude', mode: 'isolated_write' }],
    });
    const relayId = submitted.jobs[0]!.relay_id;
    const finished = await until(() => agentRelayService.get(relayId), (job) => Boolean(job && ['blocked', 'completed', 'failed'].includes(job.status)));
    assert.equal(finished?.status, 'blocked');
    assert.deepEqual(decisions, [{ requestId: 'req-push-1', allow: false }]);
    const summary = agentRelayService.summarize(finished!);
    assert.equal(summary.deniedActions.length, 1);
    assert.match(summary.deniedActions[0]!.command ?? '', /git push/);
  });
});

test('a dependent writer builds on its predecessor and the final stage lands the whole pipeline', async () => {
  await withGitProject(async (projectPath) => {
    relaySettings();
    const sawPredecessor: boolean[] = [];
    configureAgentRelayRuntimes({
      claude: async (command, options, writer) => {
        const relayWriter = writer as RelayWriter;
        relayWriter.setSessionId(`worker-stack-${Date.now()}-${Math.random()}`);
        const cwd = String(options.cwd);
        if (command.includes('STAGE-ONE')) {
          await writeFile(path.join(cwd, 'stage1.txt'), 'one\n');
        } else {
          sawPredecessor.push(await readFile(path.join(cwd, 'stage1.txt'), 'utf8').then(() => true, () => false));
          await writeFile(path.join(cwd, 'stage2.txt'), 'two\n');
        }
        relayWriter.send({
          kind: 'text',
          provider: 'claude',
          content: '<agent_relay_result>{"status":"completed","summary":"stage done","evidence":[],"filesTouched":[],"testsRun":[],"openQuestions":[]}</agent_relay_result>',
        });
        relayWriter.send({ kind: 'complete', provider: 'claude', exitCode: 0, success: true });
      },
    }, {});
    const submitted = await agentRelayService.submitBatch({
      projectPath,
      tasks: [
        { task: 'STAGE-ONE write stage1', provider: 'claude', mode: 'isolated_write', label: 'stage:1' },
        { task: 'STAGE-TWO build on stage1', provider: 'claude', mode: 'isolated_write', label: 'stage:2', dependsOn: [0] },
      ],
    });
    const [first, second] = submitted.jobs.map((job) => job.relay_id);
    const state = await until(
      () => relayDeliveryService.deliveryState(agentRelayService.get(second!)!),
      (value) => ['ready_to_land', 'rehearsal_failed', 'verify_failed'].includes(value?.stage ?? ''),
    );
    assert.deepEqual(sawPredecessor, [true], 'stage two started from stage one\'s tip');
    assert.equal(state?.stage, 'ready_to_land');
    assert.equal(relayDeliveryService.deliveryState(agentRelayService.get(first!)!)?.stage, 'verified', 'only the leaf is rehearsed');
    await relayDeliveryService.land({ rehearsalId: state!.rehearsalId!, scope: { allowUnscoped: true } });
    assert.equal(await readFile(path.join(projectPath, 'stage1.txt'), 'utf8'), 'one\n');
    assert.equal(await readFile(path.join(projectPath, 'stage2.txt'), 'utf8'), 'two\n');
  });
});

test('a usage-limit failure fails over to the next authenticated provider', async (t) => {
  const { providerAuthService } = await import('@/modules/providers/index.js');
  const codexAuth = await providerAuthService.getProviderAuthStatus('codex').catch(() => null);
  if (!codexAuth?.installed || !codexAuth.authenticated) {
    t.skip('codex is not installed/authenticated on this machine');
    return;
  }
  await withGitProject(async (projectPath) => {
    relaySettings({ workerProviders: ['claude', 'codex'], defaultMode: 'read_only' });
    const ran: string[] = [];
    configureAgentRelayRuntimes({
      claude: async (_command, _options, writer) => {
        ran.push('claude');
        const relayWriter = writer as RelayWriter;
        relayWriter.setSessionId(`claude-${Date.now()}`);
        relayWriter.send({ kind: 'error', provider: 'claude', content: "You've hit your usage limit. Try again at 4:39 PM." });
        relayWriter.send({ kind: 'complete', provider: 'claude', exitCode: 1, success: false });
      },
      codex: async (_command, _options, writer) => {
        ran.push('codex');
        const relayWriter = writer as RelayWriter;
        relayWriter.setSessionId(`codex-${Date.now()}`);
        relayWriter.send({
          kind: 'text',
          provider: 'codex',
          content: '<agent_relay_result>{"status":"completed","summary":"answered by codex","evidence":[],"filesTouched":[],"testsRun":[],"openQuestions":[]}</agent_relay_result>',
        });
        relayWriter.send({ kind: 'complete', provider: 'codex', exitCode: 0, success: true });
      },
    }, {});
    const submitted = await agentRelayService.submitBatch({
      projectPath,
      tasks: [{ task: 'Explain the module', provider: 'claude', mode: 'read_only' }],
    });
    const relayId = submitted.jobs[0]!.relay_id;
    const finished = await until(() => agentRelayService.get(relayId), (job) => job?.status === 'completed' || job?.status === 'failed');
    assert.deepEqual(ran, ['claude', 'codex']);
    assert.equal(finished?.status, 'completed');
    assert.equal(finished?.provider, 'codex');
    assert.equal(finished?.failovers.length, 1);
    assert.equal(finished?.failovers[0]?.failure, 'quota');
  });
});

test('a provider turn that ends on a sandbox denial is resumed instead of failing the job', async () => {
  await withGitProject(async (projectPath) => {
    relaySettings();
    configureRelayPermissionResolver(() => undefined);
    let calls = 0;
    configureAgentRelayRuntimes({
      claude: async (_command, _options, writer) => {
        calls += 1;
        const relayWriter = writer as RelayWriter;
        relayWriter.setSessionId('worker-denial-resume');
        if (calls === 1) {
          relayWriter.send({ kind: 'permission_request', provider: 'claude', requestId: 'req-push-resume', toolName: 'Bash', input: { command: 'git push origin main' } });
          await new Promise((resolve) => setTimeout(resolve, 150));
          relayWriter.send({ kind: 'error', provider: 'claude', content: 'Grok tool permission was denied for "run_terminal_command": Agent Relay denied this request: sandbox boundary' });
          relayWriter.send({ kind: 'complete', provider: 'claude', exitCode: 1, success: false });
          return;
        }
        relayWriter.send({
          kind: 'text',
          provider: 'claude',
          content: '<agent_relay_result>{"status":"completed","summary":"finished after resume","evidence":[],"filesTouched":[],"testsRun":[],"openQuestions":["push for the lead"]}</agent_relay_result>',
        });
        relayWriter.send({ kind: 'complete', provider: 'claude', exitCode: 0, success: true });
      },
    }, {});
    const submitted = await agentRelayService.submitBatch({
      projectPath,
      tasks: [{ task: 'Do work then push', provider: 'claude', mode: 'isolated_write' }],
    });
    const relayId = submitted.jobs[0]!.relay_id;
    const finished = await until(() => agentRelayService.get(relayId), (job) => Boolean(job && ['completed', 'failed', 'blocked'].includes(job.status)));
    assert.equal(calls, 2, 'the worker session was resumed once');
    assert.equal(finished?.status, 'completed');
    assert.equal(finished?.denied_actions.length, 1);
  });
});
