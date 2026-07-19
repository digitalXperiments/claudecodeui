import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection, initializeDatabase, projectsDb } from '@/modules/database/index.js';
import { chatRunRegistry } from '@/modules/websocket/index.js';
import {
  configureKanbanRuntimes,
  initKanbanAutomation,
  initKanbanQueue,
  kanbanDb,
  kanbanRunner,
  stopKanbanAutomation,
  stopKanbanQueue,
} from '@/modules/kanban/index.js';
import type { AnyRecord } from '@/shared/types.js';

async function withFlow(
  runTest: (projectId: string) => void | Promise<void>,
): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'kanban-review-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();
  getConnection().pragma('foreign_keys = ON');
  chatRunRegistry.clearAll();

  const created = projectsDb.createProjectPath(tempDirectory);
  const projectId = created.project!.project_id;

  // Each spawn completes successfully; provider is taken from options via the
  // stub's third arg (writer) — role is recorded on kanban_runs.
  configureKanbanRuntimes({
    claude: async (_content: string, _options: AnyRecord, writer: unknown) => {
      (writer as { send: (m: AnyRecord) => void }).send({
        kind: 'complete',
        provider: 'claude',
        exitCode: 0,
        success: true,
      });
    },
    grok: async (_content: string, _options: AnyRecord, writer: unknown) => {
      (writer as { send: (m: AnyRecord) => void }).send({
        kind: 'complete',
        provider: 'grok',
        exitCode: 0,
        success: true,
      });
    },
  });
  initKanbanAutomation();
  initKanbanQueue({ concurrency: 3 });

  try {
    await runTest(projectId);
  } finally {
    stopKanbanQueue();
    stopKanbanAutomation();
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

test('implement success without review agent moves task to Done', async () => {
  await withFlow(async (projectId) => {
    const board = kanbanDb.createBoard({ projectId, name: 'Board' });
    const task = kanbanDb.createTask({
      boardId: board.board_id,
      projectId,
      title: 'Ship feature',
      prompt: 'implement the thing',
      columnId: 'in_progress',
      assigneeProvider: 'claude',
    });

    await kanbanRunner.runTask(task.task_id, 'manual');

    const updated = kanbanDb.getTask(task.task_id);
    assert.equal(updated?.status, 'done');
    assert.equal(updated?.column_id, 'done');
    assert.equal(updated?.last_exit_code, 0);

    const run = kanbanDb.getLatestRunForTask(task.task_id);
    assert.equal(run?.role, 'implement');
    assert.equal(run?.status, 'done');
  });
});

test('implement success with review agent moves to Review and runs review', async () => {
  await withFlow(async (projectId) => {
    const board = kanbanDb.createBoard({ projectId, name: 'Board' });
    const task = kanbanDb.createTask({
      boardId: board.board_id,
      projectId,
      title: 'Ship + review',
      prompt: 'implement the thing',
      columnId: 'in_progress',
      assigneeProvider: 'claude',
      reviewProvider: 'grok',
    });

    await kanbanRunner.runTask(task.task_id, 'manual');

    // Both implement and review complete synchronously via stubs + queue.
    const updated = kanbanDb.getTask(task.task_id);
    assert.equal(updated?.status, 'done');
    assert.equal(updated?.column_id, 'done');

    const runs = kanbanDb.listRunsByTask(task.task_id);
    assert.ok(runs.length >= 2, `expected implement + review runs, got ${runs.length}`);
    const roles = runs.map((r) => r.role).sort();
    assert.deepEqual(roles, ['implement', 'review']);
    assert.ok(runs.every((r) => r.status === 'done'));
    assert.ok(runs.some((r) => r.provider === 'claude' && r.role === 'implement'));
    assert.ok(runs.some((r) => r.provider === 'grok' && r.role === 'review'));
  });
});

test('failed implement stays failed and does not enter review', async () => {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'kanban-fail-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();
  getConnection().pragma('foreign_keys = ON');
  chatRunRegistry.clearAll();

  const created = projectsDb.createProjectPath(tempDirectory);
  const projectId = created.project!.project_id;

  configureKanbanRuntimes({
    claude: async (_content: string, _options: AnyRecord, writer: unknown) => {
      (writer as { send: (m: AnyRecord) => void }).send({
        kind: 'complete',
        provider: 'claude',
        exitCode: 2,
        success: false,
      });
    },
  });
  initKanbanAutomation();
  initKanbanQueue();

  try {
    const board = kanbanDb.createBoard({ projectId, name: 'Board' });
    const task = kanbanDb.createTask({
      boardId: board.board_id,
      projectId,
      title: 'Broken',
      columnId: 'in_progress',
      assigneeProvider: 'claude',
      reviewProvider: 'grok',
    });

    await kanbanRunner.runTask(task.task_id, 'manual');

    const updated = kanbanDb.getTask(task.task_id);
    assert.equal(updated?.status, 'failed');
    assert.equal(updated?.column_id, 'in_progress');
    assert.equal(kanbanDb.listRunsByTask(task.task_id).length, 1);
  } finally {
    stopKanbanQueue();
    stopKanbanAutomation();
    chatRunRegistry.clearAll();
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

test('review brief carries the implementation output tail', async () => {
  await withFlow(async (projectId) => {
    let reviewPrompt = '';
    configureKanbanRuntimes({
      claude: async (_content: string, _options: AnyRecord, writer: unknown) => {
        const w = writer as { send: (m: AnyRecord) => void };
        w.send({
          kind: 'text',
          provider: 'claude',
          content: 'Implemented the widget in src/widget.ts',
        });
        w.send({ kind: 'complete', provider: 'claude', exitCode: 0, success: true });
      },
      grok: async (content: string, _options: AnyRecord, writer: unknown) => {
        reviewPrompt = content;
        (writer as { send: (m: AnyRecord) => void }).send({
          kind: 'complete',
          provider: 'grok',
          exitCode: 0,
          success: true,
        });
      },
    });

    const board = kanbanDb.createBoard({ projectId, name: 'Board' });
    const task = kanbanDb.createTask({
      boardId: board.board_id,
      projectId,
      title: 'Widget',
      prompt: 'build the widget',
      columnId: 'in_progress',
      assigneeProvider: 'claude',
      reviewProvider: 'grok',
    });

    await kanbanRunner.runTask(task.task_id, 'manual');

    assert.ok(reviewPrompt.includes('Original implementation instructions'));
    assert.ok(reviewPrompt.includes('build the widget'));
    assert.ok(reviewPrompt.includes('Implementation agent output'));
    assert.ok(reviewPrompt.includes('Implemented the widget in src/widget.ts'));
    assert.ok(reviewPrompt.includes('VERDICT'));
  });
});

test('board without review/done columns still runs review and finishes in place', async () => {
  await withFlow(async (projectId) => {
    const board = kanbanDb.createBoard({
      projectId,
      name: 'Custom',
      columns: [
        { id: 'todo_col', name: 'To Do', order: 0 },
        { id: 'doing', name: 'Doing', order: 1, runOnEnter: true },
        { id: 'shipped', name: 'Shipped', order: 2 },
      ],
    });
    const task = kanbanDb.createTask({
      boardId: board.board_id,
      projectId,
      title: 'Custom columns',
      columnId: 'doing',
      assigneeProvider: 'claude',
      reviewProvider: 'grok',
    });

    await kanbanRunner.runTask(task.task_id, 'manual');

    const updated = kanbanDb.getTask(task.task_id);
    // No review/done columns on this board: the card never leaves 'doing',
    // but both runs happened and the task ended done.
    assert.equal(updated?.column_id, 'doing');
    assert.equal(updated?.status, 'done');

    const roles = kanbanDb.listRunsByTask(task.task_id).map((r) => r.role).sort();
    assert.deepEqual(roles, ['implement', 'review']);
  });
});

test('exitCode 0 without success flag still counts as success', async () => {
  await withFlow(async (projectId) => {
    // Override claude to omit success flag — common incomplete complete payload.
    configureKanbanRuntimes({
      claude: async (_content: string, _options: AnyRecord, writer: unknown) => {
        (writer as { send: (m: AnyRecord) => void }).send({
          kind: 'complete',
          provider: 'claude',
          exitCode: 0,
          // success intentionally omitted
        });
      },
    });

    const board = kanbanDb.createBoard({ projectId, name: 'Board' });
    const task = kanbanDb.createTask({
      boardId: board.board_id,
      projectId,
      title: 'Soft success',
      columnId: 'in_progress',
      assigneeProvider: 'claude',
    });

    await kanbanRunner.runTask(task.task_id, 'manual');
    assert.equal(kanbanDb.getTask(task.task_id)?.status, 'done');
    assert.equal(kanbanDb.getTask(task.task_id)?.column_id, 'done');
  });
});
