import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, projectsDb } from '@/modules/database/index.js';
import { createWorkspaceService } from '@/modules/workspaces/workspace.service.js';

const TEST_ROOT = path.resolve('tmp/cloudcli');

function git(cwd: string, ...args: string[]): { status: number | null; stdout: string } {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return { status: result.status, stdout: String(result.stdout ?? '').trim() };
}

async function withProject(run: (ctx: { projectPath: string; projectId: string; tmpRoot: string }) => Promise<void>): Promise<void> {
  const previous = process.env.DATABASE_PATH;
  await mkdir(TEST_ROOT, { recursive: true });
  const root = await mkdtemp(path.join(TEST_ROOT, 'relay-landing-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(root, 'auth.db');
  await initializeDatabase();
  const projectPath = path.join(root, 'project');
  await mkdir(projectPath, { recursive: true });
  git(projectPath, 'init', '-q', '-b', 'main');
  git(projectPath, 'config', 'user.email', 'landing@example.com');
  git(projectPath, 'config', 'user.name', 'Landing Test');
  await writeFile(path.join(projectPath, 'a.txt'), 'one\ntwo\nthree\nfour\nfive\n');
  await writeFile(path.join(projectPath, 'b.txt'), 'b base\n');
  await writeFile(path.join(projectPath, 'c.txt'), 'c base\n');
  await writeFile(path.join(projectPath, '.gitignore'), 'tmp/\n');
  git(projectPath, 'add', '.');
  git(projectPath, 'commit', '-qm', 'init');
  const projectId = projectsDb.createProjectPath(projectPath).project!.project_id;
  try {
    await run({ projectPath, projectId, tmpRoot: path.join(root, 'tmp') });
  } finally {
    closeConnection();
    if (previous === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previous;
    await rm(root, { recursive: true, force: true });
  }
}

test('snapshot keeps the operator\'s uncommitted files out of the worker diff', async () => {
  await withProject(async ({ projectPath, projectId, tmpRoot }) => {
    const service = createWorkspaceService({ tmpRoot });
    await writeFile(path.join(projectPath, 'b.txt'), 'operator wip\n');
    await writeFile(path.join(projectPath, 'new-wip.txt'), 'untracked wip\n');
    const workspace = await service.create({ projectId, projectPath, branchName: 'relay/snap', snapshotPrimaryChanges: true });
    assert.ok(workspace.snapshot_sha, 'a snapshot commit is recorded');
    assert.notEqual(workspace.snapshot_sha, workspace.base_sha);
    assert.equal(await readFile(path.join(workspace.root_path, 'b.txt'), 'utf8'), 'operator wip\n', 'the worker sees the operator\'s state');
    assert.equal((await service.refreshStatus(workspace.workspace_id)).dirty_files.length, 0, 'the overlay is committed, not dirt');

    await writeFile(path.join(workspace.root_path, 'c.txt'), 'c by worker\n');
    const diff = await service.getDiff(workspace.workspace_id);
    assert.deepEqual(diff.files.map((file) => file.path), ['c.txt']);

    const tip = await service.commitPendingChanges(workspace.workspace_id, 'relay: leftovers');
    assert.ok(tip);
    assert.equal((await service.refreshStatus(workspace.workspace_id)).dirty_files.length, 0);
    await service.discard(workspace.workspace_id, { deleteBranch: true });
  });
});

test('landing onto a dirty primary commits only clean paths and never sweeps operator edits', async () => {
  await withProject(async ({ projectPath, projectId, tmpRoot }) => {
    const service = createWorkspaceService({ tmpRoot });
    // Operator has uncommitted edits in a.txt (top line) and b.txt.
    await writeFile(path.join(projectPath, 'a.txt'), 'ONE (operator)\ntwo\nthree\nfour\nfive\n');
    await writeFile(path.join(projectPath, 'b.txt'), 'operator wip\n');
    const workspace = await service.create({ projectId, projectPath, branchName: 'relay/land', snapshotPrimaryChanges: true });

    // Worker: edits the bottom of a.txt, rewrites c.txt, adds d.txt.
    await writeFile(path.join(workspace.root_path, 'a.txt'), 'ONE (operator)\ntwo\nthree\nfour\nFIVE (worker)\n');
    await writeFile(path.join(workspace.root_path, 'c.txt'), 'c by worker\n');
    await writeFile(path.join(workspace.root_path, 'd.txt'), 'new file\n');
    await service.commitPendingChanges(workspace.workspace_id, 'worker change');

    // Meanwhile the operator keeps editing a.txt near the top.
    await writeFile(path.join(projectPath, 'a.txt'), 'ONE (operator, again)\ntwo\nthree\nfour\nfive\n');

    const headBefore = git(projectPath, 'rev-parse', 'HEAD').stdout;
    const landed = await service.landOntoPrimary(workspace.workspace_id, { message: 'Land worker change' });
    assert.deepEqual([...landed.applied].sort(), ['c.txt', 'd.txt']);
    assert.deepEqual(landed.merged, ['a.txt'], 'the operator and worker edits merge three-way');
    assert.deepEqual(landed.conflicts, []);
    assert.deepEqual(landed.leftUncommitted, ['a.txt'], 'a file carrying operator edits is never committed');
    assert.equal(landed.committed, true);
    assert.notEqual(git(projectPath, 'rev-parse', 'HEAD').stdout, headBefore);

    assert.equal(await readFile(path.join(projectPath, 'a.txt'), 'utf8'), 'ONE (operator, again)\ntwo\nthree\nfour\nFIVE (worker)\n');
    assert.equal(await readFile(path.join(projectPath, 'b.txt'), 'utf8'), 'operator wip\n', 'the snapshot itself is never re-applied');
    const committedFiles = git(projectPath, 'show', '--name-only', '--format=', 'HEAD').stdout.split('\n').sort();
    assert.deepEqual(committedFiles, ['c.txt', 'd.txt']);
    const status = git(projectPath, 'status', '--porcelain').stdout;
    assert.match(status, /a\.txt/);
    assert.match(status, /b\.txt/);
    await service.discard(workspace.workspace_id, { deleteBranch: true });
  });
});

test('overlapping edits are reported as conflicts and nothing is written for them', async () => {
  await withProject(async ({ projectPath, projectId, tmpRoot }) => {
    const service = createWorkspaceService({ tmpRoot });
    const workspace = await service.create({ projectId, projectPath, branchName: 'relay/conflict', snapshotPrimaryChanges: true });
    await writeFile(path.join(workspace.root_path, 'b.txt'), 'worker version\n');
    await service.commitPendingChanges(workspace.workspace_id, 'worker');
    await writeFile(path.join(projectPath, 'b.txt'), 'operator version\n');

    const landed = await service.landOntoPrimary(workspace.workspace_id);
    assert.deepEqual(landed.conflicts.map((item) => item.path), ['b.txt']);
    assert.equal(await readFile(path.join(projectPath, 'b.txt'), 'utf8'), 'operator version\n');
    assert.equal(landed.committed, false);
    await service.discard(workspace.workspace_id, { deleteBranch: true });
  });
});

test('a stacked workspace starts from its predecessor tip and inherits the snapshot', async () => {
  await withProject(async ({ projectPath, projectId, tmpRoot }) => {
    const service = createWorkspaceService({ tmpRoot });
    await writeFile(path.join(projectPath, 'b.txt'), 'operator wip\n');
    const first = await service.create({ projectId, projectPath, branchName: 'relay/stage-1', snapshotPrimaryChanges: true });
    await writeFile(path.join(first.root_path, 'c.txt'), 'stage one\n');
    await service.commitPendingChanges(first.workspace_id, 'stage one');

    const second = await service.create({
      projectId,
      projectPath,
      branchName: 'relay/stage-2',
      startRefs: ['relay/stage-1'],
      inheritSnapshotSha: first.snapshot_sha,
    });
    assert.equal(second.snapshot_sha, first.snapshot_sha);
    assert.equal(await readFile(path.join(second.root_path, 'c.txt'), 'utf8'), 'stage one\n');
    await writeFile(path.join(second.root_path, 'd.txt'), 'stage two\n');
    await service.commitPendingChanges(second.workspace_id, 'stage two');
    const diff = await service.getDiff(second.workspace_id);
    assert.deepEqual(diff.files.map((file) => file.path), ['d.txt'], 'the stage diff shows only its own work');

    const landed = await service.landOntoPrimary(second.workspace_id);
    assert.deepEqual([...landed.applied].sort(), ['c.txt', 'd.txt'], 'landing the last stage carries the whole pipeline');
    await service.discard(second.workspace_id, { deleteBranch: true });
    await service.discard(first.workspace_id, { deleteBranch: true });
  });
});
