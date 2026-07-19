import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection, initializeDatabase, projectsDb } from '@/modules/database/index.js';
import { chatRunRegistry } from '@/modules/websocket/index.js';
import { handleRunCompletion, kanbanDb, reconcileKanbanOnBoot } from '@/modules/kanban/index.js';

async function withDb(runTest: (projectId: string) => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'kanban-auto-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();
  getConnection().pragma('foreign_keys = ON');
  chatRunRegistry.clearAll();
  const created = projectsDb.createProjectPath(tempDirectory);
  try {
    await runTest(created.project!.project_id);
  } finally {
    chatRunRegistry.clearAll();
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

test('reconcileKanbanOnBoot fails runs left running with no live registry entry', async () => {
  await withDb((projectId) => {
    const board = kanbanDb.createBoard({ projectId, name: 'Board' });
    const task = kanbanDb.createTask({
      boardId: board.board_id,
      projectId,
      title: 'Interrupted',
      assigneeProvider: 'claude',
    });
    const run = kanbanDb.createRun({
      taskId: task.task_id,
      appSessionId: 'sess-stale',
      provider: 'claude',
      trigger: 'manual',
    });
    kanbanDb.setTaskStatus(task.task_id, 'running');

    reconcileKanbanOnBoot();

    assert.equal(kanbanDb.getRun(run.run_id)?.status, 'failed');
    assert.equal(kanbanDb.getTask(task.task_id)?.status, 'failed');
  });
});

test('handleRunCompletion ignores sessions with no kanban run', async () => {
  await withDb(() => {
    // No kanban run exists for this session (interactive chat) — must be a no-op.
    assert.doesNotThrow(() =>
      handleRunCompletion({
        appSessionId: 'interactive-session',
        provider: 'claude',
        exitCode: 0,
        success: true,
        aborted: false,
      }),
    );
  });
});
