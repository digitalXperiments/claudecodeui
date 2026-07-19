import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection, initializeDatabase, projectsDb } from '@/modules/database/index.js';
import { kanbanDb } from '@/modules/kanban/index.js';

async function withDb(runTest: (projectA: string, projectB: string) => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'kanban-global-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();
  getConnection().pragma('foreign_keys = ON');
  const a = projectsDb.createProjectPath('/workspace/project-a').project!.project_id;
  const b = projectsDb.createProjectPath('/workspace/project-b').project!.project_id;
  try {
    await runTest(a, b);
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

test('getOrCreateGlobalBoard is idempotent and has null project', async () => {
  await withDb(() => {
    const first = kanbanDb.getOrCreateGlobalBoard();
    assert.equal(first.scope, 'global');
    assert.equal(first.project_id, null);
    const second = kanbanDb.getOrCreateGlobalBoard();
    assert.equal(second.board_id, first.board_id);
  });
});

test('global board holds tasks from different projects with cross-project deps', async () => {
  await withDb((projectA, projectB) => {
    const board = kanbanDb.getOrCreateGlobalBoard();
    const taskA = kanbanDb.createTask({
      boardId: board.board_id,
      projectId: projectA,
      title: 'A in project A',
      assigneeProvider: 'claude',
    });
    const taskB = kanbanDb.createTask({
      boardId: board.board_id,
      projectId: projectB,
      title: 'B in project B',
      assigneeProvider: 'grok',
    });

    // Cross-project dependency: B depends on A (A lives in a different project).
    kanbanDb.addDependency(taskB.task_id, taskA.task_id);

    const tasks = kanbanDb.listTasksByBoard(board.board_id);
    assert.equal(tasks.length, 2);
    const projectIds = new Set(tasks.map((t) => t.project_id));
    assert.ok(projectIds.has(projectA) && projectIds.has(projectB));
    assert.deepEqual(kanbanDb.getTask(taskB.task_id)?.dependsOn, [taskA.task_id]);
  });
});

test('a task can be reassigned to a different project', async () => {
  await withDb((projectA, projectB) => {
    const board = kanbanDb.getOrCreateGlobalBoard();
    const task = kanbanDb.createTask({ boardId: board.board_id, projectId: projectA, title: 'Movable' });
    const updated = kanbanDb.updateTask(task.task_id, { projectId: projectB });
    assert.equal(updated?.project_id, projectB);
  });
});
