import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import {
  findShellCreatedOpenCodeSessions,
  readOpenCodeShellRuntime,
} from '@/modules/providers/list/opencode/opencode-shell-sync.js';

type Harness = { databasePath: string; projectPath: string; db: Database.Database };

async function withHarness(runTest: (harness: Harness) => Promise<void> | void): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'opencode-shell-sync-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();

  const databasePath = path.join(tempDirectory, 'opencode.db');
  const db = new Database(databasePath);
  db.exec(`
    CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT NOT NULL, parent_id TEXT,
      time_created INTEGER, time_updated INTEGER, time_archived INTEGER);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
  `);

  try {
    await runTest({ databasePath, projectPath: path.join(tempDirectory, 'workspace'), db });
  } finally {
    db.close();
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

const insertSession = (db: Database.Database, id: string, directory: string, time: number, parentId: string | null = null) => {
  db.prepare('INSERT INTO session (id, directory, parent_id, time_created, time_updated) VALUES (?, ?, ?, ?, ?)')
    .run(id, directory, parentId, time, time);
};

const insertAssistant = (db: Database.Database, id: string, sessionId: string, time: number, data: object) => {
  db.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)')
    .run(id, sessionId, time, time, JSON.stringify({ role: 'assistant', ...data }));
};

test('reads the model, variant and agent of the newest reply since the PTY started', async () => {
  await withHarness(({ databasePath, projectPath, db }) => {
    const now = Date.now();
    insertSession(db, 'ses_1', projectPath, now - 60_000);
    insertAssistant(db, 'msg_old', 'ses_1', now - 50_000, { providerID: 'openai', modelID: 'gpt-old', agent: 'build' });
    insertAssistant(db, 'msg_new', 'ses_1', now, {
      providerID: 'anthropic', modelID: 'claude-sonnet', variant: 'high', agent: 'plan',
    });

    assert.deepEqual(
      readOpenCodeShellRuntime({ providerSessionId: 'ses_1', projectPath, since: now - 1_000, databasePath }),
      { model: 'anthropic/claude-sonnet', effort: 'high', agent: 'plan', providerSessionId: 'ses_1' },
    );
    assert.equal(
      readOpenCodeShellRuntime({ providerSessionId: 'ses_1', projectPath, since: now + 1_000, databasePath }),
      null,
    );
  });
});

test('unmapped shells skip sessions owned by another app row', async () => {
  await withHarness(({ databasePath, projectPath, db }) => {
    const now = Date.now();
    sessionsDb.createAppSession('other-app', 'opencode', projectPath);
    sessionsDb.assignProviderSessionId('other-app', 'ses_foreign');
    insertSession(db, 'ses_mine', projectPath, now - 2_000);
    insertSession(db, 'ses_foreign', projectPath, now);
    insertAssistant(db, 'm1', 'ses_mine', now - 1_000, { providerID: 'a', modelID: 'mine' });
    insertAssistant(db, 'm2', 'ses_foreign', now, { providerID: 'a', modelID: 'foreign' });

    assert.equal(
      readOpenCodeShellRuntime({ projectPath, appSessionId: 'app-1', since: now - 5_000, databasePath })?.model,
      'a/mine',
    );
  });
});

test('lists only top-level sessions created in the project since the PTY started', async () => {
  await withHarness(({ databasePath, projectPath, db }) => {
    const now = Date.now();
    insertSession(db, 'ses_old', projectPath, now - 10 * 60_000);
    insertSession(db, 'ses_new', projectPath, now);
    insertSession(db, 'ses_child', projectPath, now, 'ses_new');
    insertSession(db, 'ses_elsewhere', '/elsewhere', now);

    assert.deepEqual(findShellCreatedOpenCodeSessions(projectPath, now - 1_000, databasePath), ['ses_new']);
  });
});
