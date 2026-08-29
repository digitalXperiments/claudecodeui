import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { agentRelayService, configureAgentRelayRuntimes } from '@/modules/agent-relay/index.js';
import { appConfigDb, closeConnection, initializeDatabase, projectsDb, sessionsDb } from '@/modules/database/index.js';
import { chatRunRegistry } from '@/modules/websocket/index.js';
import { normalizeDeclaredSchema, validateJsonSchema } from '@/shared/json-schema-lite.js';
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
    installSkill: true,
    ...overrides,
  }));
}

async function withRelayDb(run: (projectPath: string) => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const root = await makeScratchDir('agent-relay-orch-');
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

test('json-schema-lite validates the practical subset', () => {
  const schema = {
    type: 'object',
    required: ['findings'],
    properties: {
      findings: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          required: ['file', 'severity'],
          properties: {
            file: { type: 'string', minLength: 1 },
            line: { type: 'integer', minimum: 1 },
            severity: { enum: ['low', 'medium', 'high'] },
          },
        },
      },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
    },
    additionalProperties: false,
  };

  assert.equal(validateJsonSchema({ findings: [{ file: 'a.ts', line: 3, severity: 'high' }] }, schema).valid, true);

  const missing = validateJsonSchema({}, schema);
  assert.equal(missing.valid, false);
  assert.match(missing.errors[0]!, /missing required property "findings"/);

  const badEnum = validateJsonSchema({ findings: [{ file: 'a.ts', severity: 'catastrophic' }] }, schema);
  assert.equal(badEnum.valid, false);
  assert.match(badEnum.errors[0]!, /findings\[0\]\.severity/);

  const extraKey = validateJsonSchema({ findings: [{ file: 'a.ts', severity: 'low' }], bogus: 1 }, schema);
  assert.equal(extraKey.valid, false);
  assert.match(extraKey.errors[0]!, /unexpected property "bogus"/);

  assert.equal(validateJsonSchema('yes', { anyOf: [{ type: 'string' }, { type: 'number' }] }).valid, true);
  assert.equal(validateJsonSchema(true, { anyOf: [{ type: 'string' }, { type: 'number' }] }).valid, false);

  assert.equal(normalizeDeclaredSchema({ type: 'object' })?.type, 'object');
  assert.equal(normalizeDeclaredSchema([]), null);
  assert.equal(normalizeDeclaredSchema({}), null);
  assert.equal(normalizeDeclaredSchema('nope'), null);
});

test('scheduler round-robins contending lead sessions even with one worker slot', async () => {
  await withRelayDb(async (_projectPath) => {
    relaySettings({ maxConcurrency: 1 });
    // Scratch paths under tmp/cloudcli are runtime-only and deliberately
    // rehomed. Use the logical checkout path for lead ownership validation.
    const logicalProjectPath = projectsDb.createProjectPath(process.cwd()).project!.project_path;
    for (const id of ['lead-a', 'lead-b', 'lead-c']) sessionsDb.createAppSession(id, 'claude', logicalProjectPath);
    const starts: string[] = [];
    configureAgentRelayRuntimes({
      claude: async (command, _options, writer) => {
        const marker = ['A1', 'A2', 'B1', 'C1'].find((candidate) => command.includes(candidate)) ?? '?';
        starts.push(marker);
        await new Promise((resolve) => setTimeout(resolve, 30));
        const relayWriter = writer as RelayWriter;
        relayWriter.setSessionId(`fair-${marker}`);
        relayWriter.send({ kind: 'text', provider: 'claude', content: `done ${marker}` });
        relayWriter.send({ kind: 'complete', provider: 'claude', exitCode: 0, success: true });
      },
    }, {});

    const a1 = await agentRelayService.submitBatch({ projectPath: logicalProjectPath, sourceSessionId: 'lead-a', tasks: [{ task: 'A1 task', provider: 'claude' }] });
    const a2 = await agentRelayService.submitBatch({ projectPath: logicalProjectPath, sourceSessionId: 'lead-a', tasks: [{ task: 'A2 task', provider: 'claude' }] });
    const b1 = await agentRelayService.submitBatch({ projectPath: logicalProjectPath, sourceSessionId: 'lead-b', tasks: [{ task: 'B1 task', provider: 'claude' }] });
    const c1 = await agentRelayService.submitBatch({ projectPath: logicalProjectPath, sourceSessionId: 'lead-c', tasks: [{ task: 'C1 task', provider: 'claude' }] });
    const ids = [a1, a2, b1, c1].map((batch) => batch.jobs[0]!.relay_id);
    const waited = await agentRelayService.wait(ids, { returnWhen: 'all', timeoutMs: 10_000 });
    assert.equal(waited.jobs.every((job) => job.status === 'completed'), true);
    assert.deepEqual(starts, ['A1', 'B1', 'C1', 'A2']);
  });
});

