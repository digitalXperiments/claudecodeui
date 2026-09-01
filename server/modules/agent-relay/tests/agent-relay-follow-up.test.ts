import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { agentRelayService, configureAgentRelayRuntimes, parseStructuredResult } from '@/modules/agent-relay/index.js';
import { appConfigDb, closeConnection, initializeDatabase } from '@/modules/database/index.js';
import { chatRunRegistry } from '@/modules/websocket/index.js';
import { makeScratchDir } from '@/shared/scratch.js';

type RelayWriter = {
  setSessionId: (sessionId: string) => void;
  send: (message: unknown) => void;
};

function relaySettings(overrides: Record<string, unknown> = {}): void {
  appConfigDb.set('agent_relay.settings', JSON.stringify({
    enabled: true,
    leadProviders: ['claude'],
    workerProviders: ['claude'],
    maxConcurrency: 4,
    defaultTimeoutMs: 60_000,
    defaultMode: 'read_only',
    installSkill: false,
    ...overrides,
  }));
}

async function withRelayDb(run: (projectPath: string) => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const root = await makeScratchDir('agent-relay-followup-');
  const projectPath = path.join(root, 'project');
  closeConnection();
  process.env.DATABASE_PATH = path.join(root, 'auth.db');
  await initializeDatabase();
  await mkdir(projectPath, { recursive: true });
  try {
    await run(projectPath);
  } finally {
    configureAgentRelayRuntimes({}, {});
    chatRunRegistry.clearAll();
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(root, { recursive: true, force: true });
  }
}

