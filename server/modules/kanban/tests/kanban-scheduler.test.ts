import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection, initializeDatabase, projectsDb } from '@/modules/database/index.js';
import {
  getScheduledJobCount,
  kanbanDb,
  startKanbanScheduler,
  stopKanbanScheduler,
  syncSchedules,
} from '@/modules/kanban/index.js';

async function withDb(runTest: (projectId: string) => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'kanban-sched-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();
  getConnection().pragma('foreign_keys = ON');
  const created = projectsDb.createProjectPath(tempDirectory);
  try {
    await runTest(created.project!.project_id);
  } finally {
    stopKanbanScheduler();
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

test('scheduler registers a job per scheduled task and drops removed ones', async () => {
  await withDb((projectId) => {
    const board = kanbanDb.createBoard({ projectId, name: 'Board' });
    const task = kanbanDb.createTask({
      boardId: board.board_id,
      projectId,
      title: 'Nightly',
      assigneeProvider: 'claude',
      scheduleCron: '0 3 * * *',
    });

    startKanbanScheduler();
    assert.equal(getScheduledJobCount(), 1);

    // Remove the cron → job is torn down on the next sync.
    kanbanDb.updateTask(task.task_id, { scheduleCron: null });
    syncSchedules();
    assert.equal(getScheduledJobCount(), 0);
  });
});

test('syncSchedules is a no-op before the scheduler is started', async () => {
  await withDb((projectId) => {
    const board = kanbanDb.createBoard({ projectId, name: 'Board' });
    kanbanDb.createTask({
      boardId: board.board_id,
      projectId,
      title: 'Nightly',
      assigneeProvider: 'claude',
      scheduleCron: '0 3 * * *',
    });
    syncSchedules();
    assert.equal(getScheduledJobCount(), 0);
  });
});

test('an invalid cron expression is skipped without throwing', async () => {
  await withDb((projectId) => {
    const board = kanbanDb.createBoard({ projectId, name: 'Board' });
    kanbanDb.createTask({
      boardId: board.board_id,
      projectId,
      title: 'Broken',
      assigneeProvider: 'claude',
      scheduleCron: 'not a cron',
    });
    assert.doesNotThrow(() => startKanbanScheduler());
    assert.equal(getScheduledJobCount(), 0);
  });
});
