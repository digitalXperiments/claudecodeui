import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, projectsDb } from '@/modules/database/index.js';
import { runService } from '@/modules/runs/index.js';
import { workspaceService } from '@/modules/workspaces/index.js';
import { parseShipConfig, shipService } from '@/modules/ship/index.js';

function git(cwd: string, args: string[]): void {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, `${args.join(' ')} failed: ${result.stderr}`);
}

async function withDatabase(callback: (root: string) => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const root = await mkdtemp(path.resolve('tmp/cloudcli/ship-'));
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
