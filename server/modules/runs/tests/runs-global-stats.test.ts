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
import { recordNormalizedRunEvent, runService } from '@/modules/runs/runs.service.js';
import runsRoutes from '@/modules/runs/runs.routes.js';
import type { GlobalRunStats } from '@/modules/runs/runs.types.js';
import {
  buildClaudeTokenBudgetFromUsage,
  buildCodexTokenUsage,
} from '@/modules/providers/index.js';
import type { LLMProvider, NormalizedMessage } from '@/shared/types.js';

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

/**
 * Insert a session the way sessions.db.ts does when the caller supplies no
 * created_at: SQLite's CURRENT_TIMESTAMP shape ('YYYY-MM-DD HH:MM:SS'), which
 * is what production rows actually look like.
 */
function seedSessionSqliteFormat(sessionId: string, provider: string, createdAt: string): void {
  const db = getConnection();
  assert.match(createdAt, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/, 'expected CURRENT_TIMESTAMP shape');
  db.prepare(`INSERT INTO sessions (session_id, provider, created_at, updated_at) VALUES (?, ?, ?, ?)`).run(
    sessionId,
    provider,
    createdAt,
    createdAt,
  );
}

/**
 * Build the `token_budget` status message the provider adapters publish (see
 * server/claude-sdk.js, server/openai-codex.js, server/opencode-cli.js).
 */
function tokenBudgetMessage(provider: LLMProvider, tokenBudget: unknown): NormalizedMessage {
  return {
    id: `msg-${Math.random().toString(36).slice(2)}`,
    sessionId: 'session-x',
    timestamp: '2026-07-02T10:00:00.000Z',
    provider,
    kind: 'status',
    text: 'token_budget',
    tokenBudget,
  } as NormalizedMessage;
}

function completeMessage(provider: LLMProvider): NormalizedMessage {
  return {
    id: `msg-${Math.random().toString(36).slice(2)}`,
    sessionId: 'session-x',
    timestamp: '2026-07-02T10:00:00.000Z',
    provider,
    kind: 'complete',
    success: true,
    exitCode: 0,
  } as NormalizedMessage;
}

function readUsageColumns(runId: string): {
  token_input: number | null;
  token_output: number | null;
  token_total: number | null;
} {
  const db = getConnection();
  return db
    .prepare(`SELECT token_input, token_output, token_total FROM agent_runs WHERE run_id = ?`)
    .get(runId) as { token_input: number | null; token_output: number | null; token_total: number | null };
}

/**
 * End-to-end proof for the bug that made every token KPI read zero: nothing in
 * production wrote agent_runs.token_*. This drives real provider usage payloads
 * through their own builders and through recordNormalizedRunEvent (the path all
 * run creators share), then asserts globalStats() sums them.
 */
