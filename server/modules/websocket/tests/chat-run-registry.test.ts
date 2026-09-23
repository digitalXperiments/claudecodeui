import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { WebSocket } from 'ws';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { chatRunRegistry } from '@/modules/websocket/services/chat-run-registry.service.js';
import {
  handleChatSubscribe,
  type ChatWebSocketDependencies,
} from '@/modules/websocket/services/chat-websocket.service.js';
import { connectedClients } from '@/modules/websocket/services/websocket-state.service.js';

/**
 * Minimal stand-in for a websocket connection: collects every JSON frame the
 * gateway writer forwards so assertions can inspect the outbound protocol.
 */
class FakeConnection {
  readyState = 1; // WS_OPEN_STATE
  frames: Array<Record<string, unknown>> = [];

  send(data: string): void {
    this.frames.push(JSON.parse(data) as Record<string, unknown>);
  }
}

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'chat-run-registry-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await initializeDatabase();

  try {
    await runTest();
  } finally {
    connectedClients.clear();
    chatRunRegistry.clearAll();
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

test('live events are remapped to the app session id and sequenced', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('app-run-1', 'claude', '/workspace/demo');
    const connection = new FakeConnection();
    const run = chatRunRegistry.startRun({
      appSessionId: 'app-run-1',
      provider: 'claude',
      providerSessionId: null,
      connection,
      userId: 'user-1',
    });
    assert.ok(run);

    run.writer.send({ kind: 'stream_delta', provider: 'claude', sessionId: 'provider-id-9', content: 'hello' });
    run.writer.send({ kind: 'text', provider: 'claude', sessionId: 'provider-id-9', content: 'hello world' });

    assert.equal(connection.frames.length, 2);
    assert.equal(connection.frames[0]?.sessionId, 'app-run-1');
    assert.equal(connection.frames[0]?.seq, 1);
    assert.equal(connection.frames[1]?.sessionId, 'app-run-1');
    assert.equal(connection.frames[1]?.seq, 2);
  });
});

test('session_created is swallowed and persisted as the provider-id mapping', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('app-run-2', 'cursor', '/workspace/demo');
    const connection = new FakeConnection();
    connectedClients.add(connection as never);
    const run = chatRunRegistry.startRun({
      appSessionId: 'app-run-2',
      provider: 'cursor',
      providerSessionId: null,
      connection,
      userId: null,
    });
    assert.ok(run);

    run.writer.send({
      kind: 'session_created',
      provider: 'cursor',
      sessionId: 'cursor-native-7',
      newSessionId: 'cursor-native-7',
    });

    // The provider-native event itself is never forwarded...
    const sessionUpserts = connection.frames.filter((frame) => frame.kind === 'session_upserted');
    assert.equal(sessionUpserts.length, 1);
    assert.equal(sessionUpserts[0]?.sessionId, 'app-run-2');
    assert.equal(sessionUpserts[0]?.providerSessionId, 'cursor-native-7');
    // ...but the canonical mapping is recorded and persisted in the database.
    assert.equal(run.providerSessionId, 'cursor-native-7');
    assert.equal(sessionsDb.getSessionById('app-run-2')?.provider_session_id, 'cursor-native-7');
  });
});

test('complete marks the run finished and duplicate completes are dropped', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('app-run-3', 'codex', '/workspace/demo');
    const connection = new FakeConnection();
    const run = chatRunRegistry.startRun({
      appSessionId: 'app-run-3',
      provider: 'codex',
      providerSessionId: null,
      connection,
      userId: null,
    });
    assert.ok(run);

    run.writer.send({ kind: 'complete', provider: 'codex', sessionId: 'native-3', exitCode: 0 });
    // Late duplicate from a killed runtime's exit handler.
    run.writer.send({ kind: 'complete', provider: 'codex', sessionId: 'native-3', exitCode: 1 });

    const completes = connection.frames.filter((frame) => frame.kind === 'complete');
    assert.equal(completes.length, 1);
    assert.equal(completes[0]?.actualSessionId, 'app-run-3');
    assert.equal(chatRunRegistry.isProcessing('app-run-3'), false);

    // completeRun is also a no-op once the run already completed.
    chatRunRegistry.completeRun('app-run-3', { exitCode: 1 });
    assert.equal(connection.frames.filter((frame) => frame.kind === 'complete').length, 1);
  });
});

