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
  kanbanDb,
  kanbanRunner,
  stopKanbanAutomation,
} from '@/modules/kanban/index.js';
import type { AnyRecord } from '@/shared/types.js';

type SpawnBehavior = (writer: {
  send: (message: AnyRecord) => void;
  setSessionId?: (id: string) => void;
}) => void;

async function withRunner(
  behavior: SpawnBehavior,
  runTest: (ctx: { projectId: string }) => void | Promise<void>,
): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'kanban-runner-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await initializeDatabase();
  getConnection().pragma('foreign_keys = ON');
  chatRunRegistry.clearAll();

  const created = projectsDb.createProjectPath(tempDirectory);
  const projectId = created.project!.project_id;

  configureKanbanRuntimes({
    claude: async (_content: string, _options: AnyRecord, writer: unknown) => {
      behavior(writer as { send: (m: AnyRecord) => void });
    },
  });
  const dispose = initKanbanAutomation();

  try {
    await runTest({ projectId });
  } finally {
    dispose();
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

test('runTask drives a successful run to done and records the kanban_run', async () => {
  await withRunner(
    (writer) => {
      writer.send({ kind: 'complete', provider: 'claude', exitCode: 0, success: true });
    },
    async ({ projectId }) => {
      const board = kanbanDb.createBoard({ projectId, name: 'Board' });
      const task = kanbanDb.createTask({
        boardId: board.board_id,
        projectId,
        title: 'Ship it',
        prompt: 'do the thing',
        assigneeProvider: 'claude',
      });

      const result = await kanbanRunner.runTask(task.task_id, 'manual');
      // The stub emits `complete` synchronously, so status has settled already.
      const updated = kanbanDb.getTask(task.task_id);
      assert.equal(updated?.status, 'done');
      assert.equal(updated?.app_session_id, result.appSessionId);
      assert.equal(updated?.last_exit_code, 0);

      const run = kanbanDb.getRun(result.runId);
      assert.equal(run?.status, 'done');
      assert.equal(run?.exit_code, 0);
      assert.equal(run?.trigger, 'manual');
    },
  );
});

test('runTask marks the task failed on a non-zero exit', async () => {
  await withRunner(
    (writer) => {
      writer.send({ kind: 'complete', provider: 'claude', exitCode: 2, success: false });
    },
    async ({ projectId }) => {
      const board = kanbanDb.createBoard({ projectId, name: 'Board' });
      const task = kanbanDb.createTask({
        boardId: board.board_id,
        projectId,
        title: 'Break it',
        assigneeProvider: 'claude',
      });

      const result = await kanbanRunner.runTask(task.task_id, 'manual');
      assert.equal(kanbanDb.getTask(task.task_id)?.status, 'failed');
      assert.equal(kanbanDb.getRun(result.runId)?.status, 'failed');
    },
  );
});

test('runTask rejects a task with no assignee', async () => {
  await withRunner(
    () => undefined,
    async ({ projectId }) => {
      const board = kanbanDb.createBoard({ projectId, name: 'Board' });
      const task = kanbanDb.createTask({ boardId: board.board_id, projectId, title: 'Orphan' });
      await assert.rejects(() => kanbanRunner.runTask(task.task_id, 'manual'), /no assigned agent/i);
    },
  );
});