async function waitForStatus(relayId: string, status: string, attempts = 80): Promise<void> {
  for (let i = 0; i < attempts && agentRelayService.get(relayId)?.status !== status; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(agentRelayService.get(relayId)?.status, status, `expected relay to reach status "${status}"`);
}

test('relay_follow_up injects into a live running worker instead of waiting for completion', async () => {
  await withRelayDb(async (projectPath) => {
    relaySettings();

    let callCount = 0;
    const injected: Array<{ content: string }> = [];
    const release: { run: (() => void) | null } = { run: null };

    configureAgentRelayRuntimes(
      {
        claude: async (_command, _options, writer) => {
          callCount += 1;
          const relayWriter = writer as RelayWriter;
          relayWriter.setSessionId('relay-live-1');
          await new Promise<void>((resolve) => { release.run = resolve; });
          relayWriter.send({
            kind: 'text',
            provider: 'claude',
            content: '<agent_relay_result>{"status":"completed","summary":"Done after follow-up","evidence":[],"filesTouched":[],"testsRun":[],"openQuestions":[]}</agent_relay_result>',
          });
          relayWriter.send({ kind: 'complete', provider: 'claude', exitCode: 0, success: true });
        },
      },
      {},
      {
        claude: async (command) => {
          injected.push({ content: command });
          return true;
        },
      },
    );

    const submitted = await agentRelayService.submitBatch({
      projectPath,
      tasks: [{ task: 'Investigate the failing test.', provider: 'claude' }],
    });
    const relayId = submitted.jobs[0]!.relay_id;
    await waitForStatus(relayId, 'running');

    const followed = await agentRelayService.followUp(relayId, 'Also check the retry path.');
    // Injection happened in place: still the same running attempt, not a new one.
    assert.equal(followed.status, 'running');
    assert.equal(followed.attempt, 1);
    assert.equal(followed.pending_follow_up, null);
    assert.equal(injected.length, 1);
    assert.match(injected[0]!.content, /Also check the retry path\./);
    // Injection must not spawn a second worker process.
    assert.equal(callCount, 1);

    release.run?.();
    const waited = await agentRelayService.wait([relayId], { returnWhen: 'all', timeoutMs: 5_000 });
    assert.equal(waited.jobs[0]?.status, 'completed');
    assert.equal(waited.jobs[0]?.attempt, 1);
    assert.equal(callCount, 1);
  });
});

test('relay_follow_up queues for the next turn when the provider has no live injection hook', async () => {
  await withRelayDb(async (projectPath) => {
    relaySettings({ workerProviders: ['codex'], leadProviders: ['codex'] });

    let callCount = 0;
    const release: { run: (() => void) | null } = { run: null };

    configureAgentRelayRuntimes({
      codex: async (_command, _options, writer) => {
        callCount += 1;
        const relayWriter = writer as RelayWriter;
        relayWriter.setSessionId(`relay-codex-${callCount}`);
        if (callCount === 1) {
          await new Promise<void>((resolve) => { release.run = resolve; });
        }
        relayWriter.send({
          kind: 'text',
          provider: 'codex',
          content: `<agent_relay_result>{"status":"completed","summary":"Attempt ${callCount}","evidence":[],"filesTouched":[],"testsRun":[],"openQuestions":[]}</agent_relay_result>`,
        });
        relayWriter.send({ kind: 'complete', provider: 'codex', exitCode: 0, success: true });
      },
    }, {});

    const submitted = await agentRelayService.submitBatch({
      projectPath,
      tasks: [{ task: 'Investigate the flaky test.', provider: 'codex' }],
    });
    const relayId = submitted.jobs[0]!.relay_id;
    await waitForStatus(relayId, 'running');

    const followed = await agentRelayService.followUp(relayId, 'Also confirm the fix on CI.');
    // No live inject hook for codex: the prompt is held, not lost, and the
    // lead does not have to wait for the current turn to finish.
    assert.equal(followed.status, 'running');
    assert.equal(followed.pending_follow_up, 'Also confirm the fix on CI.');
    assert.equal(callCount, 1);

    release.run?.();
    // The pending follow-up should be picked up as the very next attempt,
    // without the lead calling relay_follow_up again.
    for (let i = 0; i < 80 && agentRelayService.get(relayId)?.attempt !== 2; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const waited = await agentRelayService.wait([relayId], { returnWhen: 'all', timeoutMs: 5_000 });
    assert.equal(waited.jobs[0]?.status, 'completed');
    assert.equal(waited.jobs[0]?.attempt, 2);
    assert.equal(waited.jobs[0]?.pending_follow_up, null);
    assert.equal(waited.jobs[0]?.result?.summary, 'Attempt 2');
    assert.equal(callCount, 2);
  });
});

test('relay_follow_up on a queued job merges directly into its first attempt prompt', async () => {
  await withRelayDb(async (projectPath) => {
    // Disabled so submitted jobs stay queued instead of dispatching.
    relaySettings({ enabled: false });

    const submitted = await agentRelayService.submitBatch({
      projectPath,
      tasks: [{ task: 'Investigate the failing test.', provider: 'claude' }],
    });
    const relayId = submitted.jobs[0]!.relay_id;
    assert.equal(agentRelayService.get(relayId)?.status, 'queued');

    const followed = await agentRelayService.followUp(relayId, 'Focus on the retry path first.');
    assert.equal(followed.status, 'queued');
    assert.equal(followed.pending_follow_up, null);
    assert.match(followed.last_prompt, /Focus on the retry path first\./);
  });
});

test('parseStructuredResult recovers tagged JSON wrapped in a markdown fence', () => {
  const output = [
    'Investigated the failing test.',
    '<agent_relay_result>',
    '```json',
    '{"status":"completed","summary":"Fixed the off-by-one","evidence":["src/a.ts:4"],"filesTouched":["src/a.ts"],"testsRun":["npm test"],"openQuestions":[]}',
    '```',
    '</agent_relay_result>',
  ].join('\n');
  const parsed = parseStructuredResult(output, false);
  assert.equal(parsed.contract, 'valid');
  assert.equal(parsed.result.summary, 'Fixed the off-by-one');
  assert.deepEqual(parsed.result.evidence, ['src/a.ts:4']);
});

test('parseStructuredResult recovers a trailing JSON object when the tag is missing', () => {
  const output = [
    'I looked into this and found the cause.',
    'Here is my answer:',
    '{"status":"completed","summary":"Root cause is the parser","evidence":["src/parser.ts:10"],"filesTouched":[],"testsRun":[],"openQuestions":[]}',
  ].join('\n');
  const parsed = parseStructuredResult(output, false);
  assert.equal(parsed.contract, 'valid');
  assert.equal(parsed.result.summary, 'Root cause is the parser');
  assert.deepEqual(parsed.result.evidence, ['src/parser.ts:10']);
});

test('parseStructuredResult treats a present-but-unparseable tag as malformed, not recovered', () => {
  const output = '<agent_relay_result>{"status": "completed", "summary": not valid json</agent_relay_result>';
  const parsed = parseStructuredResult(output, false);
  assert.equal(parsed.contract, 'malformed');
  assert.equal(parsed.result.status, 'completed');
});

test('parseStructuredResult still prefers the last tagged block over an earlier stray JSON object', () => {
  const output = [
    'Intermediate note: {"status":"completed","summary":"stray, not the answer"}',
    '<agent_relay_result>{"status":"completed","summary":"Final answer","evidence":[],"filesTouched":[],"testsRun":[],"openQuestions":[]}</agent_relay_result>',
  ].join('\n');
  const parsed = parseStructuredResult(output, false);
  assert.equal(parsed.contract, 'valid');
  assert.equal(parsed.result.summary, 'Final answer');
});
