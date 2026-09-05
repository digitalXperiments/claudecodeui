import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import test from 'node:test';

import type { WebSocket } from 'ws';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import {
  handleChatAbort,
  type ChatWebSocketDependencies,
} from '@/modules/websocket/services/chat-websocket.service.js';
import { chatRunRegistry } from '@/modules/websocket/services/chat-run-registry.service.js';
import { makeScratchDir } from '@/shared/scratch.js';

type Frame = Record<string, unknown>;

class FakeConnection {
  readyState = 1;
  frames: Frame[] = [];

  send(data: string): void {
    this.frames.push(JSON.parse(data) as Frame);
  }
}

test('stopping a lead cancels its Agent Relay workers', async () => {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const root = await makeScratchDir('chat-abort-relay-');
  closeConnection();
  process.env.DATABASE_PATH = `${root}/auth.db`;
  await initializeDatabase();

  const connection = new FakeConnection();
  const leadSessionId = 'lead-session-stop-relay';
  sessionsDb.createAppSession(leadSessionId, 'claude', '/workspace/demo');
  chatRunRegistry.startRun({
    appSessionId: leadSessionId,
    provider: 'claude',
    providerSessionId: 'claude-native-lead',
    connection,
    userId: null,
  });

  const cancelledSessions: string[] = [];
  let abortCalls = 0;
  const dependencies = {
    abortFns: {
      claude: async () => {
        abortCalls += 1;
        return true;
      },
    },
    cancelRelayJobsForSession: async (sessionId: string) => {
      cancelledSessions.push(sessionId);
    },
  } as unknown as ChatWebSocketDependencies;

  try {
    await handleChatAbort(
      connection as unknown as WebSocket,
      { sessionId: leadSessionId },
      dependencies,
    );

    assert.deepEqual(cancelledSessions, [leadSessionId]);
    assert.equal(abortCalls, 1);
    assert.equal(chatRunRegistry.isProcessing(leadSessionId), false);
    assert.equal(connection.frames.at(-1)?.kind, 'complete');
    assert.equal(connection.frames.at(-1)?.aborted, true);
  } finally {
    chatRunRegistry.clearAll();
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(root, { recursive: true, force: true });
  }
});

test('aborting a first run with no provider session id still reaches the abort fn', async () => {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const root = await makeScratchDir('chat-abort-first-run-');
  closeConnection();
  process.env.DATABASE_PATH = `${root}/auth.db`;
  await initializeDatabase();

  const connection = new FakeConnection();
  const leadSessionId = 'lead-session-first-abort';
  sessionsDb.createAppSession(leadSessionId, 'claude', '/workspace/demo');
  chatRunRegistry.startRun({
    appSessionId: leadSessionId,
    provider: 'claude',
    providerSessionId: null,
    connection,
    userId: null,
  });

  const abortTargets: string[] = [];
  const dependencies = {
    abortFns: {
      claude: async (target: string) => {
        abortTargets.push(target);
        return true;
      },
    },
  } as unknown as ChatWebSocketDependencies;

  try {
    await handleChatAbort(
      connection as unknown as WebSocket,
      { sessionId: leadSessionId },
      dependencies,
    );

    assert.deepEqual(abortTargets, [leadSessionId]);
    assert.equal(chatRunRegistry.isProcessing(leadSessionId), false);
    assert.equal(connection.frames.at(-1)?.kind, 'complete');
    assert.equal(connection.frames.at(-1)?.aborted, true);
  } finally {
    chatRunRegistry.clearAll();
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(root, { recursive: true, force: true });
  }
});

test('stopping a session with no registered run cancels the provider and clears the spinner', async () => {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const root = await makeScratchDir('chat-abort-ghost-');
  closeConnection();
  process.env.DATABASE_PATH = `${root}/auth.db`;
  await initializeDatabase();

  const connection = new FakeConnection();
  const sessionId = 'ghost-run-session';
  sessionsDb.createAppSession(sessionId, 'grok', '/workspace/demo');
  sessionsDb.assignProviderSessionId(sessionId, 'grok-native-ghost');

  // No chatRunRegistry.startRun: this is the post-restart state where the
  // in-memory run is gone but the chat bar is still showing the session busy.
  const abortTargets: string[] = [];
  const cancelledSessions: string[] = [];
  const dependencies = {
    abortFns: {
      grok: (target: string) => {
        abortTargets.push(target);
        return true;
      },
    },
    cancelRelayJobsForSession: async (target: string) => {
      cancelledSessions.push(target);
    },
  } as unknown as ChatWebSocketDependencies;

  try {
    await handleChatAbort(
      connection as unknown as WebSocket,
      { sessionId },
      dependencies,
    );

    // Addressed with the provider-native id the runtime keys its process map by.
    assert.deepEqual(abortTargets, ['grok-native-ghost']);
    assert.deepEqual(cancelledSessions, [sessionId]);
    assert.equal(
      connection.frames.some((frame) => frame.kind === 'protocol_error'),
      false,
      'Stop must not report "has no active run" back to the user',
    );
    assert.equal(connection.frames.at(-1)?.kind, 'complete');
    assert.equal(connection.frames.at(-1)?.aborted, true);
  } finally {
    chatRunRegistry.clearAll();
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(root, { recursive: true, force: true });
  }
});