test('a finished run\'s safety net cannot complete the session\'s next run', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('app-run-9', 'codex', '/workspace/demo');
    const connection = new FakeConnection();

    const firstRun = chatRunRegistry.startRun({
      appSessionId: 'app-run-9',
      provider: 'codex',
      providerSessionId: null,
      connection,
      userId: null,
    });
    assert.ok(firstRun);
    firstRun.writer.send({ kind: 'complete', provider: 'codex', sessionId: 'native-9', exitCode: 0 });

    // A queued message starts the next run before the first run's runtime
    // promise settles (the chat handler's `finally` hasn't executed yet).
    const secondRun = chatRunRegistry.startRun({
      appSessionId: 'app-run-9',
      provider: 'codex',
      providerSessionId: null,
      connection,
      userId: null,
    });
    assert.ok(secondRun);

    // First run's safety net fires late: it must not touch the new run.
    chatRunRegistry.completeRunIfCurrent(firstRun, { exitCode: 1 });
    assert.equal(chatRunRegistry.isProcessing('app-run-9'), true);
    assert.equal(connection.frames.filter((frame) => frame.kind === 'complete').length, 1);

    // The second run's own safety net still works while it is current.
    chatRunRegistry.completeRunIfCurrent(secondRun, { exitCode: 1 });
    assert.equal(chatRunRegistry.isProcessing('app-run-9'), false);
    assert.equal(connection.frames.filter((frame) => frame.kind === 'complete').length, 2);
  });
});

test('listRunningRuns returns only currently running app sessions', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('app-run-7', 'claude', '/workspace/demo');
    sessionsDb.createAppSession('app-run-8', 'codex', '/workspace/demo');
    const connection = new FakeConnection();

    const completedRun = chatRunRegistry.startRun({
      appSessionId: 'app-run-7',
      provider: 'claude',
      providerSessionId: null,
      connection,
      userId: null,
    });
    assert.ok(completedRun);

    const runningRun = chatRunRegistry.startRun({
      appSessionId: 'app-run-8',
      provider: 'codex',
      providerSessionId: null,
      connection,
      userId: null,
    });
    assert.ok(runningRun);

    chatRunRegistry.completeRun('app-run-7', { exitCode: 0 });

    const runningSessions = chatRunRegistry.listRunningRuns();
    assert.deepEqual(runningSessions.map((session) => session.sessionId), ['app-run-8']);
    assert.equal(runningSessions[0]?.provider, 'codex');
  });
});

test('replayEvents returns only events after the requested seq', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('app-run-4', 'claude', '/workspace/demo');
    const connection = new FakeConnection();
    const run = chatRunRegistry.startRun({
      appSessionId: 'app-run-4',
      provider: 'claude',
      providerSessionId: null,
      connection,
      userId: null,
    });
    assert.ok(run);

    run.writer.send({ kind: 'stream_delta', provider: 'claude', sessionId: 'x', content: 'a' });
    run.writer.send({ kind: 'stream_delta', provider: 'claude', sessionId: 'x', content: 'b' });
    run.writer.send({ kind: 'stream_delta', provider: 'claude', sessionId: 'x', content: 'c' });

    const replayed = chatRunRegistry.replayEvents('app-run-4', 1);
    assert.deepEqual(replayed.map((event) => event.content), ['b', 'c']);
    assert.deepEqual(replayed.map((event) => event.seq), [2, 3]);
  });
});

test('attachConnection fans the live stream out to every attached socket', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('app-run-5', 'opencode', '/workspace/demo');
    const firstConnection = new FakeConnection();
    const run = chatRunRegistry.startRun({
      appSessionId: 'app-run-5',
      provider: 'opencode',
      providerSessionId: null,
      connection: firstConnection,
      userId: null,
    });
    assert.ok(run);

    run.writer.send({ kind: 'stream_delta', provider: 'opencode', sessionId: 'o', content: 'before' });

    const secondConnection = new FakeConnection();
    assert.equal(chatRunRegistry.attachConnection('app-run-5', secondConnection), true);
    run.writer.send({ kind: 'stream_delta', provider: 'opencode', sessionId: 'o', content: 'after' });

    // Both tabs keep receiving the stream — subscribing no longer steals it.
    assert.deepEqual(firstConnection.frames.map((frame) => frame.content), ['before', 'after']);
    assert.deepEqual(secondConnection.frames.map((frame) => frame.content), ['after']);
  });
});

test('attaching the same socket twice is idempotent', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('app-run-12', 'opencode', '/workspace/demo');
    const connection = new FakeConnection();
    const run = chatRunRegistry.startRun({
      appSessionId: 'app-run-12',
      provider: 'opencode',
      providerSessionId: null,
      connection,
      userId: null,
    });
    assert.ok(run);

    assert.equal(chatRunRegistry.attachConnection('app-run-12', connection), false);
    run.writer.send({ kind: 'stream_delta', provider: 'opencode', sessionId: 'o', content: 'once' });

    assert.deepEqual(connection.frames.map((frame) => frame.content), ['once']);
  });
});

