import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
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
import {
  parseRemoteSlug,
  remoteRepoSlug,
  runGit as runGitAsync,
} from '@/modules/workspaces/workspace-git.service.js';

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

test('worktrees use private excludes and isolated copy-on-write dependencies', async () => {
  await withDatabase(async (taskRoot) => {
    const projectPath = path.join(taskRoot, 'project');
    await mkdir(projectPath, { recursive: true });
    await initGitRepo(projectPath);
    // A primary install to clone from; contents prove the clone is isolated.
    await mkdir(path.join(projectPath, 'node_modules', 'left-pad'), { recursive: true });
    await writeFile(path.join(projectPath, 'node_modules', 'left-pad', 'index.js'), 'x\n');
    const trackedGitignore = await readFile(path.join(projectPath, '.gitignore'), 'utf8');

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

    // Dependencies are independently writable: agents cannot mutate the
    // primary install through a workspace symlink.
    const cloned = path.join(workspace.root_path, 'node_modules', 'left-pad', 'index.js');
    assert.equal(await pathExists(cloned), true, 'node_modules should be pre-warmed');
    const modules = await lstat(path.join(workspace.root_path, 'node_modules'));
    assert.equal(modules.isSymbolicLink(), false, 'node_modules must not point at the primary tree');
    await writeFile(cloned, 'workspace-only\n');
    assert.equal(
      await readFile(path.join(projectPath, 'node_modules', 'left-pad', 'index.js'), 'utf8'),
      'x\n',
    );

    // Git must not see the worktree, its scratch dir, or cloned modules.
    assert.equal(runGit(projectPath, ['status', '--porcelain']).stdout, '');
    assert.equal(await readFile(path.join(projectPath, '.gitignore'), 'utf8'), trackedGitignore);
    assert.match(await readFile(path.join(projectPath, '.git', 'info', 'exclude'), 'utf8'), /^\.worktrees\/$/m);

    await service.discard(workspace.workspace_id, { deleteBranch: true });
  });
});

test('cross-process workspace lock waits boundedly and recovers an expired owner', async () => {
  await withDatabase(async (taskRoot) => {
    const projectPath = path.join(taskRoot, 'locked-project');
    await mkdir(projectPath, { recursive: true });
    await initGitRepo(projectPath);
    const projectId = projectsDb.createProjectPath(projectPath).project!.project_id;
    const lockDir = path.join(projectPath, '.cloudcli', 'locks');
    const lockPath = path.join(lockDir, `${projectId}.lock`);
    await mkdir(lockDir, { recursive: true });
    await writeFile(
      lockPath,
      `${JSON.stringify({ token: 'other-owner', pid: 999999, hostname: 'elsewhere' })}\n`,
    );

    const service = createWorkspaceService({
      tmpRoot: path.join(taskRoot, 'fallback'),
      lockWaitMs: 30,
      lockRetryMs: 5,
      lockStaleMs: 750,
    });
    await assert.rejects(
      service.create({ projectId, projectPath, branchName: 'feat/blocked' }),
      /Timed out waiting 30ms for workspace lock/,
    );

    const expired = new Date(Date.now() - 5_000);
    await utimes(lockPath, expired, expired);
    const workspace = await service.create({
      projectId,
      projectPath,
      branchName: 'feat/recovered',
    });
    assert.equal(workspace.status, 'active');
    assert.equal(await pathExists(lockPath), false, 'owner release should remove only its own lock');

    const ownershipCreate = service.create({
      projectId,
      projectPath,
      branchName: 'feat/ownership-check',
    });
    for (let attempt = 0; attempt < 100 && !(await pathExists(lockPath)); attempt += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 2));
    }
    assert.equal(await pathExists(lockPath), true, 'create should hold the project lease');
    await writeFile(lockPath, `${JSON.stringify({ token: 'replacement-owner' })}\n`);
    const ownershipWorkspace = await ownershipCreate;
    assert.equal(
      JSON.parse(await readFile(lockPath, 'utf8')).token,
      'replacement-owner',
      'release must preserve a lock whose ownership token changed',
    );
    await rm(lockPath, { force: true });

    await service.discard(workspace.workspace_id, { deleteBranch: true });
    await service.discard(ownershipWorkspace.workspace_id, { deleteBranch: true });
  });
});

test('failed provisioning remains persisted for recovery and diagnosis', async () => {
  await withDatabase(async (taskRoot) => {
    const projectPath = path.join(taskRoot, 'provision-project');
    await mkdir(projectPath, { recursive: true });
    await initGitRepo(projectPath);
    const projectId = projectsDb.createProjectPath(projectPath).project!.project_id;
    const service = createWorkspaceService({ tmpRoot: path.join(taskRoot, 'fallback') });
    const first = await service.create({ projectId, projectPath, branchName: 'feat/occupied' });

    await assert.rejects(
      service.create({ projectId, projectPath, branchName: 'feat/occupied' }),
      /git workspace provisioning failed/,
    );
    const failed = service.list(projectId, { status: ['error'] });
    assert.equal(failed.length, 1);
    assert.match(failed[0].last_error ?? '', /worktree add failed/);

    await service.discard(first.workspace_id, { deleteBranch: true });
    await service.discard(failed[0].workspace_id);
  });
});

