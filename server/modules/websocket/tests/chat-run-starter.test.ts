import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { chatRunRegistry } from '@/modules/websocket/services/chat-run-registry.service.js';
import { startProviderRun } from '@/modules/websocket/services/chat-run-starter.service.js';
import { connectedClients } from '@/modules/websocket/services/websocket-state.service.js';
import type { AnyRecord } from '@/shared/types.js';

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
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'chat-run-starter-'));
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

test('a send while a run is active is offered to injectFn instead of rejected', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createAppSession('app-inject-1', 'claude', '/workspace/demo');
    const connection = new FakeConnection();

    const spawnCalls: string[] = [];
    const spawnFn = async (command: string) => {
      spawnCalls.push(command);
      // Stay pending so the registry run remains active, like a real runtime.
      await new Promise(() => undefined);
    };

    const first = await startProviderRun({
      appSessionId: 'app-inject-1',
      provider: 'claude',
      providerSessionId: 'native-1',
      projectPath: '/workspace/demo',
      spawnFn,
      content: 'first',
      options: {},
      connection,
      userId: null,
    });
    assert.equal(first.ok, true);
    assert.equal(first.injected, undefined);

    const injectCalls: Array<{ command: string; options: AnyRecord }> = [];
    const second = await startProviderRun({
      appSessionId: 'app-inject-1',
      provider: 'claude',
      providerSessionId: 'native-1',
      projectPath: '/workspace/demo',
      spawnFn,
      injectFn: async (command, options) => {
        injectCalls.push({ command, options });
        return true;
      },
      content: 'second',
      options: {},
      connection,
      userId: null,
    });

    assert.equal(second.ok, true);
    assert.equal(second.injected, true);
    await second.completion;

    // The injection carries the live run's provider id, not a new run.
    assert.equal(spawnCalls.length, 1);
    assert.equal(injectCalls.length, 1);
    assert.equal(injectCalls[0]?.command, 'second');
    assert.equal(injectCalls[0]?.options.sessionId, 'native-1');
    assert.equal(injectCalls[0]?.options.appSessionId, 'app-inject-1');
    assert.equal(injectCalls[0]?.options.resume, true);

    // Still exactly one run, still owned by the first send.
    assert.equal(chatRunRegistry.isProcessing('app-inject-1'), true);
  });
});

test('a send while a run is active is rejected when injectFn is absent or declines', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createAppSession('app-inject-2', 'codex', '/workspace/demo');
    const connection = new FakeConnection();
    const spawnFn = async () => {
      // Stay pending so the registry run remains active, like a real runtime.
      await new Promise(() => undefined);
    };

    const first = await startProviderRun({
      appSessionId: 'app-inject-2',
      provider: 'codex',
      providerSessionId: 'native-2',
      projectPath: '/workspace/demo',
      spawnFn,
      content: 'first',
      options: {},
      connection,
      userId: null,
    });
    assert.equal(first.ok, true);

    const withoutInject = await startProviderRun({
      appSessionId: 'app-inject-2',
      provider: 'codex',
      providerSessionId: 'native-2',
      projectPath: '/workspace/demo',
      spawnFn,
      content: 'second',
      options: {},
      connection,
      userId: null,
    });
    assert.deepEqual(withoutInject, { ok: false, code: 'RUN_IN_PROGRESS' });

    const decliningInject = await startProviderRun({
      appSessionId: 'app-inject-2',
      provider: 'codex',
      providerSessionId: 'native-2',
      projectPath: '/workspace/demo',
      spawnFn,
      injectFn: async () => false,
      content: 'second',
      options: {},
      connection,
      userId: null,
    });
    assert.deepEqual(decliningInject, { ok: false, code: 'RUN_IN_PROGRESS' });
  });
});

test('an injectFn that throws falls back to RUN_IN_PROGRESS', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createAppSession('app-inject-3', 'claude', '/workspace/demo');
    const connection = new FakeConnection();
    const spawnFn = async () => {
      // Stay pending so the registry run remains active, like a real runtime.
      await new Promise(() => undefined);
    };

    const first = await startProviderRun({
      appSessionId: 'app-inject-3',
      provider: 'claude',
      providerSessionId: 'native-3',
      projectPath: '/workspace/demo',
      spawnFn,
      content: 'first',
      options: {},
      connection,
      userId: null,
    });
    assert.equal(first.ok, true);

    const result = await startProviderRun({
      appSessionId: 'app-inject-3',
      provider: 'claude',
      providerSessionId: 'native-3',
      projectPath: '/workspace/demo',
      spawnFn,
      injectFn: async () => {
        throw new Error('channel gone');
      },
      content: 'second',
      options: {},
      connection,
      userId: null,
    });
    assert.deepEqual(result, { ok: false, code: 'RUN_IN_PROGRESS' });
  });
});