test('detachConnection removes a closed socket from every run', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('app-run-10', 'opencode', '/workspace/demo');
    const firstConnection = new FakeConnection();
    const run = chatRunRegistry.startRun({
      appSessionId: 'app-run-10',
      provider: 'opencode',
      providerSessionId: null,
      connection: firstConnection,
      userId: null,
    });
    assert.ok(run);

    const secondConnection = new FakeConnection();
    assert.equal(chatRunRegistry.attachConnection('app-run-10', secondConnection), true);

    // The second tab closes: its socket is detached from all runs.
    chatRunRegistry.detachConnection(secondConnection);
    run.writer.send({ kind: 'stream_delta', provider: 'opencode', sessionId: 'o', content: 'live' });

    assert.deepEqual(firstConnection.frames.map((frame) => frame.content), ['live']);
    assert.deepEqual(secondConnection.frames.map((frame) => frame.content), []);
  });
});

test('closed sockets are pruned lazily from the fan-out set on send', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('app-run-11', 'opencode', '/workspace/demo');
    const firstConnection = new FakeConnection();
    const run = chatRunRegistry.startRun({
      appSessionId: 'app-run-11',
      provider: 'opencode',
      providerSessionId: null,
      connection: firstConnection,
      userId: null,
    });
    assert.ok(run);

    // A subscriber whose socket is already CLOSED (readyState 3) — e.g. it
    // went away without an explicit detach.
    const deadConnection = new FakeConnection();
    deadConnection.readyState = 3;
    chatRunRegistry.attachConnection('app-run-11', deadConnection);

    run.writer.send({ kind: 'stream_delta', provider: 'opencode', sessionId: 'o', content: 'live' });

    assert.deepEqual(firstConnection.frames.map((frame) => frame.content), ['live']);
    assert.equal(deadConnection.frames.length, 0);
  });
});

test('startRun rejects a second concurrent run for the same session', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('app-run-6', 'opencode', '/workspace/demo');
    const connection = new FakeConnection();
    const first = chatRunRegistry.startRun({
      appSessionId: 'app-run-6',
      provider: 'opencode',
      providerSessionId: null,
      connection,
      userId: null,
    });
    assert.ok(first);

    const second = chatRunRegistry.startRun({
      appSessionId: 'app-run-6',
      provider: 'opencode',
      providerSessionId: null,
      connection,
      userId: null,
    });
    assert.equal(second, null);

    // After the run finishes a new one is allowed again.
    chatRunRegistry.completeRun('app-run-6', { exitCode: 0 });
    const third = chatRunRegistry.startRun({
      appSessionId: 'app-run-6',
      provider: 'opencode',
      providerSessionId: null,
      connection,
      userId: null,
    });
    assert.ok(third);
  });
});

test('frames emitted after complete are forwarded unsequenced and never buffered', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('app-run-late', 'opencode', '/workspace/demo');
    const connection = new FakeConnection();
    const run = chatRunRegistry.startRun({
      appSessionId: 'app-run-late',
      provider: 'opencode',
      providerSessionId: null,
      connection,
      userId: null,
    });
    assert.ok(run);

    run.writer.send({ kind: 'text', provider: 'opencode', sessionId: 'p', content: 'done' });
    run.writer.send({ kind: 'complete', provider: 'opencode', sessionId: 'p', exitCode: 0 });
    run.writer.send({ kind: 'status', provider: 'opencode', sessionId: 'p', text: 'token_budget', tokenBudget: { used: 1 } });

    assert.equal(connection.frames.length, 3);
    const late = connection.frames[2];
    assert.equal(late?.text, 'token_budget');
    assert.equal(late?.sessionId, 'app-run-late');
    assert.equal('seq' in (late ?? {}), false);
    assert.equal(run.lastSeq, 2);
    assert.deepEqual(chatRunRegistry.replayEvents('app-run-late', 0).map((event) => event.seq), [1, 2]);

    // The session's next run starts cleanly at seq 1.
    const next = chatRunRegistry.startRun({
      appSessionId: 'app-run-late',
      provider: 'opencode',
      providerSessionId: null,
      connection,
      userId: null,
    });
    assert.ok(next);
    next.writer.send({ kind: 'text', provider: 'opencode', sessionId: 'p', content: 'again' });
    assert.equal(connection.frames.at(-1)?.seq, 1);
  });
});

