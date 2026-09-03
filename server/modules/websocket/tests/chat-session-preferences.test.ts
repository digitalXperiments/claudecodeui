import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import test from 'node:test';

import type { WebSocket } from 'ws';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import {
  handleChatSend,
  handleChatSessionPreferences,
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
  const dependencies = {
    spawnFns: {
      codex: async (_content: string, options: Record<string, unknown>) => {
        seenModes.push(String(options.permissionMode));
      },
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
  } finally {
    chatRunRegistry.clearAll();
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(root, { recursive: true, force: true });
  }
});
