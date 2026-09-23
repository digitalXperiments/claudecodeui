import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase } from '@/modules/database/index.js';
import { sessionsService } from '@/modules/providers/index.js';
import { mergeRunErrorsIntoHistory } from '@/modules/providers/services/session-run-errors.service.js';
import { chatRunRegistry } from '@/modules/websocket/index.js';
import type { NormalizedMessage } from '@/shared/types.js';

class FakeConnection {
  readyState = 1;
  frames: Array<Record<string, unknown>> = [];

  send(data: string): void {
    this.frames.push(JSON.parse(data) as Record<string, unknown>);
  }
}

async function withIsolatedDatabase(runTest: () => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'session-run-errors-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();
  try {
    await runTest();
  } finally {
    chatRunRegistry.clearAll();
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

function row(id: string, timestamp: string, fields: Partial<NormalizedMessage>): NormalizedMessage {
  return { id, sessionId: 's1', timestamp, provider: 'codex', kind: 'text', ...fields } as NormalizedMessage;
}

test('mergeRunErrorsIntoHistory places a failed turn\'s error right after its prompt', () => {
  const history = [
    row('u1', '2026-09-23T03:30:00.000Z', { role: 'user', content: 'first' }),
    row('a1', '2026-09-23T03:30:03.000Z', { role: 'assistant', content: 'pong' }),
    row('u2', '2026-09-23T03:30:10.000Z', { role: 'user', content: 'second' }),
    row('u3', '2026-09-23T03:30:30.000Z', { role: 'user', content: 'third' }),
  ];
  const error = row('error_1', '2026-09-23T03:30:12.000Z', { kind: 'error', content: 'model not supported' });

  const merged = mergeRunErrorsIntoHistory(history, [error]);
  assert.deepEqual(merged.map((message) => message.id), ['u1', 'a1', 'u2', 'error_1', 'u3']);
  // Already-present ids are not duplicated.
  assert.equal(mergeRunErrorsIntoHistory(merged, [error]), merged);
});

test('a live provider error survives a history reload (Codex unsupported model)', async () => {
  await withIsolatedDatabase(async () => {
    // A rejected Codex turn: the error frame is the only output, and the
    // provider transcript never records it.
    const { sessionId } = sessionsService.createAppSession('codex', '/workspace/run-errors');
    const connection = new FakeConnection();
    const run = chatRunRegistry.startRun({
      appSessionId: sessionId,
      provider: 'codex',
      providerSessionId: null,
      connection,
      userId: null,
    });
    assert.ok(run);

    const content = "The 'gpt-5.4-mini' model is not supported when using Codex with a ChatGPT account.";
    run.writer.send({ kind: 'error', provider: 'codex', sessionId: 'native-thread', content, id: 'error_live_1', timestamp: '2026-09-23T03:29:59.492Z' });
    run.writer.send({ kind: 'complete', provider: 'codex', sessionId: 'native-thread', exitCode: 1 });

    const history = await sessionsService.fetchHistory(sessionId, { limit: 20, offset: 0 });
    const errors = history.messages.filter((message) => message.kind === 'error');
    assert.equal(errors.length, 1);
    // Same id as the live row, so the client reconciles instead of duplicating.
    assert.equal(errors[0].id, 'error_live_1');
    assert.equal(errors[0].content, content);
    assert.equal(errors[0].sessionId, sessionId);
    assert.equal(history.total, 1);
  });
});
