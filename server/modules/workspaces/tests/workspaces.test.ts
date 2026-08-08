import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
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
import { parseRemoteSlug, remoteRepoSlug } from '@/modules/workspaces/workspace-git.service.js';

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
  await writeFile(path.join(directory, '.gitignore'), '.worktrees/\nnode_modules/\ntmp/\n');
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

test('remote slugs resolve so gh targets the pushed-to fork, not upstream', async () => {
  assert.equal(parseRemoteSlug('https://github.com/digitalXperiments/claudecodeui.git'), 'digitalXperiments/claudecodeui');
  assert.equal(parseRemoteSlug('https://github.com/owner/name'), 'owner/name');
  assert.equal(parseRemoteSlug('git@github.com:owner/name.git'), 'owner/name');
  assert.equal(parseRemoteSlug('ssh://git@github.com/owner/name.git'), 'owner/name');
  assert.equal(parseRemoteSlug('git@gitlab.com:group/sub/name.git'), 'group/sub/name');
  assert.equal(parseRemoteSlug(''), null);
  assert.equal(parseRemoteSlug('not-a-remote'), null);

  await withDatabase(async (taskRoot) => {
    const projectPath = path.join(taskRoot, 'slug-project');
    await mkdir(projectPath, { recursive: true });
    await initGitRepo(projectPath);
    // A fork checkout: origin is the fork, upstream is where gh would default.
    runGit(projectPath, ['remote', 'add', 'origin', 'git@github.com:me/fork.git']);
    runGit(projectPath, ['remote', 'add', 'upstream', 'git@github.com:them/parent.git']);

    assert.equal(await remoteRepoSlug(projectPath), 'me/fork');
    assert.equal(await remoteRepoSlug(projectPath, 'upstream'), 'them/parent');
    assert.equal(await remoteRepoSlug(projectPath, 'nope'), null);
  });
});

test('worktrees land in <project>/.worktrees, gitignored and pre-warmed', async () => {
  await withDatabase(async (taskRoot) => {
    const projectPath = path.join(taskRoot, 'project');
    await mkdir(projectPath, { recursive: true });
    await initGitRepo(projectPath);
    // A primary install to link from; contents prove the link resolves.
    await mkdir(path.join(projectPath, 'node_modules', 'left-pad'), { recursive: true });
    await writeFile(path.join(projectPath, 'node_modules', 'left-pad', 'index.js'), 'x\n');

    const projectId = projectsDb.createProjectPath(projectPath).project!.project_id;
    const service = createWorkspaceService({ tmpRoot: path.join(taskRoot, 'fallback') });
    const workspace = await service.create({ projectId, projectPath, branchName: 'feat/paths' });

    assert.equal(
      workspace.root_path,
      path.join(projectPath, '.worktrees', workspace.workspace_id),
      'worktree must sit under <project>/.worktrees/<id>',
    );

    // The scratch root exists, so mkdtemp into it cannot ENOENT.
    assert.equal(await pathExists(path.join(workspace.root_path, 'tmp', 'cloudcli')), true);

    // node_modules is linked to the primary checkout, not copied.
    const linked = path.join(workspace.root_path, 'node_modules', 'left-pad', 'index.js');
    assert.equal(await pathExists(linked), true, 'node_modules should resolve through the link');
    const link = await lstat(path.join(workspace.root_path, 'node_modules'));
    assert.equal(link.isSymbolicLink(), true, 'node_modules should be a symlink, not a copy');

    // Git must not see the worktree, its scratch dir, or the linked modules.
    assert.equal(runGit(projectPath, ['status', '--porcelain']).stdout, '');
    assert.match(await readFile(path.join(projectPath, '.gitignore'), 'utf8'), /^\.worktrees\/$/m);

    await service.discard(workspace.workspace_id, { deleteBranch: true });
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