test('a declared outputSchema is enforced with one automatic repair turn', async () => {
  await withRelayDb(async (projectPath) => {
    relaySettings();
    const prompts: string[] = [];
    configureAgentRelayRuntimes({
      claude: async (command, _options, writer) => {
        prompts.push(command);
        const relayWriter = writer as RelayWriter;
        relayWriter.setSessionId(`schema-native-${prompts.length}`);
        const reply = prompts.length === 1
          // First turn: contract present but "data" violates the schema.
          ? '<agent_relay_result>{"status":"completed","summary":"first pass","data":{"verdict":"maybe"}}</agent_relay_result>'
          : '<agent_relay_result>{"status":"completed","summary":"repaired","data":{"verdict":"refuted","reason":"stale line number"}}</agent_relay_result>';
        relayWriter.send({ kind: 'text', provider: 'claude', content: reply });
        relayWriter.send({ kind: 'complete', provider: 'claude', exitCode: 0, success: true });
      },
    }, {});

    const schema = {
      type: 'object',
      required: ['verdict', 'reason'],
      properties: { verdict: { enum: ['confirmed', 'refuted'] }, reason: { type: 'string' } },
    };
    const submitted = await agentRelayService.submitBatch({
      projectPath,
      tasks: [{ task: 'Verify finding 3.', provider: 'claude', label: 'verify:finding-3', outputSchema: schema }],
    });
    assert.equal(submitted.jobs[0]?.label, 'verify:finding-3');

    const waited = await agentRelayService.wait([submitted.jobs[0]!.relay_id], { returnWhen: 'all', timeoutMs: 10_000 });
    const job = waited.jobs[0]!;
    assert.equal(job.status, 'completed');
    assert.equal(prompts.length, 2, 'exactly one automatic repair turn');
    assert.match(prompts[0]!, /"data" key/);
    assert.match(prompts[1]!, /did not satisfy the structured output contract/);
    assert.match(prompts[1]!, /verdict/);
    assert.equal(job.schema_retry_count, 1);
    assert.deepEqual(job.result?.structuredOutput, { verdict: 'refuted', reason: 'stale line number' });
    assert.equal(job.result?.outputValidation?.valid, true);

    // The compact summary carries the validated data but not the raw output.
    const summary = agentRelayService.summarize(job);
    assert.equal(summary.label, 'verify:finding-3');
    assert.deepEqual(summary.result?.structuredOutput, { verdict: 'refuted', reason: 'stale line number' });
    assert.equal(summary.result?.hasFullOutput, true);
    const full = agentRelayService.getResult(job.relay_id);
    assert.match(full.result?.output ?? '', /repaired/);
  });
});

test('output that stays invalid after the repair turn is reported, not hidden', async () => {
  await withRelayDb(async (projectPath) => {
    relaySettings();
    let calls = 0;
    configureAgentRelayRuntimes({
      claude: async (_command, _options, writer) => {
        calls += 1;
        const relayWriter = writer as RelayWriter;
        relayWriter.setSessionId(`stubborn-native-${calls}`);
        relayWriter.send({
          kind: 'text',
          provider: 'claude',
          content: '<agent_relay_result>{"status":"completed","summary":"still no data key"}</agent_relay_result>',
        });
        relayWriter.send({ kind: 'complete', provider: 'claude', exitCode: 0, success: true });
      },
    }, {});

    const submitted = await agentRelayService.submitBatch({
      projectPath,
      tasks: [{ task: 'Return the inventory.', provider: 'claude', outputSchema: { type: 'object', required: ['items'] } }],
    });
    const waited = await agentRelayService.wait([submitted.jobs[0]!.relay_id], { returnWhen: 'all', timeoutMs: 10_000 });
    const job = waited.jobs[0]!;
    assert.equal(calls, 2, 'repair is attempted exactly once');
    assert.equal(job.status, 'completed');
    assert.equal(job.result?.outputValidation?.valid, false);
    assert.match(job.result?.outputValidation?.errors[0] ?? '', /missing required "data" key/);
  });
});

