import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import Database from 'better-sqlite3';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import {
  AntigravitySessionSynchronizer,
  antigravityConversationsDir,
} from '@/modules/providers/index.js';

// Minimal protobuf writer for a type-14 (user input) step, matching 1.1.1.
const varint = (value: number): Buffer => {
  const bytes: number[] = [];
  let remaining = value;
  do {
    let byte = remaining % 128;
    remaining = Math.floor(remaining / 128);
    if (remaining > 0) byte |= 0x80;
    bytes.push(byte);
  } while (remaining > 0);
  return Buffer.from(bytes);
};
const pbVarint = (field: number, value: number): Buffer => Buffer.concat([varint(field * 8), varint(value)]);
const pbBytes = (field: number, value: Buffer | string): Buffer => {
  const body = Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8');
  return Buffer.concat([varint(field * 8 + 2), varint(body.length), body]);
};
const userInputStep = (text: string): Buffer => Buffer.concat([
  pbVarint(1, 14),
  pbBytes(19, pbBytes(2, text)),
]);

const writeConversation = (
  dir: string,
  sessionId: string,
  prompt: string | null,
  meta: Record<string, unknown> | null,
): void => {
  fs.mkdirSync(dir, { recursive: true });
  fs.rmSync(path.join(dir, `${sessionId}.db`), { force: true });
  const db = new Database(path.join(dir, `${sessionId}.db`));
  db.exec('CREATE TABLE steps (idx integer PRIMARY KEY, step_type integer NOT NULL DEFAULT 0, step_payload blob)');
  if (prompt !== null) {
    db.prepare('INSERT INTO steps (idx, step_type, step_payload) VALUES (?, ?, ?)').run(0, 14, userInputStep(prompt));
  }
  db.close();
  if (meta) fs.writeFileSync(path.join(dir, `${sessionId}.meta`), JSON.stringify(meta));
};

async function withHarness(
  runTest: (conversationsDir: string) => void | Promise<void>,
): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const previousRuntimeDir = process.env.CLOUDCLI_ANTIGRAVITY_DIR;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'antigravity-sync-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  process.env.CLOUDCLI_ANTIGRAVITY_DIR = path.join(tempDirectory, 'runtime');
  await initializeDatabase();

  try {
    await runTest(antigravityConversationsDir());
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    if (previousRuntimeDir === undefined) delete process.env.CLOUDCLI_ANTIGRAVITY_DIR;
    else process.env.CLOUDCLI_ANTIGRAVITY_DIR = previousRuntimeDir;
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

describe('antigravity session synchronizer', () => {
  it('indexes conversations and names them from the first user prompt', async () => {
    await withHarness(async (dir) => {
      writeConversation(dir, 'sess-1', 'Fix the login redirect loop', { cwd: '/workspace/app' });

      const processed = await new AntigravitySessionSynchronizer().synchronize();
      assert.equal(processed, 1);

      const row = sessionsDb.getSessionByProviderSessionId('sess-1', 'antigravity');
      assert.equal(row?.custom_name, 'Fix the login redirect loop');
      assert.equal(row?.project_path, '/workspace/app');
    });
  });

  it('skips a conversation with no recorded working directory', async () => {
    // Without a cwd there is no project to file the row under, and guessing one
    // would put the session in the wrong project.
    await withHarness(async (dir) => {
      writeConversation(dir, 'sess-nocwd', 'orphan work', null);

      assert.equal(await new AntigravitySessionSynchronizer().synchronize(), 0);
      assert.equal(sessionsDb.getSessionByProviderSessionId('sess-nocwd', 'antigravity'), null);
    });
  });

  it('binds a CloudCLI-started session onto its pending app row', async () => {
    await withHarness(async (dir) => {
      sessionsDb.createAppSession('app-row', 'antigravity', '/workspace/app', { internal: true });
      writeConversation(dir, 'sess-2', 'Continue the refactor', { cwd: '/workspace/app' });

      await new AntigravitySessionSynchronizer().synchronize();

      const row = sessionsDb.getSessionById('app-row');
      assert.equal(row?.provider_session_id, 'sess-2');
      assert.equal(row?.custom_name, 'Continue the refactor');
    });
  });

  it('names a row that was indexed before its first prompt landed', async () => {
    await withHarness(async (dir) => {
      writeConversation(dir, 'sess-3', null, { cwd: '/workspace/app' });
      const sync = new AntigravitySessionSynchronizer();
      await sync.synchronize();
      assert.equal(sessionsDb.getSessionByProviderSessionId('sess-3', 'antigravity')?.custom_name, null);

      writeConversation(dir, 'sess-3', 'The prompt finally arrived', { cwd: '/workspace/app' });
      await sync.synchronize();

      assert.equal(
        sessionsDb.getSessionByProviderSessionId('sess-3', 'antigravity')?.custom_name,
        'The prompt finally arrived',
      );
    });
  });

  it('never overwrites a name the user chose', async () => {
    await withHarness(async (dir) => {
      writeConversation(dir, 'sess-4', 'Original prompt', { cwd: '/workspace/app' });
      const sync = new AntigravitySessionSynchronizer();
      await sync.synchronize();
      sessionsDb.updateSessionCustomName('sess-4', 'My renamed session');

      await sync.synchronize();

      assert.equal(
        sessionsDb.getSessionByProviderSessionId('sess-4', 'antigravity')?.custom_name,
        'My renamed session',
      );
    });
  });

  it('resolves a session from any of the files the watcher reports', async () => {
    await withHarness(async (dir) => {
      writeConversation(dir, 'sess-5', 'Watched write', { cwd: '/workspace/app' });
      const sync = new AntigravitySessionSynchronizer();

      assert.equal(await sync.synchronizeFile(path.join(dir, 'sess-5.db-wal')), 'sess-5');
      assert.equal(await sync.synchronizeFile(path.join(dir, 'sess-5.meta')), 'sess-5');
      assert.equal(await sync.synchronizeFile(path.join(dir, 'unrelated.jsonl')), null);
      assert.equal(await sync.synchronizeFile('/somewhere/else/sess-5.db'), null);
    });
  });
});