test('provider token_budget events land in agent_runs and roll up into globalStats', async () => {
  const db = await useTempDatabase();
  try {
    // --- Claude: live SDK stream, one snapshot per assistant message (deltas).
    const claudeRun = runService.create({
      source: 'chat',
      provider: 'claude',
      model: 'opus',
      appSessionId: 'session-claude',
    });
    // Turn 1: 1000 fresh input + 5000 cache read = 6000 billed input, 200 out.
    recordNormalizedRunEvent(
      claudeRun.run_id,
      tokenBudgetMessage(
        'claude',
        buildClaudeTokenBudgetFromUsage(
          { input_tokens: 1000, cache_read_input_tokens: 5000, output_tokens: 200 },
          'opus',
        ),
      ),
      'chat',
    );
    assert.deepEqual(
      readUsageColumns(claudeRun.run_id),
      { token_input: 6000, token_output: 200, token_total: 6200 },
      'first claude snapshot is persisted',
    );
    // Turn 2: 1200 + 7000 = 8200 billed input, 300 out. Deltas accumulate.
    recordNormalizedRunEvent(
      claudeRun.run_id,
      tokenBudgetMessage(
        'claude',
        buildClaudeTokenBudgetFromUsage(
          { input_tokens: 1200, cache_read_input_tokens: 7000, output_tokens: 300 },
          'opus',
        ),
      ),
      'chat',
    );
    assert.deepEqual(
      readUsageColumns(claudeRun.run_id),
      { token_input: 14_200, token_output: 500, token_total: 14_700 },
      'claude per-turn snapshots accumulate rather than overwrite',
    );

    // --- Codex: cumulative session totals, re-reported every turn.
    const codexRun = runService.create({
      source: 'chat',
      provider: 'codex',
      model: 'gpt-5-codex',
      appSessionId: 'session-codex',
    });
    recordNormalizedRunEvent(
      codexRun.run_id,
      tokenBudgetMessage(
        'codex',
        buildCodexTokenUsage({
          total: { inputTokens: 3000, outputTokens: 400 },
          last: { inputTokens: 3000, outputTokens: 400 },
          modelContextWindow: 272_000,
          model: 'gpt-5-codex',
        }),
      ),
      'chat',
    );
    recordNormalizedRunEvent(
      codexRun.run_id,
      tokenBudgetMessage(
        'codex',
        buildCodexTokenUsage({
          total: { inputTokens: 9000, outputTokens: 1100 },
          last: { inputTokens: 6000, outputTokens: 700 },
          modelContextWindow: 272_000,
          model: 'gpt-5-codex',
        }),
      ),
      'chat',
    );
    assert.deepEqual(
      readUsageColumns(codexRun.run_id),
      { token_input: 9000, token_output: 1100, token_total: 10_100 },
      'cumulative snapshots supersede: 9000/1100, not the 12000/1500 a sum would give',
    );
    // A repeated (or stale) snapshot must not move the numbers.
    recordNormalizedRunEvent(
      codexRun.run_id,
      tokenBudgetMessage(
        'codex',
        buildCodexTokenUsage({
          total: { inputTokens: 9000, outputTokens: 1100 },
          last: { inputTokens: 6000, outputTokens: 700 },
          modelContextWindow: 272_000,
          model: 'gpt-5-codex',
        }),
      ),
      'chat',
    );
    assert.deepEqual(
      readUsageColumns(codexRun.run_id),
      { token_input: 9000, token_output: 1100, token_total: 10_100 },
      'replaying a cumulative snapshot is idempotent',
    );

    // --- OpenCode: emits its snapshot *after* `complete`, and exposes only the
    // generic inputTokens/outputTokens pair (no billed* fields).
    const opencodeRun = runService.create({
      source: 'chat',
      provider: 'opencode',
      model: 'grok-code',
      appSessionId: 'session-opencode',
    });
    recordNormalizedRunEvent(opencodeRun.run_id, completeMessage('opencode'), 'chat');
    assert.equal(runService.get(opencodeRun.run_id)?.status, 'succeeded');
    recordNormalizedRunEvent(
      opencodeRun.run_id,
      tokenBudgetMessage('opencode', {
        used: 3200,
        inputTokens: 2500,
        outputTokens: 700,
        breakdown: { input: 2500, output: 700 },
      }),
      'chat',
    );
    assert.deepEqual(
      readUsageColumns(opencodeRun.run_id),
      { token_input: 2500, token_output: 700, token_total: 3200 },
      'usage still lands when the snapshot arrives after the run went terminal',
    );

    // --- The dashboard aggregate is now non-zero.
    const stats = runService.globalStats({});
    assert.equal(stats.overview.totalTokens, 28_000);
    assert.equal(stats.overview.inputTokens, 25_700);
    assert.equal(stats.overview.outputTokens, 2_300);
    assert.equal(stats.overview.runsWithTokens, 3);
    assert.ok(stats.overview.totalTokens > 0, 'token KPIs are no longer zero');

    // ...and attributed to the right providers.
    assert.deepEqual(
      stats.providers.map((row) => [row.provider, row.inputTokens, row.outputTokens]),
      [
        ['claude', 14_200, 500],
        ['codex', 9000, 1100],
        ['opencode', 2500, 700],
      ],
    );
  } finally {
    await db.restore();
  }
});

