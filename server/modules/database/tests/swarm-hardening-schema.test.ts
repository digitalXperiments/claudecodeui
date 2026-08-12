import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import {
  closeConnection,
  getConnection,
  initializeDatabase,
} from '@/modules/database/index.js';
import { makeScratchDir } from '@/shared/scratch.js';

test('upgraded databases receive durable swarm and interrupt control-plane schema', async () => {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const directory = await makeScratchDir('swarm-schema-');
  const databasePath = path.join(directory, 'auth.db');
  closeConnection();

  const legacy = new Database(databasePath);
  legacy.exec(`
    CREATE TABLE projects (
      project_id TEXT PRIMARY KEY NOT NULL,
      project_path TEXT NOT NULL UNIQUE,
      custom_project_name TEXT,
      isStarred BOOLEAN DEFAULT 0,
      isArchived BOOLEAN DEFAULT 0,
      category_id TEXT
    );
    CREATE TABLE swarm_runs (
      swarm_id TEXT PRIMARY KEY NOT NULL,
      project_id TEXT NOT NULL,
      parent_run_id TEXT,
      goal TEXT NOT NULL,
      status TEXT NOT NULL,
      roles_json TEXT NOT NULL,
      findings_json TEXT DEFAULT '[]',
      synthesis_json TEXT,
      plan_json TEXT,
      blackboard_json TEXT DEFAULT '[]',
      skills_json TEXT DEFAULT '[]',
      config_json TEXT,
      workspace_id TEXT,
      pr_url TEXT,
      feature_branch TEXT,
      approval_status TEXT,
      interrupt_id TEXT,
      archived_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      finished_at DATETIME
    );
    CREATE TABLE swarm_members (
      member_id TEXT PRIMARY KEY NOT NULL,
      swarm_id TEXT NOT NULL,
      role TEXT NOT NULL,
      kind TEXT,
      label TEXT,
      provider TEXT,
      model TEXT,
      effort TEXT,
      permission_mode TEXT,
      skills_json TEXT,
      step_id TEXT,
      run_id TEXT,
      status TEXT NOT NULL,
      findings_summary TEXT,
      error TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      finished_at DATETIME
    );
    CREATE TABLE interrupts (
      interrupt_id TEXT PRIMARY KEY NOT NULL,
      project_id TEXT,
      kind TEXT NOT NULL,
      severity TEXT NOT NULL DEFAULT 'warning',
      title TEXT NOT NULL,
      body TEXT DEFAULT '',
      run_id TEXT,
      task_id TEXT,
      workspace_id TEXT,
      href TEXT,
      actions_json TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'open',
      snooze_until DATETIME,
      resolved_at DATETIME,
      resolved_by TEXT,
      resolution TEXT,
      priority INTEGER NOT NULL DEFAULT 50,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      meta_json TEXT DEFAULT '{}'
    );
  `);
  legacy.close();

  process.env.DATABASE_PATH = databasePath;
  try {
    await initializeDatabase();
    const db = getConnection();
    const swarmColumns = new Set(
      (db.prepare(`PRAGMA table_info(swarm_runs)`).all() as Array<{ name: string }>).map(
        (column) => column.name,
      ),
    );
    for (const expected of [
      'version',
      'cancel_requested_at',
      'lease_owner',
      'lease_expires_at',
      'idempotency_key',
      'last_error',
    ]) {
      assert.ok(swarmColumns.has(expected), `missing swarm_runs.${expected}`);
    }

    const interruptColumns = new Set(
      (db.prepare(`PRAGMA table_info(interrupts)`).all() as Array<{ name: string }>).map(
        (column) => column.name,
      ),
    );
    assert.ok(interruptColumns.has('dedupe_key'));

    const attempts = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'swarm_step_attempts'`)
      .get() as { name: string } | undefined;
    assert.equal(attempts?.name, 'swarm_step_attempts');
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(directory, { recursive: true, force: true });
  }
});
