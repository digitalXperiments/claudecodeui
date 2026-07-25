import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase } from '@/modules/database/index.js';
import { missionControlDb } from '@/modules/mission-control/mission-control.repository.js';
import { applyItemAction } from '@/modules/mission-control/mission-control-runner.service.js';
import { kanbanDb, COLUMN_BACKLOG } from '@/modules/kanban/index.js';
import type { McSection } from '@/modules/mission-control/mission-control.types.js';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'mc-kanban-bridge-'));
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

// A review section with no resolve prompt: Approve resolves immediately (no agent
// run), which is enough to exercise the kanban bridge.
function seedSection(overrides: Partial<McSection> = {}) {
  return missionControlDb.createSection({
    title: 'Jira drafts',
    mode: 'review',
    provider: 'claude',
    resolve_prompt: '',
    create_kanban_task: true,
    kanban_assignee_provider: 'claude',
    ...overrides,
  });
}

test('approve bridges an item to a global-board backlog card', async () => {
  await withIsolatedDatabase(async () => {
    const section = seedSection();
    const item = missionControlDb.insertItemIfNew(section, {
      title: 'Fix checkout bug',
      summary: 'Users cannot pay',
      body: {},
      dedupeKey: 'k1',
    });
    assert.ok(item);

    const resolved = await applyItemAction(item.item_id, 'approve');
    assert.ok(resolved);
    assert.equal(resolved.status, 'resolved');
    const taskId = resolved.result?.kanbanTaskId;
    assert.equal(typeof taskId, 'string');

    const board = kanbanDb.getOrCreateGlobalBoard();
    const tasks = kanbanDb.listTasksByBoard(board.board_id);
    assert.equal(tasks.length, 1);
    const card = tasks[0];
    assert.equal(card.task_id, taskId);
    assert.equal(card.title, 'Fix checkout bug');
    assert.equal(card.column_id, COLUMN_BACKLOG);
    assert.equal(card.assignee_provider, 'claude');
    // No project attached yet — the user picks one before moving to In Progress.
    assert.equal(card.project_id, '');
  });
});

test('approve does not create a card when the bridge is disabled', async () => {
  await withIsolatedDatabase(async () => {
    const section = seedSection({ create_kanban_task: false });
    const item = missionControlDb.insertItemIfNew(section, {
      title: 'No bridge',
      summary: '',
      body: {},
      dedupeKey: 'k2',
    });
    assert.ok(item);

    const resolved = await applyItemAction(item.item_id, 'approve');
    assert.equal(resolved?.status, 'resolved');
    assert.equal(resolved?.result?.kanbanTaskId, undefined);

    const board = kanbanDb.getOrCreateGlobalBoard();
    assert.equal(kanbanDb.listTasksByBoard(board.board_id).length, 0);
  });
});