test('globalStats converts conversation-cumulative provider snapshots into per-run deltas', async () => {
  const db = await useTempDatabase();
  try {
    seedSession('session-cumulative', 'codex', '2026-07-01T00:00:00.000Z');
    seedRun({
      provider: 'codex',
      appSessionId: 'session-cumulative',
      createdAt: '2026-07-01T10:00:00.000Z',
      tokens: { input: 900, output: 100, total: 1_000, costUsd: 1 },
    });
    seedRun({
      provider: 'codex',
      appSessionId: 'session-cumulative',
      createdAt: '2026-07-02T10:00:00.000Z',
      tokens: { input: 1_350, output: 150, total: 1_500, costUsd: 1.5 },
    });
    // A lower snapshot is a provider counter reset, not a negative delta.
    seedRun({
      provider: 'codex',
      appSessionId: 'session-cumulative',
      createdAt: '2026-07-03T10:00:00.000Z',
      tokens: { input: 180, output: 20, total: 200, costUsd: 0.2 },
    });

    // Claude snapshots are per-run and must continue to add normally even
    // when multiple runs share the same conversation.
    seedSession('session-delta', 'claude', '2026-07-01T00:00:00.000Z');
    seedRun({
      provider: 'claude',
      appSessionId: 'session-delta',
      createdAt: '2026-07-01T11:00:00.000Z',
      tokens: { input: 250, output: 50, total: 300, costUsd: 0.3 },
    });
    seedRun({
      provider: 'claude',
      appSessionId: 'session-delta',
      createdAt: '2026-07-02T11:00:00.000Z',
      tokens: { input: 400, output: 100, total: 500, costUsd: 0.5 },
    });

    const all = runService.globalStats({});
    assert.equal(all.overview.totalTokens, 1_500 + 200 + 300 + 500);
    assert.equal(all.overview.totalCostUsd, 1.5 + 0.2 + 0.3 + 0.5);
    assert.equal(all.providers.find((row) => row.provider === 'codex')?.tokens, 1_700);

    // The July 2 window still subtracts July 1's cumulative baseline because
    // the window function is evaluated before the date predicate.
    const july2 = runService.globalStats({
      from: '2026-07-02T00:00:00.000Z',
      to: '2026-07-02T23:59:59.999Z',
    });
    assert.equal(july2.overview.totalTokens, 500 + 500);
    assert.equal(july2.providers.find((row) => row.provider === 'codex')?.tokens, 500);
    assert.equal(july2.overview.totalCostUsd, 0.5 + 0.5);
  } finally {
    await db.restore();
  }
});

test('token_budget messages without usable usage leave the run untouched', async () => {
  const db = await useTempDatabase();
  try {
    const run = runService.create({ source: 'chat', provider: 'claude' });
    // Context-occupancy-only payload: no billed/input/output token fields.
    recordNormalizedRunEvent(
      run.run_id,
      tokenBudgetMessage('claude', { used: 1234, total: 200_000, contextPercent: 0.6 }),
      'chat',
    );
    // Wrong shapes must not throw or write.
    recordNormalizedRunEvent(run.run_id, tokenBudgetMessage('claude', null), 'chat');
    recordNormalizedRunEvent(run.run_id, tokenBudgetMessage('claude', 'nonsense'), 'chat');
    recordNormalizedRunEvent(run.run_id, tokenBudgetMessage('claude', [1, 2, 3]), 'chat');

    assert.deepEqual(readUsageColumns(run.run_id), {
      token_input: null,
      token_output: null,
      token_total: null,
    });
    const stats = runService.globalStats({});
    assert.equal(stats.overview.runsWithTokens, 0, 'no usage reported → still counted as unreported');
    assert.equal(stats.overview.totalTokens, 0);
  } finally {
    await db.restore();
  }
});

/**
 * Regression: agent_runs.created_at is JS ISO ('...T..Z') while
 * sessions.created_at is usually SQLite CURRENT_TIMESTAMP ('... ...'), and
 * globalStats reused the ISO predicate for both. Because ' ' < 'T', every
 * space-formatted session on the `from` day was silently dropped.
 */
