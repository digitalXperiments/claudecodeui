import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection, initializeDatabase, projectsDb } from '@/modules/database/index.js';
import {
  handleManualColumnMove,
  kanbanDb,
  reconcileKanbanOnBoot,
  setOnTaskDone,
} from '@/modules/kanban/index.js';

/**
 * Dragging a card between columns goes through PUT /tasks/:taskId, which calls
 * handleManualColumnMove to keep the lifecycle status in sync with the column.
 * These tests cover that sync plus the boot-time repair for cards stuck by the
 * pre-fix behavior (drags used to update only column_id).
 */
async function withDb(runTest: (projectId: string) => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'kanban-move-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();
  getConnection().pragma('foreign_keys = ON');

  const created = projectsDb.createProjectPath(tempDirectory);
  const projectId = created.project!.project_id;

  try {
    await runTest(projectId);
  } finally {
    setOnTaskDone(null);
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

test('dragging into Done marks the task done and fires the done cascade', async () => {
  await withDb(async (projectId) => {
    const board = kanbanDb.createBoard({ name: 'Board' });
    const task = kanbanDb.createTask({
      boardId: board.board_id,
      projectId,
      title: 'Manual finish',
      columnId: 'in_progress',
    });
    assert.equal(task.status, 'todo');

    const doneCalls: string[] = [];
    setOnTaskDone((taskId) => doneCalls.push(taskId));

    kanbanDb.updateTask(task.task_id, { columnId: 'done' });
    handleManualColumnMove(task.task_id, 'in_progress');

    const updated = kanbanDb.getTask(task.task_id);
    assert.equal(updated?.status, 'done');
    assert.equal(updated?.column_id, 'done');
    assert.deepEqual(doneCalls, [task.task_id]);
  });
});

test('dragging out of Done reopens the task and re-blocks dependents', async () => {
  await withDb(async (projectId) => {
    const board = kanbanDb.createBoard({ name: 'Board' });
    const blocker = kanbanDb.createTask({
      boardId: board.board_id,
      projectId,
      title: 'Blocker',
      columnId: 'done',
    });
    kanbanDb.setTaskStatus(blocker.task_id, 'done');
    const dependent = kanbanDb.createTask({
      boardId: board.board_id,
      projectId,
      title: 'Dependent',
      columnId: 'backlog',
    });
    kanbanDb.addDependency(dependent.task_id, blocker.task_id);
    // Dependent is unblocked while the blocker is done.
    assert.equal(kanbanDb.getTask(dependent.task_id)?.status, 'todo');

    kanbanDb.updateTask(blocker.task_id, { columnId: 'backlog' });
    handleManualColumnMove(blocker.task_id, 'done');

    assert.equal(kanbanDb.getTask(blocker.task_id)?.status, 'todo');
    assert.equal(kanbanDb.getTask(dependent.task_id)?.status, 'blocked');
  });
});

test('queued/running tasks are left to the run lifecycle when dragged', async () => {
  await withDb(async (projectId) => {
    const board = kanbanDb.createBoard({ name: 'Board' });
    const task = kanbanDb.createTask({
      boardId: board.board_id,
      projectId,
      title: 'Running work',
      columnId: 'in_progress',
    });
    kanbanDb.setTaskStatus(task.task_id, 'running');

    const doneCalls: string[] = [];
    setOnTaskDone((taskId) => doneCalls.push(taskId));

    kanbanDb.updateTask(task.task_id, { columnId: 'done' });
    handleManualColumnMove(task.task_id, 'in_progress');

    assert.equal(kanbanDb.getTask(task.task_id)?.status, 'running');
    assert.deepEqual(doneCalls, []);
  });
});

test('boot reconcile repairs tasks stuck in Done with a non-done status', async () => {
  await withDb(async (projectId) => {
    const board = kanbanDb.createBoard({ name: 'Board' });
    const stuck = kanbanDb.createTask({
      boardId: board.board_id,
      projectId,
      title: 'Stuck card',
      columnId: 'done',
    });
    const running = kanbanDb.createTask({
      boardId: board.board_id,
      projectId,
      title: 'Running card',
      columnId: 'done',
    });
    kanbanDb.setTaskStatus(running.task_id, 'running');
    assert.equal(kanbanDb.getTask(stuck.task_id)?.status, 'todo');

    reconcileKanbanOnBoot();

    assert.equal(kanbanDb.getTask(stuck.task_id)?.status, 'done');
    // Run-lifecycle states are not touched.
    assert.equal(kanbanDb.getTask(running.task_id)?.status, 'running');
  });
});
