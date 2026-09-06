import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';

import { closeConnection, getConnection, initializeDatabase } from '@/modules/database/index.js';
import { runService } from '@/modules/runs/runs.service.js';
import {
  reconcileAllAntigravityRuns,
  reconcileCompletedAntigravityRunUsage,
} from '@/modules/runs/runs-usage-reconciliation.js';
import { makeScratchDir } from '@/shared/scratch.js';

function encodeVarint(n: number): Buffer {
  const bytes: number[] = [];
  while (n >= 0x80) {
    bytes.push((n & 0x7f) | 0x80);
    n >>>= 7;
  }
  bytes.push(n);
  return Buffer.from(bytes);
}

function encodeField(tag: number, wireType: number, payload: Buffer): Buffer {
  const key = encodeVarint((tag << 3) | wireType);
  if (wireType === 0) return Buffer.concat([key, payload]);
  if (wireType === 2) return Buffer.concat([key, encodeVarint(payload.length), payload]);
  throw new Error(`Unsupported wireType ${wireType}`);
}

function createMockAntigravityBlob(options: {
  promptTokens: number;
  candidatesTokens: number;
  cachedTokens: number;
  model: string;
  stepIndex: number;
}): Buffer {
  const usage = Buffer.concat([
    encodeField(2, 0, encodeVarint(options.promptTokens)),
    encodeField(3, 0, encodeVarint(options.candidatesTokens)),
    encodeField(5, 0, encodeVarint(options.cachedTokens)),
  ]);

  const modelSub = encodeField(8, 2, Buffer.from(options.model));
  const field27 = encodeField(27, 2, modelSub);

  const kvField = Buffer.concat([
    encodeField(1, 2, Buffer.from('last_step_index')),
    encodeField(2, 2, Buffer.from(String(options.stepIndex))),
  ]);
  const field20 = encodeField(20, 2, kvField);

  const genMeta = Buffer.concat([
    encodeField(4, 2, usage),
    field27,
    field20,
  ]);

  return encodeField(1, 2, genMeta);
}