test('date bounds select the same window for ISO and CURRENT_TIMESTAMP sessions', async () => {
  const db = await useTempDatabase();
  try {
    seedRun({
      provider: 'claude',
      tokens: { total: 100 },
      appSessionId: 'in-sqlite-fmt',
      createdAt: '2026-07-02T10:00:00.000Z',
    });

    // Both rows sit at the same instant on the `from` day — one stored in each
    // format. Before the fix only the ISO row was counted.
    seedSessionSqliteFormat('in-sqlite-fmt', 'claude', '2026-07-02 10:00:00');
    seedSession('in-iso-fmt', 'claude', '2026-07-02T10:00:00.000Z');
    // Same-instant pair on the inclusive `to` day.
    seedSessionSqliteFormat('to-day-sqlite-fmt', 'claude', '2026-07-03 23:00:00');
    seedSession('to-day-iso-fmt', 'claude', '2026-07-03T23:00:00.000Z');
    // Same-instant pair just outside the window, in both formats.
    seedSessionSqliteFormat('out-sqlite-fmt', 'claude', '2026-07-01 10:00:00');
    seedSession('out-iso-fmt', 'claude', '2026-07-01T10:00:00.000Z');

    const stats = runService.globalStats({
      from: '2026-07-02T00:00:00.000Z',
      to: '2026-07-03T23:59:59.999Z',
    });

    assert.equal(
      stats.overview.conversationCount,
      4,
      'both storage formats are matched, and both out-of-range rows excluded',
    );

    // The two formats must also agree per day, not just in the total.
    const byDay = Object.fromEntries(stats.daily.map((day) => [day.day, day.conversations]));
    assert.equal(byDay['2026-07-02'], 2, 'from-day sessions in both formats are in the window');
    assert.equal(byDay['2026-07-03'], 2, 'to-day sessions in both formats are in the window');

    // Provider rollup counts conversations through the same predicate.
    const claude = stats.providers.find((row) => row.provider === 'claude');
    assert.equal(claude?.conversations, 4);

    // An unbounded query sees every row regardless of format.
    assert.equal(runService.globalStats({}).overview.conversationCount, 6);

    // A `from`-only bound behaves the same way.
    assert.equal(
      runService.globalStats({ from: '2026-07-02T00:00:00.000Z' }).overview.conversationCount,
      4,
    );
    // A `to`-only bound keeps the two 07-01 rows and drops nothing else.
    assert.equal(
      runService.globalStats({ to: '2026-07-02T23:59:59.999Z' }).overview.conversationCount,
      4,
    );
  } finally {
    await db.restore();
  }
});

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

test('globalStats honours provider filter including unknown attribution', async () => {
  const db = await useTempDatabase();
  try {
    seedRun({
      provider: 'claude',
      tokens: { total: 100 },
      createdAt: '2026-07-02T12:00:00.000Z',
      startedAt: '2026-07-02T12:00:00.000Z',
      finishedAt: '2026-07-02T12:00:05.000Z',
    });
    seedRun({
      provider: 'grok',
      tokens: { total: 200 },
      createdAt: '2026-07-02T13:00:00.000Z',
      startedAt: '2026-07-02T13:00:00.000Z',
      finishedAt: '2026-07-02T13:00:05.000Z',
    });
    const unknownId = seedRun({
      provider: 'claude',
      tokens: { total: 50 },
      createdAt: '2026-07-02T14:00:00.000Z',
      startedAt: '2026-07-02T14:00:00.000Z',
      finishedAt: '2026-07-02T14:00:05.000Z',
    });
    getConnection().prepare(`UPDATE agent_runs SET provider = NULL WHERE run_id = ?`).run(unknownId);
    seedSession('session-claude', 'claude', '2026-07-02T12:00:00.000Z');
    seedSession('session-grok', 'grok', '2026-07-02T13:00:00.000Z');

    const claude = runService.globalStats({ provider: 'claude' });
    assert.equal(claude.overview.totalRuns, 1);
    assert.equal(claude.overview.totalTokens, 100);
    assert.equal(claude.overview.conversationCount, 1);
    assert.deepEqual(
      claude.providers.map((row) => row.provider),
      ['claude'],
    );

    const unknown = runService.globalStats({ provider: '__unknown__' });
    assert.equal(unknown.overview.totalRuns, 1);
    assert.equal(unknown.overview.totalTokens, 50);
    assert.equal(unknown.providers.length, 1);
    assert.equal(unknown.providers[0].provider, null);
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
