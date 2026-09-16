import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  closeConnection,
  getConnection,
  initializeDatabase,
} from '@/modules/database/index.js';

test('prototype cleanup drops foreign-key tables in child-first order', async () => {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'mc-prototype-migration-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'migration.db');
  try {
    await initializeDatabase();
    const db = getConnection();
    db.pragma('foreign_keys = ON');
    db.exec(`
      CREATE TABLE bots (id TEXT PRIMARY KEY);
      CREATE TABLE bot_versions (id TEXT PRIMARY KEY, bot_id TEXT REFERENCES bots(id));
      CREATE TABLE bot_ticks (id TEXT PRIMARY KEY, version_id TEXT REFERENCES bot_versions(id));
      CREATE TABLE bot_proposals (id TEXT PRIMARY KEY, tick_id TEXT REFERENCES bot_ticks(id));
      CREATE TABLE bot_spend_daily (id TEXT PRIMARY KEY, bot_id TEXT REFERENCES bots(id));
      CREATE TABLE integration_apps (id TEXT PRIMARY KEY);
      CREATE TABLE integration_accounts (id TEXT PRIMARY KEY, app_id TEXT REFERENCES integration_apps(id));
      CREATE TABLE integration_oauth_states (id TEXT PRIMARY KEY, account_id TEXT REFERENCES integration_accounts(id));
      CREATE TABLE integration_grants (id TEXT PRIMARY KEY, account_id TEXT REFERENCES integration_accounts(id));
      CREATE TABLE integration_calls (id TEXT PRIMARY KEY, grant_id TEXT REFERENCES integration_grants(id));
      CREATE INDEX bot_ticks_idx ON bot_ticks(version_id);
      INSERT INTO bots VALUES ('bot');
      INSERT INTO bot_versions VALUES ('version', 'bot');
      INSERT INTO bot_ticks VALUES ('tick', 'version');
      INSERT INTO bot_proposals VALUES ('proposal', 'tick');
      INSERT INTO bot_spend_daily VALUES ('spend', 'bot');
      INSERT INTO integration_apps VALUES ('app');
      INSERT INTO integration_accounts VALUES ('account', 'app');
      INSERT INTO integration_oauth_states VALUES ('oauth', 'account');
      INSERT INTO integration_grants VALUES ('grant', 'account');
      INSERT INTO integration_calls VALUES ('call', 'grant');
    `);

    await initializeDatabase();

    const remaining = db.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (
        'bots', 'bot_versions', 'bot_ticks', 'bot_proposals', 'bot_spend_daily',
        'integration_apps', 'integration_accounts', 'integration_oauth_states',
        'integration_grants', 'integration_calls'
      )`,
    ).all();
    assert.deepEqual(remaining, []);
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(tempDirectory, { recursive: true, force: true });
  }
});