test('dependsOn forms a pipeline: gated start, injected results, fail-fast on broken inputs', async () => {
  await withRelayDb(async (projectPath) => {
    relaySettings();
    const prompts: string[] = [];
    configureAgentRelayRuntimes({
      claude: async (command, _options, writer) => {
        prompts.push(command);
        const relayWriter = writer as RelayWriter;
        relayWriter.setSessionId(`pipeline-native-${prompts.length}`);
        const stage = command.includes('SCAN-A') ? 'A' : command.includes('SCAN-B') ? 'B' : 'MERGE';
        relayWriter.send({
          kind: 'text',
          provider: 'claude',
          content: `<agent_relay_result>{"status":"completed","summary":"stage ${stage} done","data":{"stage":"${stage}"}}</agent_relay_result>`,
        });
        relayWriter.send({ kind: 'complete', provider: 'claude', exitCode: 0, success: true });
      },
    }, {});

    const submitted = await agentRelayService.submitBatch({
      projectPath,
      tasks: [
        { task: 'SCAN-A the auth module.', provider: 'claude', label: 'scan:a', outputSchema: { type: 'object' } },
        { task: 'SCAN-B the api module.', provider: 'claude', label: 'scan:b', outputSchema: { type: 'object' } },
        { task: 'Merge and rank both scans.', provider: 'claude', label: 'merge', dependsOn: [0, 1] },
      ],
    });
    assert.deepEqual(submitted.jobs[2]?.depends_on, [submitted.jobs[0]!.relay_id, submitted.jobs[1]!.relay_id]);

    const waited = await agentRelayService.wait(submitted.jobs.map((job) => job.relay_id), { returnWhen: 'all', timeoutMs: 10_000 });
    assert.equal(waited.timedOut, false);
    assert.deepEqual(waited.jobs.map((job) => job.status), ['completed', 'completed', 'completed']);

    const mergePrompt = prompts.find((prompt) => prompt.includes('Merge and rank'))!;
    assert.match(mergePrompt, /Prerequisite "scan:a" \(completed\)/);
    assert.match(mergePrompt, /Prerequisite "scan:b" \(completed\)/);
    assert.match(mergePrompt, /stage A done/);
    assert.match(mergePrompt, /"stage":"B"/);

    // Invalid dependency indices are rejected atomically.
    await assert.rejects(
      () => agentRelayService.submitBatch({
        projectPath,
        tasks: [
          { task: 'First.', provider: 'claude' },
          { task: 'Depends on itself.', provider: 'claude', dependsOn: [1] },
        ],
      }),
      /dependsOn must list zero-based indices of earlier tasks/,
    );

    // A failed input fails the dependent fast instead of running it blind.
    configureAgentRelayRuntimes({
      claude: async (_command, _options, writer) => {
        const relayWriter = writer as RelayWriter;
        relayWriter.setSessionId('pipeline-fail-native');
        relayWriter.send({ kind: 'complete', provider: 'claude', exitCode: 1, success: false });
      },
    }, {});
    const failing = await agentRelayService.submitBatch({
      projectPath,
      tasks: [
        { task: 'This stage breaks.', provider: 'claude', label: 'broken-stage' },
        { task: 'Never runs.', provider: 'claude', label: 'downstream', dependsOn: [0] },
      ],
    });
    const failedWait = await agentRelayService.wait(failing.jobs.map((job) => job.relay_id), { returnWhen: 'all', timeoutMs: 10_000 });
    assert.equal(failedWait.jobs[0]?.status, 'failed');
    assert.equal(failedWait.jobs[1]?.status, 'failed');
    assert.match(failedWait.jobs[1]?.error ?? '', /Dependency "broken-stage" ended failed/);
  });
});

