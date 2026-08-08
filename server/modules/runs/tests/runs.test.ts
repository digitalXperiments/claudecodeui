/**
 * Tests for the canonical run spine (PRD §6.9).
 *
 * Uses a temp SQLite database per test, following the pattern from
 * server/modules/database/tests/agent-run-profiles.test.ts.
 */

import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import type { AddressInfo } from 'node:net';

import express from 'express';

import { makeScratchDir } from '@/shared/scratch.js';
import { closeConnection, initializeDatabase } from '@/modules/database/index.js';
import { redactPayload, runService } from '@/modules/runs/runs.service.js';
import runsRoutes from '@/modules/runs/runs.routes.js';
import { ORPHAN_ERROR_SUMMARY } from '@/modules/runs/runs.types.js';
import { CloudError } from '@/shared/run-events.js';

type TempDb = { directory: string; restore: () => Promise<void> };

async function useTempDatabase(): Promise<TempDb> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const directory = await makeScratchDir('runs-');
  closeConnection();
  process.env.DATABASE_PATH = path.join(directory, 'auth.db');
  await initializeDatabase();
  return {
    directory,
    restore: async () => {
      closeConnection();
      if (previousDatabasePath === undefined) {
        delete process.env.DATABASE_PATH;
      } else {
        process.env.DATABASE_PATH = previousDatabasePath;
      }
      await rm(directory, { recursive: true, force: true });
    },
  };
}

