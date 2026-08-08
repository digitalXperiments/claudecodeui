import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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
import { workspaceService } from '@/modules/workspaces/index.js';
import type { AnyRecord } from '@/shared/types.js';

function runGit(repoPath: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync('git', args, { cwd: repoPath, encoding: 'utf8' });
  return {
    status: result.status,
    stdout: String(result.stdout ?? '').trim(),
    stderr: String(result.stderr ?? '').trim(),
  };
}

async function initGitRepo(dir: string): Promise<void> {
  const init = runGit(dir, ['init', '-b', 'main']);
  assert.equal(init.status, 0, `git init failed: ${init.stderr}`);
  assert.equal(runGit(dir, ['config', 'user.email', 'test@example.com']).status, 0);
  assert.equal(runGit(dir, ['config', 'user.name', 'Test Runner']).status, 0);
  await writeFile(path.join(dir, 'README.md'), 'initial\n');
  assert.equal(runGit(dir, ['add', '.']).status, 0);
  const commit = runGit(dir, ['commit', '-m', 'initial commit']);
  assert.equal(commit.status, 0, `git commit failed: ${commit.stderr}`);
}

const completeSuccess = async (_content: string, _options: AnyRecord, writer: unknown) => {
  (writer as { send: (m: AnyRecord) => void }).send({
    kind: 'complete',
    provider: 'claude',
    exitCode: 0,
    success: true,
  });
};

/**
 * Opens an isolated DB with `tempDirectory` registered as a project (a plain,
 * non-git folder — used by the "non-git project" test). Tests that need a git
 * repo create a `repo/` subdirectory themselves and register their own project.
 */
async function withIsolated(
  runTest: (plainProjectId: string, tempDirectory: string) => void | Promise<void>,
): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'kanban-branch-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();
  getConnection().pragma('foreign_keys = ON');
  chatRunRegistry.clearAll();

  const created = projectsDb.createProjectPath(tempDirectory);
  configureKanbanRuntimes({ claude: completeSuccess });
  const dispose = initKanbanAutomation();

  try {
    await runTest(created.project!.project_id, tempDirectory);
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

test('an implementation run creates and persists a feature branch in a git repo', async () => {
  await withIsolated(async (_plainProjectId, tempDirectory) => {
    const repoDir = path.join(tempDirectory, 'repo');
    await mkdir(repoDir, { recursive: true });
    await initGitRepo(repoDir);
    assert.equal(runGit(repoDir, ['branch', '--show-current']).stdout, 'main');
    const repoProjectId = projectsDb.createProjectPath(repoDir).project!.project_id;

    const board = kanbanDb.createBoard({ name: 'Board' });
    const task = kanbanDb.createTask({
      boardId: board.board_id,
      projectId: repoProjectId,
      title: 'Ship the widget',
      prompt: 'build the widget',
      assigneeProvider: 'claude',
    });

    await kanbanRunner.runTask(task.task_id, 'manual');

    const updated = kanbanDb.getTask(task.task_id);
    const expected = `feat/${task.task_id}-ship-the-widget`;
    assert.equal(updated?.feature_branch, expected);
    assert.equal(updated?.status, 'done');

    // P1 keeps the primary checkout untouched; the feature branch lives in
    // the isolated workspace and can be merged/discarded explicitly.
    assert.equal(runGit(repoDir, ['branch', '--show-current']).stdout, 'main');
    const workspace = workspaceService.get(updated!.workspace_id!);
    assert.ok(workspace);
    assert.equal(workspace.feature_branch, expected);
    assert.equal(runGit(workspace.root_path, ['branch', '--show-current']).stdout, expected);
    await workspaceService.discard(workspace.workspace_id, { deleteBranch: true });
  });
});

test('a non-git project still runs without creating a branch', async () => {
  await withIsolated(async (plainProjectId, tempDirectory) => {
    const board = kanbanDb.createBoard({ name: 'Board' });
    const task = kanbanDb.createTask({
      boardId: board.board_id,
      projectId: plainProjectId,
      title: 'Plain folder',
      prompt: 'do the thing',
      assigneeProvider: 'claude',
    });

    await kanbanRunner.runTask(task.task_id, 'manual');

    const updated = kanbanDb.getTask(task.task_id);
    assert.equal(updated?.feature_branch, null);
    assert.equal(updated?.status, 'done');
  });
});

test('review runs never create a feature branch', async () => {
  await withIsolated(async (_plainProjectId, tempDirectory) => {
    const repoDir = path.join(tempDirectory, 'repo');
    await mkdir(repoDir, { recursive: true });
    await initGitRepo(repoDir);
    const repoProjectId = projectsDb.createProjectPath(repoDir).project!.project_id;

    const board = kanbanDb.createBoard({ name: 'Board' });
    const task = kanbanDb.createTask({
      boardId: board.board_id,
      projectId: repoProjectId,
      title: 'In review already',
      columnId: 'review',
      reviewProvider: 'claude',
    });

    await kanbanRunner.runTask(task.task_id, 'review');

    const updated = kanbanDb.getTask(task.task_id);
    assert.equal(updated?.feature_branch, null);
    assert.equal(runGit(repoDir, ['branch', '--show-current']).stdout, 'main');
  });
});
