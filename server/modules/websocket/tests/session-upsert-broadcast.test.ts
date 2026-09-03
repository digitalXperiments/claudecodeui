import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import {
  broadcastSessionUpserted,
  broadcastSessionUpsertedBatch,
  buildSessionUpsertedEvent,
} from '@/modules/websocket/services/session-upsert-broadcast.service.js';
import { broadcastCanonicalSessionUpsert } from '@/modules/websocket/services/chat-run-registry.service.js';
import { connectedClients } from '@/modules/websocket/services/websocket-state.service.js';

/**
 * Minimal stand-in for a websocket connection: collects every JSON frame the
 * broadcaster sends so assertions can inspect the outbound wire payloads.
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
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'session-upsert-broadcast-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await initializeDatabase();

  try {
    await runTest();
  } finally {
    connectedClients.clear();
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

/** Drops the wall-clock field so payloads built moments apart compare equal. */
function withoutTimestamp(event: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!event) {
    return null;
  }
  const { timestamp, ...rest } = event;
  assert.equal(typeof timestamp, 'string');
  return rest;
}

test('watcher path and run-registry path build the identical payload', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createAppSession('app-1', 'claude', '/workspace/demo');
    sessionsDb.assignProviderSessionId('app-1', 'native-1');
    sessionsDb.updateSessionCustomName('app-1', 'My chat');

    // Run-registry path: canonical app session id, no provider scope.
    const registryEvent = await buildSessionUpsertedEvent('app-1');
    // Watcher path: provider-native id from a transcript file name.
    const watcherEvent = await buildSessionUpsertedEvent('native-1', 'claude');

    assert.ok(registryEvent);
    assert.ok(watcherEvent);
    assert.deepEqual(
      withoutTimestamp(watcherEvent as unknown as Record<string, unknown>),
      withoutTimestamp(registryEvent as unknown as Record<string, unknown>),
    );

    // The exact regression the shared builder fixes: the watcher copy used to
    // omit providerSessionId, leaving stale duplicate sidebar rows unmerged.
    assert.equal(watcherEvent.providerSessionId, 'native-1');
    assert.equal(registryEvent.providerSessionId, 'native-1');

    // Wire contract consumed by the frontend (useProjectsState) — renaming or
    // dropping any of these silently breaks sidebar upserts.
    assert.deepEqual(Object.keys(watcherEvent).sort(), [
      'kind',
      'project',
      'provider',
      'providerSessionId',
      'session',
      'sessionId',
      'timestamp',
    ]);
    assert.equal(watcherEvent.kind, 'session_upserted');
    assert.equal(watcherEvent.sessionId, 'app-1');
    assert.equal(watcherEvent.provider, 'claude');
    assert.deepEqual(Object.keys(watcherEvent.session).sort(), [
      'id',
      'lastActivity',
      'messageCount',
      'summary',
    ]);
    assert.equal(watcherEvent.session.id, 'app-1');
    assert.equal(watcherEvent.session.summary, 'My chat');
    assert.ok(watcherEvent.project);
    assert.deepEqual(Object.keys(watcherEvent.project).sort(), [
      'categoryId',
      'displayName',
      'fullPath',
      'isStarred',
      'path',
      'projectId',
    ]);
    assert.equal(watcherEvent.project.path, '/workspace/demo');
    assert.equal(watcherEvent.project.fullPath, '/workspace/demo');
    assert.equal(watcherEvent.project.isStarred, false);
    assert.equal(watcherEvent.project.categoryId, null);
  });
});

test('a session without a provider mapping broadcasts providerSessionId: null', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createAppSession('app-2', 'codex', '/workspace/demo');

    const event = await buildSessionUpsertedEvent('app-2');
    assert.ok(event);
    assert.equal(event.providerSessionId, null);
    // JSON.stringify must keep the field on the wire (null, not dropped).
    assert.ok(Object.hasOwn(JSON.parse(JSON.stringify(event)), 'providerSessionId'));
  });
});

test('internal, unknown, and provider-mismatched sessions are never announced', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createAppSession('app-internal', 'claude', '/workspace/demo', { internal: true });
    sessionsDb.createAppSession('app-3', 'claude', '/workspace/demo');
    sessionsDb.assignProviderSessionId('app-3', 'native-3');

    assert.equal(await buildSessionUpsertedEvent('app-internal'), null);
    assert.equal(await buildSessionUpsertedEvent('missing-id'), null);
    // A watcher event scoped to another provider must not resolve through the
    // unscoped app-id fallback into a different provider's row.
    assert.equal(await buildSessionUpsertedEvent('app-3', 'codex'), null);
    // ...while the correctly scoped lookup still works.
    assert.ok(await buildSessionUpsertedEvent('native-3', 'claude'));
  });
});

test('broadcastSessionUpserted sends one frame per open client (registry call path)', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createAppSession('app-4', 'cursor', '/workspace/demo');
    sessionsDb.assignProviderSessionId('app-4', 'cursor-native-4');

    const openConnection = new FakeConnection();
    const closedConnection = new FakeConnection();
    closedConnection.readyState = 3;
    connectedClients.add(openConnection as never);
    connectedClients.add(closedConnection as never);

    await broadcastSessionUpserted('app-4');

    assert.equal(openConnection.frames.length, 1);
    assert.equal(closedConnection.frames.length, 0);
    assert.equal(openConnection.frames[0]?.kind, 'session_upserted');
    assert.equal(openConnection.frames[0]?.sessionId, 'app-4');
    assert.equal(openConnection.frames[0]?.providerSessionId, 'cursor-native-4');
  });
});

test('broadcastSessionUpsertedBatch flushes only resolvable updates (watcher call path)', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createAppSession('app-5', 'claude', '/workspace/demo');
    sessionsDb.assignProviderSessionId('app-5', 'native-5');
    sessionsDb.createAppSession('app-6', 'codex', '/workspace/other');
    sessionsDb.assignProviderSessionId('app-6', 'native-6');

    const connection = new FakeConnection();
    connectedClients.add(connection as never);

    await broadcastSessionUpsertedBatch([
      { sessionId: 'native-5', provider: 'claude' },
      { sessionId: 'native-6', provider: 'codex' },
      { sessionId: 'never-indexed', provider: 'claude' },
    ]);

    assert.deepEqual(
      connection.frames.map((frame) => frame.sessionId),
      ['app-5', 'app-6'],
    );
    assert.deepEqual(
      connection.frames.map((frame) => frame.providerSessionId),
      ['native-5', 'native-6'],
    );
    assert.ok(connection.frames.every((frame) => frame.kind === 'session_upserted'));
  });
});

test('broadcastCanonicalSessionUpsert emits the exact shared-builder payload', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createAppSession('app-7', 'claude', '/workspace/demo');
    sessionsDb.assignProviderSessionId('app-7', 'native-7');

    const connection = new FakeConnection();
    connectedClients.add(connection as never);

    await broadcastCanonicalSessionUpsert('app-7');

    assert.equal(connection.frames.length, 1);
    const expected = await buildSessionUpsertedEvent('native-7', 'claude');
    assert.ok(expected);
    assert.deepEqual(
      withoutTimestamp(connection.frames[0] ?? null),
      withoutTimestamp(JSON.parse(JSON.stringify(expected)) as Record<string, unknown>),
    );
  });
});
