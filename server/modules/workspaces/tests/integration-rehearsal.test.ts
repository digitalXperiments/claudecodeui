import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection, initializeDatabase, projectsDb } from '@/modules/database/index.js';
import { createIntegrationRehearsalService } from '@/modules/workspaces/integration-rehearsal.service.js';
import { createWorkspaceService } from '@/modules/workspaces/workspace.service.js';
import { CloudError } from '@/shared/run-events.js';

const TEST_ROOT = path.resolve('tmp/cloudcli');
await mkdir(TEST_ROOT, { recursive: true });

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
  assert.equal(runGit(directory, ['config', 'user.email', 'rehearsal-test@example.com']).status, 0);
  assert.equal(runGit(directory, ['config', 'user.name', 'Rehearsal Test']).status, 0);
  await writeFile(path.join(directory, 'README.md'), 'base\n');
  await writeFile(path.join(directory, 'check.sh'), '#!/bin/sh\nexit 0\n');
  await mkdir(path.join(directory, '.cloudcli'), { recursive: true });
  await writeFile(
    path.join(directory, '.cloudcli', 'ship.yaml'),
    'test:\n  command: git diff --check\n',
  );
  assert.equal(runGit(directory, ['add', '.']).status, 0);
  assert.equal(runGit(directory, ['commit', '-m', 'initial']).status, 0);
}