test('reconciliation rejects persisted roots outside the workspace policy', async () => {
  await withDatabase(async (taskRoot) => {
    const projectPath = path.join(taskRoot, 'policy-project');
    const outsidePath = path.join(taskRoot, 'must-not-touch');
    await mkdir(projectPath, { recursive: true });
    await mkdir(outsidePath, { recursive: true });
    await writeFile(path.join(outsidePath, 'keep.txt'), 'safe\n');
    const projectId = projectsDb.createProjectPath(projectPath).project!.project_id;
    const service = createWorkspaceService({ tmpRoot: path.join(taskRoot, 'fallback') });
    const workspace = await service.create({ projectId, projectPath, mode: 'sandbox_copy' });
    getConnection()
      .prepare('UPDATE agent_workspaces SET root_path = ? WHERE workspace_id = ?')
      .run(outsidePath, workspace.workspace_id);

    const orphaned = await service.reconcileOrphanedWorkspaces(projectId);
    assert.deepEqual(orphaned.map((entry) => entry.workspace_id), [workspace.workspace_id]);
    assert.equal(await readFile(path.join(outsidePath, 'keep.txt'), 'utf8'), 'safe\n');
    await assert.rejects(service.cleanup(workspace.workspace_id), /escapes allowed roots/);
  });
});

test('workspace operations reject an allowed-looking symlink that resolves outside policy', async () => {
  await withDatabase(async (taskRoot) => {
    const projectPath = path.join(taskRoot, 'symlink-policy-project');
    const outsidePath = path.join(taskRoot, 'outside-target');
    await mkdir(projectPath, { recursive: true });
    await mkdir(outsidePath, { recursive: true });
    await writeFile(path.join(outsidePath, 'keep.txt'), 'safe\n');
    const projectId = projectsDb.createProjectPath(projectPath).project!.project_id;
    const service = createWorkspaceService({ tmpRoot: path.join(taskRoot, 'fallback') });
    const workspace = await service.create({ projectId, projectPath, mode: 'sandbox_copy' });

    await rm(workspace.root_path, { recursive: true, force: true });
    await symlink(outsidePath, workspace.root_path, 'dir');

    await assert.rejects(
      service.cleanup(workspace.workspace_id),
      /resolves outside allowed roots/,
    );
    assert.equal(await readFile(path.join(outsidePath, 'keep.txt'), 'utf8'), 'safe\n');
    await rm(workspace.root_path, { force: true });
  });
});

test('git subprocesses are noninteractive and have a hard timeout', async () => {
  await withDatabase(async (taskRoot) => {
    const projectPath = path.join(taskRoot, 'git-runner-project');
    await mkdir(projectPath, { recursive: true });
    await initGitRepo(projectPath);

    const env = await runGitAsync(
      projectPath,
      ['-c', 'alias.showenv=!printf %s "$GIT_TERMINAL_PROMPT"', 'showenv'],
      { timeoutMs: 1_000 },
    );
    assert.equal(env.code, 0);
    assert.equal(env.stdout, '0');

    const startedAt = Date.now();
    const timedOut = await runGitAsync(
      projectPath,
      ['-c', 'alias.hang=!sleep 2', 'hang'],
      { timeoutMs: 25 },
    );
    assert.equal(timedOut.code, null);
    assert.match(timedOut.stderr, /timed out after 25ms/);
    assert.ok(Date.now() - startedAt < 1_500);

    const noisy = await runGitAsync(
      projectPath,
      ['-c', `alias.noisy=!printf ${'x'.repeat(1_024)}`, 'noisy'],
      { timeoutMs: 1_000, maxOutputBytes: 64 },
    );
    assert.equal(noisy.code, null);
    assert.match(noisy.stderr, /output exceeded 64 bytes/);
    assert.ok(Buffer.byteLength(noisy.stdout) <= 64);
  });
});

test('uses sandbox_copy when explicitly requested and detects an orphan', async () => {
  await withDatabase(async (taskRoot) => {
    const projectPath = path.join(taskRoot, 'plain-project');
    await mkdir(projectPath, { recursive: true });
    await writeFile(path.join(projectPath, 'input.txt'), 'source\n');
    const projectId = projectsDb.createProjectPath(projectPath).project!.project_id;
    const service = createWorkspaceService({ tmpRoot: path.join(taskRoot, 'fallback') });

    const workspace = await service.create({
      projectId,
      projectPath,
      taskId: 'plain-task',
      mode: 'sandbox_copy',
    });
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

test('auto-inits a plain non-git project so it gets real, mergeable git_worktree isolation', async () => {
  await withDatabase(async (taskRoot) => {
    const projectPath = path.join(taskRoot, 'plain-project');
    await mkdir(projectPath, { recursive: true });
    await writeFile(path.join(projectPath, 'input.txt'), 'source\n');
    const projectId = projectsDb.createProjectPath(projectPath).project!.project_id;
    const service = createWorkspaceService({ tmpRoot: path.join(taskRoot, 'fallback') });

    const workspace = await service.create({ projectId, projectPath, taskId: 'plain-task' });
    assert.equal(workspace.mode, 'git_worktree');
    assert.equal(await pathExists(path.join(projectPath, '.git')), true);

    await writeFile(path.join(workspace.root_path, 'output.txt'), 'isolated\n');
    assert.equal(await pathExists(path.join(projectPath, 'output.txt')), false);
    await runGit(workspace.root_path, ['add', '-A']);
    await runGit(workspace.root_path, ['commit', '-m', 'add output.txt']);

    const merged = await service.mergeToBase(workspace.workspace_id, { strategy: 'merge', deleteAfter: true });
    assert.equal(merged.status, 'merged');
    assert.equal(await pathExists(path.join(projectPath, 'output.txt')), true);
  });
});
