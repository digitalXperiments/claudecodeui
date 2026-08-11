/**
 * Tests for the global usage-stats aggregation (Stats dashboard).
 *
 * Uses a temp SQLite database per test, following the pattern from
 * server/modules/runs/tests/runs.test.ts. Timestamps are patched directly so
 * durations, day buckets, and hour histograms are deterministic.
 */

import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import type { AddressInfo } from 'node:net';

import express from 'express';

import { makeScratchDir } from '@/shared/scratch.js';
import { closeConnection, getConnection, initializeDatabase } from '@/modules/database/index.js';
import { runService } from '@/modules/runs/runs.service.js';
import runsRoutes from '@/modules/runs/runs.routes.js';
import type { GlobalRunStats } from '@/modules/runs/runs.types.js';

type TempDb = { directory: string; restore: () => Promise<void> };

async function useTempDatabase(): Promise<TempDb> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const directory = await makeScratchDir('runs-global-stats-');
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

async function withRoutes(fn: (baseUrl: string) => Promise<void>): Promise<void> {
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

type SeedRunOptions = {
  source?: string;
  provider?: string | null;
  model?: string | null;
  status?: 'succeeded' | 'failed' | 'aborted';
  appSessionId?: string;
  tokens?: { input?: number; output?: number; total?: number; costUsd?: number };
  /** ISO timestamps patched onto the row for deterministic aggregation. */
  createdAt?: string;
  startedAt?: string;
  finishedAt?: string;
};

function seedRun(options: SeedRunOptions): string {
  const run = runService.create({
    source: options.source ?? 'chat',
    provider: options.provider ?? undefined,
    model: options.model ?? undefined,
    appSessionId: options.appSessionId ?? undefined,
  });
  if (options.tokens) {
    runService.attachUsage(run.run_id, {
      input: options.tokens.input ?? null,
      output: options.tokens.output ?? null,
      total: options.tokens.total ?? null,
      costUsdEstimate: options.tokens.costUsd ?? null,
    });
  }
  if (options.status) {
    runService.markTerminal(run.run_id, { status: options.status });
  }
  if (options.createdAt || options.startedAt || options.finishedAt) {
    const db = getConnection();
    db.prepare(
      `UPDATE agent_runs SET
        created_at = COALESCE(?, created_at),
        started_at = COALESCE(?, started_at),
        finished_at = COALESCE(?, finished_at)
      WHERE run_id = ?`,
    ).run(
      options.createdAt ?? null,
      options.startedAt ?? null,
      options.finishedAt ?? null,
      run.run_id,
    );
  }
  return run.run_id;
}

function seedSession(sessionId: string, provider: string, createdAt: string): void {
  const db = getConnection();
  db.prepare(`INSERT INTO sessions (session_id, provider, created_at, updated_at) VALUES (?, ?, ?, ?)`).run(
    sessionId,
    provider,
    createdAt,
    createdAt,
  );
}

test('globalStats aggregates tokens, cost, durations, conversations, and breakdowns', async () => {
  const db = await useTempDatabase();
  try {
    // Day 1 (2026-07-01): two claude runs on the same conversation.
    seedRun({
      provider: 'claude',
      model: 'opus',
      status: 'succeeded',
      appSessionId: 'session-a',
      tokens: { input: 100, output: 50, total: 150, costUsd: 0.25 },
      createdAt: '2026-07-01T10:00:00.000Z',
      startedAt: '2026-07-01T10:00:00.000Z',
      finishedAt: '2026-07-01T10:01:00.000Z', // 60s
    });
    seedRun({
      provider: 'claude',
      model: 'opus',
      status: 'failed',
      appSessionId: 'session-a',
      tokens: { input: 200, output: 100, total: 300, costUsd: 0.5 },
      createdAt: '2026-07-01T14:30:00.000Z',
      startedAt: '2026-07-01T14:30:00.000Z',
      finishedAt: '2026-07-01T14:32:00.000Z', // 120s
    });
    // Day 2 (2026-07-02): one grok run on another conversation, no cost.
    seedRun({
      source: 'kanban',
      provider: 'grok',
      model: 'grok-code',
      status: 'succeeded',
      appSessionId: 'session-b',
      tokens: { input: 400, output: 150, total: 550 },
      createdAt: '2026-07-02T09:00:00.000Z',
      startedAt: '2026-07-02T09:00:00.000Z',
      finishedAt: '2026-07-02T09:00:30.000Z', // 30s
    });
    // Run without provider/model attribution and without token data.
    seedRun({
      source: 'webhook',
      status: 'aborted',
      createdAt: '2026-07-02T12:00:00.000Z',
      startedAt: '2026-07-02T12:00:00.000Z',
      finishedAt: '2026-07-02T12:00:10.000Z', // 10s
    });

    seedSession('session-a', 'claude', '2026-07-01T08:00:00.000Z');
    seedSession('session-b', 'grok', '2026-07-02T08:00:00.000Z');
    seedSession('session-c', 'grok', '2026-07-05T08:00:00.000Z');

    const stats = runService.globalStats({});

    // Overview.
    assert.equal(stats.overview.totalRuns, 4);
    assert.equal(stats.overview.runsWithTokens, 3);
    assert.equal(stats.overview.totalTokens, 1000);
    assert.equal(stats.overview.inputTokens, 700);
    assert.equal(stats.overview.outputTokens, 300);
    assert.equal(stats.overview.totalCostUsd, 0.75);
    assert.equal(stats.overview.runsWithCost, 2);
    assert.equal(stats.overview.totalDurationMs, 220_000);
    assert.equal(stats.overview.avgDurationMs, 55_000);
    assert.equal(stats.overview.conversationCount, 3);
    assert.equal(stats.overview.activeConversations, 2);
    assert.equal(stats.overview.avgTokensPerConversation, 500);
    assert.equal(stats.overview.avgTokensPerRun, 250);
    // succeeded 2 of 4 terminal runs.
    assert.equal(stats.overview.successRate, 0.5);

    // Status rollup.
    const byStatus = Object.fromEntries(stats.byStatus.map((row) => [row.status, row.count]));
    assert.deepEqual(byStatus, { succeeded: 2, failed: 1, aborted: 1 });

    // Daily buckets: runs on 07-01/07-02, plus a conversations-only day 07-05.
    assert.deepEqual(
      stats.daily.map((day) => day.day),
      ['2026-07-01', '2026-07-02', '2026-07-05'],
    );
    const day1 = stats.daily[0];
    assert.equal(day1.tokens, 450);
    assert.equal(day1.runs, 2);
    assert.equal(day1.costUsd, 0.75);
    assert.equal(day1.durationMs, 180_000);
    assert.equal(day1.conversations, 1);
    const day3 = stats.daily[2];
    assert.equal(day3.runs, 0);
    assert.equal(day3.conversations, 1);

    // Providers (ordered by tokens desc).
    assert.deepEqual(
      stats.providers.map((row) => [row.provider, row.tokens, row.runs, row.conversations]),
      [
        ['grok', 550, 1, 2],
        ['claude', 450, 2, 1],
        [null, 0, 1, 0],
      ],
    );
    assert.equal(stats.providers[1].costUsd, 0.75);
    assert.equal(stats.providers[0].costUsd, null, 'grok runs carry no cost estimate');

    // Models.
    assert.deepEqual(
      stats.models.map((row) => [row.provider, row.model, row.tokens]),
      [
        ['grok', 'grok-code', 550],
        ['claude', 'opus', 450],
        [null, null, 0],
      ],
    );

    // Sources.
    const bySource = Object.fromEntries(stats.sources.map((row) => [row.source, row.runs]));
    assert.deepEqual(bySource, { chat: 2, kanban: 1, webhook: 1 });

    // Hour histogram (UTC).
    assert.equal(stats.byHourUtc.length, 24);
    assert.equal(stats.byHourUtc[10].runs, 1);
    assert.equal(stats.byHourUtc[14].runs, 1);
    assert.equal(stats.byHourUtc[9].runs, 1);
    assert.equal(stats.byHourUtc[12].runs, 1);
    assert.equal(
      stats.byHourUtc.reduce((sum, bucket) => sum + bucket.runs, 0),
      4,
    );

    // Range echo + firstRunAt.
    assert.deepEqual(stats.range, { from: null, to: null });
    assert.equal(stats.firstRunAt, '2026-07-01T10:00:00.000Z');
  } finally {
    await db.restore();
  }
});

test('globalStats honours from/to bounds inclusively on created_at', async () => {
  const db = await useTempDatabase();
  try {
    seedRun({
      provider: 'claude',
      tokens: { total: 100 },
      createdAt: '2026-07-01T23:59:59.999Z',
      startedAt: '2026-07-01T23:59:00.000Z',
      finishedAt: '2026-07-01T23:59:59.000Z',
    });
    seedRun({
      provider: 'claude',
      tokens: { total: 200 },
      createdAt: '2026-07-02T00:00:00.000Z', // exact from bound
      startedAt: '2026-07-02T00:00:00.000Z',
      finishedAt: '2026-07-02T00:00:05.000Z',
    });
    seedRun({
      provider: 'claude',
      tokens: { total: 400 },
      createdAt: '2026-07-03T00:00:00.000Z', // exact to bound
      startedAt: '2026-07-03T00:00:00.000Z',
      finishedAt: '2026-07-03T00:00:05.000Z',
    });
    seedRun({
      provider: 'claude',
      tokens: { total: 800 },
      createdAt: '2026-07-03T00:00:00.001Z', // just past the to bound
      startedAt: '2026-07-03T00:00:00.000Z',
      finishedAt: '2026-07-03T00:00:05.000Z',
    });
    seedSession('session-in', 'claude', '2026-07-02T12:00:00.000Z');
    seedSession('session-out', 'claude', '2026-07-04T12:00:00.000Z');

    const stats = runService.globalStats({
      from: '2026-07-02T00:00:00.000Z',
      to: '2026-07-03T00:00:00.000Z',
    });

    assert.equal(stats.overview.totalRuns, 2, 'bounds are inclusive on both ends');
    assert.equal(stats.overview.totalTokens, 600);
    assert.equal(stats.overview.conversationCount, 1);
    assert.deepEqual(stats.range, {
      from: '2026-07-02T00:00:00.000Z',
      to: '2026-07-03T00:00:00.000Z',
    });
    // firstRunAt is unbounded context: the oldest run overall.
    assert.equal(stats.firstRunAt, '2026-07-01T23:59:59.999Z');

    // A range in the far past yields an empty-but-valid payload.
    const empty = runService.globalStats({
      from: '2000-01-01T00:00:00.000Z',
      to: '2000-01-02T00:00:00.000Z',
    });
    assert.equal(empty.overview.totalRuns, 0);
    assert.equal(empty.overview.totalTokens, 0);
    assert.equal(empty.overview.totalCostUsd, null, 'no cost data → null, not 0');
    assert.equal(empty.overview.totalDurationMs, 0);
    assert.equal(empty.overview.avgDurationMs, null);
    assert.equal(empty.overview.avgTokensPerConversation, null);
    assert.equal(empty.overview.successRate, null);
    assert.deepEqual(empty.daily, []);
    assert.deepEqual(empty.providers, []);
    assert.deepEqual(empty.models, []);
    assert.equal(empty.byHourUtc.length, 24);
  } finally {
    await db.restore();
  }
});

test('GET /stats/global returns the payload and validates the range', async () => {
  const db = await useTempDatabase();
  try {
    seedRun({
      provider: 'claude',
      model: 'opus',
      status: 'succeeded',
      tokens: { input: 10, output: 5, total: 15, costUsd: 0.01 },
      createdAt: '2026-07-02T10:00:00.000Z',
      startedAt: '2026-07-02T10:00:00.000Z',
      finishedAt: '2026-07-02T10:00:05.000Z',
    });

    await withRoutes(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/stats/global`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as { success: boolean; stats: GlobalRunStats };
      assert.equal(body.success, true);
      assert.equal(body.stats.overview.totalRuns, 1);
      assert.equal(body.stats.overview.totalTokens, 15);
      assert.equal(body.stats.overview.totalCostUsd, 0.01);
      assert.equal(body.stats.providers[0].provider, 'claude');
      assert.equal(body.stats.models[0].model, 'opus');

      // Filtered via query params.
      const filtered = await fetch(
        `${baseUrl}/stats/global?from=${encodeURIComponent('2026-07-03T00:00:00.000Z')}`,
      );
      assert.equal(filtered.status, 200);
      const filteredBody = (await filtered.json()) as { stats: GlobalRunStats };
      assert.equal(filteredBody.stats.overview.totalRuns, 0);

      // Invalid dates → 400 with a stable error code.
      const badFrom = await fetch(`${baseUrl}/stats/global?from=not-a-date`);
      assert.equal(badFrom.status, 400);
      const badFromBody = (await badFrom.json()) as { error: { code: string } };
      assert.equal(badFromBody.error.code, 'RUN_INVALID_STATS_RANGE');

      const badTo = await fetch(`${baseUrl}/stats/global?to=2026-13-99`);
      assert.equal(badTo.status, 400);
    });

    // The route must not be swallowed by /:runId — a literal "stats" id lookup 404s,
    // proving /stats/global was matched by its own handler above.
    await withRoutes(async (baseUrl) => {
      const runLookup = await fetch(`${baseUrl}/stats`);
      assert.notEqual(runLookup.status, 200, 'plain /stats still requires projectId');
      const missing = await fetch(`${baseUrl}/statsx`);
      assert.equal(missing.status, 404, 'unknown run id shape still hits /:runId');
    });
  } finally {
    await db.restore();
  }
});

test('globalStats treats runs without usage as zero-token and keeps cost null', async () => {
  const db = await useTempDatabase();
  try {
    seedRun({
      provider: 'agy',
      status: 'succeeded',
      createdAt: '2026-07-02T10:00:00.000Z',
      startedAt: '2026-07-02T10:00:00.000Z',
      finishedAt: '2026-07-02T10:00:05.000Z',
    });

    const stats = runService.globalStats({});
    assert.equal(stats.overview.totalRuns, 1);
    assert.equal(stats.overview.totalTokens, 0);
    assert.equal(stats.overview.runsWithTokens, 0);
    assert.equal(stats.overview.totalCostUsd, null);
    assert.equal(stats.overview.runsWithCost, 0);
    assert.equal(stats.overview.avgTokensPerRun, 0);
    assert.equal(stats.overview.avgTokensPerConversation, null);
    assert.equal(stats.overview.successRate, 1);
    // Duration still accrues from real timestamps.
    assert.equal(stats.overview.totalDurationMs, 5_000);
    assert.equal(stats.providers[0].costUsd, null);
  } finally {
    await db.restore();
  }
});
