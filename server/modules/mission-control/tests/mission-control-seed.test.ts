import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase } from '@/modules/database/index.js';
import { missionControlDb } from '@/modules/mission-control/mission-control.repository.js';
import {
  buildTrelloTasksSectionInput,
  ensureTrelloTasksSection,
  ensureMissionControlSeedSections,
  TRELLO_TASKS_SECTION_TITLE,
} from '@/modules/mission-control/mission-control-seed.service.js';
import type { TrelloSeedBoardConfig } from '@/modules/mission-control/mission-control-seed.config.js';

const FAKE_BOARD: TrelloSeedBoardConfig = {
  boardName: 'Test Board',
  boardShortLink: 'testShortLink',
  boardUrl: 'https://trello.com/b/testShortLink/test-board',
  boardId: 'aaaaaaaaaaaaaaaaaaaaaaaa',
  priorityListName: 'Priority Items',
  priorityListId: 'bbbbbbbbbbbbbbbbbbbbbbbb',
  client: 'Acme_Co',
  suggestedProjectPathExample: '/tmp/example-project',
  kanbanMcpTools: ['Composio'],
};

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'mc-seed-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();
  try {
    await runTest();
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

async function withTrelloSeedConfig(
  config: TrelloSeedBoardConfig | null,
  runTest: () => void | Promise<void>,
): Promise<void> {
  const previousConfigPath = process.env.CLOUDCLI_TRELLO_SEED_CONFIG_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'mc-seed-config-'));
  const configPath = path.join(tempDirectory, 'trello-seed.json');
  process.env.CLOUDCLI_TRELLO_SEED_CONFIG_PATH = configPath;
  if (config) {
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(configPath, JSON.stringify(config), 'utf8');
  }
  try {
    await runTest();
  } finally {
    if (previousConfigPath === undefined) {
      delete process.env.CLOUDCLI_TRELLO_SEED_CONFIG_PATH;
    } else {
      process.env.CLOUDCLI_TRELLO_SEED_CONFIG_PATH = previousConfigPath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

test('Trello Tasks seed is a no-op without a user config file', async () => {
  await withIsolatedDatabase(async () => {
    await withTrelloSeedConfig(null, async () => {
      const result = ensureTrelloTasksSection();
      assert.equal(result.created, false);
      assert.equal(result.updated, false);
      assert.equal(result.section, null);

      // The aggregate seeder still runs config-free sections (X Articles);
      // what must be absent is a Trello section.
      const seeded = ensureMissionControlSeedSections();
      assert.equal(
        seeded.filter((s) => s.title === TRELLO_TASKS_SECTION_TITLE).length,
        0,
      );
    });
  });
});

test('Trello Tasks seed creates once and is idempotent when configured', async () => {
  await withIsolatedDatabase(async () => {
    await withTrelloSeedConfig(FAKE_BOARD, async () => {
      const input = buildTrelloTasksSectionInput(FAKE_BOARD);
      assert.equal(input.title, TRELLO_TASKS_SECTION_TITLE);
      assert.equal(input.provider, 'grok');
      assert.equal(input.create_kanban_task, true);
      assert.equal(input.auto_approve, true);
      assert.ok(input.produce_tools?.includes('Composio'));
      assert.ok(input.produce_prompt?.includes(FAKE_BOARD.boardShortLink));
      assert.ok(input.produce_prompt?.includes('trello:card:'));
      assert.equal(input.resolve_prompt, '');

      const first = ensureTrelloTasksSection();
      assert.equal(first.created, true);
      assert.equal(first.updated, false);
      assert.ok(first.section);
      assert.equal(first.section!.title, TRELLO_TASKS_SECTION_TITLE);
      assert.equal(first.section!.provider, 'grok');
      assert.equal(first.section!.create_kanban_task, true);
      assert.ok(first.section!.produce_prompt.includes('Prompt version:'));

      const second = ensureTrelloTasksSection();
      assert.equal(second.created, false);
      assert.equal(second.updated, false);
      assert.equal(second.section!.section_id, first.section!.section_id);

      // Stale prompt (missing version marker) should refresh on ensure.
      missionControlDb.updateSection(first.section!.section_id, {
        produce_prompt: 'old prompt without version marker',
      });
      const third = ensureTrelloTasksSection();
      assert.equal(third.created, false);
      assert.equal(third.updated, true);
      assert.ok(third.section!.produce_prompt.includes('Prompt version:'));
      assert.ok(third.section!.produce_prompt.includes('Priority Items'));

      const all = missionControlDb.listSections().filter((s) => s.title === TRELLO_TASKS_SECTION_TITLE);
      assert.equal(all.length, 1);
    });
  });
});
