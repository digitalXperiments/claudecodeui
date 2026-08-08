import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';

import {
  closeConnection,
  getConnection,
  initializeDatabase,
  projectsDb,
} from '@/modules/database/index.js';
import { createWorkspaceService } from '@/modules/workspaces/workspace.service.js';

const TEST_ROOT = path.resolve('tmp/cloudcli');

function runGit(cwd: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return {
    status: result.status,
    stdout: String(result.stdout ?? '').trim(),
    stderr: String(result.stderr ?? '').trim(),
  };
}

async function initGitRepo(directory: string): Promise<void> {
  assert.equal(runGit(directory, ['init', '-b', 'main']).status, 0);
  assert.equal(runGit(directory, ['config', 'user.email', 'workspace-test@example.com']).status, 0);
  assert.equal(runGit(directory, ['config', 'user.name', 'Workspace Test']).status, 0);
  await writeFile(path.join(directory, 'README.md'), 'initial\n');
  await writeFile(path.join(directory, '.gitignore'), '.cloudcli/worktrees/\n');
  assert.equal(runGit(directory, ['add', '.']).status, 0);
  assert.equal(runGit(directory, ['commit', '-m', 'initial']).status, 0);
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

async function withDatabase(
  callback: (taskRoot: string) => Promise<void>,
): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const taskRoot = await mkdtemp(path.join(TEST_ROOT, 'workspace-test-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(taskRoot, 'auth.db');
  await initializeDatabase();
  getConnection().pragma('foreign_keys = ON');
  try {
    await callback(taskRoot);
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(taskRoot, { recursive: true, force: true });
  }
}

test('creates concurrent isolated worktrees without changing the primary checkout', async () => {
  await withDatabase(async (taskRoot) => {
    const projectPath = path.join(taskRoot, 'project');
    await mkdir(projectPath, { recursive: true });
    await initGitRepo(projectPath);
    const projectId = projectsDb.createProjectPath(projectPath).project!.project_id;
    const service = createWorkspaceService({ tmpRoot: path.join(taskRoot, 'fallback') });

    const [first, second] = await Promise.all([
      service.create({ projectId, projectPath, taskId: 'task-a', branchName: 'feat/task-a' }),
      service.create({ projectId, projectPath, taskId: 'task-b', branchName: 'feat/task-b' }),
    ]);

    assert.notEqual(first.root_path, second.root_path);
    assert.equal(runGit(projectPath, ['branch', '--show-current']).stdout, 'main');
    assert.equal(runGit(first.root_path, ['branch', '--show-current']).stdout, 'feat/task-a');
    assert.equal(runGit(second.root_path, ['branch', '--show-current']).stdout, 'feat/task-b');

    await writeFile(path.join(first.root_path, 'agent-a.txt'), 'A\n');
    assert.equal(await pathExists(path.join(second.root_path, 'agent-a.txt')), false);
    assert.equal(await pathExists(path.join(projectPath, 'agent-a.txt')), false);

    const firstStatus = await service.refreshStatus(first.workspace_id);
    assert.ok(firstStatus.dirty_files.some((file) => file.path === 'agent-a.txt'));
    const secondStatus = await service.refreshStatus(second.workspace_id);
    assert.equal(secondStatus.dirty_files.some((file) => file.path === 'agent-a.txt'), false);

    assert.equal(runGit(first.root_path, ['add', 'agent-a.txt']).status, 0);
    assert.equal(runGit(first.root_path, ['commit', '-m', 'agent A']).status, 0);
    const diff = await service.getDiff(first.workspace_id);
    assert.ok(diff.files.some((file) => file.path === 'agent-a.txt'));
    assert.ok(diff.summary.additions >= 1);

    const merged = await service.mergeToBase(first.workspace_id, { strategy: 'ff-only' });
    assert.equal(merged.merged, true);
    assert.equal(merged.status, 'merged');
    assert.equal(await readFile(path.join(projectPath, 'agent-a.txt'), 'utf8'), 'A\n');

    await service.cleanup(first.workspace_id);
    await service.discard(second.workspace_id, { deleteBranch: true });
    assert.equal(await pathExists(first.root_path), false);
    assert.equal(await pathExists(second.root_path), false);
    assert.equal(runGit(projectPath, ['branch', '--show-current']).stdout, 'main');
  });
});

test('uses sandbox_copy for a non-git project and detects an orphan', async () => {
  await withDatabase(async (taskRoot) => {
    const projectPath = path.join(taskRoot, 'plain-project');
    await mkdir(projectPath, { recursive: true });
    await writeFile(path.join(projectPath, 'input.txt'), 'source\n');
    const projectId = projectsDb.createProjectPath(projectPath).project!.project_id;
    const service = createWorkspaceService({ tmpRoot: path.join(taskRoot, 'fallback') });

    const workspace = await service.create({ projectId, projectPath, taskId: 'plain-task' });
    assert.equal(workspace.mode, 'sandbox_copy');
    await writeFile(path.join(workspace.root_path, 'output.txt'), 'isolated\n');
    assert.equal(await pathExists(path.join(projectPath, 'output.txt')), false);
    assert.equal((await service.refreshStatus(workspace.workspace_id)).status, 'active');

    await rm(workspace.root_path, { recursive: true, force: true });
    const orphanStatus = await service.refreshStatus(workspace.workspace_id);
    assert.equal(orphanStatus.status, 'orphan');
    assert.equal(service.get(workspace.workspace_id)?.status, 'orphan');
  });
});
