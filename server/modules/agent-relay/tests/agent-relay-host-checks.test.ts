import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';

import {
  closeConnection,
  getConnection,
  initializeDatabase,
  projectsDb,
} from '@/modules/database/index.js';
import {
  createRelayHostCheckService,
} from '@/modules/agent-relay/relay-host-check.service.js';
import { createWorkspaceService } from '@/modules/workspaces/index.js';
import { CloudError } from '@/shared/run-events.js';

const TEST_ROOT = path.resolve('tmp/cloudcli');
await mkdir(TEST_ROOT, { recursive: true });

function git(cwd: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return {
    status: result.status,
    stdout: String(result.stdout ?? '').trim(),
    stderr: String(result.stderr ?? '').trim(),
  };
}

async function initRepository(root: string): Promise<void> {
  assert.equal(git(root, ['init', '-b', 'main']).status, 0);
  assert.equal(git(root, ['config', 'user.email', 'host-check@example.com']).status, 0);
  assert.equal(git(root, ['config', 'user.name', 'Host Check']).status, 0);
  await writeFile(path.join(root, 'README.md'), 'host checks\n');
  assert.equal(git(root, ['add', '.']).status, 0);
  assert.equal(git(root, ['commit', '-m', 'initial']).status, 0);
}

async function withWorkspace(
  callback: (input: { root: string; taskRoot: string; workspaceId: string; service: ReturnType<typeof createRelayHostCheckService> }) => Promise<void>,
  options: { packageJson?: string } = {},
): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const taskRoot = await mkdtemp(path.join(TEST_ROOT, 'host-check-test-'));
  const projectRoot = path.join(taskRoot, 'project');
  await mkdir(projectRoot, { recursive: true });
  await initRepository(projectRoot);
  if (options.packageJson) await writeFile(path.join(projectRoot, 'package.json'), options.packageJson);

  closeConnection();
  process.env.DATABASE_PATH = path.join(taskRoot, 'auth.db');
  await initializeDatabase();
  getConnection().pragma('foreign_keys = ON');
  try {
    const projectId = projectsDb.createProjectPath(projectRoot).project!.project_id;
    const workspaces = createWorkspaceService({ tmpRoot: path.join(taskRoot, 'tmp') });
    const workspace = await workspaces.create({
      projectId,
      projectPath: projectRoot,
      branchName: 'feat/host-checks',
      taskId: 'host-checks',
    });
    const service = createRelayHostCheckService({ workspaceService: workspaces });
    try {
      await callback({ root: projectRoot, taskRoot, workspaceId: workspace.workspace_id, service });
    } finally {
      await workspaces.discard(workspace.workspace_id, { deleteBranch: true });
    }
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(taskRoot, { recursive: true, force: true });
  }
}

test('runs argv checks in the isolated workspace and reports the tested commit and failures', async () => {
  await withWorkspace(async ({ service, workspaceId }) => {
    const result = await service.runRelayHostChecks({
      workspaceId,
      commands: ['git diff --check', 'git rev-parse --verify missing-host-check-ref'],
    });

    assert.equal(result.evidence.length, 2);
    assert.equal(result.evidence[0].passed, true);
    assert.equal(result.evidence[0].exitCode, 0);
    assert.equal(result.evidence[1].passed, false);
    assert.notEqual(result.evidence[1].exitCode, 0);
    assert.match(result.testedCommit ?? '', /^[0-9a-f]{40}$/);
    assert.equal(result.evidence[0].testedCommit, result.testedCommit);
    assert.match(result.evidence[0].cwd, /host-check-test/);
    assert.equal(result.passed, false);
  });
});

test('rejects shell composition, installs, network, and destructive commands without spawning them', async () => {
  await withWorkspace(async ({ service, workspaceId }) => {
    const result = await service.runRelayHostChecks({
      workspaceId,
      commands: [
        'echo safe && echo shell',
        'npm install',
        'curl https://example.com',
        'rm -rf .',
        'sh -c echo shell',
      ],
    });

    assert.equal(result.passed, false);
    assert.equal(result.evidence.length, 5);
    for (const evidence of result.evidence) {
      assert.equal(evidence.exitCode, null);
      assert.equal(evidence.output, '');
      assert.match(evidence.reason ?? '', /not allowed|rejected|unsafe|destructive|network|install/i);
    }
  });
});

test('kills timed out checks, caps and redacts output, and reports missing executables', async () => {
  await withWorkspace(async ({ service, workspaceId, taskRoot }) => {
    const timeout = await service.runRelayHostChecks({ workspaceId, commands: ['sleep 5'], timeoutMs: 100 });
    assert.equal(timeout.evidence[0].timedOut, true);
    assert.equal(timeout.evidence[0].passed, false);

    // The workspace root is surfaced by the evidence cwd; write test data there.
    await writeFile(path.join(timeout.evidence[0].cwd, 'secret-output.txt'), `ghp_secret_token_1234567890\n${'x'.repeat(40_000)}`);
    const capped = await service.runRelayHostChecks({ workspaceId, commands: ['cat secret-output.txt'] });
    assert.equal(capped.evidence[0].capped, true);
    assert.equal(capped.evidence[0].passed, false);
    assert.ok(capped.evidence[0].output.length <= 30_000);
    assert.doesNotMatch(capped.evidence[0].output, /ghp_secret_token_1234567890/);
    assert.match(capped.evidence[0].output, /\*\*\*REDACTED\*\*\*/);

    const previousPath = process.env.PATH;
    process.env.PATH = path.join(taskRoot, 'empty-bin');
    try {
      const missing = await service.runRelayHostChecks({ workspaceId, commands: ['eslint --version'] });
      assert.equal(missing.evidence[0].passed, false);
      assert.equal(missing.evidence[0].reason, 'executable_not_found');
      assert.equal(missing.evidence[0].exitCode, null);
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  });
});

test('rejects a configured cwd that escapes the canonical workspace path', async () => {
  await withWorkspace(async ({ service, workspaceId }) => {
    const first = await service.runRelayHostChecks({ workspaceId, commands: ['pwd'] });
    await mkdir(path.join(first.evidence[0].cwd, '.cloudcli'), { recursive: true });
    await writeFile(path.join(first.evidence[0].cwd, '.cloudcli', 'ship.yaml'), 'test:\n  command: pwd\n  cwd: ../\n');

    await assert.rejects(
      service.runRelayHostChecks({ workspaceId }),
      (error: unknown) => error instanceof CloudError && /inside the isolated workspace/.test(error.message),
    );
  });
});

test('reports unavailable test configuration as not passed', async () => {
  await withWorkspace(async ({ service, workspaceId }) => {
    const result = await service.runRelayHostChecks({ workspaceId });
    assert.equal(result.unavailable, true);
    assert.equal(result.passed, false);
    assert.deepEqual(result.evidence, []);
  });
});
