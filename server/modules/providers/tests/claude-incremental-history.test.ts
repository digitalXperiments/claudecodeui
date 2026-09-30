import assert from 'node:assert/strict';
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import {
  ClaudeSessionsProvider,
  clearClaudeTranscriptCache,
} from '@/modules/providers/list/claude/claude-sessions.provider.js';

async function withIsolatedDatabase(runTest: (tempDirectory: string) => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'claude-incremental-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();
  clearClaudeTranscriptCache();
  try {
    await runTest(tempDirectory);
  } finally {
    clearClaudeTranscriptCache();
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

const entry = (uuid: string, role: 'user' | 'assistant', text: string, timestamp: string, sessionId = 'claude-s1') =>
  `${JSON.stringify({ uuid, sessionId, timestamp, message: { role, content: text } })}\n`;

test('claude history picks up appended turns, sorts by timestamp and survives rewrites', async () => {
  await withIsolatedDatabase(async (tempDirectory) => {
    const jsonlPath = path.join(tempDirectory, 'claude-s1.jsonl');
    await writeFile(
      jsonlPath,
      entry('u1', 'user', 'first question', '2026-09-01T00:00:01.000Z')
        + entry('other', 'user', 'other session', '2026-09-01T00:00:00.500Z', 'claude-other')
        + entry('a1', 'assistant', 'first answer', '2026-09-01T00:00:02.000Z'),
    );
    const sessionId = sessionsDb.createSession('claude-s1', 'claude', tempDirectory, 'S1', undefined, undefined, jsonlPath);
    const provider = new ClaudeSessionsProvider();

    const first = await provider.fetchHistory(sessionId, { providerSessionId: 'claude-s1' });
    assert.deepEqual(first.messages.map((message) => message.content), ['first question', 'first answer']);

    // An out-of-order timestamp in the appended chunk still sorts correctly,
    // and a partial trailing line is ignored until completed.
    await appendFile(
      jsonlPath,
      entry('u2', 'user', 'second question', '2026-09-01T00:00:03.000Z')
        + entry('early', 'assistant', 'late-written early note', '2026-09-01T00:00:01.500Z')
        + '{"uuid":"a2","sessionId":"claude-s1"',
    );
    const second = await provider.fetchHistory(sessionId, { providerSessionId: 'claude-s1' });
    assert.deepEqual(second.messages.map((message) => message.content), [
      'first question',
      'late-written early note',
      'first answer',
      'second question',
    ]);

    await appendFile(jsonlPath, ',"timestamp":"2026-09-01T00:00:04.000Z","message":{"role":"assistant","content":"second answer"}}\n');
    const third = await provider.fetchHistory(sessionId, { providerSessionId: 'claude-s1', limit: 2, offset: 0 });
    assert.deepEqual(third.messages.map((message) => message.content), ['second question', 'second answer']);
    assert.equal(third.total, 5);

    // Rewritten transcript (e.g. compaction) is re-parsed from scratch.
    await writeFile(jsonlPath, entry('r1', 'user', 'rewritten', '2026-09-02T00:00:00.000Z'));
    const rewritten = await provider.fetchHistory(sessionId, { providerSessionId: 'claude-s1' });
    assert.deepEqual(rewritten.messages.map((message) => message.content), ['rewritten']);
  });
});
