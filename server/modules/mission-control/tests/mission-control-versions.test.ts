import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection, initializeDatabase } from '@/modules/database/index.js';
import { missionControlDb } from '@/modules/mission-control/mission-control.repository.js';
import { getSectionVersionHistory } from '@/modules/mission-control/mission-control-versions.service.js';

async function withDatabase(run: () => void): Promise<void> {
  const previous = process.env.DATABASE_PATH;
  const root = path.resolve('tmp/cloudcli');
  await mkdir(root, { recursive: true });
  const scratch = await mkdtemp(path.join(root, 'bot-versions-'));
  closeConnection();
  const databasePath = path.join(scratch, 'versions.db');
  await writeFile(databasePath, '');
  process.env.DATABASE_PATH = databasePath;
  await initializeDatabase();
  try { run(); } finally {
    closeConnection();
    if (previous === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previous;
    await rm(scratch, { recursive: true, force: true });
  }
}

test('version snapshots track configuration edits, not runtime or list state', async () => {
  await withDatabase(() => {
    const bot = missionControlDb.createSection({ title: 'Versioned bot', produce_prompt: 'Start' });
    assert.equal(getSectionVersionHistory(bot).versions[0]?.version, 1);
    missionControlDb.updateSection(bot.section_id, { enabled: false, sort_order: 8 });
    assert.equal(getSectionVersionHistory(missionControlDb.getSection(bot.section_id)!).versions.length, 1);
    missionControlDb.updateSection(bot.section_id, { produce_prompt: 'Changed' });
    const history = getSectionVersionHistory(missionControlDb.getSection(bot.section_id)!);
    assert.deepEqual(history.versions.map((version) => version.version), [2, 1]);
    assert.equal(history.versions[0]?.config.produce_prompt, 'Changed');
    assert.equal(history.versions[1]?.config.produce_prompt, 'Start');
  });
});

test('scorecards attribute only stamped produce ticks and preserve unknown usage', async () => {
  await withDatabase(() => {
    const bot = missionControlDb.createSection({ title: 'Score bot' });
    const db = getConnection();
    const insert = db.prepare(`INSERT INTO agent_runs
      (run_id, source, source_ref, status, trigger, meta_json, token_total, cost_usd_estimate, created_at)
      VALUES (?, 'mission_control', ?, ?, 'manual', ?, ?, ?, ?)`);
    const now = new Date().toISOString();
    insert.run('run-1', bot.section_id, 'succeeded', JSON.stringify({ phase: 'produce', bot_version: 1 }), 100, 0.25, now);
    insert.run('run-2', bot.section_id, 'failed', JSON.stringify({ phase: 'produce', bot_version: 1 }), null, null, now);
    insert.run('run-old', bot.section_id, 'succeeded', JSON.stringify({ phase: 'produce' }), null, null, now);
    insert.run('run-resolve', bot.section_id, 'succeeded', JSON.stringify({ phase: 'resolve', bot_version: 1 }), null, null, now);
    const history = getSectionVersionHistory(bot);
    assert.equal(history.unversionedRuns, 1);
    assert.equal(history.versions[0]?.scorecard.ticks, 2);
    assert.equal(history.versions[0]?.scorecard.successRate, 0.5);
    assert.equal(history.versions[0]?.scorecard.totalTokens, 100);
    assert.equal(history.versions[0]?.scorecard.runsWithCost, 1);
    assert.equal(history.versions[0]?.scorecard.totalCostUsd, 0.25);
  });
});

test('older snapshots without a memory field do not produce a phantom version', async () => {
  await withDatabase(() => {
    const bot = missionControlDb.createSection({ title: 'Legacy version' });
    const db = getConnection();
    db.prepare(`UPDATE mc_section_versions SET snapshot_json = json_remove(snapshot_json, '$.approved_memory') WHERE section_id = ?`).run(bot.section_id);
    const history = getSectionVersionHistory(bot);
    assert.equal(history.versions.length, 1);
    assert.deepEqual(history.versions[0]?.config.approved_memory, []);
  });
});
