import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { agentRelayService, configureAgentRelayRuntimes } from '@/modules/agent-relay/index.js';
import {
  configureAgentRelayLeadWake,
  notifyAgentRelayTerminal,
} from '@/modules/agent-relay/lead-session-wake.service.js';
import type { AgentRelayJob } from '@/modules/agent-relay/agent-relay.types.js';
import { appConfigDb, closeConnection, initializeDatabase, projectsDb, sessionsDb } from '@/modules/database/index.js';
import { chatRunRegistry, DETACHED_CONNECTION, startProviderRun } from '@/modules/websocket/index.js';
import { makeScratchDir } from '@/shared/scratch.js';

type RelayWriter = {
  setSessionId: (sessionId: string) => void;
  send: (message: unknown) => void;
};

class FakeConnection {
  readyState = 1;
  frames: Array<Record<string, unknown>> = [];

  send(data: string): void {
    this.frames.push(JSON.parse(data) as Record<string, unknown>);
  }
}

function relaySettings(): void {
  appConfigDb.set('agent_relay.settings', JSON.stringify({
    enabled: true,
    leadProviders: ['claude'],
    workerProviders: ['claude'],
    maxConcurrency: 1,
    defaultTimeoutMs: 60_000,
    defaultMode: 'read_only',
    installSkill: true,
  }));
}

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 320; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(message);
}

async function createLeadFixture(prefix: string): Promise<{
  leadSessionId: string;
  logicalProjectPath: string;
  cleanup: () => Promise<void>;
}> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const root = await makeScratchDir(prefix);
  const projectPath = path.join(root, 'project');
  await mkdir(projectPath, { recursive: true });
  closeConnection();
  process.env.DATABASE_PATH = path.join(root, 'auth.db');
  await initializeDatabase();

  const leadSessionId = `${prefix}-lead`;
  const logicalProjectPath = projectsDb.createProjectPath(process.cwd()).project!.project_path;
  sessionsDb.createAppSession(leadSessionId, 'claude', logicalProjectPath, { permissionMode: 'default' });

  return {
    leadSessionId,
    logicalProjectPath,
    cleanup: async () => {
      configureAgentRelayLeadWake({});
      chatRunRegistry.clearAll();
      closeConnection();
      if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
      else process.env.DATABASE_PATH = previousDatabasePath;
      await rm(root, { recursive: true, force: true });
    },
  };
}

