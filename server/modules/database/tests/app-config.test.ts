import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { makeScratchDir } from '@/shared/scratch.js';
import { appConfigDb, closeConnection, initializeDatabase } from '@/modules/database/index.js';

async function withTempDb(fn: () => Promise<void> | void): Promise<void> {
  const previous = process.env.DATABASE_PATH;
  const directory = await makeScratchDir('app-config-');
  closeConnection();
  process.env.DATABASE_PATH = path.join(directory, 'auth.db');
  await initializeDatabase();
  try {
    await fn();
  } finally {
    closeConnection();
    if (previous === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previous;
    await rm(directory, { recursive: true, force: true });
  }
}

test('getOrCreateJwtSecret persists and never rotates on a second read', async () => {
  await withTempDb(() => {
    const first = appConfigDb.getOrCreateJwtSecret();
    assert.equal(first.length, 128);
    const second = appConfigDb.getOrCreateJwtSecret();
    assert.equal(second, first);
    assert.equal(appConfigDb.get('jwt_secret'), first);
  });
});

test('getOrCreateJwtSecret does not overwrite a secret another writer persisted', async () => {
  await withTempDb(() => {
    appConfigDb.set('jwt_secret', 'already-there');
    assert.equal(appConfigDb.getOrCreateJwtSecret(), 'already-there');
  });
});