async function withDatabase(callback: (taskRoot: string) => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const taskRoot = await mkdtemp(path.join(TEST_ROOT, 'rehearsal-test-'));
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

test('clean success combines committed tips without touching primary', async () => {
  await withDatabase(async (taskRoot) => {
    const projectPath = path.join(taskRoot, 'project');
    await mkdir(projectPath, { recursive: true });
    await initGitRepo(projectPath);
    const baseSha = runGit(projectPath, ['rev-parse', 'HEAD']).stdout;
    await writeFile(path.join(projectPath, 'primary-dirty.txt'), 'do not copy\n');
    const projectId = projectsDb.createProjectPath(projectPath).project!.project_id;
    const tmpRoot = path.join(taskRoot, 'tmp');
    const workspaces = createWorkspaceService({ tmpRoot });
    const rehearsal = createIntegrationRehearsalService({ tmpRoot, testTimeoutMs: 15_000 });

    const a = await workspaces.create({ projectId, projectPath, branchName: 'feat/a', taskId: 'task-a' });
    const b = await workspaces.create({ projectId, projectPath, branchName: 'feat/b', taskId: 'task-b' });
    await writeFile(path.join(a.root_path, 'a.txt'), 'A\n');
    assert.equal(runGit(a.root_path, ['add', 'a.txt']).status, 0);
    assert.equal(runGit(a.root_path, ['commit', '-m', 'add a']).status, 0);
    await writeFile(path.join(b.root_path, 'b.txt'), 'B\n');
    assert.equal(runGit(b.root_path, ['add', 'b.txt']).status, 0);
    assert.equal(runGit(b.root_path, ['commit', '-m', 'add b']).status, 0);

    const result = await rehearsal.run({
      projectId,
      workspaceIds: [a.workspace_id, b.workspace_id],
      baseSha,
    });

    assert.equal(result.outcome, 'success');
    assert.equal(result.merge_conflicts.length, 0);
    assert.equal(result.test?.passed, true);
    assert.equal(result.test?.command, 'git diff --check');
    assert.ok(result.test?.exit_code === 0);
    assert.equal(result.cleaned_up, true);
    assert.equal(result.inputs[0].head_sha, runGit(a.root_path, ['rev-parse', 'HEAD']).stdout);
    assert.equal(result.base_sha, baseSha);
    assert.ok(result.warnings.some((warning) => /Uncommitted edits are excluded/.test(warning)));
    assert.equal(runGit(projectPath, ['branch', '--show-current']).stdout, 'main');
    assert.equal(runGit(projectPath, ['rev-parse', 'HEAD']).stdout, baseSha);
    assert.equal(await readFile(path.join(projectPath, 'primary-dirty.txt'), 'utf8'), 'do not copy\n');
    assert.equal(runGit(projectPath, ['branch', '--list', result.rehearsal_branch]).stdout, '');
  });
});

test('textual conflict is reported separately from tests', async () => {
  await withDatabase(async (taskRoot) => {
    const projectPath = path.join(taskRoot, 'conflict-project');
    await mkdir(projectPath, { recursive: true });
    await initGitRepo(projectPath);
    const baseSha = runGit(projectPath, ['rev-parse', 'HEAD']).stdout;
    const projectId = projectsDb.createProjectPath(projectPath).project!.project_id;
    const tmpRoot = path.join(taskRoot, 'tmp');
    const workspaces = createWorkspaceService({ tmpRoot });
    const rehearsal = createIntegrationRehearsalService({ tmpRoot, testTimeoutMs: 15_000 });

    const a = await workspaces.create({ projectId, projectPath, branchName: 'feat/left', taskId: 'left' });
    const b = await workspaces.create({ projectId, projectPath, branchName: 'feat/right', taskId: 'right' });
    await writeFile(path.join(a.root_path, 'README.md'), 'left\n');
    assert.equal(runGit(a.root_path, ['add', 'README.md']).status, 0);
    assert.equal(runGit(a.root_path, ['commit', '-m', 'left']).status, 0);
    await writeFile(path.join(b.root_path, 'README.md'), 'right\n');
    assert.equal(runGit(b.root_path, ['add', 'README.md']).status, 0);
    assert.equal(runGit(b.root_path, ['commit', '-m', 'right']).status, 0);

    const result = await rehearsal.run({
      projectId,
      workspaceIds: [a.workspace_id, b.workspace_id],
      baseSha,
    });

    assert.equal(result.outcome, 'merge_conflict');
    assert.ok(result.merge_conflicts.includes('README.md'));
    assert.equal(result.test, null);
    assert.equal(result.cleaned_up, true);
    assert.equal(runGit(projectPath, ['rev-parse', 'HEAD']).stdout, baseSha);
  });
});

test('semantic failure runs tests after a clean merge', async () => {
  await withDatabase(async (taskRoot) => {
    const projectPath = path.join(taskRoot, 'fail-project');
    await mkdir(projectPath, { recursive: true });
    await initGitRepo(projectPath);
    await writeFile(path.join(projectPath, '.cloudcli', 'ship.yaml'), 'test:\n  command: git rev-parse --verify missing-ref-for-fail\n');
    assert.equal(runGit(projectPath, ['add', '.cloudcli/ship.yaml']).status, 0);
    assert.equal(runGit(projectPath, ['commit', '-m', 'failing test command']).status, 0);
    const baseSha = runGit(projectPath, ['rev-parse', 'HEAD']).stdout;
    const projectId = projectsDb.createProjectPath(projectPath).project!.project_id;
    const tmpRoot = path.join(taskRoot, 'tmp');
    const workspaces = createWorkspaceService({ tmpRoot });
    const rehearsal = createIntegrationRehearsalService({ tmpRoot, testTimeoutMs: 15_000 });

    const a = await workspaces.create({ projectId, projectPath, branchName: 'feat/ok-a', taskId: 'ok-a' });
    const b = await workspaces.create({ projectId, projectPath, branchName: 'feat/ok-b', taskId: 'ok-b' });
    await writeFile(path.join(a.root_path, 'ok-a.txt'), '1\n');
    assert.equal(runGit(a.root_path, ['add', 'ok-a.txt']).status, 0);
    assert.equal(runGit(a.root_path, ['commit', '-m', 'a']).status, 0);
    await writeFile(path.join(b.root_path, 'ok-b.txt'), '2\n');
    assert.equal(runGit(b.root_path, ['add', 'ok-b.txt']).status, 0);
    assert.equal(runGit(b.root_path, ['commit', '-m', 'b']).status, 0);

    const result = await rehearsal.run({
      projectId,
      workspaceIds: [a.workspace_id, b.workspace_id],
      baseSha,
    });

    assert.equal(result.outcome, 'test_failed');
    assert.equal(result.merge_conflicts.length, 0);
    assert.equal(result.test?.passed, false);
    assert.notEqual(result.test?.exit_code, 0);
    assert.equal(result.cleaned_up, true);
  });
});

test('dirty and invalid inputs are rejected and primary stays unchanged', async () => {
  await withDatabase(async (taskRoot) => {
    const projectPath = path.join(taskRoot, 'invalid-project');
    await mkdir(projectPath, { recursive: true });
    await initGitRepo(projectPath);
    const baseSha = runGit(projectPath, ['rev-parse', 'HEAD']).stdout;
    const projectId = projectsDb.createProjectPath(projectPath).project!.project_id;
    const otherPath = path.join(taskRoot, 'other');
    await mkdir(otherPath, { recursive: true });
    await initGitRepo(otherPath);
    const otherId = projectsDb.createProjectPath(otherPath).project!.project_id;
    const tmpRoot = path.join(taskRoot, 'tmp');
    const workspaces = createWorkspaceService({ tmpRoot });
    const rehearsal = createIntegrationRehearsalService({ tmpRoot, testTimeoutMs: 15_000 });

    const a = await workspaces.create({ projectId, projectPath, branchName: 'feat/dirty', taskId: 'dirty' });
    const b = await workspaces.create({ projectId, projectPath, branchName: 'feat/clean', taskId: 'clean' });
    await writeFile(path.join(a.root_path, 'a.txt'), 'A\n');
    assert.equal(runGit(a.root_path, ['add', 'a.txt']).status, 0);
    assert.equal(runGit(a.root_path, ['commit', '-m', 'a']).status, 0);
    await writeFile(path.join(b.root_path, 'b.txt'), 'B\n');
    assert.equal(runGit(b.root_path, ['add', 'b.txt']).status, 0);
    assert.equal(runGit(b.root_path, ['commit', '-m', 'b']).status, 0);
    await writeFile(path.join(a.root_path, 'uncommitted.txt'), 'nope\n');

    await assert.rejects(
      () => rehearsal.run({ projectId, workspaceIds: [a.workspace_id], baseSha }),
      (error: unknown) => error instanceof CloudError && error.code === 'WORKSPACE_CREATE_FAILED',
    );
    await assert.rejects(
      () =>
        rehearsal.run({
          projectId,
          workspaceIds: [a.workspace_id, b.workspace_id],
          baseSha,
        }),
      (error: unknown) => error instanceof CloudError && error.code === 'WORKSPACE_DIRTY_CONFLICT',
    );

    const otherWs = await workspaces.create({
      projectId: otherId,
      projectPath: otherPath,
      branchName: 'feat/other',
      taskId: 'other',
    });
    await assert.rejects(
      () =>
        rehearsal.run({
          projectId,
          workspaceIds: [b.workspace_id, otherWs.workspace_id],
          baseSha,
        }),
      (error: unknown) => error instanceof CloudError && error.code === 'WORKSPACE_CREATE_FAILED',
    );
    await assert.rejects(
      () =>
        rehearsal.run({
          projectId,
          workspaceIds: [b.workspace_id, a.workspace_id],
          baseSha: 'not a sha; rm -rf /',
        }),
      (error: unknown) => error instanceof CloudError && error.code === 'WORKSPACE_CREATE_FAILED',
    );

    assert.equal(runGit(projectPath, ['rev-parse', 'HEAD']).stdout, baseSha);
    assert.equal(runGit(projectPath, ['branch', '--show-current']).stdout, 'main');
  });
});
