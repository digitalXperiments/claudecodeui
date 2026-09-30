import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import test from 'node:test';

import { createCodexAppServer } from './codex-app-server.js';
import {
  __setCodexTestOverrides,
  abortCodexSession,
  closeAllWarmCodexSessions,
  getWarmCodexSessionStats,
  isCodexSessionActive,
  queryCodex,
  releaseWarmCodexSession,
} from './openai-codex.js';

// ---------------------------------------------------------------------------
// Fake `codex app-server` child process speaking JSONL JSON-RPC on stdio.
// ---------------------------------------------------------------------------

let threadSeq = 0;

function createFakeChild(behaviour = {}) {
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.killed = false;
  child.requests = [];
  child.notifications = [];
  child.behaviour = behaviour;
  child.turnSeq = 0;
  child.heldTurn = null;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();

  const send = (message) => {
    if (!child.stdout.destroyed && !child.stdout.writableEnded) {
      child.stdout.write(`${JSON.stringify(message)}\n`);
    }
  };
  child.send = send;

  const terminate = (code, signal) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.exitCode = code;
    child.signalCode = signal;
    setImmediate(() => {
      if (!child.stdout.destroyed) child.stdout.end();
      if (!child.stderr.destroyed) child.stderr.end();
      child.emit('exit', code, signal);
      setImmediate(() => child.emit('close', code, signal));
    });
  };
  child.kill = (signal = 'SIGTERM') => {
    child.killed = true;
    terminate(null, signal);
    return true;
  };
  child.crash = () => terminate(1, null);
  Object.defineProperty(child, 'alive', {
    get: () => child.exitCode === null && child.signalCode === null,
  });

  const completeTurn = (threadId, turnId, status = 'completed') => {
    send({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status } } });
  };
  child.completeTurn = completeTurn;

  const runTurn = (threadId, turnId) => {
    setImmediate(() => {
      child.behaviour.beforeTurnEvents?.(child, threadId, turnId);
      send({ method: 'turn/started', params: { threadId, turn: { id: turnId } } });
      send({ method: 'item/started', params: { threadId, turnId, item: { type: 'agentMessage', id: `${turnId}-msg` } } });
      send({ method: 'item/agentMessage/delta', params: { threadId, turnId, itemId: `${turnId}-msg`, delta: `reply ${turnId}` } });
      send({ method: 'item/completed', params: { threadId, turnId, item: { type: 'agentMessage', id: `${turnId}-msg`, text: `reply ${turnId}` } } });
      completeTurn(threadId, turnId);
    });
  };

  const handle = (message) => {
    if (typeof message.id === 'undefined') {
      child.notifications.push(message);
      return;
    }
    child.requests.push(message);
    const { id, method, params = {} } = message;
    const reply = (result) => send({ id, result });
    if (child.behaviour.silent) return;
    switch (method) {
      case 'initialize':
        reply({});
        break;
      case 'thread/start':
        reply({ thread: { id: `thread-new-${++threadSeq}` } });
        break;
      case 'thread/resume':
        reply({ thread: { id: params.threadId } });
        break;
      case 'turn/start': {
        if (child.behaviour.failTurnStart) {
          send({ id, error: { message: 'thread not loaded' } });
          break;
        }
        const turnId = `${params.threadId}-turn-${++child.turnSeq}`;
        reply({ turn: { id: turnId } });
        if (child.behaviour.holdTurn) {
          child.heldTurn = { threadId: params.threadId, turnId };
        } else {
          runTurn(params.threadId, turnId);
        }
        break;
      }
      case 'turn/interrupt':
        reply({});
        setImmediate(() => completeTurn(params.threadId, params.turnId, 'interrupted'));
        break;
      default:
        reply({});
    }
  };

  let buffer = '';
  child.stdin = new Writable({
    write(chunk, _encoding, callback) {
      buffer += chunk.toString();
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.trim()) handle(JSON.parse(line));
      }
      callback();
    },
  });
  return child;
}

