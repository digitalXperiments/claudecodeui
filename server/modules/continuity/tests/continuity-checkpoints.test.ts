import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection, initializeDatabase } from '@/modules/database/index.js';
import { makeScratchDir } from '@/shared/scratch.js';

import {
  continuityCheckpointsRepository,
  formatCheckpointForPrompt,
  resolveLineageRoot,
} from '../continuity-checkpoints.js';

async function withDatabase(callback: () => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const root = await makeScratchDir('continuity-checkpoints-');
  closeConnection();
  process.env.DATABASE_PATH = path.join(root, 'auth.db');
  await initializeDatabase();
  try {
    await callback();
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(root, { recursive: true, force: true });
  }
}

test('creates checkpoints and retrieves the newest checkpoint for a session', async () => {
  await withDatabase(async () => {
    const first = continuityCheckpointsRepository.createCheckpoint({
      sessionId: 'child',
      lineageRootSessionId: 'root',
      provider: 'claude',
      runId: 'run-1',
      summary: 'Implemented the parser.',
      nextSteps: ['Add integration coverage'],
      openQuestions: ['Should errors be retried?'],
      filesTouched: ['server/parser.ts'],
      commands: ['npm test'],
      doNotRepeat: ['Do not regenerate fixtures'],
      tags: ['parser'],
    });
    const second = continuityCheckpointsRepository.createCheckpoint({
      sessionId: first.sessionId,
      lineageRootSessionId: first.lineageRootSessionId,
      provider: first.provider,
      runId: 'run-2',
      summary: 'Integration coverage added.',
      nextSteps: first.nextSteps,
      openQuestions: first.openQuestions,
      filesTouched: first.filesTouched,
      commands: first.commands,
      doNotRepeat: first.doNotRepeat,
      tags: first.tags,
    });

    assert.match(first.checkpointId, /^checkpoint_/);
    assert.equal(continuityCheckpointsRepository.getLatestCheckpoint('child')?.checkpointId, second.checkpointId);
    assert.equal(continuityCheckpointsRepository.getLatestCheckpoint('missing'), null);
  });
});

test('stores, lists, updates, and expires lineage scratchpad entries', async () => {
  await withDatabase(async () => {
    continuityCheckpointsRepository.setScratchpad({
      lineageRootSessionId: 'root', key: 'decision', value: 'Use SQLite',
    });
    continuityCheckpointsRepository.setScratchpad({
      lineageRootSessionId: 'root', key: 'temporary', value: 'old', ttlSeconds: 0,
    });
    continuityCheckpointsRepository.setScratchpad({
      lineageRootSessionId: 'other', key: 'decision', value: 'Not visible',
    });

    assert.equal(continuityCheckpointsRepository.getScratchpad({
      lineageRootSessionId: 'root', key: 'decision',
    })?.value, 'Use SQLite');
    assert.deepEqual(continuityCheckpointsRepository.listScratchpad('root').map((entry) => entry.key), ['decision']);

    continuityCheckpointsRepository.setScratchpad({
      lineageRootSessionId: 'root', key: 'decision', value: 'Use WAL', ttlSeconds: 60,
    });
    assert.equal(continuityCheckpointsRepository.getScratchpad({
      lineageRootSessionId: 'root', key: 'decision',
    })?.value, 'Use WAL');
  });
});

test('resolves session lineage to its root and formats checkpoint context', async () => {
  await withDatabase(async () => {
    const db = getConnection();
    db.prepare('INSERT INTO sessions (session_id, provider, continued_from_session_id) VALUES (?, ?, ?)')
      .run('root', 'claude', null);
    db.prepare('INSERT INTO sessions (session_id, provider, continued_from_session_id) VALUES (?, ?, ?)')
      .run('middle', 'codex', 'root');
    db.prepare('INSERT INTO sessions (session_id, provider, continued_from_session_id) VALUES (?, ?, ?)')
      .run('leaf', 'cursor', 'middle');

    assert.equal(await resolveLineageRoot('leaf'), 'root');
    assert.equal(await resolveLineageRoot('unknown'), 'unknown');

    const checkpoint = continuityCheckpointsRepository.createCheckpoint({
      sessionId: 'leaf', lineageRootSessionId: 'root', provider: 'cursor', runId: null,
      summary: '  Ready for review.  ', nextSteps: ['Run the smoke test'],
      openQuestions: [], filesTouched: ['server/example.ts'], commands: [], doNotRepeat: [], tags: [],
    });
    assert.equal(formatCheckpointForPrompt(checkpoint), [
      '### Agent Checkpoint', '', 'Ready for review.', '', '**Next steps**',
      '- Run the smoke test', '', '**Open questions**', '- None', '',
      '**Files touched**', '- server/example.ts',
    ].join('\n'));
  });
});
