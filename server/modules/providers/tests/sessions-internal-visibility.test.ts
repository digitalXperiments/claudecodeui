import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { sessionsService } from '@/modules/providers/index.js';
import { chatRunRegistry, shellSessionRegistry } from '@/modules/websocket/index.js';

class FakeConnection {
  readyState = 1;
  frames: Array<Record<string, unknown>> = [];

  send(data: string): void {
    this.frames.push(JSON.parse(data) as Record<string, unknown>);
  }
}

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const previousGrokHome = process.env.GROK_HOME;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'sessions-internal-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await initializeDatabase();

  try {
    await runTest();
  } finally {
    chatRunRegistry.clearAll();
    shellSessionRegistry.clear();
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    if (previousGrokHome === undefined) {
      delete process.env.GROK_HOME;
    } else {
      process.env.GROK_HOME = previousGrokHome;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

test('fetchHistory returns the transcript for an internal swarm session instead of 404', async () => {
  await withIsolatedDatabase(async () => {
    const grokHome = await mkdtemp(path.join(tmpdir(), 'grok-home-'));
    const projectPath = '/workspace/demo-swarm';
    const nativeId = 'grok-native-swarm';
    process.env.GROK_HOME = grokHome;

    try {
      const created = sessionsService.createAppSession('grok', projectPath, { internal: true });
      const row = sessionsDb.getSessionById(created.sessionId);
      const diskProjectPath = row?.runtime_project_path || row?.project_path || projectPath;
      const sessionDir = path.join(
        grokHome,
        'sessions',
        encodeURIComponent(diskProjectPath),
        nativeId,
      );
      await mkdir(sessionDir, { recursive: true });
      await writeFile(
        path.join(sessionDir, 'chat_history.jsonl'),
        `${JSON.stringify({
          type: 'user',
          content: [{ type: 'text', text: '<user_query>Map the swarm</user_query>' }],
        })}\n${JSON.stringify({
          type: 'assistant',
          content: [{ type: 'text', text: 'Here is the map.' }],
        })}\n`,
      );
      sessionsDb.assignProviderSessionId(created.sessionId, nativeId);

      const result = await sessionsService.fetchHistory(created.sessionId);
      assert.equal(result.total, 2);
      assert.equal(result.messages[0]?.role, 'user');
      assert.equal(result.messages[0]?.content, 'Map the swarm');
      assert.equal(result.messages[1]?.role, 'assistant');
      assert.equal(result.messages[1]?.content, 'Here is the map.');
      assert.equal(result.messages[0]?.sessionId, created.sessionId);
    } finally {
      await rm(grokHome, { recursive: true, force: true });
    }
  });
});

test('listRunningSessions includes internal Chatbar and Shell activity', async () => {
  await withIsolatedDatabase(() => {
    const created = sessionsService.createAppSession('grok', '/workspace/demo-swarm', { internal: true });
    const connection = new FakeConnection();
    const run = chatRunRegistry.startRun({
      appSessionId: created.sessionId,
      provider: 'grok',
      providerSessionId: null,
      connection,
      userId: null,
    });
    assert.ok(run);

    const chatRunning = sessionsService.listRunningSessions();
    assert.equal(chatRunning.length, 1);
    assert.equal(chatRunning[0]?.sessionId, created.sessionId);
    assert.equal(chatRunning[0]?.source, 'chat');
    assert.equal(chatRunning[0]?.canInterrupt, false);
    assert.equal(typeof chatRunning[0]?.title, 'string');
    assert.ok('projectId' in (chatRunning[0] ?? {}));

    chatRunRegistry.completeRun(created.sessionId, { exitCode: 0 });
    shellSessionRegistry.register('pty-swarm', {
      sessionId: created.sessionId,
      provider: 'grok',
      startedAt: 123,
    });

    const shellRunning = sessionsService.listRunningSessions();
    assert.equal(shellRunning.length, 1);
    assert.equal(shellRunning[0]?.sessionId, created.sessionId);
    assert.equal(shellRunning[0]?.source, 'shell');
    assert.equal(shellRunning[0]?.canInterrupt, false);
  });
});

test('listRunningSessions keeps a live shell session even before the DB row exists', async () => {
  await withIsolatedDatabase(() => {
    shellSessionRegistry.register('pty-orphan', {
      sessionId: 'not-yet-persisted',
      provider: 'grok',
      startedAt: 99,
    });

    const running = sessionsService.listRunningSessions();
    assert.equal(running.length, 1);
    assert.equal(running[0]?.sessionId, 'not-yet-persisted');
    assert.equal(running[0]?.title, 'not-yet-persisted');
    assert.equal(running[0]?.projectId, null);
  });
});