function createWriter() {
  return {
    isWebSocketWriter: true,
    messages: [],
    send(message) {
      this.messages.push(message);
    },
    setSessionId() {},
    count(kind) {
      return this.messages.filter((m) => m.kind === kind).length;
    },
    text() {
      return this.messages.filter((m) => m.kind === 'stream_delta').map((m) => m.content).join('|');
    },
  };
}

const WARM_ENV_KEYS = [
  'CLOUDCLI_WARM_CODEX_SESSIONS',
  'CLOUDCLI_CODEX_WARM_TTL_MS',
  'CLOUDCLI_CODEX_WARM_MAX',
];

async function withWarmEnv(env, fn) {
  const previous = Object.fromEntries(WARM_ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of WARM_ENV_KEYS) {
    if (env[key] === undefined) delete process.env[key];
    else process.env[key] = env[key];
  }
  const children = [];
  const ctx = { children, nextBehaviour: {} };
  __setCodexTestOverrides({
    spawn: () => {
      const child = createFakeChild(ctx.nextBehaviour);
      ctx.nextBehaviour = {};
      children.push(child);
      return child;
    },
    resolveResumeModel: async (_id, model) => model || 'gpt-test',
    getProviderModels: async () => ({
      models: {
        OPTIONS: [
          { value: 'gpt-test', effort: { values: [{ value: 'high' }, { value: 'low' }] } },
          { value: 'gpt-other', effort: { values: [{ value: 'high' }] } },
        ],
      },
    }),
    loadManagedObsidianCodexRuntime: () => null,
    authStamp: () => 1,
    isProviderInstalled: async () => true,
  });
  try {
    await fn(ctx);
  } finally {
    await closeAllWarmCodexSessions();
    for (const child of children) {
      if (child.alive) child.kill('SIGKILL');
    }
    __setCodexTestOverrides({});
    for (const key of WARM_ENV_KEYS) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

function baseOptions(extra = {}) {
  return {
    cwd: '/tmp',
    appSessionId: 'app-codex-warm-1',
    permissionMode: 'default',
    ...extra,
  };
}

async function runTurn(options) {
  const writer = createWriter();
  await queryCodex('hello', options, writer);
  return writer;
}

function methods(child) {
  return child.requests.map((r) => r.method);
}

async function firstTurn(extra = {}) {
  const writer = await runTurn(baseOptions(extra));
  const created = writer.messages.find((m) => m.kind === 'session_created');
  return { writer, threadId: created.newSessionId };
}

// ---------------------------------------------------------------------------

test('warm codex: follow-up reuses the parked app-server, skipping initialize + thread/resume', async () => {
  await withWarmEnv({}, async ({ children }) => {
    const { writer: first, threadId } = await firstTurn();
    assert.equal(children.length, 1);
    assert.equal(first.count('complete'), 1);
    assert.deepEqual(getWarmCodexSessionStats().parked, [threadId]);
    assert.equal(isCodexSessionActive(threadId), false, 'parked process is not shown as processing');
    assert.ok(children[0].alive);

    const second = await runTurn(baseOptions({ sessionId: threadId, model: 'gpt-other', effort: 'high' }));
    assert.equal(children.length, 1, 'no new spawn');
    assert.equal(second.count('complete'), 1);
    assert.equal(second.count('error'), 0);
    assert.deepEqual(methods(children[0]), ['initialize', 'thread/start', 'turn/start', 'turn/start']);
    const turnStart = children[0].requests.at(-1);
    assert.equal(turnStart.params.model, 'gpt-other', 'model is a per-turn param');
    assert.equal(turnStart.params.effort, 'high');
    assert.equal(turnStart.params.threadId, threadId);
    assert.equal(isCodexSessionActive(threadId), false);
    assert.deepEqual(getWarmCodexSessionStats().parked, [threadId]);
  });
});

test('warm codex: releaseWarmCodexSession retires the parked app-server (Agent CLI handoff)', async () => {
  await withWarmEnv({}, async ({ children }) => {
    const { threadId } = await firstTurn();
    assert.deepEqual(getWarmCodexSessionStats().parked, [threadId]);
    await releaseWarmCodexSession(threadId);
    assert.deepEqual(getWarmCodexSessionStats().parked, []);
    assert.equal(children[0].alive, false);
    await releaseWarmCodexSession(threadId); // no-op when nothing is parked
  });
});

test('warm codex: notifications from a previous turn never reach the next run', async () => {
  await withWarmEnv({}, async ({ children }) => {
    const { threadId } = await firstTurn();
    const child = children[0];
    const oldTurnId = `${threadId}-turn-1`;

    // Straggler while parked: dropped, process stays warm.
    child.send({ method: 'item/agentMessage/delta', params: { threadId, turnId: oldTurnId, itemId: 'x', delta: 'LEAK-IDLE' } });
    await tick(5);
    assert.deepEqual(getWarmCodexSessionStats().parked, [threadId]);

    // Straggler during the next run: dropped from that run's writer.
    child.behaviour.beforeTurnEvents = (c, tid) => {
      c.send({ method: 'item/agentMessage/delta', params: { threadId: tid, turnId: oldTurnId, itemId: 'y', delta: 'LEAK-RUN' } });
    };
    const second = await runTurn(baseOptions({ sessionId: threadId }));
    assert.equal(second.text(), `reply ${threadId}-turn-2`);
    assert.ok(!second.text().includes('LEAK'));
    assert.equal(second.count('complete'), 1);
  });
});

test('warm codex: unexpected turn activity while parked retires the process', async () => {
  await withWarmEnv({}, async ({ children }) => {
    const { threadId } = await firstTurn();
    children[0].send({ method: 'turn/started', params: { threadId, turn: { id: 'surprise' } } });
    await tick(10);
    assert.deepEqual(getWarmCodexSessionStats().parked, []);
    assert.equal(children[0].killed, true);

    // A server request while idle is answered (so codex does not hang) and retires.
    const again = await runTurn(baseOptions({ sessionId: threadId }));
    assert.equal(children.length, 2);
    assert.equal(again.count('complete'), 1);
    children[1].send({ id: 99, method: 'item/commandExecution/requestApproval', params: { threadId } });
    await tick(10);
    assert.deepEqual(getWarmCodexSessionStats().parked, []);
    assert.equal(children[1].killed, true);
  });
});

test('warm codex: a process-level option change (cwd) respawns', async () => {
  await withWarmEnv({}, async ({ children }) => {
    const { threadId } = await firstTurn();
    await runTurn(baseOptions({ sessionId: threadId, cwd: '/' }));
    assert.equal(children.length, 2);
    assert.equal(children[0].killed, true);
    assert.deepEqual(methods(children[1]), ['initialize', 'thread/resume', 'turn/start']);
    assert.deepEqual(getWarmCodexSessionStats().parked, [threadId]);
  });
});

test('warm codex: sandbox (permission mode) change respawns', async () => {
  await withWarmEnv({}, async ({ children }) => {
    const { threadId } = await firstTurn();
    await runTurn(baseOptions({ sessionId: threadId, permissionMode: 'bypassPermissions' }));
    assert.equal(children.length, 2, 'sandbox mode is process/thread-level');
  });
});

test('warm codex: clearing a sticky turn override (effort -> default) respawns', async () => {
  await withWarmEnv({}, async ({ children }) => {
    const { threadId } = await firstTurn({ effort: 'high' });
    await runTurn(baseOptions({ sessionId: threadId, effort: 'low' }));
    assert.equal(children.length, 1, 'changing effort is a per-turn override');
    await runTurn(baseOptions({ sessionId: threadId }));
    assert.equal(children.length, 2, 'clearing effort needs a fresh thread load');
  });
});

test('warm codex: idle TTL retires the parked process and releases its listeners', async () => {
  await withWarmEnv({ CLOUDCLI_CODEX_WARM_TTL_MS: '30' }, async ({ children }) => {
    const { threadId } = await firstTurn();
    assert.deepEqual(getWarmCodexSessionStats().parked, [threadId]);
    await tick(80);
    assert.deepEqual(getWarmCodexSessionStats().parked, []);
    const child = children[0];
    assert.equal(child.killed, true);
    assert.equal(child.stdout.listenerCount('data'), 0);
    assert.equal(child.stderr.listenerCount('data'), 0);
    assert.equal(child.stdout.destroyed, true);
    assert.equal(getWarmCodexSessionStats().live, 0);
  });
});

test('warm codex: pool is capped with LRU eviction', async () => {
  await withWarmEnv({ CLOUDCLI_CODEX_WARM_MAX: '2' }, async ({ children }) => {
    const a = await firstTurn({ appSessionId: 'app-a' });
    const b = await firstTurn({ appSessionId: 'app-b' });
    const c = await firstTurn({ appSessionId: 'app-c' });
    assert.deepEqual(getWarmCodexSessionStats().parked, [b.threadId, c.threadId]);
    assert.equal(children[0].killed, true);
    // Reusing b refreshes its LRU position.
    await runTurn(baseOptions({ appSessionId: 'app-b', sessionId: b.threadId }));
    assert.deepEqual(getWarmCodexSessionStats().parked, [c.threadId, b.threadId]);
    assert.equal(children.length, 3);
    assert.ok(a.threadId);
  });
});

test('warm codex: a parked process that crashed falls back to a fresh spawn', async () => {
  await withWarmEnv({}, async ({ children }) => {
    const { threadId } = await firstTurn();
    children[0].crash();
    await tick(10);
    assert.deepEqual(getWarmCodexSessionStats().parked, [], 'crash removes it from the pool');
    const next = await runTurn(baseOptions({ sessionId: threadId }));
    assert.equal(children.length, 2);
    assert.equal(next.count('complete'), 1);
    assert.equal(next.count('error'), 0);
  });
});

test('warm codex: warm turn/start rejection respawns transparently', async () => {
  await withWarmEnv({}, async ({ children }) => {
    const { threadId } = await firstTurn();
    children[0].behaviour.failTurnStart = true;
    const next = await runTurn(baseOptions({ sessionId: threadId }));
    assert.equal(children.length, 2);
    assert.equal(children[0].killed, true);
    assert.equal(next.count('complete'), 1);
    assert.equal(next.count('error'), 0);
    assert.deepEqual(methods(children[1]), ['initialize', 'thread/resume', 'turn/start']);
    assert.deepEqual(getWarmCodexSessionStats().parked, [threadId]);
  });
});

test('warm codex: abort during a reused turn interrupts, sends no complete, and retires', async () => {
  await withWarmEnv({}, async ({ children }) => {
    const { threadId } = await firstTurn();
    children[0].behaviour.holdTurn = true;
    const writer = createWriter();
    const run = queryCodex('hello', baseOptions({ sessionId: threadId }), writer);
    for (let i = 0; i < 50 && !children[0].heldTurn; i += 1) await tick(2);
    assert.ok(isCodexSessionActive(threadId));
    assert.equal(abortCodexSession(threadId), true);
    await run;
    assert.equal(writer.count('complete'), 0, 'abort-session owns the aborted complete');
    assert.ok(methods(children[0]).includes('turn/interrupt'));
    assert.deepEqual(getWarmCodexSessionStats().parked, []);
    assert.equal(children[0].killed, true);
    assert.equal(isCodexSessionActive(threadId), false);
  });
});

test('warm codex: a crash mid-turn ends the run with one error complete', async () => {
  await withWarmEnv({}, async ({ children }) => {
    const { threadId } = await firstTurn();
    children[0].behaviour.holdTurn = true;
    const writer = createWriter();
    const run = queryCodex('hello', baseOptions({ sessionId: threadId }), writer);
    for (let i = 0; i < 50 && !children[0].heldTurn; i += 1) await tick(2);
    children[0].crash();
    await run;
    assert.equal(writer.count('complete'), 1);
    assert.equal(writer.messages.find((m) => m.kind === 'complete').exitCode, 1);
    assert.deepEqual(getWarmCodexSessionStats().parked, []);
  });
});

test('warm codex: kill switch restores one process per turn', async () => {
  await withWarmEnv({ CLOUDCLI_WARM_CODEX_SESSIONS: '0' }, async ({ children }) => {
    const { threadId } = await firstTurn();
    assert.deepEqual(getWarmCodexSessionStats().parked, []);
    await runTurn(baseOptions({ sessionId: threadId }));
    assert.equal(children.length, 2);
    await tick(10);
    assert.ok(children.every((child) => child.killed));
  });
});

test('warm codex: TTL 0, unattended, relay workers and missing appSessionId stay per-turn', async () => {
  for (const [env, extra] of [
    [{ CLOUDCLI_CODEX_WARM_TTL_MS: '0' }, {}],
    [{}, { unattended: true }],
    [{}, { relayWorker: true }],
    [{}, { appSessionId: undefined }],
  ]) {
    await withWarmEnv(env, async ({ children }) => {
      await firstTurn(extra);
      assert.deepEqual(getWarmCodexSessionStats().parked, [], JSON.stringify(extra));
      await tick(5);
      assert.equal(children[0].killed, true);
    });
  }
});

test('warm codex: closeAllWarmCodexSessions closes every parked process', async () => {
  await withWarmEnv({}, async ({ children }) => {
    await firstTurn({ appSessionId: 'app-x' });
    await firstTurn({ appSessionId: 'app-y' });
    assert.equal(getWarmCodexSessionStats().parked.length, 2);
    await closeAllWarmCodexSessions();
    assert.deepEqual(getWarmCodexSessionStats().parked, []);
    assert.ok(children.every((child) => child.killed && !child.alive));
    assert.equal(getWarmCodexSessionStats().live, 0);
  });
});

test('codex app-server client: close() removes every listener and destroys stdio', async () => {
  const child = createFakeChild();
  const rpc = createCodexAppServer({ cwd: '/tmp', env: {}, spawnFn: () => child });
  const offMessage = rpc.onMessage(() => {});
  rpc.onExit(() => {});
  assert.ok(child.stdout.listenerCount('data') > 0);
  assert.ok(child.stderr.listenerCount('data') > 0);
  assert.equal(rpc.getListenerStats().messageHandlers, 1);

  rpc.close();
  assert.deepEqual(
    { ...rpc.getListenerStats(), exitHandlers: 0 },
    { messageHandlers: 0, exitHandlers: 0, pendingRequests: 0, stdoutData: 0, stderrData: 0, rlLine: 0 },
  );
  assert.equal(child.stdout.destroyed, true);
  assert.equal(child.stderr.destroyed, true);
  assert.equal(child.killed, true);
  await rpc.exited;
  assert.equal(rpc.getListenerStats().exitHandlers, 0, 'exit handlers released after exit');
  assert.equal(rpc.alive, false);
  offMessage();
  assert.throws(() => rpc.notify('initialized'), /closed/);
});

test('codex app-server client: pending requests reject when the child crashes', async () => {
  const child = createFakeChild();
  const rpc = createCodexAppServer({ cwd: '/tmp', env: {}, spawnFn: () => child });
  let exitSeen = null;
  rpc.onExit((info) => {
    exitSeen = info;
  });
  child.behaviour.silent = true; // never answers
  const pending = rpc.request('initialize');
  child.crash();
  await assert.rejects(pending, /exited|closed/);
  await rpc.exited;
  assert.deepEqual(exitSeen, { code: 1, signal: null });
  assert.equal(rpc.getListenerStats().stdoutData, 0);
  assert.equal(rpc.getListenerStats().exitHandlers, 0);
});
