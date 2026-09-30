import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection, initializeDatabase } from '@/modules/database/index.js';
import { buildProducePrompt } from '@/modules/mission-control/mission-control-agent.service.js';
import { listBotExceptions } from '@/modules/mission-control/mission-control-exceptions.service.js';
import { listBotMemories, proposeBotMemory, reviewBotMemory } from '@/modules/mission-control/mission-control-memory.service.js';
import { missionControlDb } from '@/modules/mission-control/mission-control.repository.js';
import { getSectionVersionHistory, recordSectionVersion } from '@/modules/mission-control/mission-control-versions.service.js';

async function withDatabase(run: () => void): Promise<void> {
  const previous = process.env.DATABASE_PATH;
  const root = path.resolve('tmp/cloudcli');
  await mkdir(root, { recursive: true });
  const scratch = await mkdtemp(path.join(root, 'bot-operator-'));
  closeConnection();
  const databasePath = path.join(scratch, 'operator.db');
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

test('only approved memories enter future produce prompts; revocation removes them', async () => {
  await withDatabase(() => {
    const bot = missionControlDb.createSection({ title: 'Memory bot', produce_prompt: 'Find work.' });
    const proposed = proposeBotMemory(bot.section_id, 'Prefer concise summaries', null);
    assert.equal(listBotMemories(bot.section_id).length, 1);
    assert.doesNotMatch(buildProducePrompt(bot), /Prefer concise summaries/);
    reviewBotMemory(bot.section_id, proposed.memoryId, 'approved', 'Prefer concise summaries');
    recordSectionVersion(bot, 'edited');
    assert.match(buildProducePrompt(bot), /Prefer concise summaries/);
    assert.deepEqual(getSectionVersionHistory(bot).versions.map((version) => version.version), [2, 1]);
    reviewBotMemory(bot.section_id, proposed.memoryId, 'rejected');
    recordSectionVersion(bot, 'edited');
    assert.doesNotMatch(buildProducePrompt(bot), /Prefer concise summaries/);
    assert.equal(getSectionVersionHistory(bot).versions[0]?.config.approved_memory.length, 0);
  });
});

test('memory source must belong to the bot', async () => {
  await withDatabase(() => {
    const first = missionControlDb.createSection({ title: 'First' });
    const second = missionControlDb.createSection({ title: 'Second' });
    const item = missionControlDb.insertItemIfNew(first, { title: 'Source', summary: 'Example', body: {}, dedupeKey: 'source' });
    assert.ok(item);
    assert.throws(() => proposeBotMemory(second.section_id, 'Wrong source', item.item_id));
  });
});

test('exception inbox shows latest failed tick and clears it after a successful tick', async () => {
  await withDatabase(() => {
    const bot = missionControlDb.createSection({ title: 'Exception bot' });
    const db = getConnection();
    const insert = db.prepare(`INSERT INTO agent_runs (run_id, source, source_ref, status, trigger, meta_json, error_summary, created_at)
      VALUES (?, 'mission_control', ?, ?, 'manual', '{"phase":"produce"}', ?, ?)`);
    insert.run('failed-1', bot.section_id, 'failed', 'Network error', '2026-09-01T00:00:00.000Z');
    assert.equal(listBotExceptions().find((entry) => entry.runId === 'failed-1')?.detail, 'Network error');
    insert.run('success-2', bot.section_id, 'succeeded', null, '2026-09-02T00:00:00.000Z');
    assert.equal(listBotExceptions().filter((entry) => entry.kind === 'failed_tick').length, 0);
  });
});

test('exception inbox includes failures without a recorded agent run', async () => {
  await withDatabase(() => {
    const bot = missionControlDb.createSection({ title: 'Start failure' });
    getConnection().prepare('UPDATE mc_sections SET last_run_error = ? WHERE section_id = ?').run('Provider unavailable', bot.section_id);
    const entry = listBotExceptions().find((candidate) => candidate.sectionId === bot.section_id);
    assert.equal(entry?.detail, 'Provider unavailable');
    assert.equal(entry?.runId, null);
  });
});