function terminalJob(leadSessionId: string, relayId: string, overrides: Partial<AgentRelayJob> = {}): AgentRelayJob {
  return {
    relay_id: relayId,
    batch_id: 'batch-wake-test',
    project_id: 'project-wake-test',
    project_path: process.cwd(),
    source_session_id: leadSessionId,
    app_session_id: leadSessionId,
    run_id: null,
    workspace_id: null,
    provider: 'claude',
    model: null,
    requested_model: null,
    model_label: null,
    catalog_default_model: null,
    catalog_resolved_model: null,
    runtime_resolved_model: null,
    model_selection_source: null,
    effort: null,
    mode: 'read_only',
    approval_policy: 'auto',
    status: 'completed',
    label: null,
    task: 'wake test task',
    last_prompt: 'wake test task',
    pending_follow_up: null,
    mcp_servers: [],
    output_schema: null,
    depends_on: [],
    retries: 0,
    retry_count: 0,
    schema_retry_count: 0,
    result: null,
    error: null,
    timeout_ms: 60_000,
    attempt: 1,
    created_at: new Date().toISOString(),
    started_at: null,
    finished_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

test('a completed relay wakes an idle lead and keeps its browser stream attached', async () => {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const root = await makeScratchDir('agent-relay-lead-wake-');
  const projectPath = path.join(root, 'project');
  await mkdir(projectPath, { recursive: true });
  closeConnection();
  process.env.DATABASE_PATH = path.join(root, 'auth.db');
  await initializeDatabase();

  const leadSessionId = 'lead-session-wake';
  const logicalProjectPath = projectsDb.createProjectPath(process.cwd()).project!.project_path;
  sessionsDb.createAppSession(leadSessionId, 'claude', logicalProjectPath, { permissionMode: 'default' });
  const connection = new FakeConnection();
  let wakeWriter: RelayWriter | null = null;
  let releaseWake = () => {};
  let wakeStarted = false;

  try {
    // Establish the lead's first turn so the wake-up must resume its existing
    // provider transcript and can prove that the old browser socket survives.
    const firstLead = await startProviderRun({
      appSessionId: leadSessionId,
      provider: 'claude',
      providerSessionId: null,
      projectPath: logicalProjectPath,
      spawnFn: async (_command, _options, writer) => {
        const relayWriter = writer as RelayWriter;
        relayWriter.setSessionId('lead-native-wake');
        relayWriter.send({ kind: 'complete', provider: 'claude', exitCode: 0, success: true });
      },
      content: 'initial lead turn',
      options: {},
      connection,
      userId: null,
    });
    if (!firstLead.ok) throw new Error('The initial lead run did not start.');
    await firstLead.completion;

    relaySettings();
    const runtime = async (command: string, options: Record<string, unknown>, writer: unknown) => {
      const relayWriter = writer as RelayWriter;
      if (options.relayWorker === true) {
        relayWriter.setSessionId('worker-native-wake');
        relayWriter.send({ kind: 'complete', provider: 'claude', exitCode: 0, success: true });
        return;
      }

      assert.match(command, /Agent Relay notification/);
      assert.equal(options.appSessionId, leadSessionId);
      assert.equal(options.sessionId, 'lead-native-wake');
      assert.equal(options.resume, true);
      assert.equal(options.permissionMode, 'default');
      wakeWriter = relayWriter;
      wakeStarted = true;
      await new Promise<void>((resolve) => {
        releaseWake = resolve;
      });
      relayWriter.send({ kind: 'text', provider: 'claude', content: 'harvested relay result' });
      relayWriter.send({ kind: 'complete', provider: 'claude', exitCode: 0, success: true });
    };
    configureAgentRelayRuntimes({ claude: runtime }, {});
    configureAgentRelayLeadWake({ claude: runtime });

    const submitted = await agentRelayService.submitBatch({
      projectPath: logicalProjectPath,
      sourceSessionId: leadSessionId,
      tasks: [{ task: 'Finish the bounded worker task.', provider: 'claude' }],
    });
    const relayId = submitted.jobs[0]!.relay_id;
    const waited = await agentRelayService.wait([relayId], { returnWhen: 'all', timeoutMs: 5_000 });
    assert.equal(waited.jobs[0]?.status, 'completed');

    await waitFor(() => wakeStarted, 'relay completion did not wake the idle lead');
    assert.equal(chatRunRegistry.isProcessing(leadSessionId), true);
    assert.ok(wakeWriter);
    assert.equal(connection.frames.some((frame) => frame.kind === 'text' && frame.content === 'harvested relay result'), false);

    releaseWake();
    await waitFor(() => chatRunRegistry.isProcessing(leadSessionId) === false, 'lead wake did not finish');
    assert.equal(connection.frames.some((frame) => frame.kind === 'text' && frame.content === 'harvested relay result'), true);
  } finally {
    releaseWake();
    configureAgentRelayLeadWake({});
    configureAgentRelayRuntimes({}, {});
    chatRunRegistry.clearAll();
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(root, { recursive: true, force: true });
  }
});

test('a terminal notification does not inject a prompt while the lead is processing', { concurrency: false }, async () => {
  const fixture = await createLeadFixture('agent-relay-lead-processing-');
  let releaseLead = () => {};
  let wakeCalls = 0;

  try {
    const activeLead = await startProviderRun({
      appSessionId: fixture.leadSessionId,
      provider: 'claude',
      providerSessionId: null,
      projectPath: fixture.logicalProjectPath,
      spawnFn: async (_command, _options, writer) => {
        await new Promise<void>((resolve) => {
          releaseLead = () => {
            (writer as RelayWriter).send({ kind: 'complete', provider: 'claude', exitCode: 0, success: true });
            resolve();
          };
        });
      },
      content: 'active lead turn',
      options: {},
      connection: DETACHED_CONNECTION,
      userId: null,
    });
    if (!activeLead.ok) throw new Error('The active lead run did not start.');

    configureAgentRelayLeadWake({
      claude: async () => {
        wakeCalls += 1;
      },
    });
    notifyAgentRelayTerminal(terminalJob(fixture.leadSessionId, 'relay-processing', { status: 'failed' }));
    await new Promise((resolve) => setTimeout(resolve, 2_100));
    assert.equal(wakeCalls, 0);

    releaseLead();
    await activeLead.completion;
  } finally {
    releaseLead();
    await fixture.cleanup();
  }
});

test('cancelled workers still wake an idle lead', { concurrency: false }, async () => {
  const fixture = await createLeadFixture('agent-relay-lead-cancelled-');
  let wakePrompt = '';

  try {
    configureAgentRelayLeadWake({
      claude: async (command, _options, writer) => {
        wakePrompt = command;
        (writer as RelayWriter).send({ kind: 'complete', provider: 'claude', exitCode: 0, success: true });
      },
    });
    notifyAgentRelayTerminal(terminalJob(fixture.leadSessionId, 'relay-cancelled', {
      label: 'Cancelled worker',
      status: 'cancelled',
    }));

    await waitFor(() => wakePrompt.length > 0, 'cancelled relay did not wake the idle lead');
    assert.match(wakePrompt, /Cancelled worker/);
    assert.match(wakePrompt, /relay-cancelled/);
    assert.match(wakePrompt, /cancelled/);
  } finally {
    await fixture.cleanup();
  }
});

test('terminal worker notifications coalesce into one lead wake with a summary', { concurrency: false }, async () => {
  const fixture = await createLeadFixture('agent-relay-lead-coalesce-');
  let wakeCalls = 0;
  let wakePrompt = '';

  try {
    configureAgentRelayLeadWake({
      claude: async (command, _options, writer) => {
        wakeCalls += 1;
        wakePrompt = command;
        (writer as RelayWriter).send({ kind: 'complete', provider: 'claude', exitCode: 0, success: true });
      },
    });
    notifyAgentRelayTerminal(terminalJob(fixture.leadSessionId, 'relay-one', {
      label: 'First worker',
    }));
    notifyAgentRelayTerminal(terminalJob(fixture.leadSessionId, 'relay-two', {
      label: 'Second worker',
      status: 'failed',
    }));
    notifyAgentRelayTerminal(terminalJob(fixture.leadSessionId, 'relay-three', {
      label: 'Blocked worker',
      result: { status: 'blocked', summary: 'blocked', evidence: [], filesTouched: [], testsRun: [], openQuestions: [], output: '' },
    }));

    await waitFor(() => wakeCalls === 1, 'terminal relay burst did not produce one lead wake');
    assert.match(wakePrompt, /First worker \(relay-one\): completed/);
    assert.match(wakePrompt, /Second worker \(relay-two\): failed/);
    assert.match(wakePrompt, /Blocked worker \(relay-three\): blocked/);
    await new Promise((resolve) => setTimeout(resolve, 350));
    assert.equal(wakeCalls, 1);
  } finally {
    await fixture.cleanup();
  }
});