async function withRoutes(
  fn: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use('/api/runs', runsRoutes);
  // Mirror the shape of the orchestrator's error middleware (server/index.js).
  app.use(
    (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      const anyErr = err as { statusCode?: number; code?: string; message?: string };
      res.status(anyErr.statusCode ?? 500).json({
        success: false,
        error: { code: anyErr.code ?? 'INTERNAL_ERROR', message: anyErr.message },
      });
    },
  );
  const server = await new Promise<ReturnType<express.Express['listen']>>((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  try {
    const { port } = server.address() as AddressInfo;
    await fn(`http://127.0.0.1:${port}/api/runs`);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

test('create/get/list runs with filters and cursor pagination', async () => {
  const db = await useTempDatabase();
  try {
    const first = runService.create({
      source: 'chat',
      projectId: 'proj-a',
      title: 'First',
      provider: 'claude',
      model: 'opus',
    });
    const second = runService.create({ source: 'kanban', projectId: 'proj-a', title: 'Second' });
    const third = runService.create({ source: 'webhook', projectId: 'proj-b', title: 'Third' });
    runService.updateStatus(second.run_id, 'running');
    runService.markTerminal(third.run_id, { status: 'failed', errorSummary: 'boom' });

    const fetched = runService.get(first.run_id);
    assert.equal(fetched?.title, 'First');
    assert.equal(fetched?.status, 'queued');
    assert.equal(fetched?.provider, 'claude');
    assert.equal(runService.get('run_missing'), null);

    // List all, newest first.
    const all = runService.list({});
    assert.equal(all.runs.length, 3);
    assert.equal(all.runs[0].run_id, third.run_id);
    assert.equal(all.nextCursor, undefined);

    // Filter by projectId / status / source.
    const byProject = runService.list({ projectId: 'proj-a' });
    assert.deepEqual(
      byProject.runs.map((r) => r.run_id).sort(),
      [first.run_id, second.run_id].sort(),
    );
    const byStatus = runService.list({ status: 'failed' });
    assert.deepEqual(byStatus.runs.map((r) => r.run_id), [third.run_id]);
    const byMultiStatus = runService.list({ status: ['queued', 'running'] });
    assert.equal(byMultiStatus.runs.length, 2);
    const bySource = runService.list({ source: 'webhook' });
    assert.deepEqual(bySource.runs.map((r) => r.run_id), [third.run_id]);

    // from/to bounds: fixed windows avoid relying on inter-row clock ties.
    assert.equal(runService.list({ to: '2000-01-01T00:00:00.000Z' }).runs.length, 0);
    assert.equal(runService.list({ from: '2999-01-01T00:00:00.000Z' }).runs.length, 0);
    assert.equal(
      runService.list({ from: '2000-01-01T00:00:00.000Z', to: '2999-01-01T00:00:00.000Z' }).runs
        .length,
      3,
    );

    // Cursor pagination: page size 2 over 3 rows yields a second page of 1.
    const page1 = runService.list({ limit: 2 });
    assert.equal(page1.runs.length, 2);
    assert.ok(page1.nextCursor, 'expected nextCursor for full page');
    const page2 = runService.list({ limit: 2, cursor: page1.nextCursor });
    assert.equal(page2.runs.length, 1);
    assert.equal(page2.nextCursor, undefined);
    const seen = new Set([...page1.runs, ...page2.runs].map((r) => r.run_id));
    assert.equal(seen.size, 3, 'pages must not overlap');
  } finally {
    await db.restore();
  }
});

test('event seq is monotonic per run and listEvents honours afterSeq/limit', async () => {
  const db = await useTempDatabase();
  try {
    const run = runService.create({ source: 'chat', projectId: 'proj-a' });
    // create() itself emits run.queued as seq 1.
    const events = [
      runService.appendEvent(run.run_id, {
        run_id: run.run_id,
        ts: new Date().toISOString(),
        source: 'chat',
        type: 'run.started',
        payload: {},
      }),
      runService.appendEvent(run.run_id, {
        run_id: run.run_id,
        ts: new Date().toISOString(),
        source: 'chat',
        type: 'tool.call',
        payload: { tool: 'Bash' },
      }),
    ];
    assert.equal(events[0].seq, 2);
    assert.equal(events[1].seq, 3);
    assert.ok(events[0].event_id.startsWith('evt_'));

    const all = runService.listEvents(run.run_id);
    assert.deepEqual(all.map((e) => e.seq), [1, 2, 3]);
    assert.equal(all[0].type, 'run.queued');

    const after = runService.listEvents(run.run_id, { afterSeq: 1 });
    assert.deepEqual(after.map((e) => e.seq), [2, 3]);
    const limited = runService.listEvents(run.run_id, { afterSeq: 0, limit: 1 });
    assert.deepEqual(limited.map((e) => e.seq), [1]);
  } finally {
    await db.restore();
  }
});

test('abort route: happy path aborts, terminal run returns RUN_ALREADY_TERMINAL', async () => {
  const db = await useTempDatabase();
  try {
    const run = runService.create({ source: 'chat', projectId: 'proj-a' });
    runService.updateStatus(run.run_id, 'running');

    await withRoutes(async (baseUrl) => {
      const abortRes = await fetch(`${baseUrl}/${run.run_id}/abort`, { method: 'POST' });
      assert.equal(abortRes.status, 200);
      const abortBody = (await abortRes.json()) as {
        success: boolean;
        run: { status: string; finished_at: string | null };
      };
      assert.equal(abortBody.success, true);
      assert.equal(abortBody.run.status, 'aborted');
      assert.ok(abortBody.run.finished_at, 'finished_at should be stamped');

      // Second abort must fail with 409 RUN_ALREADY_TERMINAL.
      const againRes = await fetch(`${baseUrl}/${run.run_id}/abort`, { method: 'POST' });
      assert.equal(againRes.status, 409);
      const againBody = (await againRes.json()) as { error: { code: string } };
      assert.equal(againBody.error.code, 'RUN_ALREADY_TERMINAL');

      // Unknown run → 404 RUN_NOT_FOUND.
      const missingRes = await fetch(`${baseUrl}/run_missing/abort`, { method: 'POST' });
      assert.equal(missingRes.status, 404);

      // The abort produced a terminal event on the timeline.
      const eventsRes = await fetch(`${baseUrl}/${run.run_id}/events`);
      const eventsBody = (await eventsRes.json()) as {
        events: { type: string; seq: number }[];
      };
      assert.equal(eventsBody.events.at(-1)?.type, 'run.aborted');
    });

    // Service-level guard matches the route behaviour.
    assert.throws(
      () => runService.markTerminal(run.run_id, { status: 'failed' }),
      (error: unknown) => error instanceof CloudError && error.code === 'RUN_ALREADY_TERMINAL',
    );
  } finally {
    await db.restore();
  }
});

test('redaction strips secrets recursively and caps strings at 4KB', async () => {
  const db = await useTempDatabase();
  try {
    // Pure function behaviour.
    const redacted = redactPayload({
      headers: { Authorization: 'Bearer abc', 'x-ok': 'fine' },
      TOKEN: 'abc',
      nested: [{ password: 'hunter2', keep: 'yes' }],
      api_key: 'k',
      Secret: 's',
      list: ['ok'],
    }) as Record<string, unknown>;
    const headers = redacted.headers as Record<string, unknown>;
    assert.equal(headers.Authorization, undefined);
    assert.equal(headers['x-ok'], 'fine');
    assert.equal(redacted.TOKEN, undefined);
    assert.equal(redacted.api_key, undefined);
    assert.equal(redacted.Secret, undefined);
    const nested = redacted.nested as Record<string, unknown>[];
    assert.equal(nested[0].password, undefined);
    assert.equal(nested[0].keep, 'yes');

    // Persisted event payloads go through redaction.
    const run = runService.create({ source: 'chat' });
    runService.appendEvent(run.run_id, {
      run_id: run.run_id,
      ts: new Date().toISOString(),
      source: 'chat',
      type: 'tool.call',
      payload: {
        tool: 'WebFetch',
        headers: { Authorization: 'Bearer super-secret', Accept: 'application/json' },
      },
    });
    const stored = runService.listEvents(run.run_id).at(-1);
    const storedHeaders = stored?.payload.headers as Record<string, unknown>;
    assert.equal(storedHeaders.Authorization, undefined, 'Authorization must be stripped');
    assert.equal(storedHeaders.Accept, 'application/json');

    // Large payload capping: strings over 4KB are truncated to 4096 chars.
    const big = 'x'.repeat(8192);
    runService.appendEvent(run.run_id, {
      run_id: run.run_id,
      ts: new Date().toISOString(),
      source: 'chat',
      type: 'tool.result',
      payload: { output: big, note: 'small' },
    });
    const capped = runService.listEvents(run.run_id).at(-1);
    assert.equal((capped?.payload.output as string).length, 4096);
    assert.equal(capped?.payload.note, 'small');
  } finally {
    await db.restore();
  }
});

test('reconcileOrphans marks in-flight runs failed on boot', async () => {
  const db = await useTempDatabase();
  try {
    const queued = runService.create({ source: 'chat' });
    const starting = runService.create({ source: 'chat', status: 'starting' });
    const running = runService.create({ source: 'kanban' });
    runService.updateStatus(running.run_id, 'running');
    const done = runService.create({ source: 'chat' });
    runService.markTerminal(done.run_id, { status: 'succeeded' });

    const reconciled = runService.reconcileOrphans();
    assert.equal(reconciled, 3);

    for (const orphan of [queued, starting, running]) {
      const run = runService.get(orphan.run_id);
      assert.equal(run?.status, 'failed');
      assert.equal(run?.error_summary, ORPHAN_ERROR_SUMMARY);
      assert.ok(run?.finished_at, 'finished_at should be stamped');
    }
    assert.equal(runService.get(done.run_id)?.status, 'succeeded');

    // Idempotent: nothing left to reconcile.
    assert.equal(runService.reconcileOrphans(), 0);
  } finally {
    await db.restore();
  }
});

test('runsDb.attachUsage + linkSession/linkWorkspace update the run row', async () => {
  const db = await useTempDatabase();
  try {
    const run = runService.create({ source: 'chat' });
    runService.attachUsage(run.run_id, { input: 10, output: 5, total: 15, costUsdEstimate: 0.01 });
    runService.attachUsage(run.run_id, { input: 20, output: 10, total: 30 });
    runService.linkSession(run.run_id, 'session-1');
    runService.linkWorkspace(run.run_id, 'ws_01TEST');

    const updated = runService.get(run.run_id);
    assert.equal(updated?.token_input, 20);
    assert.equal(updated?.token_output, 10);
    assert.equal(updated?.token_total, 30);
    assert.equal(updated?.cost_usd_estimate, 0.01);
    assert.equal(updated?.app_session_id, 'session-1');
    assert.equal(updated?.workspace_id, 'ws_01TEST');

    const events = runService.listEvents(run.run_id);
    assert.ok(events.some((e) => e.type === 'token.usage'));
    assert.ok(events.some((e) => e.type === 'workspace.bound'));
  } finally {
    await db.restore();
  }
});

test('list summaries include effort, tokens, cost, duration, tool counts', async () => {
  const db = await useTempDatabase();
  try {
    const run = runService.create({
      source: 'chat',
      projectId: 'proj-sum',
      title: 'Summary run',
      provider: 'claude',
      model: 'opus',
      effort: 'high',
      rootRunId: 'run_root',
    });
    runService.updateStatus(run.run_id, 'running');
    runService.attachUsage(run.run_id, {
      input: 100,
      output: 50,
      total: 150,
      costUsdEstimate: 0.25,
    });
    runService.appendEvent(run.run_id, {
      run_id: run.run_id,
      ts: new Date().toISOString(),
      source: 'chat',
      type: 'tool.call',
      payload: { tool: 'Bash' },
    });
    runService.appendEvent(run.run_id, {
      run_id: run.run_id,
      ts: new Date().toISOString(),
      source: 'chat',
      type: 'tool.call',
      payload: { tool: 'Read' },
    });
    runService.markTerminal(run.run_id, { status: 'succeeded' });

    const listed = runService.list({ projectId: 'proj-sum' });
    assert.equal(listed.runs.length, 1);
    const summary = listed.runs[0];
    assert.equal(summary.effort, 'high');
    assert.equal(summary.token_input, 100);
    assert.equal(summary.token_output, 50);
    assert.equal(summary.token_total, 150);
    assert.equal(summary.cost_usd_estimate, 0.25);
    assert.equal(summary.root_run_id, 'run_root');
    assert.equal(summary.tool_call_count, 2);
    assert.ok(typeof summary.duration_ms === 'number' && summary.duration_ms >= 0);
    assert.equal(summary.is_stuck, false);
    assert.equal(summary.status, 'succeeded');
  } finally {
    await db.restore();
  }
});

test('project stats and budget get/put via service and HTTP', async () => {
  const db = await useTempDatabase();
  try {
    const projectId = 'proj-stats';

    const defaultBudget = runService.getBudget(projectId);
    assert.equal(defaultBudget.project_id, projectId);
    assert.equal(defaultBudget.stuck_minutes, 15);
    assert.equal(defaultBudget.monthly_token_budget, null);

    const saved = runService.putBudget({
      projectId,
      monthlyTokenBudget: 1_000_000,
      monthlyCostUsdBudget: 50,
      stuckMinutes: 20,
    });
    assert.equal(saved.monthly_token_budget, 1_000_000);
    assert.equal(saved.monthly_cost_usd_budget, 50);
    assert.equal(saved.stuck_minutes, 20);
    assert.equal(runService.getBudget(projectId).stuck_minutes, 20);

    const active = runService.create({
      source: 'chat',
      projectId,
      title: 'Active',
      provider: 'claude',
    });
    runService.updateStatus(active.run_id, 'running');
    runService.attachUsage(active.run_id, { total: 500, costUsdEstimate: 1.5 });

    const done = runService.create({ source: 'kanban', projectId, title: 'Done' });
    runService.attachUsage(done.run_id, { total: 200, costUsdEstimate: 0.5 });
    runService.markTerminal(done.run_id, { status: 'succeeded' });

    const other = runService.create({ source: 'chat', projectId: 'other', title: 'Other' });
    runService.attachUsage(other.run_id, { total: 9999, costUsdEstimate: 99 });

    const stats = runService.projectStats(projectId);
    assert.equal(stats.total, 2);
    assert.equal(stats.activeCount, 1);
    assert.equal(stats.byStatus.running, 1);
    assert.equal(stats.byStatus.succeeded, 1);
    assert.equal(stats.tokensMonth, 700);
    assert.equal(stats.costMonth, 2);
    assert.ok(typeof stats.stuckCount === 'number');
    assert.ok(stats.avgDurationMs == null || typeof stats.avgDurationMs === 'number');

    await withRoutes(async (baseUrl) => {
      const statsRes = await fetch(`${baseUrl}/stats?projectId=${encodeURIComponent(projectId)}`);
      assert.equal(statsRes.status, 200);
      const statsBody = (await statsRes.json()) as {
        success: boolean;
        stats: { total: number; tokensMonth: number; costMonth: number; activeCount: number };
      };
      assert.equal(statsBody.success, true);
      assert.equal(statsBody.stats.total, 2);
      assert.equal(statsBody.stats.tokensMonth, 700);
      assert.equal(statsBody.stats.costMonth, 2);
      assert.equal(statsBody.stats.activeCount, 1);

      const budgetGet = await fetch(`${baseUrl}/budget?projectId=${encodeURIComponent(projectId)}`);
      assert.equal(budgetGet.status, 200);
      const budgetGetBody = (await budgetGet.json()) as {
        budget: { stuck_minutes: number; monthly_token_budget: number };
      };
      assert.equal(budgetGetBody.budget.stuck_minutes, 20);
      assert.equal(budgetGetBody.budget.monthly_token_budget, 1_000_000);

      const budgetPut = await fetch(`${baseUrl}/budget`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId,
          monthlyTokenBudget: 2_000_000,
          monthlyCostUsdBudget: 75,
          stuckMinutes: 30,
        }),
      });
      assert.equal(budgetPut.status, 200);
      const budgetPutBody = (await budgetPut.json()) as {
        budget: {
          stuck_minutes: number;
          monthly_token_budget: number;
          monthly_cost_usd_budget: number;
        };
      };
      assert.equal(budgetPutBody.budget.stuck_minutes, 30);
      assert.equal(budgetPutBody.budget.monthly_token_budget, 2_000_000);
      assert.equal(budgetPutBody.budget.monthly_cost_usd_budget, 75);

      const missingStats = await fetch(`${baseUrl}/stats`);
      assert.equal(missingStats.status, 400);
    });
  } finally {
    await db.restore();
  }
});

test('is_stuck is true for in-flight runs past stuck_minutes', async () => {
  const db = await useTempDatabase();
  try {
    const projectId = 'proj-stuck';
    runService.putBudget({ projectId, stuckMinutes: 15 });

    const run = runService.create({ source: 'chat', projectId, title: 'Stale' });
    runService.updateStatus(run.run_id, 'running');

    const { getConnection } = await import('@/modules/database/index.js');
    const conn = getConnection();
    const old = new Date(Date.now() - 20 * 60_000).toISOString();
    conn
      .prepare(
        `UPDATE agent_runs SET started_at = ?, created_at = ?, updated_at = ? WHERE run_id = ?`,
      )
      .run(old, old, old, run.run_id);
    conn.prepare(`UPDATE agent_run_events SET ts = ? WHERE run_id = ?`).run(old, run.run_id);

    const listed = runService.list({ projectId });
    assert.equal(listed.runs.length, 1);
    assert.equal(listed.runs[0].is_stuck, true);

    const stats = runService.projectStats(projectId);
    assert.equal(stats.stuckCount, 1);
  } finally {
    await db.restore();
  }
});
