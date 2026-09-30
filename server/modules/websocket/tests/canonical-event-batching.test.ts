import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { chatRunRegistry } from '@/modules/websocket/services/chat-run-registry.service.js';
import {
  broadcastSystemEvent,
  subscribeRunEvents,
  unsubscribeRunEvents,
} from '@/modules/websocket/services/system-broadcast.service.js';
import { connectedClients } from '@/modules/websocket/services/websocket-state.service.js';
import type { NormalizedMessage } from '@/shared/types.js';
import type { RunEventEnvelope } from '@/shared/run-events.js';

class FakeConnection {
  readyState = 1;
  frames: Array<Record<string, unknown>> = [];
  constructor(private readonly log?: string[]) {}
  send(data: string): void {
    const frame = JSON.parse(data) as Record<string, unknown>;
    this.frames.push(frame);
    this.log?.push(`forward:${String(frame.kind)}`);
  }
}

async function withIsolatedDatabase(runTest: () => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'canonical-batch-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
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

test('live frames are forwarded before canonical persistence, which is batched in order', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createAppSession('batch-1', 'claude', '/workspace/demo');
    const log: string[] = [];
    const connection = new FakeConnection(log);
    const persisted: NormalizedMessage[] = [];
    const run = chatRunRegistry.startRun({
      appSessionId: 'batch-1',
      provider: 'claude',
      providerSessionId: null,
      connection,
      userId: null,
      onEvent: (message) => {
        log.push(`persist:${message.kind}`);
        persisted.push(message);
      },
    });
    assert.ok(run);

    run.writer.send({ kind: 'stream_delta', provider: 'claude', content: 'a' });
    run.writer.send({ kind: 'stream_delta', provider: 'claude', content: 'b' });
    // Forwarded synchronously, nothing persisted yet.
    assert.equal(connection.frames.length, 2);
    assert.equal(persisted.length, 0);

    // The batch timer (~50ms) delivers both, in order.
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.deepEqual(persisted.map((message) => message.content), ['a', 'b']);
    assert.deepEqual(persisted.map((message) => message.seq), [1, 2]);
    assert.deepEqual(log, ['forward:stream_delta', 'forward:stream_delta', 'persist:stream_delta', 'persist:stream_delta']);
  });
});

test('urgent events flush on the next microtask, after the forward and with prior events first', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createAppSession('batch-2', 'claude', '/workspace/demo');
    const log: string[] = [];
    const connection = new FakeConnection(log);
    const run = chatRunRegistry.startRun({
      appSessionId: 'batch-2',
      provider: 'claude',
      providerSessionId: null,
      connection,
      userId: null,
      onEvent: (message) => log.push(`persist:${message.kind}`),
    });
    assert.ok(run);

    run.writer.send({ kind: 'text', provider: 'claude', content: 'hello' });
    run.writer.send({ kind: 'permission_request', provider: 'claude', requestId: 'r1', toolName: 'Bash' });
    assert.deepEqual(log, ['forward:text', 'forward:permission_request']);

    await Promise.resolve();
    assert.deepEqual(log, [
      'forward:text',
      'forward:permission_request',
      'persist:text',
      'persist:permission_request',
    ]);
  });
});

test('complete persists earlier events before completion listeners and itself before awaiting code resumes', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createAppSession('batch-3', 'claude', '/workspace/demo');
    const log: string[] = [];
    const connection = new FakeConnection(log);
    const offComplete = chatRunRegistry.onRunComplete(() => log.push('listener:complete'));
    try {
      const run = chatRunRegistry.startRun({
        appSessionId: 'batch-3',
        provider: 'claude',
        providerSessionId: null,
        connection,
        userId: null,
        onEvent: (message) => log.push(`persist:${message.kind}`),
      });
      assert.ok(run);

      const runtime = (async () => {
        run.writer.send({ kind: 'stream_delta', provider: 'claude', content: 'x' });
        run.writer.send({ kind: 'complete', provider: 'claude', exitCode: 0, success: true });
      })();
      await runtime;
      log.push('awaiter:resumed');

      assert.deepEqual(log, [
        'forward:stream_delta',
        'persist:stream_delta',
        'listener:complete',
        'forward:complete',
        'persist:complete',
        'awaiter:resumed',
      ]);
    } finally {
      offComplete();
    }
  });
});

test('CLOUDCLI_PERF_BATCH_RUN_EVENTS=0 restores inline persistence', async () => {
  await withIsolatedDatabase(async () => {
    const previous = process.env.CLOUDCLI_PERF_BATCH_RUN_EVENTS;
    process.env.CLOUDCLI_PERF_BATCH_RUN_EVENTS = '0';
    try {
      sessionsDb.createAppSession('batch-4', 'claude', '/workspace/demo');
      const persisted: string[] = [];
      const run = chatRunRegistry.startRun({
        appSessionId: 'batch-4',
        provider: 'claude',
        providerSessionId: null,
        connection: new FakeConnection(),
        userId: null,
        onEvent: (message) => persisted.push(message.kind),
      });
      assert.ok(run);
      run.writer.send({ kind: 'stream_delta', provider: 'claude', content: 'x' });
      assert.deepEqual(persisted, ['stream_delta']);
    } finally {
      if (previous === undefined) delete process.env.CLOUDCLI_PERF_BATCH_RUN_EVENTS;
      else process.env.CLOUDCLI_PERF_BATCH_RUN_EVENTS = previous;
    }
  });
});

test('run_event frames reach only sockets subscribed to that run (or to all runs)', () => {
  const plain = new FakeConnection();
  const runA = new FakeConnection();
  const everything = new FakeConnection();
  connectedClients.add(plain as never);
  connectedClients.add(runA as never);
  connectedClients.add(everything as never);
  try {
    const event = { run_id: 'run-a', seq: 1 } as unknown as RunEventEnvelope;

    // No subscribers at all: nothing is sent.
    broadcastSystemEvent({ kind: 'run_event', run_id: 'run-a', event });
    assert.equal(plain.frames.length + runA.frames.length + everything.frames.length, 0);

    subscribeRunEvents(runA as never, 'run-a');
    subscribeRunEvents(everything as never, '*');
    broadcastSystemEvent({ kind: 'run_event', run_id: 'run-a', event });
    broadcastSystemEvent({ kind: 'run_event', run_id: 'run-b', event });
    assert.equal(plain.frames.length, 0);
    assert.deepEqual(runA.frames.map((frame) => frame.run_id), ['run-a']);
    assert.deepEqual(everything.frames.map((frame) => frame.run_id), ['run-a', 'run-b']);

    // Other system events still go to everyone.
    broadcastSystemEvent({ kind: 'run_updated', run: { run_id: 'run-a' } } as never);
    assert.equal(plain.frames.length, 1);

    unsubscribeRunEvents(runA as never);
    broadcastSystemEvent({ kind: 'run_event', run_id: 'run-a', event });
    assert.equal(runA.frames.filter((frame) => frame.kind === 'run_event').length, 1);
    unsubscribeRunEvents(everything as never, '*');
  } finally {
    connectedClients.clear();
  }
});