test('a retry budget re-dispatches an infra failure on a fresh worker session', async () => {
  await withRelayDb(async (projectPath) => {
    relaySettings();
    let calls = 0;
    const sessionIds: Array<string | null> = [];
    configureAgentRelayRuntimes({
      claude: async (_command, options, writer) => {
        calls += 1;
        const relayWriter = writer as RelayWriter;
        relayWriter.setSessionId(`retry-native-${calls}`);
        sessionIds.push((options as { appSessionId?: string }).appSessionId ?? null);
        if (calls === 1) {
          // Infrastructure-style death: non-zero exit, no output at all.
          relayWriter.send({ kind: 'complete', provider: 'claude', exitCode: 1, success: false });
          return;
        }
        relayWriter.send({
          kind: 'text',
          provider: 'claude',
          content: '<agent_relay_result>{"status":"completed","summary":"second try worked"}</agent_relay_result>',
        });
        relayWriter.send({ kind: 'complete', provider: 'claude', exitCode: 0, success: true });
      },
    }, {});

    const submitted = await agentRelayService.submitBatch({
      projectPath,
      tasks: [{ task: 'Flaky infra task.', provider: 'claude', retries: 1 }],
    });
    const waited = await agentRelayService.wait([submitted.jobs[0]!.relay_id], { returnWhen: 'all', timeoutMs: 10_000 });
    const job = waited.jobs[0]!;
    assert.equal(calls, 2);
    assert.equal(job.status, 'completed');
    assert.equal(job.retry_count, 1);
    assert.equal(job.result?.summary, 'second try worked');

    // No stale transcript: the retry ran in a brand-new internal session.
    const firstSession = sessionsDb.getSessionById(String(sessionIds[0]));
    const secondSession = sessionsDb.getSessionById(String(sessionIds[1]));
    assert.ok(firstSession && secondSession);
    assert.notEqual(sessionIds[0], sessionIds[1]);

    // Without a budget the same failure is terminal.
    configureAgentRelayRuntimes({
      claude: async (_command, _options, writer) => {
        const relayWriter = writer as RelayWriter;
        relayWriter.setSessionId('retry-none-native');
        relayWriter.send({ kind: 'complete', provider: 'claude', exitCode: 1, success: false });
      },
    }, {});
    const unbudgeted = await agentRelayService.submitBatch({
      projectPath,
      tasks: [{ task: 'Dies once, stays dead.', provider: 'claude' }],
    });
    const deadWait = await agentRelayService.wait([unbudgeted.jobs[0]!.relay_id], { returnWhen: 'all', timeoutMs: 10_000 });
    assert.equal(deadWait.jobs[0]?.status, 'failed');
    assert.equal(deadWait.jobs[0]?.retry_count, 0);
  });
});

test('a malformed result tag gets one repair turn instead of silently passing as completed', async () => {
  await withRelayDb(async (projectPath) => {
    relaySettings();
    let calls = 0;
    configureAgentRelayRuntimes({
      claude: async (_command, _options, writer) => {
        calls += 1;
        const relayWriter = writer as RelayWriter;
        relayWriter.setSessionId(`malformed-native-${calls}`);
        relayWriter.send({
          kind: 'text',
          provider: 'claude',
          content: calls === 1
            ? 'Here is my analysis. <agent_relay_result>{not valid json}</agent_relay_result>'
            : '<agent_relay_result>{"status":"completed","summary":"clean second reply"}</agent_relay_result>',
        });
        relayWriter.send({ kind: 'complete', provider: 'claude', exitCode: 0, success: true });
      },
    }, {});

    const submitted = await agentRelayService.submitBatch({
      projectPath,
      tasks: [{ task: 'Report on the config loader.', provider: 'claude' }],
    });
    const waited = await agentRelayService.wait([submitted.jobs[0]!.relay_id], { returnWhen: 'all', timeoutMs: 10_000 });
    assert.equal(calls, 2);
    assert.equal(waited.jobs[0]?.status, 'completed');
    assert.equal(waited.jobs[0]?.result?.summary, 'clean second reply');
  });
});
