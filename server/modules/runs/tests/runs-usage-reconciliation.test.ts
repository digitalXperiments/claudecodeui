import assert from 'node:assert/strict';
import { rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection, initializeDatabase } from '@/modules/database/index.js';
import { estimateCostUsd } from '@/modules/runs/model-pricing.js';
import { runService } from '@/modules/runs/runs.service.js';
import { reconcileCompletedClaudeRunUsage } from '@/modules/runs/runs-usage-reconciliation.js';
import { makeScratchDir } from '@/shared/scratch.js';

test('completed Claude runs are durably repaired from their authoritative JSONL window', async () => {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const directory = await makeScratchDir('runs-usage-reconciliation-');
  try {
    process.env.DATABASE_PATH = path.join(directory, 'auth.db');
    closeConnection();
    await initializeDatabase();

    const jsonlPath = path.join(directory, 'claude-session.jsonl');
    const assistant = (
      timestamp: string,
      input: number,
      cacheRead: number,
      cacheWrite: number,
      output: number,
    ) => JSON.stringify({
      type: 'assistant',
      timestamp,
      message: {
        model: 'claude-sonnet-5',
        usage: {
          input_tokens: input,
          cache_read_input_tokens: cacheRead,
          cache_creation_input_tokens: cacheWrite,
          output_tokens: output,
        },
      },
    });
    await writeFile(
      jsonlPath,
      [
        assistant('2026-07-01T09:55:00.000Z', 1, 9, 0, 1),
        assistant('2026-07-01T10:05:00.000Z', 100, 900, 50, 25),
        assistant('2026-07-01T10:10:00.000Z', 200, 1_800, 100, 50),
      ].join('\n'),
      'utf8',
    );

    const db = getConnection();
    db.prepare(
      `INSERT INTO sessions (session_id, provider, jsonl_path, created_at, updated_at)
       VALUES (?, 'claude', ?, ?, ?)`,
    ).run('session-reconcile', jsonlPath, '2026-07-01T09:00:00.000Z', '2026-07-01T09:00:00.000Z');

    const run = runService.create({
      source: 'chat',
      provider: 'claude',
      model: 'default',
      appSessionId: 'session-reconcile',
    });
    runService.attachUsage(run.run_id, {
      input: 99_000,
      output: 9_000,
      total: 108_000,
      costUsdEstimate: 999,
    });
    db.prepare(
      `UPDATE agent_runs
       SET created_at = ?, started_at = ?, finished_at = ?, status = 'succeeded'
       WHERE run_id = ?`,
    ).run(
      '2026-07-01T10:00:00.000Z',
      '2026-07-01T10:00:00.000Z',
      '2026-07-01T10:15:00.000Z',
      run.run_id,
    );

    assert.equal(reconcileCompletedClaudeRunUsage(run.run_id), true);
    const repaired = runService.get(run.run_id);
    assert.equal(repaired?.token_input, 3_150);
    assert.equal(repaired?.token_output, 75);
    assert.equal(repaired?.token_total, 3_225);
    assert.equal(repaired?.token_cache_read, 2_700);
    assert.equal(repaired?.token_cache_write, 150);
    assert.equal(repaired?.model, 'claude-sonnet-5');
    assert.equal(
      repaired?.cost_usd_estimate,
      estimateCostUsd(
        'claude',
        'claude-sonnet-5',
        3_150,
        75,
        '2026-07-01T10:00:00.000Z',
        2_700,
        150,
      ),
    );

    // Re-running the explicit completion repair is safe and deterministic.
    assert.equal(reconcileCompletedClaudeRunUsage(run.run_id), true);
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(directory, { recursive: true, force: true });
  }
});
