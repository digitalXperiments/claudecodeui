import assert from 'node:assert/strict';
import test from 'node:test';

import {
  __setClaudeSdkTestOverrides,
  abortClaudeSDKSession,
  applyPlanModeAllowedTools,
  closeAllWarmClaudeSessions,
  createRequestId,
  extractPermissionPaths,
  extractTokenBudget,
  getWarmClaudeSessionStats,
  isClaudeSDKSessionActive,
  isTurnActivityMessage,
  mapCliOptionsToSDK,
  prewarmClaudeSession,
  queryClaudeSDK,
  readJsonFileCached,
  releaseWarmClaudeSession,
  resolveApprovalTimeoutMs,
  resolveToolApproval,
  updateClaudePermissionMode,
  trackBackgroundTask,
  waitForToolApproval,
} from './claude-sdk.js';
import { CLAUDE_FALLBACK_MODELS } from './modules/providers/list/claude/claude-models.provider.js';

const ENV_KEY = 'CLOUDCLI_UNATTENDED_APPROVAL_TIMEOUT_MS';

function withEnv(value, fn) {
  const previous = process.env[ENV_KEY];
  if (value === undefined) {
    delete process.env[ENV_KEY];
  } else {
    process.env[ENV_KEY] = value;
  }
  try {
    return fn();
  } finally {
    if (previous === undefined) {
      delete process.env[ENV_KEY];
    } else {
      process.env[ENV_KEY] = previous;
    }
  }
}

test('resolveApprovalTimeoutMs keeps interactive runs unbounded', () => {
  withEnv(undefined, () => {
    assert.equal(resolveApprovalTimeoutMs(), 0);
    assert.equal(resolveApprovalTimeoutMs({ unattended: false }), 0);
    // Interactive stays 0 even when a budget is configured.
    assert.equal(resolveApprovalTimeoutMs({ unattended: false, approvalTimeoutMs: 5000 }), 0);
  });
});

test('resolveApprovalTimeoutMs bounds unattended runs', () => {
  withEnv(undefined, () => {
    assert.equal(resolveApprovalTimeoutMs({ unattended: true }), 10 * 60_000);
    assert.equal(resolveApprovalTimeoutMs({ unattended: true, approvalTimeoutMs: 5000 }), 5000);
    // Non-positive/unparseable option values fall through to the default so a
    // misconfigured 0 can never reintroduce an infinite headless wait.
    assert.equal(resolveApprovalTimeoutMs({ unattended: true, approvalTimeoutMs: 0 }), 10 * 60_000);
    assert.equal(resolveApprovalTimeoutMs({ unattended: true, approvalTimeoutMs: 'nope' }), 10 * 60_000);
  });

  withEnv('120000', () => {
    assert.equal(resolveApprovalTimeoutMs({ unattended: true }), 120000);
    // Explicit option wins over the env var.
    assert.equal(resolveApprovalTimeoutMs({ unattended: true, approvalTimeoutMs: 5000 }), 5000);
  });

  withEnv('not-a-number', () => {
    assert.equal(resolveApprovalTimeoutMs({ unattended: true }), 10 * 60_000);
  });
});

test('extractPermissionPaths pulls common path shapes from tool input', () => {
  assert.deepEqual(extractPermissionPaths(null), []);
  assert.deepEqual(extractPermissionPaths('git status'), []);
  assert.deepEqual(extractPermissionPaths({ command: 'git status' }), []);
  assert.deepEqual(extractPermissionPaths({ file_path: '/a/b.js' }), ['/a/b.js']);
  assert.deepEqual(extractPermissionPaths({ filePath: '/a/b.js', path: '/c/d.js' }), ['/a/b.js', '/c/d.js']);
  assert.deepEqual(extractPermissionPaths({ paths: ['/a', '/b'], files: ['/c'] }), ['/a', '/b', '/c']);
  // Codex applyPatchApproval shape.
  assert.deepEqual(extractPermissionPaths({ changes: { '/repo/x.ts': { kind: 'update' } } }), ['/repo/x.ts']);
});

test('extractTokenBudget ignores Claude result aggregates after per-response usage', () => {
  assert.equal(
    extractTokenBudget({
      type: 'result',
      usage: { input_tokens: 50_000, output_tokens: 2_000 },
      modelUsage: {},
    }),
    null,
  );

  const perResponse = extractTokenBudget({
    type: 'assistant',
    message: {
      model: 'claude-sonnet-5',
      usage: {
        input_tokens: 100,
        cache_read_input_tokens: 900,
        cache_creation_input_tokens: 50,
        output_tokens: 25,
      },
    },
  });
  assert.equal(perResponse?.billedInputTokens, 1_050);
  assert.equal(perResponse?.billedOutputTokens, 25);
});

