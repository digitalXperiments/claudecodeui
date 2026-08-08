import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';

import { makeScratchDir } from '@/shared/scratch.js';
import { closeConnection, initializeDatabase, projectsDb } from '@/modules/database/index.js';
import { runService } from '@/modules/runs/index.js';
import { workspaceService } from '@/modules/workspaces/index.js';
import { createShipService, parseShipConfig, shipService } from '@/modules/ship/index.js';

function git(cwd: string, args: string[]): void {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, `${args.join(' ')} failed: ${result.stderr}`);
}

async function withDatabase(callback: (root: string) => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const root = await makeScratchDir('ship-');
  closeConnection();
  process.env.DATABASE_PATH = path.join(root, 'auth.db');
  await initializeDatabase();
  try {
    await callback(root);
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(root, { recursive: true, force: true });
  }
}

test('createPullRequest pushes the branch and pins gh to the origin repo', async () => {
  await withDatabase(async (root) => {
    const projectPath = path.join(root, 'project');
    await mkdir(path.join(projectPath, '.cloudcli'), { recursive: true });
    git(projectPath, ['init', '-b', 'main']);
    git(projectPath, ['config', 'user.email', 'ship@example.com']);
    git(projectPath, ['config', 'user.name', 'Ship Test']);
    await writeFile(path.join(projectPath, 'README.md'), 'ship\n');
    await writeFile(
      path.join(projectPath, '.cloudcli', 'ship.yaml'),
      'test:\n  command: "printf ok"\n  cwd: "."\n',
    );
    git(projectPath, ['add', '.']);
    git(projectPath, ['commit', '-m', 'initial']);

    // A fork checkout: the fetch URL names the fork (what gh must target),
    // while pushes go to a local bare repo so the test needs no network.
    const originPath = path.join(root, 'origin.git');
    git(root, ['init', '--bare', originPath]);
    git(projectPath, ['remote', 'add', 'origin', 'https://github.com/me/fork.git']);
    git(projectPath, ['remote', 'set-url', '--push', 'origin', originPath]);

    const projectId = projectsDb.createProjectPath(projectPath).project!.project_id;
    const workspace = await workspaceService.create({
      projectId,
      projectPath,
      branchName: 'feat/ship-pr',
    });
    await writeFile(path.join(workspace.root_path, 'change.txt'), 'work\n');
    git(workspace.root_path, ['add', 'change.txt']);
    git(workspace.root_path, ['commit', '-m', 'agent change']);

    const calls: string[][] = [];
    const service = createShipService({
      runCommand: async (command, args) => {
        calls.push([command, ...args]);
        return {
          code: 0,
          stdout: 'https://github.com/me/fork/pull/7\n',
          stderr: '',
          timedOut: false,
        };
      },
    });

    const pr = await service.createPullRequest(workspace.workspace_id);
    assert.equal(pr.url, 'https://github.com/me/fork/pull/7');
    assert.equal(pr.number, 7);

    // The branch really reached the remote — without this the PR API has no head.
    const remoteBranches = spawnSync('git', ['branch', '--list', 'feat/ship-pr'], {
      cwd: originPath,
      encoding: 'utf8',
    });
    assert.match(String(remoteBranches.stdout), /feat\/ship-pr/);

    // gh is pinned to origin; unpinned it would resolve to the upstream parent.
    const create = calls.find((call) => call[1] === 'pr' && call[2] === 'create');
    assert.ok(create, 'expected a gh pr create call');
    const repoFlag = create.indexOf('--repo');
    assert.notEqual(repoFlag, -1, 'gh pr create must pass --repo');
    assert.equal(create[repoFlag + 1], 'me/fork');

    await workspaceService.discard(workspace.workspace_id, { deleteBranch: true });
  });
});

test('ship test runner honors project config and opens a child fix run', async () => {
  await withDatabase(async (root) => {
    const projectPath = path.join(root, 'project');
    await mkdir(path.join(projectPath, '.cloudcli'), { recursive: true });
    git(projectPath, ['init', '-b', 'main']);
    git(projectPath, ['config', 'user.email', 'ship@example.com']);
    git(projectPath, ['config', 'user.name', 'Ship Test']);
    await writeFile(path.join(projectPath, 'README.md'), 'ship\n');
    await writeFile(path.join(projectPath, '.cloudcli', 'ship.yaml'), 'test:\n  command: "printf ship-ok"\n  cwd: "."\n');
    git(projectPath, ['add', '.']);
    git(projectPath, ['commit', '-m', 'initial']);
    const projectId = projectsDb.createProjectPath(projectPath).project!.project_id;
    const parent = runService.create({ source: 'kanban', projectId, provider: 'claude', title: 'Implement feature' });
    const workspace = await workspaceService.create({ projectId, projectPath, runId: parent.run_id, branchName: 'feat/ship-test' });

    const report = await shipService.runTests(workspace.workspace_id);
    assert.equal(report.passed, true);
    assert.match(report.stdout, /ship-ok/);
    assert.equal(parseShipConfig('{"test":{"command":"npm test"}}').test?.command, 'npm test');

    const child = shipService.openFixRun({ parentRunId: parent.run_id, failureSummary: 'lint failed' });
    assert.equal(child.parent_run_id, parent.run_id);
    assert.equal(child.source, 'ship');
    assert.equal(child.trigger, 'fix_ci');
    await workspaceService.discard(workspace.workspace_id, { deleteBranch: true });
  });
});
