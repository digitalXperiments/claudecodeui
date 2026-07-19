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
  KANBAN_PROVIDERS,
} from '@/modules/kanban/index.js';
import type { AnyRecord, LLMProvider } from '@/shared/types.js';

test('every provider runs a task through the shared spawnFns map', async () => {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'kanban-providers-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();
  getConnection().pragma('foreign_keys = ON');
  chatRunRegistry.clearAll();
  const projectId = projectsDb.createProjectPath(tempDirectory).project!.project_id;

  const seenOptions = new Map<LLMProvider, AnyRecord>();
  const runtimes = Object.fromEntries(
    KANBAN_PROVIDERS.map((provider) => [
      provider,
      async (_content: string, options: AnyRecord, writer: unknown) => {
        seenOptions.set(provider, options);
        (writer as { send: (m: AnyRecord) => void }).send({
          kind: 'complete',
          provider,
          exitCode: 0,
          success: true,
        });
      },
    ]),
  ) as Record<LLMProvider, (c: string, o: AnyRecord, w: unknown) => Promise<void>>;

  configureKanbanRuntimes(runtimes);
  const dispose = initKanbanAutomation();

  try {
    const board = kanbanDb.createBoard({ projectId, name: 'Board' });
    for (const provider of KANBAN_PROVIDERS) {
      const task = kanbanDb.createTask({
        boardId: board.board_id,
        projectId,
        title: `Task ${provider}`,
        prompt: `run ${provider}`,
        assigneeProvider: provider,
        permissionMode: 'default',
        tools: { allowedCommands: ['Bash(ls)'], disallowedCommands: ['Bash(rm)'] },
      });
      await kanbanRunner.runTask(task.task_id, 'manual');
      assert.equal(kanbanDb.getTask(task.task_id)?.status, 'done', `${provider} should be done`);
      const opts = seenOptions.get(provider)!;
      // Permission mode is passed through to the runtime, never forced to bypass.
      assert.equal(opts.permissionMode, 'default');

      // Per-provider permission option shape.
      const toolsSettings = opts.toolsSettings as Record<string, unknown> | undefined;
      if (provider === 'claude' || provider === 'cursor') {
        assert.deepEqual(toolsSettings?.allowedTools, ['Bash(ls)'], `${provider} allowedTools`);
        assert.deepEqual(toolsSettings?.disallowedTools, ['Bash(rm)'], `${provider} disallowedTools`);
        assert.equal(toolsSettings?.skipPermissions, false, `${provider} skipPermissions`);
      } else if (provider === 'grok') {
        assert.deepEqual(toolsSettings?.allowedCommands, ['Bash(ls)'], 'grok allowedCommands');
        assert.deepEqual(toolsSettings?.disallowedCommands, ['Bash(rm)'], 'grok disallowedCommands');
      } else {
        assert.equal(toolsSettings, undefined, `${provider} takes only permissionMode`);
      }
    }
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
});
