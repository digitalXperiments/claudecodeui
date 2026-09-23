import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase } from '@/modules/database/index.js';
import { missionControlDb } from '@/modules/mission-control/mission-control.repository.js';
import { simulateSectionTick } from '@/modules/mission-control/mission-control-simulator.service.js';
import { runsDb } from '@/modules/runs/index.js';

async function withIsolatedDatabase(run: () => void | Promise<void>): Promise<void> {
  const previousPath = process.env.DATABASE_PATH;
  const scratchRoot = path.resolve('tmp/cloudcli');
  await mkdir(scratchRoot, { recursive: true });
  const scratch = await mkdtemp(path.join(scratchRoot, 'bot-studio-simulator-'));
  closeConnection();
  const databasePath = path.join(scratch, 'simulator.db');
  // An existing empty file prevents the app's one-time legacy DB migration.
  await writeFile(databasePath, '');
  process.env.DATABASE_PATH = databasePath;
  await initializeDatabase();
  try {
    await run();
  } finally {
    closeConnection();
    if (previousPath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousPath;
    await rm(scratch, { recursive: true, force: true });
  }
}

test('simulator applies produce dedupe rules without creating an inbox item or run', async () => {
  await withIsolatedDatabase(() => {
    const section = missionControlDb.createSection({
      title: 'Sample bot',
      produce_prompt: 'Find useful work.',
      mode: 'review',
      auto_approve: true,
    });
    missionControlDb.insertItemIfNew(section, {
      title: 'Already seen',
      summary: '',
      body: {},
      dedupeKey: 'source-1',
    });
    const beforeItems = missionControlDb.listItems({ sectionId: section.section_id });
    const beforeLastRun = missionControlDb.getSection(section.section_id)?.last_run_at;

    const result = simulateSectionTick(section.section_id, JSON.stringify([
      { title: 'Existing', dedupeKey: 'source-1', body: {} },
      { title: 'New', dedupeKey: 'source-2', body: { value: 2 } },
      { title: 'Repeated', dedupeKey: 'source-2', body: {} },
      { summary: 'Invalid without a title', dedupeKey: 'source-3' },
    ]));

    assert.equal(result.status, 'ready');
    assert.deepEqual(result.counts, {
      candidates: 4,
      invalid: 1,
      filtered: 0,
      wouldCreate: 1,
      skipped: 2,
    });
    assert.deepEqual(result.drafts.map((draft) => draft.outcome), [
      'already_seen', 'would_create', 'repeated_in_output',
    ]);
    assert.equal(result.drafts[1]?.nextStep, 'auto_approve');
    assert.deepEqual(missionControlDb.listItems({ sectionId: section.section_id }), beforeItems);
    assert.equal(missionControlDb.getSection(section.section_id)?.last_run_at, beforeLastRun);
    assert.deepEqual(runsDb.listBySourceRefs('mission_control', [section.section_id]), []);
  });
});

test('paused and fire-and-forget bots preview their real routing without writes', async () => {
  await withIsolatedDatabase(() => {
    const paused = missionControlDb.createSection({
      title: 'Paused bot',
      enabled: false,
      produce_prompt: 'Find useful work.',
    });
    assert.equal(simulateSectionTick(paused.section_id, '[]').status, 'disabled');

    const actor = missionControlDb.createSection({
      title: 'Acting bot',
      mode: 'fire_and_forget',
      produce_prompt: 'Complete the task.',
    });
    const result = simulateSectionTick(actor.section_id, 'A completed result.');
    assert.equal(result.drafts[0]?.outcome, 'would_log');
    assert.equal(result.drafts[0]?.nextStep, 'resolved');
    assert.deepEqual(missionControlDb.listItems({ sectionId: actor.section_id }), []);
    assert.deepEqual(runsDb.listBySourceRefs('mission_control', [actor.section_id]), []);
  });
});
