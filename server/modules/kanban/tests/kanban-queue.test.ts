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
  getQueueStatus,
  initKanbanAutomation,
  initKanbanQueue,
  kanbanDb,
  stopKanbanAutomation,
  stopKanbanQueue,
} from '@/modules/kanban/index.js';
import type { AnyRecord } from '@/shared/types.js';

type Behavior = (writer: { send: (m: AnyRecord) => void }) => void;

async function withQueue(
  behavior: Behavior,
  options: { concurrency?: number },
  runTest: (projectId: string) => void | Promise<void>,
): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'kanban-queue-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();
  getConnection().pragma('foreign_keys = ON');
  chatRunRegistry.clearAll();
  const created = projectsDb.createProjectPath(tempDirectory);

  configureKanbanRuntimes({
    claude: async (_content: string, _options: AnyRecord, writer: unknown) => {
      behavior(writer as { send: (m: AnyRecord) => void });
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

test('dependency cascade: finishing A enqueues and runs dependent B', async () => {
  await withQueue(completeSuccess, {}, (projectId) => {
    const board = kanbanDb.createBoard({ projectId, name: 'Board' });
    const a = kanbanDb.createTask({ boardId: board.board_id, projectId, title: 'A', assigneeProvider: 'claude' });
    const b = kanbanDb.createTask({ boardId: board.board_id, projectId, title: 'B', assigneeProvider: 'claude' });
    kanbanDb.addDependency(b.task_id, a.task_id); // B depends on A

    enqueueTask(a.task_id, 'manual');

    // Stub completes synchronously, so the whole cascade has already resolved.
    assert.equal(kanbanDb.getTask(a.task_id)?.status, 'done');
    assert.equal(kanbanDb.getTask(b.task_id)?.status, 'done');
  });
});

test('dependency cascade does not fire until every dependency is done', async () => {
  await withQueue(completeSuccess, {}, (projectId) => {
    const board = kanbanDb.createBoard({ projectId, name: 'Board' });
    const a = kanbanDb.createTask({ boardId: board.board_id, projectId, title: 'A', assigneeProvider: 'claude' });
    const b = kanbanDb.createTask({ boardId: board.board_id, projectId, title: 'B', assigneeProvider: 'claude' });
    const c = kanbanDb.createTask({ boardId: board.board_id, projectId, title: 'C', assigneeProvider: 'claude' });
    kanbanDb.addDependency(c.task_id, a.task_id);
    kanbanDb.addDependency(c.task_id, b.task_id);

    enqueueTask(a.task_id, 'manual');
    // A done, but B not yet → C must still be waiting.
    assert.equal(kanbanDb.getTask(a.task_id)?.status, 'done');
    assert.equal(kanbanDb.getTask(c.task_id)?.status, 'todo');

    enqueueTask(b.task_id, 'manual');
    // Now both deps are done → C ran.
    assert.equal(kanbanDb.getTask(c.task_id)?.status, 'done');
  });
});

test('concurrency cap bounds simultaneously running tasks', async () => {
  await withQueue(neverComplete, { concurrency: 2 }, (projectId) => {
    const board = kanbanDb.createBoard({ projectId, name: 'Board' });
    const ids = [1, 2, 3, 4].map(
      (n) =>
        kanbanDb.createTask({
          boardId: board.board_id,
          projectId,
          title: `T${n}`,
          assigneeProvider: 'claude',
        }).task_id,
    );
    ids.forEach((id) => enqueueTask(id, 'schedule'));

    const status = getQueueStatus();
    assert.equal(status.inFlight, 2);
    assert.equal(status.pending, 2);
    // Exactly the cap number are actually running.
    const running = ids.filter((id) => kanbanDb.getTask(id)?.status === 'running');
    assert.equal(running.length, 2);
  });
});

test('enqueue dedupes an already-queued task', async () => {
  await withQueue(neverComplete, { concurrency: 1 }, (projectId) => {
    const board = kanbanDb.createBoard({ projectId, name: 'Board' });
    const a = kanbanDb.createTask({ boardId: board.board_id, projectId, title: 'A', assigneeProvider: 'claude' });
    const b = kanbanDb.createTask({ boardId: board.board_id, projectId, title: 'B', assigneeProvider: 'claude' });
    enqueueTask(a.task_id, 'schedule'); // starts running (cap 1)
    enqueueTask(b.task_id, 'schedule'); // queued
    enqueueTask(b.task_id, 'schedule'); // duplicate → ignored
    assert.equal(getQueueStatus().pending, 1);
  });
});
