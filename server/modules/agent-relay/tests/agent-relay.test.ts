import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { agentRelayDb, agentRelayService, allowedWorkerModelsFor, catalogEffortValuesForModel, configureAgentRelayRuntimes, configureRelayModelRegistry, providerHonorsRelayMcpGrants, providerSupportsReadOnlyRelay, relayPermissionMode, resolveAgentRelayMcpScope, resolveCatalogModelId, resolveRelayEffort, resolveRelayModelIdentity, resolveRelayWorkerModel, sanitizeWorkerMcpServers } from '@/modules/agent-relay/index.js';
import { appConfigDb, closeConnection, getConnection, initializeDatabase, projectsDb, sessionsDb } from '@/modules/database/index.js';
import { providerModelsService, sessionsService } from '@/modules/providers/index.js';
import { upsertModelCapability } from '@/modules/swarm/index.js';
import { runService } from '@/modules/runs/index.js';
import { chatRunRegistry } from '@/modules/websocket/index.js';
import { newRelayBatchId, newRelayJobId } from '@/shared/ids.js';
import { makeScratchDir } from '@/shared/scratch.js';

test('Agent Relay dispatches a fresh internal provider session and returns structured results', async () => {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const root = await makeScratchDir('agent-relay-');
  const projectPath = path.join(root, 'project');
  closeConnection();
  process.env.DATABASE_PATH = path.join(root, 'auth.db');
  await initializeDatabase();
  await mkdir(projectPath, { recursive: true });

  appConfigDb.set('agent_relay.settings', JSON.stringify({
    enabled: true,
    leadProviders: ['claude'],
    workerProviders: ['claude'],
    maxConcurrency: 2,
    defaultTimeoutMs: 60_000,
    defaultMode: 'read_only',
    installSkill: true,
  }));

  let callCount = 0;
  const seenOptions: Array<Record<string, unknown>> = [];
  const originalGetProviderModels = providerModelsService.getProviderModels;
  providerModelsService.getProviderModels = async () => ({
    models: {
      DEFAULT: 'default',
      OPTIONS: [
        {
          value: 'default',
          label: 'Default (recommended)',
          resolvedModel: 'claude-runtime-model',
          effort: { default: 'medium', values: [{ value: 'low' }, { value: 'high' }] },
        },
        { value: 'claude-test-model', label: 'Claude Test Model' },
      ],
    },
    cache: {
      updatedAt: new Date().toISOString(),
      expiresAt: new Date().toISOString(),
      source: 'fresh',
    },
  });
  configureAgentRelayRuntimes({
    claude: async (command, options, writer) => {
      callCount += 1;
      seenOptions.push(options as Record<string, unknown>);
      const relayWriter = writer as {
        setSessionId: (sessionId: string) => void;
        send: (message: unknown) => void;
      };
      relayWriter.setSessionId(`relay-native-${callCount}`);
      relayWriter.send({
        id: `budget-${callCount}`,
        sessionId: `relay-native-${callCount}`,
        timestamp: new Date().toISOString(),
        kind: 'status',
        provider: 'claude',
        text: 'token_budget',
        tokenBudget: { model: 'claude-runtime-model' },
      });
      relayWriter.send({
        kind: 'text',
        provider: 'claude',
        content: `${command.slice(0, 20)}\n<agent_relay_result>{"status":"completed","summary":"Found the cause","evidence":["src/a.ts:4"],"filesTouched":[],"testsRun":["npm test"],"openQuestions":[]}</agent_relay_result>`,
      });
      relayWriter.send({ kind: 'complete', provider: 'claude', exitCode: 0, success: true });
    },
  }, {});

  try {
    const capabilities = await agentRelayService.getCapabilities();
    assert.equal(capabilities.catalogs[0]?.defaultModel, 'default');
    assert.equal(capabilities.catalogs[0]?.models[0]?.value, 'default');
    assert.equal(capabilities.catalogs[0]?.models[0]?.resolvedModel, 'claude-runtime-model');
    assert.deepEqual(capabilities.catalogs[0]?.models[0]?.effort?.values, [{ value: 'low' }, { value: 'high' }]);

    await assert.rejects(
      () => agentRelayService.submitBatch({
        projectPath,
        tasks: [
          { task: 'This task is valid.', provider: 'claude' },
          { task: 'x'.repeat(12_001), provider: 'claude' },
        ],
      }),
      /Relay task 2/,
    );
    const relayCount = getConnection().prepare('SELECT COUNT(*) AS count FROM agent_relay_jobs').get() as { count: number };
    assert.equal(relayCount.count, 0);

    const submitted = await agentRelayService.submitBatch({
      projectPath,
      tasks: [{ task: 'Investigate the failing test.', provider: 'claude', model: 'default', effort: 'high' }],
    });
    assert.equal(submitted.jobs.length, 1);
    assert.equal(submitted.jobs[0]?.status, 'queued');
    assert.equal(submitted.jobs[0]?.approval_policy, 'auto');

    const waited = await agentRelayService.wait([submitted.jobs[0]!.relay_id], {
      returnWhen: 'all',
      timeoutMs: 5_000,
    });
    assert.equal(waited.timedOut, false);
    const completed = waited.jobs[0]!;
    assert.equal(completed.status, 'completed');
    assert.equal(completed.result?.summary, 'Found the cause');
    assert.deepEqual(completed.result?.evidence, ['src/a.ts:4']);
    assert.equal(completed.attempt, 1);
    assert.equal(completed.model, 'default');
    assert.equal(completed.requested_model, 'default');
    assert.equal(completed.model_label, 'Default (recommended)');
    assert.equal(completed.catalog_default_model, 'default');
    assert.equal(completed.catalog_resolved_model, 'claude-runtime-model');
    assert.equal(completed.runtime_resolved_model, 'claude-runtime-model');
    assert.equal(completed.model_selection_source, 'requested');
    assert.equal(completed.effort, 'high');
    assert.equal(seenOptions[0]?.model, 'claude-runtime-model');
    assert.equal(seenOptions[0]?.effort, 'high');
    assert.equal(seenOptions[0]?.permissionMode, 'plan');
    assert.equal(seenOptions[0]?.relayWorker, true);
    assert.deepEqual(seenOptions[0]?.mcpServers, []);
    assert.equal((seenOptions[0]?.toolsSettings as { skipPermissions?: boolean } | undefined)?.skipPermissions, false);
    const disallowedTools = (seenOptions[0]?.toolsSettings as { disallowedTools?: string[] } | undefined)?.disallowedTools ?? [];
    assert.ok(disallowedTools.includes('Task'));
    assert.ok(disallowedTools.includes('Agent'));

    const session = sessionsDb.getSessionById(completed.app_session_id!);
    assert.equal(session?.is_internal, 1);
    assert.equal(session?.provider_session_id, 'relay-native-1');
    assert.equal(sessionsDb.getAllSessions().some((row) => row.session_id === completed.app_session_id), false);

    const run = getConnection().prepare('SELECT source, source_ref, model, effort, status FROM agent_runs WHERE run_id = ?')
      .get(completed.run_id) as { source: string; source_ref: string; model: string; effort: string; status: string };
    assert.equal(run.source, 'agent_relay');
    assert.equal(run.source_ref, completed.relay_id);
    assert.equal(run.model, 'claude-runtime-model');
    assert.equal(run.effort, 'high');
    assert.equal(run.status, 'succeeded');

    const summary = agentRelayService.summarize(completed);
    assert.equal(summary.selectedModel, 'default');
    assert.equal(summary.runtimeResolvedModel, 'claude-runtime-model');
    assert.equal(agentRelayService.getResult(completed.relay_id).modelLabel, 'Default (recommended)');

    const followed = await agentRelayService.followUp(completed.relay_id, 'Clarify the exact failure path.');
    assert.equal(followed.status, 'queued');
    const followUpResult = await agentRelayService.wait([completed.relay_id], { returnWhen: 'all', timeoutMs: 5_000 });
    assert.equal(followUpResult.jobs[0]?.status, 'completed');
    assert.equal(followUpResult.jobs[0]?.attempt, 2);
    assert.equal(followUpResult.jobs[0]?.app_session_id, completed.app_session_id);
    assert.equal(callCount, 2);

    let releaseCancelledRun: (() => void) | null = null;
    configureAgentRelayRuntimes({
      claude: async (_command, _options, writer) => {
        const relayWriter = writer as {
          setSessionId: (sessionId: string) => void;
          send: (message: unknown) => void;
        };
        relayWriter.setSessionId('relay-native-cancel');
        await new Promise<void>((resolve) => { releaseCancelledRun = resolve; });
        relayWriter.send({ kind: 'complete', provider: 'claude', exitCode: 1, aborted: true });
      },
    }, {
      claude: async () => {
        releaseCancelledRun?.();
        // Simulate a provider whose abort acknowledgement is slow. The Relay
        // API must still return the persisted cancellation immediately.
        await new Promise((resolve) => setTimeout(resolve, 250));
        return true;
      },
    });
    const cancellable = await agentRelayService.submitBatch({
      projectPath,
      tasks: [{ task: 'Wait until cancelled.', provider: 'claude' }],
    });
    const cancellableId = cancellable.jobs[0]!.relay_id;
    for (let attempt = 0; attempt < 40 && agentRelayService.get(cancellableId)?.status !== 'running'; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(agentRelayService.get(cancellableId)?.status, 'running');
    const cancelStartedAt = Date.now();
    const cancelled = await agentRelayService.cancel(cancellableId);
    assert.ok(Date.now() - cancelStartedAt < 100, 'cancel should not await provider abort acknowledgement');
    assert.equal(cancelled.status, 'cancelled');
    const cancelledRun = getConnection().prepare('SELECT status FROM agent_runs WHERE run_id = ?')
      .get(cancelled.run_id) as { status: string };
    assert.equal(cancelledRun.status, 'aborted');
  } finally {
    providerModelsService.getProviderModels = originalGetProviderModels;
    configureAgentRelayRuntimes({}, {});
    chatRunRegistry.clearAll();
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(root, { recursive: true, force: true });
  }
});

test('Agent Relay schema is additive and boot recovery preserves never-started jobs', async () => {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const root = await makeScratchDir('agent-relay-schema-');
  closeConnection();
  process.env.DATABASE_PATH = path.join(root, 'auth.db');
  await initializeDatabase();
  try {
    const columns = new Set((getConnection().prepare('PRAGMA table_info(agent_relay_jobs)').all() as Array<{ name: string }>).map((column) => column.name));
    for (const expected of ['relay_id', 'batch_id', 'project_id', 'app_session_id', 'run_id', 'workspace_id', 'model', 'requested_model', 'model_label', 'catalog_default_model', 'catalog_resolved_model', 'runtime_resolved_model', 'model_selection_source', 'effort', 'approval_policy', 'result_json', 'timeout_ms']) {
      assert.ok(columns.has(expected), `missing agent_relay_jobs.${expected}`);
    }
    assert.equal(agentRelayService.recoverOnBoot(), 0);

    const project = projectsDb.createProjectPath(process.cwd()).project!;
    agentRelayDb.create({
      relayId: newRelayJobId(),
      batchId: newRelayBatchId(),
      projectId: project.project_id,
      projectPath: project.project_path,
      provider: 'claude',
      mode: 'read_only',
      task: 'Interrupted on boot.',
      prompt: 'Interrupted on boot.',
      mcpServers: [],
      timeoutMs: 60_000,
    });
    assert.equal(agentRelayService.recoverOnBoot(), 0);
    assert.equal(agentRelayDb.list({ active: true }).length, 1);
    assert.equal(agentRelayDb.list({ active: true })[0]?.status, 'queued');
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(root, { recursive: true, force: true });
  }
});

test('Agent Relay scopes jobs and approvals to the lead session that dispatched them', async () => {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const root = await makeScratchDir('agent-relay-scope-');
  closeConnection();
  process.env.DATABASE_PATH = path.join(root, 'auth.db');
  await initializeDatabase();
  // Scratch dirs under the repo are treated as runtime paths and rehomed to
  // their logical parent, so a session created inside one would not match the
  // batch's project. Use the logical project root directly instead.
  const projectPath = process.cwd();

  appConfigDb.set('agent_relay.settings', JSON.stringify({
    enabled: true,
    leadProviders: ['claude'],
    workerProviders: ['claude'],
    maxConcurrency: 2,
    defaultTimeoutMs: 60_000,
    defaultMode: 'read_only',
    installSkill: false,
  }));

  configureAgentRelayRuntimes({
    claude: async (_command, _options, writer) => {
      const relayWriter = writer as { setSessionId: (id: string) => void; send: (message: unknown) => void };
      relayWriter.setSessionId(`scoped-${Math.random().toString(36).slice(2)}`);
      relayWriter.send({ kind: 'text', provider: 'claude', content: 'done' });
      relayWriter.send({ kind: 'complete', provider: 'claude', exitCode: 0, success: true });
    },
  }, {});

  try {
    // Two interactive leads in the same project, exactly the shape that used to
    // show every session's workers in every session's panel. Sessions are
    // created on the project's canonical path so the batch's same-project check
    // is not defeated by symlinked scratch paths (/var vs /private/var).
    const canonicalPath = projectsDb.createProjectPath(projectPath).project!.project_path;
    const leadA = sessionsService.createAppSession('claude', canonicalPath).sessionId;
    const leadB = sessionsService.createAppSession('claude', canonicalPath).sessionId;
    assert.equal(sessionsDb.getSessionById(leadA)?.project_path, canonicalPath);

    const batchA = await agentRelayService.submitBatch({
      projectPath,
      sourceSessionId: leadA,
      tasks: [{ task: 'Lead A investigates the parser.', provider: 'claude' }],
    });
    const batchB = await agentRelayService.submitBatch({
      projectPath,
      sourceSessionId: leadB,
      tasks: [{ task: 'Lead B investigates the router.', provider: 'claude' }],
    });

    const relayA = batchA.jobs[0]!.relay_id;
    const relayB = batchB.jobs[0]!.relay_id;
    assert.equal(agentRelayService.get(relayA)?.source_session_id, leadA);

    const seenByA = agentRelayService.list({ sourceSessionId: leadA }).map((job) => job.relay_id);
    assert.deepEqual(seenByA, [relayA]);
    assert.deepEqual(agentRelayService.list({ sourceSessionId: leadB }).map((job) => job.relay_id), [relayB]);
    assert.equal(agentRelayService.list({}).length, 2);

    // A lead may read its own relay and must not see another lead's.
    assert.equal(agentRelayService.getForScope(relayA, { sourceSessionId: leadA })?.relay_id, relayA);
    assert.equal(agentRelayService.getForScope(relayB, { sourceSessionId: leadA }), null);

    // Cross-session steering is refused, and indistinguishably from "missing"
    // so relay ids cannot be probed across sessions.
    await assert.rejects(
      () => agentRelayService.cancel(relayB, { sourceSessionId: leadA }),
      /Relay job not found/,
    );
    await assert.rejects(
      () => agentRelayService.followUp(relayB, 'Report back.', undefined, { sourceSessionId: leadA }),
      /Relay job not found/,
    );
    await assert.rejects(
      () => agentRelayService.wait([relayB], { scope: { sourceSessionId: leadA } }),
      /Relay job not found/,
    );
    // An unattributable caller sees nothing rather than everything.
    await assert.rejects(
      () => agentRelayService.cancel(relayA, { sourceSessionId: null }),
      /Relay job not found/,
    );

    const worker = sessionsService.createAppSession('claude', canonicalPath, { internal: true }).sessionId;
    await assert.rejects(
      () => agentRelayService.submitBatch({
        projectPath,
        sourceSessionId: worker,
        tasks: [{ task: 'Workers must not nest relays.', provider: 'claude' }],
      }),
      /interactive session/,
    );
  } finally {
    configureAgentRelayRuntimes({}, {});
    chatRunRegistry.clearAll();
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(root, { recursive: true, force: true });
  }
});

test('the relay panel shows a batch when viewing any one worker session', async () => {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const root = await makeScratchDir('agent-relay-relevance-');
  closeConnection();
  process.env.DATABASE_PATH = path.join(root, 'auth.db');
  await initializeDatabase();
  const projectPath = process.cwd();

  try {
    const project = projectsDb.createProjectPath(projectPath).project!;
    const lead = sessionsService.createAppSession('claude', project.project_path).sessionId;
    const batchId = newRelayBatchId();
    const made = ['claude', 'codex', 'grok'].map((provider, index) => {
      const relayId = newRelayJobId();
      agentRelayDb.create({
        relayId,
        batchId,
        projectId: project.project_id,
        projectPath: project.project_path,
        sourceSessionId: lead,
        provider: provider as 'claude',
        mode: 'read_only',
        task: `Worker ${index}`,
        prompt: `Worker ${index}`,
        mcpServers: [],
        timeoutMs: 60_000,
      });
      const worker = sessionsService.createAppSession(provider as 'claude', project.project_path, { internal: true }).sessionId;
      agentRelayDb.attachExecution(relayId, { appSessionId: worker, runId: null as unknown as string });
      return { relayId, worker };
    });

    // From the lead: all three of its relays.
    assert.equal(agentRelayService.list({ relevantToSessionId: lead }).length, 3);

    // From inside ONE worker's transcript: still the whole batch, not an empty
    // panel. This is the regression that made a 3-worker batch look like zero.
    for (const { worker } of made) {
      const visible = agentRelayService.list({ relevantToSessionId: worker });
      assert.equal(visible.length, 3, `worker ${worker} should see its batch`);
    }

    // An unrelated session still sees nothing of this batch.
    const stranger = sessionsService.createAppSession('claude', project.project_path).sessionId;
    assert.equal(agentRelayService.list({ relevantToSessionId: stranger }).length, 0);
  } finally {
    chatRunRegistry.clearAll();
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(root, { recursive: true, force: true });
  }
});

test('HTTP MCP scope prefers bound lead id and rejects internal body claims', async () => {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const root = await makeScratchDir('agent-relay-mcp-scope-');
  closeConnection();
  process.env.DATABASE_PATH = path.join(root, 'auth.db');
  await initializeDatabase();
  try {
    const project = projectsDb.createProjectPath(path.join(root, 'project')).project!;
    const lead = sessionsService.createAppSession('claude', project.project_path).sessionId;
    const other = sessionsService.createAppSession('claude', project.project_path).sessionId;
    const worker = sessionsService.createAppSession('claude', project.project_path, { internal: true }).sessionId;

    assert.deepEqual(
      resolveAgentRelayMcpScope({ headers: { 'x-cloudcli-lead-session-id': lead } }, { sourceSessionId: other }),
      { sourceSessionId: lead },
    );
    assert.deepEqual(
      resolveAgentRelayMcpScope({ headers: {} }, { sourceSessionId: lead }),
      { sourceSessionId: null },
    );
    assert.deepEqual(
      resolveAgentRelayMcpScope({ headers: { 'x-cloudcli-lead-session-id': worker } }, { sourceSessionId: lead }),
      { sourceSessionId: null },
    );
    assert.deepEqual(
      resolveAgentRelayMcpScope({ headers: { 'x-cloudcli-lead-session-id': 'missing-session' } }, {}),
      { sourceSessionId: null },
    );

    const relayId = newRelayJobId();
    agentRelayDb.create({
      relayId,
      batchId: newRelayBatchId(),
      projectId: project.project_id,
      projectPath: project.project_path,
      sourceSessionId: lead,
      provider: 'claude',
      mode: 'read_only',
      task: 'move me',
      prompt: 'move me',
      mcpServers: [],
      timeoutMs: 60_000,
    });
    assert.equal(agentRelayService.rehomeSourceSession(lead, other), 1);
    assert.equal(agentRelayService.get(relayId)?.source_session_id, other);
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(root, { recursive: true, force: true });
  }
});

test('resolveRelayWorkerModel enforces the Settings allowlist', () => {
  configureRelayModelRegistry(() => null);
  try {
    const restricted = { allowedWorkerModels: { claude: ['cheap-model', 'strong-model'] } };
    assert.deepEqual(allowedWorkerModelsFor(restricted, 'claude'), ['cheap-model', 'strong-model']);
    assert.equal(allowedWorkerModelsFor({ allowedWorkerModels: {} }, 'claude'), null);
    assert.equal(resolveRelayWorkerModel(restricted, 'claude', null, 'strong-model'), 'strong-model');
    assert.equal(resolveRelayWorkerModel(restricted, 'claude', 'cheap-model'), 'cheap-model');
    assert.equal(resolveRelayWorkerModel(restricted, 'claude', null), 'cheap-model');
    assert.throws(() => resolveRelayWorkerModel(restricted, 'claude', 'secret-model'), /not allowlisted/);
    assert.equal(resolveRelayWorkerModel({ allowedWorkerModels: {} }, 'claude', null, 'catalog-default'), 'catalog-default');
    assert.equal(resolveRelayWorkerModel({ allowedWorkerModels: {} }, 'claude', null), null);
    assert.equal(resolveRelayWorkerModel({ allowedWorkerModels: {} }, 'claude', 'any-model'), 'any-model');
  } finally {
    configureRelayModelRegistry(null);
  }
});

test('Agent Relay intersects Settings allowlist with enabled Model profiles', async () => {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const root = await makeScratchDir('agent-relay-registry-intersect-');
  closeConnection();
  process.env.DATABASE_PATH = path.join(root, 'auth.db');
  await initializeDatabase();

  const sample = (modelId: string, enabled: boolean) => ({
    modelId,
    provider: 'claude' as const,
    displayName: modelId,
    contextWindow: 200_000,
    maxContextWindow: null,
    officialContextWindow: null,
    inputCostPerMtok: 1,
    outputCostPerMtok: 5,
    codingScore: 0.8,
    agenticScore: 0.7,
    longContextScore: 0.6,
    speedScore: 0.5,
    confidence: 0.8,
    sources: ['test'],
    aliases: [] as string[],
    assessmentKind: 'heuristic' as const,
    fetchedAt: new Date().toISOString(),
    enabled,
  });

  try {
    getConnection().prepare('DELETE FROM model_capabilities').run();
    upsertModelCapability(sample('cheap-model', true));
    upsertModelCapability(sample('strong-model', true));
    upsertModelCapability(sample('secret-model', false));

    const unrestricted = { allowedWorkerModels: {} };
    assert.deepEqual(
      allowedWorkerModelsFor(unrestricted, 'claude')?.sort(),
      ['cheap-model', 'strong-model'],
    );
    assert.equal(allowedWorkerModelsFor(unrestricted, 'codex'), null);

    const explicit = { allowedWorkerModels: { claude: ['cheap-model', 'secret-model', 'ghost-model'] } };
    assert.deepEqual(allowedWorkerModelsFor(explicit, 'claude'), ['cheap-model']);
    assert.throws(
      () => resolveRelayWorkerModel(explicit, 'claude', 'secret-model'),
      /not allowlisted/,
    );
    assert.equal(resolveRelayWorkerModel(explicit, 'claude', 'cheap-model'), 'cheap-model');
    assert.equal(resolveRelayWorkerModel(unrestricted, 'claude', null, 'strong-model'), 'strong-model');
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(root, { recursive: true, force: true });
  }
});

test('Relay model identity preserves defaults, aliases, and provider-qualified OpenCode ids', () => {
  const claude = resolveRelayModelIdentity(
    { allowedWorkerModels: {} },
    'claude',
    null,
    {
      DEFAULT: 'default',
      OPTIONS: [{ value: 'default', label: 'Default (recommended)', resolvedModel: 'claude-opus-5[1m]' }],
    },
  );
  assert.deepEqual(claude, {
    model: 'default',
    requestedModel: null,
    modelLabel: 'Default (recommended)',
    catalogDefaultModel: 'default',
    catalogResolvedModel: 'claude-opus-5[1m]',
    modelSelectionSource: 'catalog_default',
  });

  const openCodeId = 'openrouter/z-ai/glm-5.2';
  const opencode = resolveRelayModelIdentity(
    { allowedWorkerModels: {} },
    'opencode',
    openCodeId,
    {
      DEFAULT: 'anthropic/claude-sonnet-4-5',
      OPTIONS: [{ value: openCodeId, label: 'OpenRouter · GLM 5.2' }],
    },
  );
  assert.equal(opencode.model, openCodeId);
  assert.equal(opencode.requestedModel, openCodeId);
  assert.equal(opencode.modelLabel, 'OpenRouter · GLM 5.2');
});

const NVIDIA_CATALOG = {
  DEFAULT: 'anthropic/claude-sonnet-4-5',
  OPTIONS: [
    { value: 'anthropic/claude-sonnet-4-5', label: 'Anthropic · Sonnet 4.5' },
    { value: 'nvidia/deepseek-ai/deepseek-v4-flash', label: 'NVIDIA · DeepSeek V4 Flash' },
    { value: 'nvidia/qwen/qwen4-coder', label: 'NVIDIA · Qwen4 Coder' },
  ],
};

test('resolveCatalogModelId repairs abbreviated NVIDIA ids without stripping the vendor namespace', () => {
  assert.deepEqual(
    resolveCatalogModelId('opencode', 'nvidia/deepseek-ai/deepseek-v4-flash', NVIDIA_CATALOG),
    { model: 'nvidia/deepseek-ai/deepseek-v4-flash', repaired: false },
  );
  // Dropped middle vendor segment — the reported dispatch failure.
  assert.deepEqual(
    resolveCatalogModelId('opencode', 'nvidia/deepseek-v4-flash', NVIDIA_CATALOG),
    { model: 'nvidia/deepseek-ai/deepseek-v4-flash', repaired: true },
  );
  // Bare model name and vendor/model tail both widen to the full catalog id.
  assert.equal(resolveCatalogModelId('opencode', 'deepseek-v4-flash', NVIDIA_CATALOG).model, 'nvidia/deepseek-ai/deepseek-v4-flash');
  assert.equal(resolveCatalogModelId('opencode', 'deepseek-ai/deepseek-v4-flash', NVIDIA_CATALOG).model, 'nvidia/deepseek-ai/deepseek-v4-flash');
  // Two vendors publishing the same model name must not be guessed at.
  assert.throws(
    () => resolveCatalogModelId('opencode', 'nvidia/deepseek-v4-flash', {
      DEFAULT: '',
      OPTIONS: [
        { value: 'nvidia/deepseek-ai/deepseek-v4-flash', label: 'a' },
        { value: 'nvidia/mirror/deepseek-v4-flash', label: 'b' },
      ],
    }),
    /is ambiguous in the opencode catalog/,
  );
  // Providers without a usable catalog keep the legacy pass-through.
  assert.deepEqual(
    resolveCatalogModelId('opencode', 'nvidia/deepseek-v4-flash', { DEFAULT: '', OPTIONS: [] }),
    { model: 'nvidia/deepseek-v4-flash', repaired: false },
  );
});

test('resolveCatalogModelId redirects the retired NVIDIA deepseek-v4-flash id to opencode-go when it is live', () => {
  const CATALOG_WITH_OPENCODE_GO = {
    DEFAULT: 'anthropic/claude-sonnet-4-5',
    OPTIONS: [
      { value: 'anthropic/claude-sonnet-4-5', label: 'Anthropic · Sonnet 4.5' },
      { value: 'opencode-go/deepseek-v4-flash', label: 'OpenCode Go · DeepSeek V4 Flash' },
      { value: 'opencode-go/nemotron-free', label: 'OpenCode Go · Nemotron Free' },
    ],
  };

  assert.deepEqual(
    resolveCatalogModelId('opencode', 'nvidia/deepseek-v4-flash', CATALOG_WITH_OPENCODE_GO),
    { model: 'opencode-go/deepseek-v4-flash', repaired: true },
  );
  assert.deepEqual(
    resolveCatalogModelId('opencode', 'nvidia/deepseek-ai/deepseek-v4-flash', CATALOG_WITH_OPENCODE_GO),
    { model: 'opencode-go/deepseek-v4-flash', repaired: true },
  );

  // The NVIDIA catalog entry is still live (opencode-go is absent) — keep the
  // legacy vendor-namespace remap instead of guessing at a redirect.
  assert.deepEqual(
    resolveCatalogModelId('opencode', 'nvidia/deepseek-v4-flash', NVIDIA_CATALOG),
    { model: 'nvidia/deepseek-ai/deepseek-v4-flash', repaired: true },
  );
});

test('resolveCatalogModelId resolves gemini-3.7 and gemini-3.8 shorthands and aliases', () => {
  const OPENCODE_GEMINI_CATALOG = {
    DEFAULT: 'anthropic/claude-sonnet-4-5',
    OPTIONS: [
      { value: 'anthropic/claude-sonnet-4-5', label: 'Anthropic · Sonnet 4.5' },
      { value: 'openrouter/google/gemini-3.7-flash', label: 'OpenRouter · Gemini 3.7 Flash' },
      { value: 'openrouter/google/gemini-3.8-flash', label: 'OpenRouter · Gemini 3.8 Flash' },
    ],
  };

  assert.deepEqual(
    resolveCatalogModelId('opencode', 'gemini-3.7', OPENCODE_GEMINI_CATALOG),
    { model: 'openrouter/google/gemini-3.7-flash', repaired: true },
  );
  assert.deepEqual(
    resolveCatalogModelId('opencode', 'gemini-3.8', OPENCODE_GEMINI_CATALOG),
    { model: 'openrouter/google/gemini-3.8-flash', repaired: true },
  );
  assert.deepEqual(
    resolveCatalogModelId('opencode', 'gemini-3.7-flash', OPENCODE_GEMINI_CATALOG),
    { model: 'openrouter/google/gemini-3.7-flash', repaired: true },
  );
  assert.deepEqual(
    resolveCatalogModelId('opencode', 'google/gemini-3.8-flash', OPENCODE_GEMINI_CATALOG),
    { model: 'openrouter/google/gemini-3.8-flash', repaired: true },
  );
  assert.deepEqual(
    resolveCatalogModelId('opencode', 'openrouter/google/gemini-3.7-flash', OPENCODE_GEMINI_CATALOG),
    { model: 'openrouter/google/gemini-3.7-flash', repaired: false },
  );
});

test('Unknown relay models fail with a 400 and catalog suggestions even when unrestricted', () => {
  configureRelayModelRegistry(() => null);
  try {
  assert.throws(
    () => resolveCatalogModelId('opencode', 'nvidia/deepseek-v9-turbo', NVIDIA_CATALOG),
    (error: unknown) => {
      const failure = error as { code?: string; statusCode?: number; message?: string };
      assert.equal(failure.code, 'RELAY_MODEL_NOT_IN_CATALOG');
      assert.equal(failure.statusCode, 400);
      assert.match(failure.message ?? '', /not in the opencode model catalog/);
      return true;
    },
  );

  assert.throws(
    () => resolveRelayWorkerModel({ allowedWorkerModels: {} }, 'opencode', 'nvidia/deepseek-v9-turbo', null, NVIDIA_CATALOG),
    /RELAY_MODEL_NOT_IN_CATALOG|not in the opencode model catalog/,
  );

  const repaired = resolveRelayModelIdentity(
    { allowedWorkerModels: {} },
    'opencode',
    'nvidia/deepseek-v4-flash',
    NVIDIA_CATALOG,
  );
  assert.equal(repaired.model, 'nvidia/deepseek-ai/deepseek-v4-flash');
  assert.equal(repaired.requestedModel, 'nvidia/deepseek-v4-flash');
  assert.equal(repaired.catalogResolvedModel, 'nvidia/deepseek-ai/deepseek-v4-flash');
  assert.equal(repaired.modelLabel, 'NVIDIA · DeepSeek V4 Flash');

  assert.throws(
    () => resolveRelayModelIdentity({ allowedWorkerModels: {} }, 'opencode', 'made-up-model', NVIDIA_CATALOG),
    /not in the opencode model catalog/,
  );
  } finally {
    configureRelayModelRegistry(null);
  }
});

test('Agent Relay capabilities and dispatch honor the worker model allowlist', async () => {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const root = await makeScratchDir('agent-relay-allowlist-');
  const projectPath = path.join(root, 'project');
  closeConnection();
  process.env.DATABASE_PATH = path.join(root, 'auth.db');
  await initializeDatabase();
  await mkdir(projectPath, { recursive: true });

  appConfigDb.set('agent_relay.settings', JSON.stringify({
    enabled: true,
    leadProviders: ['claude'],
    workerProviders: ['claude'],
    allowedWorkerModels: { claude: ['claude-test-model'] },
    maxConcurrency: 2,
    defaultTimeoutMs: 60_000,
    defaultMode: 'read_only',
    installSkill: false,
  }));

  const originalGetProviderModels = providerModelsService.getProviderModels;
  providerModelsService.getProviderModels = async () => ({
    models: {
      DEFAULT: 'claude-default-model',
      OPTIONS: [
        { value: 'claude-default-model', label: 'Claude Default' },
        { value: 'claude-test-model', label: 'Claude Test Model' },
        { value: 'claude-secret-model', label: 'Claude Secret' },
      ],
    },
    cache: {
      updatedAt: new Date().toISOString(),
      expiresAt: new Date().toISOString(),
      source: 'fresh',
    },
  });
  configureAgentRelayRuntimes({
    claude: async (_command, _options, writer) => {
      const relayWriter = writer as { setSessionId: (id: string) => void; send: (message: unknown) => void };
      relayWriter.setSessionId(`allowlist-${Math.random().toString(36).slice(2)}`);
      relayWriter.send({ kind: 'text', provider: 'claude', content: 'done' });
      relayWriter.send({ kind: 'complete', provider: 'claude', exitCode: 0, success: true });
    },
  }, {});

  try {
    const capabilities = await agentRelayService.getCapabilities();
    assert.equal(capabilities.catalogs[0]?.restricted, true);
    assert.deepEqual(capabilities.catalogs[0]?.models.map((model) => model.value), ['claude-test-model']);
    assert.equal(capabilities.catalogs[0]?.defaultModel, 'claude-test-model');

    await assert.rejects(
      () => agentRelayService.submitBatch({
        projectPath,
        tasks: [{ task: 'Use a blocked model.', provider: 'claude', model: 'claude-secret-model' }],
      }),
      /not allowlisted/,
    );

    const omitted = await agentRelayService.submitBatch({
      projectPath,
      tasks: [{ task: 'Use the allowlisted default.', provider: 'claude' }],
    });
    assert.equal(omitted.jobs[0]?.model, 'claude-test-model');
    assert.equal(omitted.jobs[0]?.requested_model, null);
    assert.equal(omitted.jobs[0]?.model_label, 'Claude Test Model');
    assert.equal(omitted.jobs[0]?.catalog_default_model, 'claude-default-model');
    assert.equal(omitted.jobs[0]?.model_selection_source, 'allowlist_fallback');

    const persisted = await agentRelayService.updateSettings({
      allowedWorkerModels: { claude: ['claude-test-model', 'claude-default-model'] },
    });
    assert.deepEqual(persisted.allowedWorkerModels.claude, ['claude-test-model', 'claude-default-model']);
    const after = await agentRelayService.getCapabilities();
    assert.deepEqual(after.catalogs[0]?.models.map((model) => model.value), ['claude-default-model', 'claude-test-model']);
    assert.equal(after.catalogs[0]?.defaultModel, 'claude-default-model');
  } finally {
    providerModelsService.getProviderModels = originalGetProviderModels;
    configureAgentRelayRuntimes({}, {});
    chatRunRegistry.clearAll();
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(root, { recursive: true, force: true });
  }
});

test('relay workers never bypass the permission envelope or inherit the relay MCP', () => {
  assert.equal(relayPermissionMode({ mode: 'read_only', provider: 'claude' }), 'plan');
  assert.equal(relayPermissionMode({ mode: 'read_only', provider: 'codex' }), 'plan');
  assert.equal(relayPermissionMode({ mode: 'read_only', provider: 'cursor' }), 'default');
  assert.equal(relayPermissionMode({ mode: 'isolated_write', provider: 'claude' }), 'default');
  assert.equal(relayPermissionMode({ mode: 'isolated_write', provider: 'codex' }), 'default');
  assert.equal(relayPermissionMode({ mode: 'read_only', provider: 'opencode' }), 'plan');
  assert.equal(providerSupportsReadOnlyRelay('claude'), true);
  assert.equal(providerSupportsReadOnlyRelay('cursor'), false);
  assert.equal(providerSupportsReadOnlyRelay('antigravity'), false);
  assert.equal(providerHonorsRelayMcpGrants('claude'), true);
  assert.equal(providerHonorsRelayMcpGrants('codex'), false);
  assert.equal(providerHonorsRelayMcpGrants('antigravity'), true);
  assert.deepEqual(
    sanitizeWorkerMcpServers(['obsidian', 'cloudcli-agent-relay', 'browser']),
    ['obsidian', 'browser'],
  );
});

test('resolveRelayEffort rejects values missing from the catalog', () => {
  const catalog = {
    DEFAULT: 'default',
    OPTIONS: [{
      value: 'default',
      label: 'Default',
      effort: { default: 'medium', values: [{ value: 'low' }, { value: 'high' }] },
    }],
  };
  assert.deepEqual(catalogEffortValuesForModel(catalog, 'default'), ['low', 'high']);
  assert.equal(resolveRelayEffort('high', catalog, 'default'), 'high');
  assert.equal(resolveRelayEffort('default', catalog, 'default'), null);
  assert.equal(resolveRelayEffort('max', { DEFAULT: 'x', OPTIONS: [{ value: 'x', label: 'x' }] }, 'x'), 'max');
  assert.throws(
    () => resolveRelayEffort('max', catalog, 'default'),
    /Effort "max" is not in the catalog/,
  );
});

test('auto provider pick skips Cursor for read_only and still allows explicit isolated_write', async () => {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const root = await makeScratchDir('agent-relay-auto-provider-');
  const projectPath = path.join(root, 'project');
  closeConnection();
  process.env.DATABASE_PATH = path.join(root, 'auth.db');
  await initializeDatabase();
  await mkdir(projectPath, { recursive: true });
  const originalGetProviderModels = providerModelsService.getProviderModels;
  providerModelsService.getProviderModels = async (provider: string) => ({
    models: {
      DEFAULT: `${provider}-default`,
      OPTIONS: [{ value: `${provider}-default`, label: `${provider} default` }],
    },
    cache: { updatedAt: new Date().toISOString(), expiresAt: new Date().toISOString(), source: 'fresh' },
  });
  configureAgentRelayRuntimes({
    claude: async (_command, _options, writer) => {
      const relayWriter = writer as { setSessionId: (id: string) => void; send: (message: unknown) => void };
      relayWriter.setSessionId('relay-claude');
      relayWriter.send({ kind: 'complete', provider: 'claude', exitCode: 0, success: true });
    },
    cursor: async (_command, _options, writer) => {
      const relayWriter = writer as { setSessionId: (id: string) => void; send: (message: unknown) => void };
      relayWriter.setSessionId('relay-cursor');
      relayWriter.send({ kind: 'complete', provider: 'cursor', exitCode: 0, success: true });
    },
  }, {});
  try {
    appConfigDb.set('agent_relay.settings', JSON.stringify({
      enabled: true,
      leadProviders: ['claude'],
      workerProviders: ['cursor', 'claude'],
      maxConcurrency: 2,
      defaultTimeoutMs: 60_000,
      defaultMode: 'read_only',
      installSkill: false,
    }));
    const autoRead = await agentRelayService.submitBatch({
      projectPath,
      tasks: [{ task: 'Scout the repo without a provider.' }],
    });
    assert.equal(autoRead.jobs[0]?.provider, 'claude');
    assert.equal(autoRead.jobs[0]?.mode, 'read_only');

    await assert.rejects(
      () => agentRelayService.submitBatch({
        projectPath,
        tasks: [{ task: 'Cursor cannot be read-only.', provider: 'cursor', mode: 'read_only' }],
      }),
      /does not expose a host-enforceable read-only/,
    );

    const write = await agentRelayService.submitBatch({
      projectPath,
      tasks: [{ task: 'Cursor may write when chosen.', provider: 'cursor', mode: 'isolated_write' }],
    });
    assert.equal(write.jobs[0]?.provider, 'cursor');
    assert.equal(write.jobs[0]?.mode, 'isolated_write');
  } finally {
    providerModelsService.getProviderModels = originalGetProviderModels;
    configureAgentRelayRuntimes({}, {});
    chatRunRegistry.clearAll();
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(root, { recursive: true, force: true });
  }
});

test('Agent Relay honors the project monthly run budget before queueing work', async () => {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const root = await makeScratchDir('agent-relay-budget-');
  const projectPath = path.join(root, 'project');
  closeConnection();
  process.env.DATABASE_PATH = path.join(root, 'auth.db');
  await initializeDatabase();
  await mkdir(projectPath, { recursive: true });
  try {
    appConfigDb.set('agent_relay.settings', JSON.stringify({
      enabled: true,
      leadProviders: ['claude'],
      workerProviders: ['claude'],
      maxConcurrency: 2,
      defaultTimeoutMs: 60_000,
      defaultMode: 'read_only',
      installSkill: true,
    }));
    const project = projectsDb.createProjectPath(projectPath).project!;
    runService.putBudget({ projectId: project.project_id, monthlyTokenBudget: 0 });
    await assert.rejects(
      () => agentRelayService.submitBatch({ projectPath, tasks: [{ task: 'Do not queue this.', provider: 'claude' }] }),
      /monthly token budget is exhausted/i,
    );
    assert.equal(agentRelayDb.list({ projectId: project.project_id }).length, 0);
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(root, { recursive: true, force: true });
  }
});

test('existing Agent Relay settings gain OpenCode as a lead once', async () => {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const root = await makeScratchDir('agent-relay-opencode-lead-');
  closeConnection();
  process.env.DATABASE_PATH = path.join(root, 'auth.db');
  await initializeDatabase();
  try {
    appConfigDb.set('agent_relay.settings', JSON.stringify({
      enabled: false,
      leadProviders: ['claude', 'codex'],
      workerProviders: ['claude'],
      maxConcurrency: 2,
      defaultTimeoutMs: 60_000,
      defaultMode: 'read_only',
      installSkill: false,
    }));
    // A fresh scratch database is seeded from the install-local legacy
    // `database/auth.db` when one exists, so on a developer machine the
    // migration flag arrives already set. Clear it so this test really
    // starts from the pre-migration state it is asserting about.
    getConnection().prepare("DELETE FROM app_config WHERE key = 'agent_relay.opencode_lead_v1'").run();

    const migrated = agentRelayService.getSettings();
    assert.deepEqual(migrated.leadProviders, ['claude', 'codex', 'opencode']);
    assert.deepEqual(agentRelayService.getSettings().leadProviders, ['claude', 'codex', 'opencode']);

    appConfigDb.set('agent_relay.settings', JSON.stringify({
      ...migrated,
      leadProviders: ['claude'],
    }));
    assert.deepEqual(agentRelayService.getSettings().leadProviders, ['claude']);
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(root, { recursive: true, force: true });
  }
});

test('workerProfiles persist, sanitize junk, fill and intersect MCP grants', async () => {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const root = await makeScratchDir('agent-relay-profiles-');
  const projectPath = path.join(root, 'project');
  closeConnection();
  process.env.DATABASE_PATH = path.join(root, 'auth.db');
  await initializeDatabase();
  await mkdir(projectPath, { recursive: true });
  const originalGetProviderModels = providerModelsService.getProviderModels;
  providerModelsService.getProviderModels = async (provider) => ({
    models: {
      DEFAULT: `${provider}-default`,
      OPTIONS: [{ value: `${provider}-default`, label: 'Default' }],
    },
    cache: { updatedAt: new Date().toISOString(), expiresAt: new Date().toISOString(), source: 'fresh' },
  });
  configureAgentRelayRuntimes({
    claude: async (_command, _options, writer) => {
      const relayWriter = writer as { setSessionId: (sessionId: string) => void; send: (message: unknown) => void };
      relayWriter.setSessionId('relay-native-claude');
      relayWriter.send({ kind: 'complete', provider: 'claude', exitCode: 0, success: true });
    },
    grok: async (_command, _options, writer) => {
      const relayWriter = writer as { setSessionId: (sessionId: string) => void; send: (message: unknown) => void };
      relayWriter.setSessionId('relay-native-grok');
      relayWriter.send({ kind: 'complete', provider: 'grok', exitCode: 0, success: true });
    },
    codex: async (_command, _options, writer) => {
      const relayWriter = writer as { setSessionId: (sessionId: string) => void; send: (message: unknown) => void };
      relayWriter.setSessionId('relay-native-codex');
      relayWriter.send({ kind: 'complete', provider: 'codex', exitCode: 0, success: true });
    },
  }, {});
  try {
    const persisted = await agentRelayService.updateSettings({
      enabled: true,
      leadProviders: ['claude'],
      workerProviders: ['claude', 'grok', 'codex'],
      workerProfiles: {
        claude: { mcpServers: ['obsidian', 'obsidian', ' cloudcli-agent-relay ', 'browser'] },
        grok: { mcpServers: ['obsidian', 'notes'], defaultMode: 'isolated_write', defaultApprovalPolicy: 'manual' },
        codex: { mcpServers: ['obsidian'] },
        // @ts-expect-error junk provider must be dropped
        notAProvider: { mcpServers: ['obsidian'] },
      },
    });
    assert.deepEqual(persisted.workerProfiles.claude?.mcpServers, ['obsidian', 'browser']);
    assert.deepEqual(persisted.workerProfiles.grok?.mcpServers, ['obsidian', 'notes']);
    assert.equal(Object.prototype.hasOwnProperty.call(persisted.workerProfiles, 'notAProvider'), false);

    const filledClaude = await agentRelayService.submitBatch({
      projectPath,
      tasks: [{ task: 'Fill MCP from profile.', provider: 'claude' }],
    });
    assert.deepEqual(filledClaude.jobs[0]?.mcp_servers, ['obsidian', 'browser']);

    const filledGrok = await agentRelayService.submitBatch({
      projectPath,
      tasks: [{ task: 'Fill MCP from grok profile.', provider: 'grok' }],
    });
    assert.deepEqual(filledGrok.jobs[0]?.mcp_servers, ['obsidian', 'notes']);
    assert.equal(filledGrok.jobs[0]?.mode, 'isolated_write');
    assert.equal(filledGrok.jobs[0]?.approval_policy, 'manual');

    const intersected = await agentRelayService.submitBatch({
      projectPath,
      tasks: [{ task: 'Intersect MCP lists.', provider: 'claude', mcpServers: ['obsidian', 'slack'] }],
    });
    assert.deepEqual(intersected.jobs[0]?.mcp_servers, ['obsidian']);

    const ignoredCodex = await agentRelayService.submitBatch({
      projectPath,
      tasks: [{ task: 'Codex ignores profile MCP.', provider: 'codex' }],
    });
    assert.deepEqual(ignoredCodex.jobs[0]?.mcp_servers, []);
  } finally {
    providerModelsService.getProviderModels = originalGetProviderModels;
    configureAgentRelayRuntimes({}, {});
    chatRunRegistry.clearAll();
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(root, { recursive: true, force: true });
  }
});

test('Agent Relay MCP scope ignores body sourceSessionId and requires a live interactive header', async () => {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const root = await makeScratchDir('agent-relay-mcp-scope-');
  closeConnection();
  process.env.DATABASE_PATH = path.join(root, 'auth.db');
  await initializeDatabase();
  try {
    const { resolveAgentRelayMcpScope } = await import('@/modules/agent-relay/agent-relay.routes.js');
    const lead = sessionsService.createAppSession('claude', root).sessionId;
    const worker = sessionsService.createAppSession('claude', root, { internal: true }).sessionId;
    assert.equal(resolveAgentRelayMcpScope({ headers: {} }, { sourceSessionId: lead }).sourceSessionId, null);
    assert.equal(
      resolveAgentRelayMcpScope({ headers: { 'x-cloudcli-lead-session-id': lead } }, { sourceSessionId: worker }).sourceSessionId,
      lead,
    );
    assert.equal(
      resolveAgentRelayMcpScope({ headers: { 'x-cloudcli-lead-session-id': worker } }, {}).sourceSessionId,
      null,
    );
    assert.equal(
      resolveAgentRelayMcpScope({ headers: { 'x-cloudcli-lead-session-id': 'missing' } }, {}).sourceSessionId,
      null,
    );
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(root, { recursive: true, force: true });
  }
});

test('Agent Relay purges terminal jobs older than the retention window', async () => {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const root = await makeScratchDir('agent-relay-purge-');
  const projectPath = path.join(root, 'project');
  closeConnection();
  process.env.DATABASE_PATH = path.join(root, 'auth.db');
  await initializeDatabase();
  await mkdir(projectPath, { recursive: true });
  appConfigDb.set('agent_relay.settings', JSON.stringify({
    enabled: false,
    leadProviders: ['claude'],
    workerProviders: ['claude'],
    maxConcurrency: 1,
    defaultTimeoutMs: 60_000,
    defaultMode: 'read_only',
    installSkill: true,
  }));
  try {
    const project = projectsDb.createProjectPath(projectPath).project!;
    const makeJob = (task: string) => agentRelayDb.create({
      relayId: newRelayJobId(),
      batchId: newRelayBatchId(),
      projectId: project.project_id,
      projectPath,
      provider: 'claude',
      mode: 'read_only',
      task,
      prompt: task,
      mcpServers: [],
      timeoutMs: 60_000,
    });
    const oldJob = makeJob('Old completed job.');
    const freshJob = makeJob('Fresh completed job.');
    const runningJob = makeJob('Still running job.');
    agentRelayDb.finish(oldJob.relay_id, 'completed', {});
    agentRelayDb.finish(freshJob.relay_id, 'completed', {});
    getConnection().prepare(`
      UPDATE agent_relay_jobs SET finished_at = datetime('now', '-20 days'), updated_at = datetime('now', '-20 days')
      WHERE relay_id = ?
    `).run(oldJob.relay_id);
    getConnection().prepare(`
      UPDATE agent_relay_jobs SET status = 'running', started_at = datetime('now', '-20 days'),
        updated_at = datetime('now', '-20 days'), finished_at = NULL
      WHERE relay_id = ?
    `).run(runningJob.relay_id);
    agentRelayDb.createApproval({
      approvalId: `appr_${oldJob.relay_id}`,
      relayId: oldJob.relay_id,
      requestId: `req_${oldJob.relay_id}`,
      toolName: 'Bash',
      command: null,
      paths: [],
      cwd: null,
      reason: 'stale',
    });

    const result = await agentRelayService.purgeExpiredJobs(14);
    assert.equal(result.jobsDeleted, 1);
    assert.equal(agentRelayDb.get(oldJob.relay_id), null);
    assert.ok(agentRelayDb.get(freshJob.relay_id));
    assert.equal(agentRelayDb.get(runningJob.relay_id)?.status, 'running');
    assert.equal(
      (getConnection().prepare('SELECT COUNT(*) AS n FROM agent_relay_approvals WHERE relay_id = ?').get(oldJob.relay_id) as { n: number }).n,
      0,
    );
  } finally {
    chatRunRegistry.clearAll();
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(root, { recursive: true, force: true });
  }
});
