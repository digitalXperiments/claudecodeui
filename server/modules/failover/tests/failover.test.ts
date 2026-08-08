import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { makeScratchDir } from '@/shared/scratch.js';
import { closeConnection, initializeDatabase, projectsDb } from '@/modules/database/index.js';
import { failoverService } from '@/modules/failover/failover.service.js';
import { runService } from '@/modules/runs/index.js';
import { CloudError } from '@/shared/run-events.js';

async function withDatabase(callback: (root: string) => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const root = await makeScratchDir('failover-');
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

test('auth failure starts a bounded child failover run and prevents loops', async () => {
  await withDatabase(async (root) => {
    const projectPath = path.join(root, 'project');
    await mkdir(projectPath, { recursive: true });
    const projectId = projectsDb.createProjectPath(projectPath).project!.project_id;
    const playbook = failoverService.create({
      name: 'Claude auth fallback',
      projectId,
      match: { providers: ['claude'], errors: ['auth'] },
      strategy: {
        candidates: [{ provider: 'codex' }, { provider: 'grok' }],
        handoffMode: 'fresh',
        maxFailovers: 1,
      },
      approval: 'auto',
    });
    const parent = runService.create({ source: 'chat', projectId, provider: 'claude', title: 'Continue checkout' });
    runService.markTerminal(parent.run_id, { status: 'failed', errorSummary: 'Claude authentication expired' });

    const result = await failoverService.trigger(parent.run_id, { playbookId: playbook.playbook_id });
    assert.equal(result.status, 'started');
    assert.ok(result.childRunId);
    const child = runService.get(result.childRunId!);
    assert.equal(child?.parent_run_id, parent.run_id);
    assert.equal(child?.trigger, 'failover');
    assert.equal(child?.provider, 'codex');

    runService.markTerminal(child!.run_id, { status: 'failed', errorSummary: 'Codex timed out' });
    await assert.rejects(
      failoverService.trigger(child!.run_id, { playbookId: playbook.playbook_id }),
      (error: unknown) => error instanceof CloudError && error.code === 'PLAYBOOK_NO_CANDIDATE',
    );
  });
});

test('interrupt approval creates an actionable queue item', async () => {
  await withDatabase(async (root) => {
    const projectPath = path.join(root, 'project');
    await mkdir(projectPath, { recursive: true });
    const projectId = projectsDb.createProjectPath(projectPath).project!.project_id;
    const playbook = failoverService.create({
      name: 'Review fallback',
      projectId,
      match: { errors: ['any'] },
      strategy: { candidates: [{ provider: 'codex' }], handoffMode: 'fresh', maxFailovers: 2 },
      approval: 'interrupt',
    });
    const parent = runService.create({ source: 'chat', projectId, provider: 'claude', title: 'Needs review' });
    runService.markTerminal(parent.run_id, { status: 'failed', errorSummary: 'provider failed' });
    const result = await failoverService.trigger(parent.run_id, { playbookId: playbook.playbook_id });
    assert.equal(result.status, 'approval_pending');
    assert.ok(result.interruptId);
  });
});