test('pending-send reservations report processing until every token is released', async () => {
  await withIsolatedDatabase(() => {
    const sessionId = 'app-run-pending';
    assert.equal(chatRunRegistry.isRunningOrPending(sessionId), false);

    const releaseA = chatRunRegistry.reservePendingSend(sessionId);
    const releaseB = chatRunRegistry.reservePendingSend(sessionId);
    assert.equal(chatRunRegistry.hasPendingSend(sessionId), true);
    assert.equal(chatRunRegistry.isRunningOrPending(sessionId), true);
    // Reservations are not runs: Shell's run-idle wait must not see them.
    assert.equal(chatRunRegistry.isProcessing(sessionId), false);

    releaseA();
    releaseA();
    assert.equal(chatRunRegistry.hasPendingSend(sessionId), true);
    releaseB();
    assert.equal(chatRunRegistry.hasPendingSend(sessionId), false);
    assert.equal(chatRunRegistry.isRunningOrPending(sessionId), false);
  });
});

test('a socket that subscribes during a pending send follows the run it registers', async () => {
  await withIsolatedDatabase(() => {
    const sessionId = 'app-run-pending-attach';
    sessionsDb.createAppSession(sessionId, 'codex', '/workspace/demo');
    const release = chatRunRegistry.reservePendingSend(sessionId);

    // No prior run exists for this session: the subscriber is parked.
    const subscriber = new FakeConnection();
    handleChatSubscribe(
      subscriber as unknown as WebSocket,
      { sessions: [{ sessionId }] },
      { getPendingApprovalsForSession: () => [] } as unknown as ChatWebSocketDependencies,
    );
    assert.equal(subscriber.frames[0]?.kind, 'chat_subscribed');
    assert.equal(subscriber.frames[0]?.isProcessing, true);

    const sender = new FakeConnection();
    const run = chatRunRegistry.startRun({
      appSessionId: sessionId,
      provider: 'codex',
      providerSessionId: null,
      connection: sender,
      userId: null,
    });
    assert.ok(run);
    release();
    run.writer.send({ kind: 'stream_delta', provider: 'codex', sessionId: 'c', content: 'hello' });
    run.writer.sendComplete({ exitCode: 0 });

    assert.deepEqual(subscriber.frames.slice(1).map((frame) => frame.kind), ['stream_delta', 'complete']);
    assert.deepEqual(sender.frames.map((frame) => frame.kind), ['stream_delta', 'complete']);
  });
});

test('a pending send released without a run completes its parked subscribers', async () => {
  await withIsolatedDatabase(() => {
    const sessionId = 'app-run-pending-failed';
    sessionsDb.createAppSession(sessionId, 'claude', '/workspace/demo');
    const release = chatRunRegistry.reservePendingSend(sessionId);
    const settled: string[] = [];
    const unsubscribe = chatRunRegistry.onPendingSendSettled((id) => settled.push(id));

    const subscriber = new FakeConnection();
    assert.equal(chatRunRegistry.attachConnection(sessionId, subscriber), true);

    // e.g. AGENT_CLI_HANDOFF_FAILED: the send ends before startRun.
    release();
    unsubscribe();

    assert.deepEqual(settled, [sessionId]);
    assert.equal(subscriber.frames.length, 1);
    assert.equal(subscriber.frames[0]?.kind, 'complete');
    assert.equal(subscriber.frames[0]?.sessionId, sessionId);
    assert.equal(chatRunRegistry.isRunningOrPending(sessionId), false);
  });
});

test('detached sockets are dropped from pending subscribers', async () => {
  await withIsolatedDatabase(() => {
    const sessionId = 'app-run-pending-detach';
    const release = chatRunRegistry.reservePendingSend(sessionId);
    const subscriber = new FakeConnection();
    chatRunRegistry.attachConnection(sessionId, subscriber);
    chatRunRegistry.detachConnection(subscriber);
    release();
    assert.equal(subscriber.frames.length, 0);
  });
});

test('shutdown drain waits for pending sends and active runs', async () => {
  await withIsolatedDatabase(async () => {
    const sessionId = 'app-run-shutdown';
    sessionsDb.createAppSession(sessionId, 'codex', '/workspace/demo');
    const releaseHandler = chatRunRegistry.trackSendHandler();
    const release = chatRunRegistry.reservePendingSend(sessionId);
    chatRunRegistry.beginShutdown();
    assert.equal(chatRunRegistry.isShuttingDown(), true);
    let drained = false;
    const waiting = chatRunRegistry.waitForIdle().then(() => { drained = true; });
    const run = chatRunRegistry.startRun({
      appSessionId: sessionId,
      provider: 'codex',
      providerSessionId: null,
      connection: new FakeConnection(),
      userId: null,
    });
    assert.ok(run);
    release();
    await Promise.resolve();
    assert.equal(drained, false);
    run.writer.sendComplete({ exitCode: 0 });
    await Promise.resolve();
    assert.equal(drained, false);
    releaseHandler();
    await waiting;
    assert.equal(drained, true);
  });
});
