import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import test from 'node:test';

import type { WebSocket } from 'ws';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import {
  handleChatSend,
  handleChatSessionPreferences,
  handleChatSubscribe,
  type ChatWebSocketDependencies,
} from '@/modules/websocket/services/chat-websocket.service.js';
import { chatRunRegistry } from '@/modules/websocket/services/chat-run-registry.service.js';
import { makeScratchDir } from '@/shared/scratch.js';

class FakeConnection {
  readyState = 1;
  frames: Array<Record<string, unknown>> = [];

  send(data: string): void {
    this.frames.push(JSON.parse(data) as Record<string, unknown>);
  }
}

test('chat runs inherit session permission mode and preserve explicit legacy overrides', async () => {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const root = await makeScratchDir('chat-session-preferences-');
  closeConnection();
  process.env.DATABASE_PATH = `${root}/auth.db`;
  await initializeDatabase();

  const sessionId = 'session-runtime-preferences';
  sessionsDb.createAppSession(sessionId, 'codex', root, { permissionMode: 'bypassPermissions' });
  const connection = new FakeConnection();
  const seenModes: string[] = [];
  const releasedSessions: string[] = [];
  const dependencies = {
    spawnFns: {
      codex: async (_content: string, options: Record<string, unknown>) => {
        seenModes.push(String(options.permissionMode));
      },
    },
    releaseShellSession: async (releasedSessionId: string) => {
      releasedSessions.push(releasedSessionId);
      return true;
    },
  } as unknown as ChatWebSocketDependencies;

  try {
    await handleChatSend(
      connection as unknown as WebSocket,
      null,
      { sessionId, content: 'inherits', options: {} },
      dependencies,
    );
    assert.deepEqual(seenModes, ['bypassPermissions']);
    assert.deepEqual(releasedSessions, [sessionId]);

    handleChatSessionPreferences(connection as unknown as WebSocket, {
      sessionId,
      preferences: { permissionMode: 'default' },
    });
    assert.equal(sessionsDb.getSessionById(sessionId)?.permission_mode, 'default');
    assert.equal(connection.frames.at(-1)?.kind, 'chat_session_preferences_updated');

    await handleChatSend(
      connection as unknown as WebSocket,
      null,
      { sessionId, content: 'changed in desktop', options: {} },
      dependencies,
    );
    assert.deepEqual(seenModes, ['bypassPermissions', 'default']);

    // Older clients may keep sending the mode. It remains a supported
    // one-turn request and also advances the durable session preference.
    await handleChatSend(
      connection as unknown as WebSocket,
      null,
      { sessionId, content: 'legacy override', options: { permissionMode: 'bypassPermissions' } },
      dependencies,
    );
    assert.deepEqual(seenModes, ['bypassPermissions', 'default', 'bypassPermissions']);
    assert.equal(sessionsDb.getSessionById(sessionId)?.permission_mode, 'bypassPermissions');

    dependencies.releaseShellSession = async () => false;
    await handleChatSend(
      connection as unknown as WebSocket,
      null,
      { sessionId, content: 'must not race Agent CLI', options: {} },
      dependencies,
    );
    assert.deepEqual(seenModes, ['bypassPermissions', 'default', 'bypassPermissions']);
    assert.equal(connection.frames.at(-1)?.code, 'AGENT_CLI_HANDOFF_FAILED');
  } finally {
    chatRunRegistry.clearAll();
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(root, { recursive: true, force: true });
  }
});

test('chat.subscribe during a slow Agent CLI hand-off reports the pending send as processing', async () => {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const root = await makeScratchDir('chat-pending-send-');
  closeConnection();
  process.env.DATABASE_PATH = `${root}/auth.db`;
  await initializeDatabase();

  const sessionId = 'session-pending-send';
  sessionsDb.createAppSession(sessionId, 'codex', root);
  const connection = new FakeConnection();
  let resolveRelease: (released: boolean) => void = () => {};
  let finishRun: () => void = () => {};
  let shellActive = true;
  const dependencies = {
    spawnFns: {
      codex: (_content: string, _options: Record<string, unknown>, writer: { send: (m: unknown) => void }) =>
        new Promise<void>((resolve) => {
          finishRun = () => {
            writer.send({ kind: 'complete', provider: 'codex', sessionId: null, exitCode: 0 });
            resolve();
          };
        }),
    },
    abortFns: {},
    getPendingApprovalsForSession: () => [],
    isShellSessionActive: () => shellActive,
    releaseShellSession: () => new Promise<boolean>((resolve) => {
      resolveRelease = (released) => {
        shellActive = !released;
        resolve(released);
      };
    }),
  } as unknown as ChatWebSocketDependencies;
  const ws = connection as unknown as WebSocket;
  const lastAck = () => connection.frames.filter((frame) => frame.kind === 'chat_subscribed').at(-1);

  try {
    const send = handleChatSend(ws, null, { sessionId, content: 'hello', options: {} }, dependencies);

    // Still inside releaseShellSession: no run registered yet.
    handleChatSubscribe(ws, { sessions: [{ sessionId, lastSeq: 0 }] }, dependencies);
    assert.equal(lastAck()?.isProcessing, true);
    assert.equal(lastAck()?.isShellActive, false);

    resolveRelease(true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(chatRunRegistry.hasPendingSend(sessionId), false);
    assert.equal(chatRunRegistry.isProcessing(sessionId), true);
    handleChatSubscribe(ws, { sessions: [{ sessionId, lastSeq: 0 }] }, dependencies);
    assert.equal(lastAck()?.isProcessing, true);

    finishRun();
    await send;
    handleChatSubscribe(ws, { sessions: [{ sessionId, lastSeq: 0 }] }, dependencies);
    assert.equal(lastAck()?.isProcessing, false);

    // A failed hand-off must not leave the reservation behind.
    shellActive = true;
    const failed = handleChatSend(ws, null, { sessionId, content: 'blocked', options: {} }, dependencies);
    handleChatSubscribe(ws, { sessions: [{ sessionId, lastSeq: 0 }] }, dependencies);
    assert.equal(lastAck()?.isProcessing, true);
    resolveRelease(false);
    await failed;
    assert.equal(chatRunRegistry.hasPendingSend(sessionId), false);
    handleChatSubscribe(ws, { sessions: [{ sessionId, lastSeq: 0 }] }, dependencies);
    assert.equal(lastAck()?.isProcessing, false);
    assert.equal(lastAck()?.isShellActive, true);
  } finally {
    chatRunRegistry.clearAll();
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(root, { recursive: true, force: true });
  }
});
