import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { extractRunOutcome } from '@/modules/mission-control/mission-control-agent.service.js';
import { chatRunRegistry } from '@/modules/websocket/index.js';

const DETACHED_CONNECTION = { readyState: -1, send: () => undefined };

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'mission-control-agent-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await initializeDatabase();

  try {
    await runTest();
  } finally {
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

function startRun(appSessionId: string) {
  sessionsDb.createAppSession(appSessionId, 'claude', '/workspace/demo');
  const run = chatRunRegistry.startRun({
    appSessionId,
    provider: 'claude',
    providerSessionId: null,
    connection: DETACHED_CONNECTION,
    userId: null,
  });
  assert.ok(run);
  return run;
}

test('successful run: assistant text only, not failed', async () => {
  await withIsolatedDatabase(() => {
    const run = startRun('mc-ok-1');
    run.writer.send({ kind: 'text', provider: 'claude', content: '[{"title":"a"}]' });
    run.writer.sendComplete({ exitCode: 0 });

    const outcome = extractRunOutcome('mc-ok-1');
    assert.equal(outcome.text, '[{"title":"a"}]');
    assert.equal(outcome.failed, false);
    assert.equal(outcome.errorMessage, null);
  });
});

test('provider API failure: non-zero exit marks the run failed, error text kept separate', async () => {
  await withIsolatedDatabase(() => {
    const run = startRun('mc-fail-1');
    run.writer.send({
      kind: 'text',
      provider: 'claude',
      content: 'API Error: Unable to connect to API (ENOTFOUND)',
    });
    run.writer.send({
      kind: 'error',
      provider: 'claude',
      content: 'Claude Code returned an error result: API Error: Unable to connect to API (ENOTFOUND)',
    });
    run.writer.sendComplete({ exitCode: 1 });

    const outcome = extractRunOutcome('mc-fail-1');
    assert.equal(outcome.failed, true);
    assert.equal(outcome.text, 'API Error: Unable to connect to API (ENOTFOUND)');
    assert.match(outcome.errorMessage ?? '', /returned an error result/);
  });
});

test('benign error event with zero exit is not a failure and stays out of the text', async () => {
  await withIsolatedDatabase(() => {
    const run = startRun('mc-ok-2');
    run.writer.send({ kind: 'error', provider: 'cursor', content: 'warning: noisy stderr' });
    run.writer.send({ kind: 'text', provider: 'cursor', content: '[{"title":"b","dedupeKey":"k"}]' });
    run.writer.sendComplete({ exitCode: 0 });

    const outcome = extractRunOutcome('mc-ok-2');
    assert.equal(outcome.failed, false);
    assert.equal(outcome.text, '[{"title":"b","dedupeKey":"k"}]');
    assert.equal(outcome.errorMessage, 'warning: noisy stderr');
  });
});