test('bounded waitForToolApproval resolves null on expiry (deny path)', async () => {
  const requestId = createRequestId();
  const decision = await waitForToolApproval(requestId, { timeoutMs: 25 });
  assert.equal(decision, null);
});

test('plan mode does not inject Task for relay workers or when Task is disallowed', () => {
  const interactive = applyPlanModeAllowedTools(['Read'], {});
  assert.ok(interactive.includes('Task'));
  assert.ok(interactive.includes('exit_plan_mode'));

  const relay = applyPlanModeAllowedTools(['Read'], { relayWorker: true, disallowedTools: ['Task', 'Agent'] });
  assert.equal(relay.includes('Task'), false);
  assert.ok(relay.includes('Read'));
  assert.ok(relay.includes('WebSearch'));

  const disallowed = applyPlanModeAllowedTools([], { disallowedTools: ['Task'] });
  assert.equal(disallowed.includes('Task'), false);
  assert.ok(disallowed.includes('TodoRead'));
});

test('bounded waitForToolApproval still accepts a broker decision in time', async () => {
  const requestId = createRequestId();
  const pending = waitForToolApproval(requestId, { timeoutMs: 5000 });
  resolveToolApproval(requestId, { allow: true, updatedInput: { ok: true } });
  const decision = await pending;
  assert.deepEqual(decision, { allow: true, updatedInput: { ok: true } });
});

test('mapCliOptionsToSDK keeps the requested model for relay workers and drops settingSources', () => {
  // A relay worker asking for haiku must not have its explicit model
  // rewritten by the operator's own project/user/local Claude settings
  // (which is exactly what loading those settingSources allows).
  const sdkOptions = mapCliOptionsToSDK({
    model: 'claude-haiku-4-5-20251001',
    relayWorker: true,
  });
  assert.equal(sdkOptions.model, 'claude-haiku-4-5-20251001');
  assert.deepEqual(sdkOptions.settingSources, []);
});

test('mapCliOptionsToSDK still loads project/user/local settings for interactive (non-relay) sessions', () => {
  const sdkOptions = mapCliOptionsToSDK({ model: 'claude-sonnet-5' });
  assert.deepEqual(sdkOptions.settingSources, ['project', 'user', 'local']);
});

test('trackBackgroundTask keeps tasks in flight until they settle', () => {
  const inflight = new Set();
  trackBackgroundTask({ type: 'system', subtype: 'task_started', task_id: 'bash-1' }, inflight);
  trackBackgroundTask({ type: 'system', subtype: 'task_started', task_id: 'agent-2' }, inflight);
  trackBackgroundTask({ type: 'system', subtype: 'task_progress', task_id: 'bash-1' }, inflight);
  trackBackgroundTask({ type: 'system', subtype: 'task_updated', task_id: 'bash-1', patch: { is_backgrounded: true } }, inflight);
  assert.deepEqual([...inflight].sort(), ['agent-2', 'bash-1']);

  trackBackgroundTask({ type: 'system', subtype: 'task_notification', task_id: 'bash-1', status: 'completed' }, inflight);
  trackBackgroundTask({ type: 'system', subtype: 'task_updated', task_id: 'agent-2', patch: { status: 'killed' } }, inflight);
  assert.equal(inflight.size, 0);

  trackBackgroundTask({ type: 'result', task_id: 'ignored' }, inflight);
  assert.equal(inflight.size, 0);
});

test('isTurnActivityMessage only counts model output as a resumed turn', () => {
  assert.equal(isTurnActivityMessage({ type: 'assistant' }), true);
  assert.equal(isTurnActivityMessage({ type: 'stream_event' }), true);
  assert.equal(isTurnActivityMessage({ type: 'system', subtype: 'task_notification' }), false);
  assert.equal(isTurnActivityMessage({ type: 'result' }), false);
});

// ---------------------------------------------------------------------------
// Warm Claude sessions (SDK query mocked)
// ---------------------------------------------------------------------------

function createAsyncQueue() {
  const items = [];
  let waiter = null;
  let done = false;
  let failure = null;
  const wake = () => {
    if (waiter) {
      const resolve = waiter;
      waiter = null;
      resolve();
    }
  };
  return {
    push(item) {
      if (done) return;
      items.push(item);
      wake();
    },
    end() {
      done = true;
      wake();
    },
    fail(error) {
      failure = error;
      done = true;
      wake();
    },
    async *iterate() {
      while (true) {
        if (items.length > 0) {
          yield items.shift();
          continue;
        }
        if (failure) throw failure;
        if (done) return;
        await new Promise((resolve) => {
          waiter = resolve;
        });
      }
    },
  };
}

