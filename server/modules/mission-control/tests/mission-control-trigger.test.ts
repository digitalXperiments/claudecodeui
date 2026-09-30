import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection, initializeDatabase } from '@/modules/database/index.js';
import { interruptsService } from '@/modules/interrupt-queue/index.js';
import { configureMissionControlRuntimes } from '@/modules/mission-control/mission-control-agent.service.js';
import { missionControlDb } from '@/modules/mission-control/mission-control.repository.js';
import { runSectionProduce } from '@/modules/mission-control/mission-control-runner.service.js';
import { tickSection } from '@/modules/mission-control/mission-control-scheduler.service.js';
import { chatRunRegistry } from '@/modules/websocket/index.js';
import type { AnyRecord } from '@/shared/types.js';

type Writer = {
  send: (event: AnyRecord) => void;
  sendComplete: (event: AnyRecord) => void;
};

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'mc-trigger-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'trigger.db');
  await initializeDatabase();
  try {
    await runTest();
  } finally {
    chatRunRegistry.clearAll();
    configureMissionControlRuntimes({});
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

function stubRuntime(): void {
  configureMissionControlRuntimes({
    claude: async (_command: string, _options: AnyRecord, writer: unknown) => {
      const w = writer as Writer;
      w.send({
        kind: 'text',
        provider: 'claude',
        content: JSON.stringify([
          { title: 'Draft', summary: 's', body: { v: 1 }, dedupeKey: 'trigger-1', confidence: 0.9 },
        ]),
      });
      w.sendComplete({ exitCode: 0 });
    },
  });
}

function produceTriggers(sectionId: string): Array<string | null> {
  return (getConnection()
    .prepare("SELECT trigger FROM agent_runs WHERE source_ref = ? AND json_extract(meta_json, '$.phase') = 'produce'")
    .all(sectionId) as Array<{ trigger: string | null }>).map((row) => row.trigger);
}

test('scheduler tick records the schedule trigger; manual run stays manual', async () => {
  await withIsolatedDatabase(async () => {
    stubRuntime();
    const scheduled = missionControlDb.createSection({ title: 'Sched', mode: 'review', provider: 'claude', produce_prompt: 'Produce.' });
    await tickSection(scheduled.section_id);
    assert.deepEqual(produceTriggers(scheduled.section_id), ['schedule']);

    const manual = missionControlDb.createSection({ title: 'Manual', mode: 'review', provider: 'claude', produce_prompt: 'Produce.' });
    await runSectionProduce(manual.section_id);
    assert.deepEqual(produceTriggers(manual.section_id), ['manual']);
  });
});

test('approval interrupt links to the Bot Studio deep link', async () => {
  await withIsolatedDatabase(async () => {
    stubRuntime();
    const section = missionControlDb.createSection({ title: 'Links', mode: 'review', provider: 'claude', produce_prompt: 'Produce.' });
    await runSectionProduce(section.section_id);
    // Interrupt creation is fire-and-forget behind a dynamic import.
    for (let i = 0; i < 50 && !interruptsService.list({}).length; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const interrupts = interruptsService.list({}).filter((entry) => entry.kind === 'approval_pending');
    assert.ok(interrupts.length > 0);
    for (const entry of interrupts) {
      assert.equal(entry.href, `/bots/b/${encodeURIComponent(section.section_id)}/overview`);
    }
  });
});
