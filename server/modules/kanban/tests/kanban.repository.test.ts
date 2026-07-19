import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection, initializeDatabase, projectsDb } from '@/modules/database/index.js';
import { kanbanDb, KanbanCycleError } from '@/modules/kanban/kanban.repository.js';

async function withIsolatedDatabase(runTest: (projectId: string) => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'kanban-db-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await initializeDatabase();
  // Sanity: enforce FK constraints the same way the running server does.
  getConnection().pragma('foreign_keys = ON');
  const created = projectsDb.createProjectPath('/workspace/kanban-project');
  const projectId = created.project!.project_id;

  try {
    await runTest(projectId);
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

test('createBoard seeds default columns', async () => {
  await withIsolatedDatabase((projectId) => {
    const board = kanbanDb.createBoard({ projectId, name: 'Sprint 1' });
    assert.equal(board.name, 'Sprint 1');
    assert.deepEqual(
      board.columns.map((c) => c.name),
      ['Backlog', 'In Progress', 'Review', 'Done'],
    );
    const fetched = kanbanDb.getBoard(board.board_id);
    assert.equal(fetched?.board_id, board.board_id);
  });
});

test('task round-trips with tools + dependency list', async () => {
  await withIsolatedDatabase((projectId) => {
    const board = kanbanDb.createBoard({ projectId, name: 'Board' });
    const task = kanbanDb.createTask({
      boardId: board.board_id,
      projectId,
      title: 'Do the thing',
      prompt: 'Refactor the module',
      assigneeProvider: 'claude',
      tools: { allowedCommands: ['Bash(ls)'], disallowedCommands: ['Bash(rm)'] },
    });
    assert.equal(task.status, 'todo');
    assert.equal(task.assignee_provider, 'claude');
    assert.equal(task.column_id, 'backlog');

    const fetched = kanbanDb.getTask(task.task_id);
    assert.deepEqual(fetched?.tools.allowedCommands, ['Bash(ls)']);
    assert.deepEqual(fetched?.dependsOn, []);
  });
});

test('positions increment per column', async () => {
  await withIsolatedDatabase((projectId) => {
    const board = kanbanDb.createBoard({ projectId, name: 'Board' });
    const a = kanbanDb.createTask({ boardId: board.board_id, projectId, title: 'A' });
    const b = kanbanDb.createTask({ boardId: board.board_id, projectId, title: 'B' });
    assert.equal(a.position, 0);
    assert.equal(b.position, 1);
  });
});

test('updateTask can move a task to another column', async () => {
  await withIsolatedDatabase((projectId) => {
    const board = kanbanDb.createBoard({ projectId, name: 'Board' });
    const task = kanbanDb.createTask({ boardId: board.board_id, projectId, title: 'Move me' });
    const moved = kanbanDb.updateTask(task.task_id, { columnId: 'in_progress', position: 2 });
    assert.equal(moved?.column_id, 'in_progress');
    assert.equal(moved?.position, 2);
  });
});

test('addDependency stores an edge and getTask lists it', async () => {
  await withIsolatedDatabase((projectId) => {
    const board = kanbanDb.createBoard({ projectId, name: 'Board' });
    const a = kanbanDb.createTask({ boardId: board.board_id, projectId, title: 'A' });
    const b = kanbanDb.createTask({ boardId: board.board_id, projectId, title: 'B' });
    // b depends on a
    kanbanDb.addDependency(b.task_id, a.task_id);
    assert.deepEqual(kanbanDb.getTask(b.task_id)?.dependsOn, [a.task_id]);
    assert.deepEqual(kanbanDb.listDependents(a.task_id), [b.task_id]);
  });
});

test('addDependency rejects self-dependency', async () => {
  await withIsolatedDatabase((projectId) => {
    const board = kanbanDb.createBoard({ projectId, name: 'Board' });
    const a = kanbanDb.createTask({ boardId: board.board_id, projectId, title: 'A' });
    assert.throws(() => kanbanDb.addDependency(a.task_id, a.task_id), KanbanCycleError);
  });
});

test('addDependency rejects a direct 2-cycle', async () => {
  await withIsolatedDatabase((projectId) => {
    const board = kanbanDb.createBoard({ projectId, name: 'Board' });
    const a = kanbanDb.createTask({ boardId: board.board_id, projectId, title: 'A' });
    const b = kanbanDb.createTask({ boardId: board.board_id, projectId, title: 'B' });
    kanbanDb.addDependency(b.task_id, a.task_id); // b -> a
    assert.throws(() => kanbanDb.addDependency(a.task_id, b.task_id), KanbanCycleError); // a -> b closes the loop
  });
});

test('addDependency rejects a transitive cycle', async () => {
  await withIsolatedDatabase((projectId) => {
    const board = kanbanDb.createBoard({ projectId, name: 'Board' });
    const a = kanbanDb.createTask({ boardId: board.board_id, projectId, title: 'A' });
    const b = kanbanDb.createTask({ boardId: board.board_id, projectId, title: 'B' });
    const c = kanbanDb.createTask({ boardId: board.board_id, projectId, title: 'C' });
    kanbanDb.addDependency(b.task_id, a.task_id); // b -> a
    kanbanDb.addDependency(c.task_id, b.task_id); // c -> b
    // a -> c would create a -> c -> b -> a cycle
    assert.throws(() => kanbanDb.addDependency(a.task_id, c.task_id), KanbanCycleError);
  });
});

test('deleting a task cascades its dependency edges and runs', async () => {
  await withIsolatedDatabase((projectId) => {
    const board = kanbanDb.createBoard({ projectId, name: 'Board' });
    const a = kanbanDb.createTask({ boardId: board.board_id, projectId, title: 'A' });
    const b = kanbanDb.createTask({ boardId: board.board_id, projectId, title: 'B' });
    kanbanDb.addDependency(b.task_id, a.task_id);
    kanbanDb.createRun({ taskId: a.task_id, appSessionId: null, provider: 'claude', trigger: 'manual' });

    assert.equal(kanbanDb.deleteTask(a.task_id), true);
    // b's edge to a should be gone
    assert.deepEqual(kanbanDb.getTask(b.task_id)?.dependsOn, []);
    assert.deepEqual(kanbanDb.listRunsByTask(a.task_id), []);
  });
});

test('runs record and finish', async () => {
  await withIsolatedDatabase((projectId) => {
    const board = kanbanDb.createBoard({ projectId, name: 'Board' });
    const task = kanbanDb.createTask({ boardId: board.board_id, projectId, title: 'A' });
    const run = kanbanDb.createRun({
      taskId: task.task_id,
      appSessionId: 'sess-1',
      provider: 'claude',
      trigger: 'manual',
    });
    assert.equal(run.status, 'running');
    assert.deepEqual(
      kanbanDb.listRunningRuns().map((r) => r.run_id),
      [run.run_id],
    );
    kanbanDb.finishRun(run.run_id, 'done', 0);
    assert.equal(kanbanDb.getRun(run.run_id)?.status, 'done');
    assert.deepEqual(kanbanDb.listRunningRuns(), []);
  });
});

test('deleting a board cascades its tasks', async () => {
  await withIsolatedDatabase((projectId) => {
    const board = kanbanDb.createBoard({ projectId, name: 'Board' });
    const task = kanbanDb.createTask({ boardId: board.board_id, projectId, title: 'A' });
    assert.equal(kanbanDb.deleteBoard(board.board_id), true);
    assert.equal(kanbanDb.getTask(task.task_id), null);
  });
});
