import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  closeConnection,
  getConnection,
  initializeDatabase,
  projectsDb,
  systemNotificationsDb,
} from '@/modules/database/index.js';
import {
  kanbanDb,
  startKanbanScheduler,
  stopKanbanScheduler,
  sweepOverdueTasks,
} from '@/modules/kanban/index.js';

const PAST_DUE = '2020-01-01T00:00:00.000Z';
const FAR_FUTURE = '2099-01-01T00:00:00.000Z';

async function withDb(runTest: (projectId: string) => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'kanban-due-'));
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

test('dueDate round-trips through create and update, and null clears it', async () => {
  await withDb((projectId) => {
    const board = kanbanDb.createBoard({ name: 'Board' });
    const task = kanbanDb.createTask({
      boardId: board.board_id,
      projectId,
      title: 'Deadlined',
      dueDate: PAST_DUE,
    });
    assert.equal(kanbanDb.getTask(task.task_id)?.due_date, PAST_DUE);

    const updated = kanbanDb.updateTask(task.task_id, { dueDate: FAR_FUTURE });
    assert.equal(updated?.due_date, FAR_FUTURE);

    const cleared = kanbanDb.updateTask(task.task_id, { dueDate: null });
    assert.equal(cleared?.due_date, null);
  });
});

test('listOverdueTasks returns only past-due todo/queued tasks', async () => {
  await withDb((projectId) => {
    const board = kanbanDb.createBoard({ name: 'Board' });
    const past = kanbanDb.createTask({
      boardId: board.board_id,
      projectId,
      title: 'Past due',
      dueDate: PAST_DUE,
    });
    kanbanDb.createTask({
      boardId: board.board_id,
      projectId,
      title: 'Future',
      dueDate: FAR_FUTURE,
    });
    const done = kanbanDb.createTask({
      boardId: board.board_id,
      projectId,
      title: 'Done overdue',
      dueDate: PAST_DUE,
    });
    kanbanDb.setTaskStatus(done.task_id, 'done');
    const noDate = kanbanDb.createTask({
      boardId: board.board_id,
      projectId,
      title: 'No date',
    });

    const overdue = kanbanDb.listOverdueTasks(new Date().toISOString());
    const ids = overdue.map((t) => t.task_id).sort();
    assert.deepEqual(ids, [past.task_id]);
    assert.ok(!ids.includes(done.task_id));
    assert.ok(!ids.includes(noDate.task_id));
  });
});

test('escalation sweep notifies, comments, and stamps escalated_at', async () => {
  await withDb((projectId) => {
    const board = kanbanDb.createBoard({ name: 'Board' });
    const task = kanbanDb.createTask({
      boardId: board.board_id,
      projectId,
      title: 'Overdue thing',
      dueDate: PAST_DUE,
      assigneeProvider: 'claude',
    });

    startKanbanScheduler();
    sweepOverdueTasks();

    const updated = kanbanDb.getTask(task.task_id);
    assert.ok(updated?.escalated_at, 'expected escalated_at to be stamped');

    const comments = kanbanDb.listCommentsByTask(task.task_id);
    assert.ok(
      comments.some((c) => c.body.includes('Task overdue') && c.body.includes(PAST_DUE)),
      'expected an overdue comment',
    );

    const notifications = systemNotificationsDb.list();
    assert.ok(
      notifications.some(
        (n) => n.kind === 'info' && n.severity === 'warning' && n.title.includes('Overdue:'),
      ),
      'expected an overdue system notification',
    );
    assert.ok(
      notifications.some((n) => n.meta?.taskId === task.task_id),
      'expected notification meta to carry the task id',
    );
  });
});

test('no duplicate escalation within the cooldown window', async () => {
  await withDb((projectId) => {
    const board = kanbanDb.createBoard({ name: 'Board' });
    const task = kanbanDb.createTask({
      boardId: board.board_id,
      projectId,
      title: 'Recently escalated',
      dueDate: PAST_DUE,
    });
    // Simulate a recent escalation so the 6h cooldown is still active.
    kanbanDb.updateTask(task.task_id, { escalatedAt: new Date().toISOString() });

    startKanbanScheduler();
    sweepOverdueTasks();

    assert.equal(kanbanDb.listCommentsByTask(task.task_id).length, 0);
    assert.equal(systemNotificationsDb.list().length, 0);
  });
});

test('sweep is a no-op before the scheduler is started', async () => {
  await withDb((projectId) => {
    const board = kanbanDb.createBoard({ name: 'Board' });
    const task = kanbanDb.createTask({
      boardId: board.board_id,
      projectId,
      title: 'Not yet started',
      dueDate: PAST_DUE,
    });

    sweepOverdueTasks();

    assert.equal(kanbanDb.getTask(task.task_id)?.escalated_at, null);
    assert.equal(systemNotificationsDb.list().length, 0);
  });
});
