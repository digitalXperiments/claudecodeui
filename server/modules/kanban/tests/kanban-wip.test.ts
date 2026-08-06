import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection, initializeDatabase, projectsDb } from '@/modules/database/index.js';
import { chatRunRegistry } from '@/modules/websocket/index.js';
import {
  configureKanbanRuntimes,
  enqueueTask,
  initKanbanAutomation,
  initKanbanQueue,
  isColumnAtWipLimit,
  kanbanDb,
  stopKanbanAutomation,
  stopKanbanQueue,
} from '@/modules/kanban/index.js';
import type { AnyRecord } from '@/shared/types.js';

type Behavior = (writer: { send: (m: AnyRecord) => void }) => void | Promise<void>;

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error('waitFor timed out');
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Board with a WIP limit of 1 on the In Progress column. */
function boardWithWipLimit(limit: number) {
  const board = kanbanDb.createBoard({ name: 'WIP Board' });
  const updated = kanbanDb.updateBoard(board.board_id, {
    columns: board.columns.map((col) =>
      col.id === 'in_progress' ? { ...col, wipLimit: limit } : col,
    ),
  });
  return updated!;
}

async function withQueue(
  behavior: Behavior,
  options: { concurrency?: number },
  runTest: (projectId: string) => void | Promise<void>,
): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'kanban-wip-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();
  getConnection().pragma('foreign_keys = ON');
  chatRunRegistry.clearAll();
  const created = projectsDb.createProjectPath(tempDirectory);

  configureKanbanRuntimes({
    claude: async (_content: string, _options: AnyRecord, writer: unknown) => {
      // Resolve only after the behavior has emitted its terminal message, so
      // the run is not ended early by the registry safety net.
      await behavior(writer as { send: (m: AnyRecord) => void });
    },
  });
  initKanbanAutomation();
  initKanbanQueue({ concurrency: options.concurrency ?? 3 });

  try {
    await runTest(created.project!.project_id);
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

const completeSuccess: Behavior = (writer) =>
  writer.send({ kind: 'complete', provider: 'claude', exitCode: 0, success: true });

const neverComplete: Behavior = () => undefined;

test('enqueue is blocked when the column is at its WIP limit', async () => {
  await withQueue(neverComplete, { concurrency: 1 }, (projectId) => {
    const board = boardWithWipLimit(1);
    const a = kanbanDb.createTask({
      boardId: board.board_id,
      projectId,
      title: 'A',
      columnId: 'in_progress',
      assigneeProvider: 'claude',
    });
    const b = kanbanDb.createTask({
      boardId: board.board_id,
      projectId,
      title: 'B',
      columnId: 'in_progress',
      assigneeProvider: 'claude',
    });

    enqueueTask(a.task_id, 'column_move'); // starts running (never completes)
    assert.equal(kanbanDb.getTask(a.task_id)?.status, 'running');

    // In Progress is full (limit 1, A running) → B is parked at todo.
    enqueueTask(b.task_id, 'column_move');
    assert.equal(kanbanDb.getTask(b.task_id)?.status, 'todo');
    assert.notEqual(kanbanDb.getTask(b.task_id)?.status, 'queued');

    const comments = kanbanDb.listCommentsByTask(b.task_id);
    assert.ok(
      comments.some((c) => c.body.includes('WIP limit reached') && c.body.includes('will auto-start')),
      'expected a WIP-waiting hint comment',
    );
  });
});

test('a freed WIP slot auto-starts the waiting task', async () => {
  await withQueue(
    async (writer) => {
      // Complete after a tick so the test can park B while A is still running.
      await new Promise((resolve) => setTimeout(resolve, 20));
      writer.send({ kind: 'complete', provider: 'claude', exitCode: 0, success: true });
    },
    {},
    async (projectId) => {
      const board = boardWithWipLimit(1);
      const a = kanbanDb.createTask({
        boardId: board.board_id,
        projectId,
        title: 'A',
        columnId: 'in_progress',
        assigneeProvider: 'claude',
      });
      const b = kanbanDb.createTask({
        boardId: board.board_id,
        projectId,
        title: 'B',
        columnId: 'in_progress',
        assigneeProvider: 'claude',
      });

      enqueueTask(a.task_id, 'column_move'); // A starts (completes shortly)
      enqueueTask(b.task_id, 'column_move'); // In Progress is full → B parks at todo
      assert.equal(kanbanDb.getTask(b.task_id)?.status, 'todo');

      console.log('[wipdbg] after enqueue A=', kanbanDb.getTask(a.task_id)?.status, 'B=', kanbanDb.getTask(b.task_id)?.status);
      // A settling frees the slot → releaseWipWaiters promotes the parked B.
      await waitFor(() => kanbanDb.getTask(b.task_id)?.status === 'done');
      assert.equal(kanbanDb.getTask(a.task_id)?.status, 'done');
      assert.equal(kanbanDb.getTask(b.task_id)?.status, 'done');
    },
  );
});

test('excludeTaskId lets a task re-enter its own column without self-blocking', async () => {
  await withQueue(neverComplete, { concurrency: 2 }, (projectId) => {
    const board = boardWithWipLimit(1);
    const a = kanbanDb.createTask({
      boardId: board.board_id,
      projectId,
      title: 'A',
      columnId: 'in_progress',
      assigneeProvider: 'claude',
    });
    enqueueTask(a.task_id, 'column_move'); // A is now running
    assert.equal(kanbanDb.getTask(a.task_id)?.status, 'running');
    assert.equal(kanbanDb.listTasksByColumn('in_progress').length, 1);

    // Without exclusion the column counts A and is "full".
    assert.equal(isColumnAtWipLimit(board, 'in_progress'), true);
    // With A excluded, moving A around within the same column is allowed.
    assert.equal(isColumnAtWipLimit(board, 'in_progress', { excludeTaskId: a.task_id }), false);
  });
});

test('no WIP limit means no blocking', async () => {
  await withQueue(neverComplete, { concurrency: 2 }, (projectId) => {
    const board = kanbanDb.createBoard({ name: 'No Limit' });
    const a = kanbanDb.createTask({
      boardId: board.board_id,
      projectId,
      title: 'A',
      columnId: 'in_progress',
      assigneeProvider: 'claude',
    });
    const b = kanbanDb.createTask({
      boardId: board.board_id,
      projectId,
      title: 'B',
      columnId: 'in_progress',
      assigneeProvider: 'claude',
    });
    enqueueTask(a.task_id, 'column_move');
    enqueueTask(b.task_id, 'column_move');
    assert.equal(kanbanDb.getTask(a.task_id)?.status, 'running');
    assert.equal(kanbanDb.getTask(b.task_id)?.status, 'running');
  });
});