test('reconcileCompletedAntigravityRunUsage and reconcileAllAntigravityRuns update tokens and cost', async () => {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const previousHome = process.env.HOME;
  const previousAgDir = process.env.CLOUDCLI_ANTIGRAVITY_DIR;
  const directory = await makeScratchDir('runs-antigravity-rec-');
  try {
    process.env.DATABASE_PATH = path.join(directory, 'auth.db');
    closeConnection();
    await initializeDatabase();

    // Set up mock Antigravity conversation directory
    const agDir = path.join(directory, '.cloudcli', 'antigravity', 'profile', 'antigravity-acp', 'conversations');
    const fs = await import('node:fs/promises');
    await fs.mkdir(agDir, { recursive: true });

    const sessionId = 'test-ag-session-1';
    const mockDbPath = path.join(agDir, `${sessionId}.db`);
    const mockDb = new Database(mockDbPath);
    mockDb.exec(`
      CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER);
      CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB);
    `);

    // Turn 0: User prompt step 0 -> generation with 1000 prompt, 200 candidate, 300 cached
    mockDb.prepare('INSERT INTO steps (idx, step_type) VALUES (?, ?);').run(0, 14);
    mockDb.prepare('INSERT INTO gen_metadata (idx, data) VALUES (?, ?);').run(
      0,
      createMockAntigravityBlob({
        promptTokens: 1000,
        candidatesTokens: 200,
        cachedTokens: 300,
        model: 'gemini-3.8-flash-high',
        stepIndex: 0,
      }),
    );

    // Turn 1: User prompt step 1 -> generation with 2500 prompt, 400 candidate, 500 cached
    mockDb.prepare('INSERT INTO steps (idx, step_type) VALUES (?, ?);').run(1, 14);
    mockDb.prepare('INSERT INTO gen_metadata (idx, data) VALUES (?, ?);').run(
      1,
      createMockAntigravityBlob({
        promptTokens: 2500,
        candidatesTokens: 400,
        cachedTokens: 500,
        model: 'gemini-3.8-flash-high',
        stepIndex: 1,
      }),
    );
    mockDb.close();

    const db = getConnection();
    db.prepare(`
      INSERT INTO sessions (session_id, provider, provider_session_id, jsonl_path, created_at, updated_at)
      VALUES (?, 'antigravity', ?, ?, ?, ?)
    `).run(sessionId, sessionId, mockDbPath, '2026-07-01T10:00:00.000Z', '2026-07-01T10:00:00.000Z');

    // Create run 1
    const run1 = runService.create({
      source: 'chat',
      provider: 'antigravity',
      model: 'default',
      appSessionId: sessionId,
    });
    db.prepare(`
      UPDATE agent_runs
      SET created_at = ?, started_at = ?, finished_at = ?, status = 'succeeded'
      WHERE run_id = ?
    `).run(
      '2026-07-01T10:01:00.000Z',
      '2026-07-01T10:01:00.000Z',
      '2026-07-01T10:02:00.000Z',
      run1.run_id,
    );

    // Create run 2
    const run2 = runService.create({
      source: 'chat',
      provider: 'antigravity',
      model: 'default',
      appSessionId: sessionId,
    });
    db.prepare(`
      UPDATE agent_runs
      SET created_at = ?, started_at = ?, finished_at = ?, status = 'succeeded'
      WHERE run_id = ?
    `).run(
      '2026-07-01T10:05:00.000Z',
      '2026-07-01T10:05:00.000Z',
      '2026-07-01T10:06:00.000Z',
      run2.run_id,
    );

    // Override env so resolveAntigravityDbPath finds our test conversations
    process.env.HOME = directory;
    process.env.CLOUDCLI_ANTIGRAVITY_DIR = path.join(directory, '.cloudcli', 'antigravity');

    // Test single run reconciliation for run 1
    const reconciled1 = reconcileCompletedAntigravityRunUsage(run1.run_id);
    assert.equal(reconciled1, true);

    const repaired1 = runService.get(run1.run_id);
    assert.equal(repaired1?.token_input, 1000);
    assert.equal(repaired1?.token_output, 200);
    assert.equal(repaired1?.token_total, 1200);
    assert.equal(repaired1?.token_cache_read, 300);
    assert.equal(repaired1?.model, 'gemini-3.8-flash-high');
    assert.ok(repaired1?.cost_usd_estimate != null && repaired1.cost_usd_estimate > 0);

    // Test batch reconciliation for remaining runs (run 2)
    const reconciledCount = reconcileAllAntigravityRuns();
    assert.equal(reconciledCount, 1);

    const repaired2 = runService.get(run2.run_id);
    // Cumulative at turn 1: 1000 + 2500 = 3500 input, 200 + 400 = 600 output, 4100 total
    assert.equal(repaired2?.token_input, 3500);
    assert.equal(repaired2?.token_output, 600);
    assert.equal(repaired2?.token_total, 4100);
    assert.equal(repaired2?.token_cache_read, 800);
    assert.equal(repaired2?.model, 'gemini-3.8-flash-high');
    assert.ok(repaired2?.cost_usd_estimate != null && repaired2.cost_usd_estimate > 0);

    // Verify global stats rollup converts cumulative snapshots into deltas correctly!
    const stats = runService.globalStats({});
    const agProvider = stats.providers.find((p) => p.provider === 'antigravity');
    assert.ok(agProvider != null);
    assert.equal(agProvider.runs, 2);
    // Deltas: run1 = 1200, run2 = (4100 - 1200) = 2900. Total = 4100
    assert.equal(agProvider.tokens, 4100);

    // Verify model breakdown in global stats!
    const agModel = stats.models.find((m) => m.model === 'gemini-3.8-flash-high');
    assert.ok(agModel != null, 'gemini-3.8-flash-high should appear in stats.models');
    assert.equal(agModel.runs, 2);
    assert.equal(agModel.tokens, 4100);
    assert.ok(agModel.costUsd != null && agModel.costUsd > 0);
  } finally {
    process.env.DATABASE_PATH = previousDatabasePath;
    process.env.HOME = previousHome;
    process.env.CLOUDCLI_ANTIGRAVITY_DIR = previousAgDir;
    closeConnection();
    await rm(directory, { recursive: true, force: true });
  }
});
