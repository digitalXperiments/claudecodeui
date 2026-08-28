import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection, initializeDatabase, projectsDb } from '@/modules/database/index.js';
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
  assert.equal(runGit(directory, ['config', 'user.email', 'apply-test@example.com']).status, 0);
  assert.equal(runGit(directory, ['config', 'user.name', 'Apply Test']).status, 0);
  await writeFile(path.join(directory, 'README.md'), 'initial\n');
  await writeFile(path.join(directory, '.gitignore'), 'node_modules/\ntmp/\n');
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

async function withDatabase(callback: (taskRoot: string) => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const taskRoot = await mkdtemp(path.join(TEST_ROOT, 'apply-to-primary-test-'));
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

test('applyToPrimary copies clean changes and deletions onto the primary checkout', async () => {
  await withDatabase(async (taskRoot) => {
    const projectPath = path.join(taskRoot, 'project');
    await mkdir(projectPath, { recursive: true });
    await initGitRepo(projectPath);
    await writeFile(path.join(projectPath, 'to-delete.txt'), 'gone soon\n');
    assert.equal(runGit(projectPath, ['add', '.']).status, 0);
    assert.equal(runGit(projectPath, ['commit', '-m', 'add to-delete.txt']).status, 0);

    const projectId = projectsDb.createProjectPath(projectPath).project!.project_id;
    const service = createWorkspaceService({ tmpRoot: path.join(taskRoot, 'fallback') });
    const workspace = await service.create({ projectId, projectPath, branchName: 'feat/apply-clean' });

    // Uncommitted worktree changes must land too — no commit is made here.
    await writeFile(path.join(workspace.root_path, 'output.txt'), 'from workspace\n');
    await rm(path.join(workspace.root_path, 'to-delete.txt'), { force: true });

    const result = await service.applyToPrimary(workspace.workspace_id);

    assert.deepEqual(result.skipped, []);
    assert.deepEqual([...result.applied].sort(), ['output.txt', 'to-delete.txt']);
    assert.equal(result.committed, false);
    assert.equal(result.commit_sha, null);
    assert.equal(await readFile(path.join(projectPath, 'output.txt'), 'utf8'), 'from workspace\n');
    assert.equal(await pathExists(path.join(projectPath, 'to-delete.txt')), false);
    // File-copy only: no merge/commit/checkout touched the primary's git state.
    assert.equal(runGit(projectPath, ['status', '--porcelain']).stdout.includes('output.txt'), true);

    await service.discard(workspace.workspace_id, { deleteBranch: true });
  });
});

test('applyToPrimary leaves an unrelated dirty primary file alone', async () => {
  await withDatabase(async (taskRoot) => {
    const projectPath = path.join(taskRoot, 'project');
    await mkdir(projectPath, { recursive: true });
    await initGitRepo(projectPath);

    const projectId = projectsDb.createProjectPath(projectPath).project!.project_id;
    const service = createWorkspaceService({ tmpRoot: path.join(taskRoot, 'fallback') });
    const workspace = await service.create({ projectId, projectPath, branchName: 'feat/apply-unrelated' });

    await writeFile(path.join(workspace.root_path, 'agent.txt'), 'from workspace\n');
    // Dirty change in the primary on a path the workspace never touched.
    await writeFile(path.join(projectPath, 'README.md'), 'user is mid-edit\n');

    const result = await service.applyToPrimary(workspace.workspace_id);

    assert.deepEqual(result.applied, ['agent.txt']);
    assert.deepEqual(result.skipped, []);
    assert.equal(await readFile(path.join(projectPath, 'README.md'), 'utf8'), 'user is mid-edit\n');
    assert.equal(await readFile(path.join(projectPath, 'agent.txt'), 'utf8'), 'from workspace\n');

    await service.discard(workspace.workspace_id, { deleteBranch: true });
  });
});

test('applyToPrimary skips a path the primary changed differently instead of clobbering it', async () => {
  await withDatabase(async (taskRoot) => {
    const projectPath = path.join(taskRoot, 'project');
    await mkdir(projectPath, { recursive: true });
    await initGitRepo(projectPath);

    const projectId = projectsDb.createProjectPath(projectPath).project!.project_id;
    const service = createWorkspaceService({ tmpRoot: path.join(taskRoot, 'fallback') });
    const workspace = await service.create({ projectId, projectPath, branchName: 'feat/apply-overlap' });

    await writeFile(path.join(workspace.root_path, 'README.md'), 'workspace version\n');
    // Primary independently diverged on the same path.
    await writeFile(path.join(projectPath, 'README.md'), 'primary version\n');

    const result = await service.applyToPrimary(workspace.workspace_id);

    assert.deepEqual(result.applied, []);
    assert.deepEqual(result.skipped, [{ path: 'README.md', reason: 'dirty_overlap' }]);
    assert.equal(await readFile(path.join(projectPath, 'README.md'), 'utf8'), 'primary version\n');

    await service.discard(workspace.workspace_id, { deleteBranch: true });
  });
});

test('applyToPrimary does not skip a dirty path when the primary already matches the workspace', async () => {
  await withDatabase(async (taskRoot) => {
    const projectPath = path.join(taskRoot, 'project');
    await mkdir(projectPath, { recursive: true });
    await initGitRepo(projectPath);

    const projectId = projectsDb.createProjectPath(projectPath).project!.project_id;
    const service = createWorkspaceService({ tmpRoot: path.join(taskRoot, 'fallback') });
    const workspace = await service.create({ projectId, projectPath, branchName: 'feat/apply-matching' });

    await writeFile(path.join(workspace.root_path, 'README.md'), 'same content\n');
    // Primary is dirty at this path, but happens to already hold identical content.
    await writeFile(path.join(projectPath, 'README.md'), 'same content\n');

    const result = await service.applyToPrimary(workspace.workspace_id);

    assert.deepEqual(result.applied, ['README.md']);
    assert.deepEqual(result.skipped, []);

    await service.discard(workspace.workspace_id, { deleteBranch: true });
  });
});

test('applyToPrimary with commit:true stages and commits only the applied paths', async () => {
  await withDatabase(async (taskRoot) => {
    const projectPath = path.join(taskRoot, 'project');
    await mkdir(projectPath, { recursive: true });
    await initGitRepo(projectPath);

    const projectId = projectsDb.createProjectPath(projectPath).project!.project_id;
    const service = createWorkspaceService({ tmpRoot: path.join(taskRoot, 'fallback') });
    const workspace = await service.create({ projectId, projectPath, branchName: 'feat/apply-commit' });

    await writeFile(path.join(workspace.root_path, 'agent.txt'), 'from workspace\n');
    // Unrelated dirty file in the primary must stay unstaged after commit.
    await writeFile(path.join(projectPath, 'README.md'), 'user is mid-edit\n');

    const result = await service.applyToPrimary(workspace.workspace_id, {
      commit: true,
      message: 'Apply workspace changes',
    });

    assert.deepEqual(result.applied, ['agent.txt']);
    assert.equal(result.committed, true);
    assert.ok(result.commit_sha);

    const log = runGit(projectPath, ['log', '-1', '--pretty=%s']);
    assert.equal(log.stdout, 'Apply workspace changes');

    const status = runGit(projectPath, ['status', '--porcelain']).stdout;
    assert.equal(status.includes('agent.txt'), false, 'applied file must be committed, not left staged');
    assert.match(status, /README\.md/, 'unrelated dirty file must remain unstaged');

    await service.discard(workspace.workspace_id, { deleteBranch: true });
  });
});

test('applyToPrimary requires opts.message when commit is true', async () => {
  await withDatabase(async (taskRoot) => {
    const projectPath = path.join(taskRoot, 'project');
    await mkdir(projectPath, { recursive: true });
    await initGitRepo(projectPath);

    const projectId = projectsDb.createProjectPath(projectPath).project!.project_id;
    const service = createWorkspaceService({ tmpRoot: path.join(taskRoot, 'fallback') });
    const workspace = await service.create({ projectId, projectPath, branchName: 'feat/apply-no-message' });

    await writeFile(path.join(workspace.root_path, 'agent.txt'), 'from workspace\n');

    await assert.rejects(
      service.applyToPrimary(workspace.workspace_id, { commit: true }),
      /opts.message is required/,
    );

    await service.discard(workspace.workspace_id, { deleteBranch: true });
  });
});

test('applyToPrimary diffs sandbox_copy workspaces file-by-file against the primary path', async () => {
  await withDatabase(async (taskRoot) => {
    const projectPath = path.join(taskRoot, 'plain-project');
    await mkdir(projectPath, { recursive: true });
    await writeFile(path.join(projectPath, 'input.txt'), 'source\n');

    const projectId = projectsDb.createProjectPath(projectPath).project!.project_id;
    const service = createWorkspaceService({ tmpRoot: path.join(taskRoot, 'fallback') });
    const workspace = await service.create({ projectId, projectPath, mode: 'sandbox_copy' });

    await writeFile(path.join(workspace.root_path, 'input.txt'), 'modified in sandbox\n');
    await writeFile(path.join(workspace.root_path, 'new-file.txt'), 'brand new\n');

    const result = await service.applyToPrimary(workspace.workspace_id);

    assert.deepEqual([...result.applied].sort(), ['input.txt', 'new-file.txt']);
    assert.deepEqual(result.skipped, []);
    assert.equal(await readFile(path.join(projectPath, 'input.txt'), 'utf8'), 'modified in sandbox\n');
    assert.equal(await readFile(path.join(projectPath, 'new-file.txt'), 'utf8'), 'brand new\n');

    await service.discard(workspace.workspace_id);
  });
});
