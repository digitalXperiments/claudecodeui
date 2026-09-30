import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection, initializeDatabase } from '@/modules/database/index.js';
import { runService } from '@/modules/runs/runs.service.js';
import { makeScratchDir } from '@/shared/scratch.js';

test('usageForSession calculates total tokens, cost, last run cost, and burn rate', async () => {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const directory = await makeScratchDir('runs-burn-rate-');
  try {
    process.env.DATABASE_PATH = path.join(directory, 'auth.db');
    closeConnection();
    await initializeDatabase();

    const db = getConnection();
    const sessionId = 'session-burn-rate-test';

    db.prepare(
      `INSERT INTO sessions (session_id, provider, created_at, updated_at)
       VALUES (?, 'claude', datetime('now'), datetime('now'))`,
    ).run(sessionId);

    // Initial usage for empty session
    const emptyUsage = runService.usageForSession(sessionId);
    assert.equal(emptyUsage.tokens, 0);
    assert.equal(emptyUsage.costUsd, 0);
    assert.equal(emptyUsage.runCount, 0);
    assert.equal(emptyUsage.lastRunCostUsd, 0);
    assert.equal(emptyUsage.burnRateUsdPerMin, 0);

    // First turn: $0.15, 1000 tokens
    const run1 = runService.create({
      source: 'chat',
      provider: 'claude',
      model: 'default',
      appSessionId: sessionId,
    });
    runService.attachUsage(run1.run_id, {
      input: 800,
      output: 200,
      total: 1000,
      costUsdEstimate: 0.15,
    });
    db.prepare(
      `UPDATE agent_runs
       SET status = 'succeeded', created_at = datetime('now', '-5 minutes')
       WHERE run_id = ?`,
    ).run(run1.run_id);

    const usage1 = runService.usageForSession(sessionId);
    assert.equal(usage1.tokens, 1000);
    assert.equal(usage1.costUsd, 0.15);
    assert.equal(usage1.runCount, 1);
    assert.equal(usage1.lastRunCostUsd, 0.15);
    assert.ok((usage1.burnRateUsdPerMin ?? 0) > 0, 'burnRateUsdPerMin should be greater than 0');

    // Second turn: $0.25, 2000 tokens
    const run2 = runService.create({
      source: 'chat',
      provider: 'claude',
      model: 'default',
      appSessionId: sessionId,
    });
    runService.attachUsage(run2.run_id, {
      input: 1600,
      output: 400,
      total: 2000,
      costUsdEstimate: 0.25,
    });
    db.prepare(
      `UPDATE agent_runs
       SET status = 'succeeded', created_at = datetime('now', '-1 minute')
       WHERE run_id = ?`,
    ).run(run2.run_id);

    const usage2 = runService.usageForSession(sessionId);
    assert.equal(usage2.tokens, 3000);
    assert.equal(usage2.costUsd, 0.40);
    assert.equal(usage2.runCount, 2);
    // lastRunCostUsd should reflect run2 ($0.25)
    assert.equal(usage2.lastRunCostUsd, 0.25);
    assert.ok((usage2.burnRateUsdPerMin ?? 0) > 0, 'burnRateUsdPerMin should be positive');
  } finally {
    closeConnection();
    process.env.DATABASE_PATH = previousDatabasePath;
    await rm(directory, { recursive: true, force: true });
  }
});