let fakeSeq = 0;

/**
 * Fake SDK `query`: one instance per spawned "process". Answers each pushed
 * user message with init/assistant/result and "exits" when stdin ends.
 */
function installFakeQuery() {
  const instances = [];
  const factory = ({ prompt, options }) => {
    const out = createAsyncQueue();
    const sessionId = options.resume || `fake-session-${++fakeSeq}`;
    const inst = {
      options,
      sessionId,
      prompts: [],
      closed: false,
      interrupted: false,
      exited: false,
      crashOnNext: false,
      async interrupt() {
        inst.interrupted = true;
      },
      close() {
        inst.closed = true;
        out.end();
      },
      [Symbol.asyncIterator]() {
        return out.iterate();
      },
    };
    (async () => {
      for await (const message of prompt) {
        inst.prompts.push(message);
        const text = message.message.content?.[0]?.text ?? message.message.content;
        if (inst.crashOnNext) {
          out.fail(new Error('claude process exited with code 1'));
          return;
        }
        if (typeof text === 'string' && text.includes('HANG')) {
          continue; // never answers; only an abort ends this turn
        }
        out.push({ type: 'system', subtype: 'init', session_id: sessionId });
        if (typeof text === 'string' && text.includes('STREAM') && options.includePartialMessages) {
          const ev = (event, parent = null) => ({ type: 'stream_event', session_id: sessionId, parent_tool_use_id: parent, event });
          const assistantEarly = text.includes('EARLY');
          out.push(ev({ type: 'message_start', message: { id: 'm1' } }));
          out.push(ev({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }));
          out.push(ev({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Pondering' } }));
          out.push(ev({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig' } }));
          out.push(ev({ type: 'content_block_stop', index: 0 }));
          out.push({ type: 'assistant', session_id: sessionId, message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'Pondering' }] } });
          out.push(ev({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }));
          out.push(ev({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Hel' } }));
          // A subagent's partial frames must not leak into the main bubble.
          out.push(ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'SUB' } }, 'toolu_1'));
          out.push(ev({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'lo' } }));
          const finalText = { type: 'assistant', session_id: sessionId, message: { role: 'assistant', content: [{ type: 'text', text: 'Hello' }] } };
          if (assistantEarly) out.push(finalText);
          out.push(ev({ type: 'content_block_stop', index: 1 }));
          if (!assistantEarly) out.push(finalText);
          out.push({ type: 'assistant', session_id: sessionId, message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_2', name: 'Read', input: { file_path: '/x' } }] } });
          out.push(ev({ type: 'message_stop' }));
          out.push({ type: 'result', subtype: 'success', session_id: sessionId, is_error: false, result: 'ok' });
          continue;
        }
        out.push({
          type: 'assistant',
          session_id: sessionId,
          message: { role: 'assistant', content: [{ type: 'text', text: `echo ${text}` }] },
        });
        out.push({ type: 'result', subtype: 'success', session_id: sessionId, is_error: false, result: 'ok' });
      }
      inst.exited = true;
      out.end();
    })();
    instances.push(inst);
    return inst;
  };
  const overrides = {
    query: factory,
    resolveResumeModel: async (_sessionId, model) => model,
    loadEffortModels: async () => CLAUDE_FALLBACK_MODELS,
    loadMcpConfig: async () => null,
    applyClaudeSpawnAuthEnv: async () => {},
  };
  __setClaudeSdkTestOverrides(overrides);
  // Tests can swap individual seams: __setClaudeSdkTestOverrides({ ...instances.overrides, ... }).
  instances.overrides = overrides;
  return instances;
}

function createWriter() {
  const sent = [];
  return {
    userId: null,
    sent,
    send(message) {
      sent.push(message);
    },
    completes() {
      return sent.filter((message) => message.kind === 'complete');
    },
    errors() {
      return sent.filter((message) => message.kind === 'error');
    },
  };
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function withWarmEnv(env, fn) {
  const keys = [
    'CLOUDCLI_WARM_CLAUDE_SESSIONS',
    'CLOUDCLI_CLAUDE_WARM_TTL_MS',
    'CLOUDCLI_CLAUDE_WARM_MAX',
    'CLOUDCLI_CLAUDE_DRAIN_GRACE_MS',
    'CLOUDCLI_CLAUDE_PREWARM',
  ];
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  process.env.CLOUDCLI_CLAUDE_DRAIN_GRACE_MS = '5';
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  // Drain/idle timers are unref'd (the real server keeps the loop alive);
  // hold the test's event loop open explicitly.
  const keepAlive = setInterval(() => {}, 1_000);
  try {
    return await fn(installFakeQuery());
  } finally {
    clearInterval(keepAlive);
    await closeAllWarmClaudeSessions();
    __setClaudeSdkTestOverrides(null);
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const chatOptions = (overrides = {}) => ({
  appSessionId: 'app-warm-1',
  model: 'sonnet',
  permissionMode: 'default',
  toolsSettings: { allowedTools: [], disallowedTools: [], skipPermissions: false },
  ...overrides,
});

test('warm sessions: follow-up reuses the parked process and each run completes once', async () => {
  await withWarmEnv({}, async (instances) => {
    const first = createWriter();
    await queryClaudeSDK('hello', chatOptions(), first);
    assert.equal(instances.length, 1);
    assert.equal(first.completes().length, 1);
    assert.equal(first.completes()[0].exitCode, 0);
    const sessionId = instances[0].sessionId;
    assert.ok(first.sent.some((message) => message.kind === 'session_created'));
    // Parked: alive, but not reported as an active/processing session.
    assert.deepEqual(getWarmClaudeSessionStats().parked, [sessionId]);
    assert.equal(Boolean(isClaudeSDKSessionActive(sessionId)), false);
    assert.equal(Boolean(isClaudeSDKSessionActive('app-warm-1')), false);
    assert.equal(instances[0].exited, false);

    const second = createWriter();
    await queryClaudeSDK('again', chatOptions({ sessionId }), second);
    assert.equal(instances.length, 1, 'no new process for the follow-up');
    assert.equal(instances[0].prompts.length, 2);
    assert.equal(second.completes().length, 1);
    assert.equal(second.errors().length, 0);
    assert.equal(first.completes().length, 1, 'earlier writer receives nothing more');
    assert.deepEqual(getWarmClaudeSessionStats().parked, [sessionId]);
  });
});

test('warm sessions: a material option change evicts the warm process', async () => {
  await withWarmEnv({}, async (instances) => {
    await queryClaudeSDK('hello', chatOptions(), createWriter());
    const sessionId = instances[0].sessionId;

    const second = createWriter();
    await queryClaudeSDK('plan it', chatOptions({ sessionId, permissionMode: 'plan' }), second);
    assert.equal(instances.length, 2, 'permission mode change spawns a fresh process');
    assert.equal(instances[0].exited || instances[0].closed, true, 'old process was told to exit');
    assert.equal(instances[1].options.permissionMode, 'plan');
    assert.equal(instances[1].options.resume, sessionId);
    assert.equal(second.completes().length, 1);

    await queryClaudeSDK('model swap', chatOptions({ sessionId, permissionMode: 'plan', model: 'opus' }), createWriter());
    assert.equal(instances.length, 3, 'model change spawns a fresh process');
  });
});

test('warm sessions: idle TTL closes the parked process', async () => {
  await withWarmEnv({ CLOUDCLI_CLAUDE_WARM_TTL_MS: '40' }, async (instances) => {
    await queryClaudeSDK('hello', chatOptions(), createWriter());
    const sessionId = instances[0].sessionId;
    assert.deepEqual(getWarmClaudeSessionStats().parked, [sessionId]);
    await delay(120);
    assert.deepEqual(getWarmClaudeSessionStats().parked, []);
    assert.equal(instances[0].exited, true);

    await queryClaudeSDK('later', chatOptions({ sessionId }), createWriter());
    assert.equal(instances.length, 2);
  });
});

test('warm sessions: pool is capped with LRU eviction', async () => {
  await withWarmEnv({ CLOUDCLI_CLAUDE_WARM_MAX: '2' }, async (instances) => {
    for (const app of ['app-a', 'app-b', 'app-c']) {
      await queryClaudeSDK('hello', chatOptions({ appSessionId: app }), createWriter());
    }
    const [a, b, c] = instances;
    assert.deepEqual(getWarmClaudeSessionStats().parked, [b.sessionId, c.sessionId]);
    await delay(20);
    assert.equal(a.exited, true, 'least recently used process was closed');

    // Reusing b makes it most-recent; the next park evicts c.
    await queryClaudeSDK('again', chatOptions({ appSessionId: 'app-b', sessionId: b.sessionId }), createWriter());
    await queryClaudeSDK('hello', chatOptions({ appSessionId: 'app-d' }), createWriter());
    assert.deepEqual(getWarmClaudeSessionStats().parked, [b.sessionId, instances[3].sessionId]);
  });
});

test('warm sessions: a warm process that crashed before answering falls back to a fresh query', async () => {
  await withWarmEnv({}, async (instances) => {
    await queryClaudeSDK('hello', chatOptions(), createWriter());
    const sessionId = instances[0].sessionId;
    instances[0].crashOnNext = true;

    const writer = createWriter();
    await queryClaudeSDK('after crash', chatOptions({ sessionId }), writer);
    assert.equal(instances.length, 2, 'retried on a fresh process');
    assert.equal(instances[1].options.resume, sessionId);
    assert.equal(writer.errors().length, 0);
    assert.equal(writer.completes().length, 1);
    assert.equal(writer.completes()[0].exitCode, 0);
  });
});

test('warm sessions: abort during a reused turn does not respawn and sends no complete', async () => {
  await withWarmEnv({}, async (instances) => {
    await queryClaudeSDK('hello', chatOptions(), createWriter());
    const sessionId = instances[0].sessionId;

    const writer = createWriter();
    const run = queryClaudeSDK('HANG please', chatOptions({ sessionId }), writer);
    await delay(20);
    assert.equal(Boolean(isClaudeSDKSessionActive(sessionId)), true, 'reused turn is active while running');
    assert.equal(await abortClaudeSDKSession('app-warm-1'), true);
    await run;
    assert.equal(instances.length, 1, 'aborted turn is not retried');
    assert.equal(instances[0].interrupted, true);
    assert.equal(writer.completes().length, 0, 'abort handler owns the terminal complete');
    assert.deepEqual(getWarmClaudeSessionStats().parked, []);
  });
});

test('warm sessions: disabled flag restores one process per run', async () => {
  await withWarmEnv({ CLOUDCLI_WARM_CLAUDE_SESSIONS: '0' }, async (instances) => {
    const writer = createWriter();
    await queryClaudeSDK('hello', chatOptions(), writer);
    assert.equal(writer.completes().length, 1);
    assert.deepEqual(getWarmClaudeSessionStats().parked, []);
    await delay(10);
    assert.equal(instances[0].exited, true);

    await queryClaudeSDK('again', chatOptions({ sessionId: instances[0].sessionId }), createWriter());
    assert.equal(instances.length, 2);
  });
});

test('warm sessions: unattended and relay-worker runs never park', async () => {
  await withWarmEnv({}, async (instances) => {
    await queryClaudeSDK('auto', chatOptions({ unattended: true }), createWriter());
    await queryClaudeSDK('worker', chatOptions({ appSessionId: 'app-relay', relayWorker: true }), createWriter());
    assert.deepEqual(getWarmClaudeSessionStats().parked, []);
    await delay(10);
    assert.ok(instances.every((inst) => inst.exited));
  });
});


// --- Prewarm (chat.prewarm) -------------------------------------------------

const PREWARM_SID = 'prov-prewarm-1';
const prewarmOptions = (overrides = {}) => chatOptions({ sessionId: PREWARM_SID, resume: true, ...overrides });

/** Makes the per-run setup (model resolution) wait until `release()` is called. */
function gateResumeModel(instances) {
  let release = () => {};
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  __setClaudeSdkTestOverrides({
    ...instances.overrides,
    resolveResumeModel: async (_sessionId, model) => {
      await gate;
      return model;
    },
  });
  return () => release();
}

test('prewarm: boots a process without a message and the next send reuses it', async () => {
  await withWarmEnv({}, async (instances) => {
    assert.equal(await prewarmClaudeSession(PREWARM_SID, prewarmOptions()), true);
    assert.equal(instances.length, 1, 'one process spawned');
    assert.equal(instances[0].prompts.length, 0, 'no message pushed: no model call');
    assert.equal(instances[0].options.resume, PREWARM_SID);
    assert.deepEqual(getWarmClaudeSessionStats().parked, [PREWARM_SID]);
    assert.equal(Boolean(isClaudeSDKSessionActive(PREWARM_SID)), false, 'prewarmed process is not a running session');

    const writer = createWriter();
    await queryClaudeSDK('first turn', chatOptions({ sessionId: PREWARM_SID }), writer);
    assert.equal(instances.length, 1, 'send reused the prewarmed process (single spawn)');
    assert.equal(instances[0].prompts.length, 1);
    assert.equal(writer.completes().length, 1);
    assert.equal(writer.completes()[0].exitCode, 0);
    assert.equal(writer.errors().length, 0);
    assert.deepEqual(getWarmClaudeSessionStats().parked, [PREWARM_SID], 'parks again after the turn');
  });
});

test('prewarm: an option mismatch on send evicts the prewarmed process', async () => {
  await withWarmEnv({}, async (instances) => {
    assert.equal(await prewarmClaudeSession(PREWARM_SID, prewarmOptions()), true);
    const writer = createWriter();
    await queryClaudeSDK('with opus', chatOptions({ sessionId: PREWARM_SID, model: 'opus' }), writer);
    assert.equal(instances.length, 2, 'fresh process for the changed model');
    assert.equal(instances[0].exited || instances[0].closed, true, 'prewarmed process was retired');
    assert.equal(instances[0].prompts.length, 0);
    assert.equal(instances[1].options.model, 'opus');
    assert.equal(writer.completes().length, 1);
  });
});

test('prewarm: a changed prewarm replaces a stale warm process; a matching one is a no-op', async () => {
  await withWarmEnv({}, async (instances) => {
    assert.equal(await prewarmClaudeSession(PREWARM_SID, prewarmOptions()), true);
    assert.equal(await prewarmClaudeSession(PREWARM_SID, prewarmOptions()), true);
    assert.equal(instances.length, 1, 'matching repeat keeps the process');
    assert.equal(await prewarmClaudeSession(PREWARM_SID, prewarmOptions({ model: 'opus' })), true);
    assert.equal(instances.length, 2);
    assert.equal(instances[0].exited || instances[0].closed, true);
    assert.deepEqual(getWarmClaudeSessionStats().parked, [PREWARM_SID]);
  });
});

test('prewarm: kill switch and warm-session flag disable it', async () => {
  await withWarmEnv({ CLOUDCLI_CLAUDE_PREWARM: '0' }, async (instances) => {
    assert.equal(await prewarmClaudeSession(PREWARM_SID, prewarmOptions()), false);
    assert.equal(instances.length, 0);
  });
  await withWarmEnv({ CLOUDCLI_WARM_CLAUDE_SESSIONS: '0' }, async (instances) => {
    assert.equal(await prewarmClaudeSession(PREWARM_SID, prewarmOptions()), false);
    assert.equal(instances.length, 0);
  });
  await withWarmEnv({}, async (instances) => {
    assert.equal(await prewarmClaudeSession(PREWARM_SID, prewarmOptions({ unattended: true })), false);
    assert.equal(await prewarmClaudeSession(PREWARM_SID, prewarmOptions({ appSessionId: undefined })), false);
    assert.equal(instances.length, 0);
  });
});

test('prewarm: concurrent requests for one session share a single attempt', async () => {
  await withWarmEnv({}, async (instances) => {
    const release = gateResumeModel(instances);
    const first = prewarmClaudeSession(PREWARM_SID, prewarmOptions());
    const second = prewarmClaudeSession(PREWARM_SID, prewarmOptions());
    assert.equal(first, second, 'deduped to the in-flight promise');
    assert.deepEqual(getWarmClaudeSessionStats().prewarming, [PREWARM_SID]);
    release();
    assert.equal(await first, true);
    assert.equal(instances.length, 1);
    assert.deepEqual(getWarmClaudeSessionStats().prewarming, []);
  });
});

test('prewarm: no-op while a turn is running for the session', async () => {
  await withWarmEnv({}, async (instances) => {
    const writer = createWriter();
    const run = queryClaudeSDK('HANG please', chatOptions({ sessionId: PREWARM_SID }), writer);
    await delay(20);
    assert.equal(instances.length, 1);
    assert.equal(await prewarmClaudeSession(PREWARM_SID, prewarmOptions()), false);
    assert.equal(await prewarmClaudeSession(PREWARM_SID, prewarmOptions({ model: 'opus' })), false);
    assert.equal(instances.length, 1, 'no second process on the running transcript');
    assert.equal(instances[0].closed || instances[0].exited, false, 'running process untouched');
    assert.equal(await abortClaudeSDKSession('app-warm-1'), true);
    await run;
  });
});

test('prewarm: a send during prewarm setup waits for it and reuses the booting process', async () => {
  await withWarmEnv({}, async (instances) => {
    const release = gateResumeModel(instances);
    const prewarm = prewarmClaudeSession(PREWARM_SID, prewarmOptions());
    const writer = createWriter();
    const send = queryClaudeSDK('right away', chatOptions({ sessionId: PREWARM_SID }), writer);
    await delay(10);
    assert.equal(instances.length, 0, 'nothing spawned while setup is gated');
    release();
    assert.equal(await prewarm, true);
    await send;
    assert.equal(instances.length, 1, 'exactly one claude process for the transcript');
    assert.equal(instances[0].prompts.length, 1);
    assert.equal(writer.completes().length, 1);
    assert.equal(writer.completes()[0].exitCode, 0);
  });
});

test('prewarm: a prewarm arriving after a send claimed the session yields', async () => {
  await withWarmEnv({}, async (instances) => {
    const release = gateResumeModel(instances);
    const writer = createWriter();
    const send = queryClaudeSDK('first', chatOptions({ sessionId: PREWARM_SID }), writer);
    await delay(5); // the send has claimed the session and is in setup
    const prewarm = prewarmClaudeSession(PREWARM_SID, prewarmOptions());
    release();
    assert.equal(await prewarm, false);
    await send;
    assert.equal(instances.length, 1, 'only the send spawned');
    assert.equal(writer.completes().length, 1);
  });
});

test('prewarm: never LRU-evicts a warm process a pending send is about to use', async () => {
  await withWarmEnv({ CLOUDCLI_CLAUDE_WARM_MAX: '1' }, async (instances) => {
    await queryClaudeSDK('hello', chatOptions({ appSessionId: 'app-a' }), createWriter());
    const aSid = instances[0].sessionId;
    assert.deepEqual(getWarmClaudeSessionStats().parked, [aSid]);

    const release = gateResumeModel(instances);
    const writer = createWriter();
    const send = queryClaudeSDK('again', chatOptions({ appSessionId: 'app-a', sessionId: aSid }), writer);
    await delay(5); // claimed, still in setup
    const prewarm = prewarmClaudeSession('prov-b', chatOptions({ appSessionId: 'app-b', sessionId: 'prov-b', resume: true }));
    release();
    assert.equal(await prewarm, false, 'the prewarm yielded its slot');
    await send;
    assert.equal(instances[0].prompts.length, 2, 'the pending send reused its warm process');
    assert.equal(instances.length, 2);
    assert.equal(instances[1].prompts.length, 0);
    await delay(20);
    assert.equal(instances[1].exited || instances[1].closed, true, 'the prewarmed process was the one evicted');
    assert.deepEqual(getWarmClaudeSessionStats().parked, [aSid]);
  });
});

test('prewarm: an unused prewarmed process is TTL-evicted and closed on shutdown', async () => {
  await withWarmEnv({ CLOUDCLI_CLAUDE_WARM_TTL_MS: '40' }, async (instances) => {
    assert.equal(await prewarmClaudeSession(PREWARM_SID, prewarmOptions()), true);
    await delay(120);
    assert.deepEqual(getWarmClaudeSessionStats().parked, []);
    assert.equal(instances[0].exited, true);
  });
  await withWarmEnv({}, async (instances) => {
    const release = gateResumeModel(instances);
    const prewarm = prewarmClaudeSession(PREWARM_SID, prewarmOptions());
    setTimeout(release, 10);
    await closeAllWarmClaudeSessions(); // waits for the in-flight prewarm, then closes it
    assert.equal(await prewarm, true);
    assert.deepEqual(getWarmClaudeSessionStats().parked, []);
    await delay(10);
    assert.equal(instances[0].exited || instances[0].closed, true);
  });
});

test('prewarm: releaseWarmClaudeSession retires the parked process (Agent CLI handoff)', async () => {
  await withWarmEnv({}, async (instances) => {
    assert.equal(await prewarmClaudeSession(PREWARM_SID, prewarmOptions()), true);
    await releaseWarmClaudeSession(PREWARM_SID);
    assert.deepEqual(getWarmClaudeSessionStats().parked, []);
    assert.equal(instances[0].exited || instances[0].closed, true);
    await releaseWarmClaudeSession(PREWARM_SID); // no-op when nothing is parked
    await releaseWarmClaudeSession('');
  });
});

for (const variant of ['STREAM', 'STREAM EARLY']) {
  test(`streaming: deltas stream live and the final assistant text is not duplicated (${variant})`, async () => {
    await withWarmEnv({}, async (instances) => {
      const writer = createWriter();
      await queryClaudeSDK(variant, chatOptions(), writer);
      assert.equal(instances[0].options.includePartialMessages, true);

      const kinds = writer.sent.map((message) => message.kind);
      const deltas = writer.sent.filter((message) => message.kind === 'stream_delta').map((message) => message.content);
      assert.equal(deltas.join(''), 'Hello', 'only main-thread text deltas are streamed');
      assert.ok(deltas.length >= 1 && deltas.length <= 2, 'back-to-back deltas are coalesced');
      assert.equal(kinds.filter((kind) => kind === 'stream_end').length, 1, 'one stream_end for the text block');
      assert.ok(kinds.indexOf('stream_end') > kinds.lastIndexOf('stream_delta'));

      const thinking = writer.sent.filter((message) => message.kind === 'thinking').map((message) => message.content);
      assert.deepEqual(thinking, ['Pondering'], 'thinking streamed once; final thinking block dropped');

      const assistantTexts = writer.sent.filter((message) => message.kind === 'text' && message.role === 'assistant');
      assert.equal(assistantTexts.length, 0, 'streamed text is not re-sent as a whole text message');
      assert.equal(writer.sent.filter((message) => message.kind === 'tool_use').length, 1, 'non-text blocks still flow');
      assert.equal(writer.sent.some((message) => message.kind === 'stream_event'), false);
      assert.equal(writer.completes().length, 1);
    });
  });
}

test('streaming: unattended runs keep whole text messages without partials', async () => {
  await withWarmEnv({}, async (instances) => {
    const writer = createWriter();
    await queryClaudeSDK('STREAM', chatOptions({ unattended: true }), writer);
    assert.equal(instances[0].options.includePartialMessages, undefined);
    assert.equal(writer.sent.filter((message) => message.kind === 'stream_delta').length, 0);
    assert.equal(writer.sent.filter((message) => message.kind === 'text' && message.role === 'assistant').length, 1);
  });
});

test('readJsonFileCached re-parses only when mtime/size change', async () => {
  const { mkdtemp, writeFile, rm, utimes } = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'claude-json-cache-'));
  const file = path.join(dir, 'config.json');
  try {
    await writeFile(file, JSON.stringify({ a: 1 }));
    const first = await readJsonFileCached(file);
    const second = await readJsonFileCached(file);
    assert.equal(first, second, 'same parsed object while unchanged');

    await writeFile(file, JSON.stringify({ a: 22 }));
    const future = new Date(Date.now() + 5_000);
    await utimes(file, future, future);
    const third = await readJsonFileCached(file);
    assert.deepEqual(third, { a: 22 });

    await rm(file);
    await assert.rejects(readJsonFileCached(file), (error) => error.code === 'ENOENT');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});


test('live Claude permission updates reach the SDK and leave questions unanswered', async () => {
  await withWarmEnv({ CLOUDCLI_WARM_CLAUDE_SESSIONS: '1' }, async (instances) => {
    const writer = createWriter();
    await queryClaudeSDK('hello', { appSessionId: 'live-permissions', cwd: process.cwd(), permissionMode: 'default' }, writer);
    const instance = instances[0];
    const modes = [];
    instance.setPermissionMode = async (mode) => { modes.push(mode); };
    const toolId = createRequestId();
    const questionId = createRequestId();
    const tool = waitForToolApproval(toolId, { timeoutMs: 0, metadata: { _sessionId: instance.sessionId, _toolName: 'Bash' } });
    let questionAnswered = false;
    const question = waitForToolApproval(questionId, { timeoutMs: 0, metadata: { _sessionId: instance.sessionId, _toolName: 'AskUserQuestion' } })
      .then(() => { questionAnswered = true; });
    try {
      assert.equal(await updateClaudePermissionMode(instance.sessionId, 'bypassPermissions', 'live-permissions'), true);
      assert.deepEqual(modes, ['bypassPermissions']);
      assert.equal(instance.options.permissionMode, 'bypassPermissions');
      assert.equal((await tool).allow, true);
      assert.equal(questionAnswered, false);
      instance.setPermissionMode = async () => { throw new Error('mode rejected'); };
      await assert.rejects(updateClaudePermissionMode(instance.sessionId, 'plan', 'live-permissions'), /mode rejected/);
      assert.equal(instance.options.permissionMode, 'bypassPermissions');
    } finally {
      resolveToolApproval(toolId, { allow: false });
      resolveToolApproval(questionId, { allow: false });
      await question;
    }
  });
});


test('interactive Claude enables live bypass switching without selecting bypass', () => {
  const options = mapCliOptionsToSDK({ appSessionId: 'app', permissionMode: 'default' });
  assert.equal(options.allowDangerouslySkipPermissions, true);
  assert.notEqual(options.permissionMode, 'bypassPermissions');
  assert.equal(mapCliOptionsToSDK({ appSessionId: 'worker', relayWorker: true }).allowDangerouslySkipPermissions, undefined);
});
