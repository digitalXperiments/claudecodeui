import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, projectsDb } from '@/modules/database/index.js';
import { automationService } from '@/modules/automation/automation.service.js';
import { CloudError } from '@/shared/run-events.js';
import { runService } from '@/modules/runs/index.js';

async function withDatabase(callback: (root: string) => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const root = await mkdtemp(path.resolve('tmp/cloudcli/automation-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(root, 'auth.db');
  await initializeDatabase();
  try { await callback(root); }
  finally {
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(root, { recursive: true, force: true });
  }
}

test('manual recipe fires a canonical automation run and rejects same-event cycles', async () => {
  await withDatabase(async (root) => {
    const projectPath = path.join(root, 'project');
    await mkdir(projectPath, { recursive: true });
    const projectId = projectsDb.createProjectPath(projectPath).project!.project_id;
    const recipe = automationService.create({
      name: 'Start implementation',
      projectId,
      trigger: { type: 'manual' },
      conditions: [{ path: 'payload.ready', equals: true }],
      actions: [{ type: 'start_agent_run', provider: 'claude', title: 'Automated implementation' }],
    });
    const results = await automationService.fire({ type: 'manual', recipeId: recipe.recipe_id, projectId, payload: { ready: true } });
    assert.equal(results.length, 1);
    assert.equal(results[0].automationRun.status, 'succeeded');
    const startedRunId = results[0].actionResults[0].runId as string;
    assert.equal(runService.get(startedRunId)?.source, 'automation');

    assert.throws(() => automationService.create({
      name: 'Cycle',
      projectId,
      trigger: { type: 'kanban_event', event: 'task.done' },
      actions: [{ type: 'emit_event', event: 'task.done' }],
    }), (error: unknown) => error instanceof CloudError && error.code === 'AUTOMATION_CYCLE');
  });
});

test('workflow graph runs sequential action steps and records step_states', async () => {
  await withDatabase(async (root) => {
    const projectPath = path.join(root, 'project');
    await mkdir(projectPath, { recursive: true });
    const projectId = projectsDb.createProjectPath(projectPath).project!.project_id;
    const recipe = automationService.create({
      name: 'Graph sequential',
      projectId,
      trigger: { type: 'manual' },
      actions: [{ type: 'noop' }],
      graph: {
        version: 1,
        entry: 's1',
        steps: [
          {
            id: 's1',
            name: 'First',
            kind: 'action',
            action: { type: 'noop' },
            next: 's2',
          },
          {
            id: 's2',
            name: 'Second',
            kind: 'action',
            action: { type: 'notify', name: 'Done', message: 'ok' },
          },
        ],
      },
    });
    const results = await automationService.fire({
      type: 'manual',
      recipeId: recipe.recipe_id,
      projectId,
      payload: {},
    });
    assert.equal(results.length, 1);
    assert.equal(results[0].automationRun.status, 'succeeded');
    assert.equal(results[0].automationRun.step_states.s1?.status, 'succeeded');
    assert.equal(results[0].automationRun.step_states.s2?.status, 'succeeded');
    assert.ok(results[0].actionResults.length >= 2);
  });
});

test('workflow graph runs parallel children and rejects cycles', async () => {
  await withDatabase(async (root) => {
    const projectPath = path.join(root, 'project');
    await mkdir(projectPath, { recursive: true });
    const projectId = projectsDb.createProjectPath(projectPath).project!.project_id;
    const recipe = automationService.create({
      name: 'Graph parallel',
      projectId,
      trigger: { type: 'manual' },
      graph: {
        version: 1,
        entry: 'p1',
        steps: [
          {
            id: 'p1',
            name: 'Fan-out',
            kind: 'parallel',
            parallel: ['a', 'b'],
          },
          { id: 'a', name: 'A', kind: 'action', action: { type: 'noop' } },
          { id: 'b', name: 'B', kind: 'action', action: { type: 'noop' } },
        ],
      },
    });
    const results = await automationService.fire({
      type: 'manual',
      recipeId: recipe.recipe_id,
      projectId,
    });
    assert.equal(results[0].automationRun.step_states.a?.status, 'succeeded');
    assert.equal(results[0].automationRun.step_states.b?.status, 'succeeded');
    assert.equal(results[0].automationRun.step_states.p1?.status, 'succeeded');

    assert.throws(
      () =>
        automationService.create({
          name: 'Cyclic graph',
          projectId,
          trigger: { type: 'manual' },
          graph: {
            version: 1,
            entry: 'x',
            steps: [
              { id: 'x', name: 'X', kind: 'action', action: { type: 'noop' }, next: 'y' },
              { id: 'y', name: 'Y', kind: 'action', action: { type: 'noop' }, next: 'x' },
            ],
          },
        }),
      (error: unknown) => error instanceof CloudError && error.code === 'AUTOMATION_CYCLE',
    );
  });
});

test('automation retries a failed webhook action and records the final attempt', async () => {
  await withDatabase(async (root) => {
    const projectPath = path.join(root, 'project');
    await mkdir(projectPath, { recursive: true });
    const projectId = projectsDb.createProjectPath(projectPath).project!.project_id;
    let attempts = 0;
    const server = createServer((_request, response) => {
      attempts += 1;
      response.statusCode = attempts === 1 ? 500 : 204;
      response.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      assert.ok(address && typeof address === 'object');
      const recipe = automationService.create({
        name: 'Retry outbound webhook',
        projectId,
        trigger: { type: 'manual' },
        actions: [{ type: 'http_webhook_out', url: `http://127.0.0.1:${address.port}/hook`, body: { value: '{{payload.value}}' } }],
        retry: { max: 1, backoffMs: 1 },
      });
      const results = await automationService.fire({ type: 'manual', recipeId: recipe.recipe_id, payload: { value: 'ok' } });
      assert.equal(results.length, 1);
      assert.equal(attempts, 2);
      assert.equal(results[0].automationRun.attempt, 2);
      assert.equal(results[0].automationRun.status, 'succeeded');
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
