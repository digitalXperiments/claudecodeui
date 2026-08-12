/**
 * Historical token backfill → globalStats.
 *
 * Proves older sessions/runs with recoverable provider usage contribute to
 * token KPIs, without double-counting against the live token_budget path,
 * and without the three defects a prior swarm attempt shipped:
 *  1. Synthetic history runs must survive retention (no delete/recreate churn).
 *  2. Synthetic history runs must not inflate non-token globalStats KPIs
 *     (totalRuns, successRate, avgDurationMs, byHour) — only totalTokens.
 *  3. An unrecoverable session must be durably marked so later passes make
 *     forward progress into deeper history instead of starving on it forever.
 */

import assert from 'node:assert/strict';
import { rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { makeScratchDir } from '@/shared/scratch.js';
import { closeConnection, getConnection, initializeDatabase } from '@/modules/database/index.js';
import { applyRunRetention } from '@/modules/runs/runs-maintenance.service.js';
import {
  backfillHistoricalRunTokens,
  backfillMissingCosts,
  listSessionsNeedingTokenBackfill,
  mergeBackfillUsage,
  normalizeSessionTimestamp,
  readHistoricalSessionUsage,
  resetHistoricalTokenBackfillLatch,
  resolveUnresolvedModels,
  type BackfillSessionRow,
  type HistoricalUsageReader,
} from '@/modules/runs/runs-token-backfill.js';
import { recordNormalizedRunEvent, runService } from '@/modules/runs/runs.service.js';
import { buildCodexTokenUsage } from '@/modules/providers/index.js';
import type { NormalizedMessage } from '@/shared/types.js';

type TempDb = { directory: string; restore: () => Promise<void> };

async function useTempDatabase(): Promise<TempDb> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const directory = await makeScratchDir('runs-token-backfill-');
  closeConnection();
  process.env.DATABASE_PATH = path.join(directory, 'auth.db');
  await initializeDatabase();
  resetHistoricalTokenBackfillLatch();
  return {
    directory,
    restore: async () => {
      closeConnection();
      resetHistoricalTokenBackfillLatch();
      if (previousDatabasePath === undefined) {
        delete process.env.DATABASE_PATH;
      } else {
        process.env.DATABASE_PATH = previousDatabasePath;
      }
      await rm(directory, { recursive: true, force: true });
    },
  };
}

function seedSession(options: {
  sessionId: string;
  provider: string;
  createdAt: string;
  projectPath?: string;
  providerSessionId?: string | null;
  jsonlPath?: string | null;
}): void {
  const db = getConnection();
  if (options.projectPath) {
    db.prepare(
      `INSERT INTO projects (project_id, project_path, isArchived)
       VALUES (?, ?, 0)
       ON CONFLICT(project_path) DO NOTHING`,
    ).run(`proj-${options.sessionId}`, options.projectPath);
  }
  db.prepare(
    `INSERT INTO sessions (
       session_id, provider, provider_session_id, project_path, jsonl_path, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    options.sessionId,
    options.provider,
    options.providerSessionId ?? options.sessionId,
    options.projectPath ?? null,
    options.jsonlPath ?? null,
    options.createdAt,
    options.createdAt,
  );
}

function fixedReader(
  map: Record<string, { input: number; output: number } | null>,
): HistoricalUsageReader {
  return (session: BackfillSessionRow) => map[session.session_id] ?? null;
}

function tokenBudgetMessage(provider: string, tokenBudget: unknown): NormalizedMessage {
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

function readUsage(runId: string): {
  token_input: number | null;
  token_output: number | null;
  token_total: number | null;
} {
  return getConnection()
    .prepare(`SELECT token_input, token_output, token_total FROM agent_runs WHERE run_id = ?`)
    .get(runId) as {
    token_input: number | null;
    token_output: number | null;
    token_total: number | null;
  };
}

test('normalizeSessionTimestamp accepts ISO and SQLite CURRENT_TIMESTAMP', () => {
  assert.equal(normalizeSessionTimestamp('2026-07-02 15:30:00'), '2026-07-02T15:30:00.000Z');
  assert.equal(normalizeSessionTimestamp('2026-07-02T15:30:00.000Z'), '2026-07-02T15:30:00.000Z');
  assert.equal(normalizeSessionTimestamp('not-a-date'), null);
});

test('mergeBackfillUsage is absolute max and never lowers live values', () => {
  assert.deepEqual(mergeBackfillUsage({ token_input: null, token_output: null }, { input: 10, output: 5 }), {
    input: 10,
    output: 5,
    total: 15,
  });
  assert.deepEqual(
    mergeBackfillUsage({ token_input: 100, token_output: 20 }, { input: 50, output: 10 }),
    null,
    'lower historical snapshot must not overwrite higher live values',
  );
  assert.deepEqual(
    mergeBackfillUsage({ token_input: 100, token_output: 20 }, { input: 150, output: 10 }),
    { input: 150, output: 20, total: 170 },
  );
  assert.equal(
    mergeBackfillUsage({ token_input: 100, token_output: 20 }, { input: 100, output: 20 }),
    null,
    'identical snapshot is a no-op (idempotent)',
  );
});

test('historical-only usage appears in globalStats totalTokens but not totalRuns/successRate/avgDurationMs', async () => {
  const temp = await useTempDatabase();
  try {
    // Old session with a null-token run (pre-live-persistence shape).
    seedSession({
      sessionId: 'sess-old-run',
      provider: 'codex',
      createdAt: '2026-06-01T12:00:00.000Z',
    });
    const run = runService.create({
      source: 'chat',
      provider: 'codex',
      appSessionId: 'sess-old-run',
    });
    getConnection()
      .prepare(`UPDATE agent_runs SET created_at = ?, started_at = ?, finished_at = ? WHERE run_id = ?`)
      .run(
        '2026-06-01T12:00:00.000Z',
        '2026-06-01T12:00:00.000Z',
        '2026-06-01T12:05:00.000Z',
        run.run_id,
      );

    // Session with no runs at all — needs a synthetic history run.
    seedSession({
      sessionId: 'sess-no-runs',
      provider: 'claude',
      createdAt: '2026-06-15 09:00:00', // SQLite CURRENT_TIMESTAMP shape
    });

    const before = runService.globalStats({
      from: '2026-06-01T00:00:00.000Z',
      to: '2026-06-30T23:59:59.999Z',
    });
    assert.equal(before.overview.totalTokens, 0, 'pre-backfill tokens stay zero');
    assert.equal(before.overview.conversationCount, 2);
    // One real chat run already exists ('sess-old-run').
    assert.equal(before.overview.totalRuns, 1);

    const result = await backfillHistoricalRunTokens({
      readUsage: fixedReader({
        'sess-old-run': { input: 4000, output: 600 },
        'sess-no-runs': { input: 1500, output: 200 },
      }),
    });

    assert.equal(result.runsUpdated, 1);
    assert.equal(result.runsCreated, 1);
    assert.equal(result.errors, 0);

    assert.deepEqual(readUsage(run.run_id), {
      token_input: 4000,
      token_output: 600,
      token_total: 4600,
    });

    const after = runService.globalStats({
      from: '2026-06-01T00:00:00.000Z',
      to: '2026-06-30T23:59:59.999Z',
    });
    assert.equal(after.overview.totalTokens, 4600 + 1700);
    assert.equal(after.overview.inputTokens, 5500);
    assert.equal(after.overview.outputTokens, 800);
    assert.equal(after.overview.runsWithTokens, 2);
    assert.equal(after.overview.conversationCount, 2);
    // The synthetic history run for 'sess-no-runs' must NOT inflate totalRuns
    // — it is a bookkeeping row, not a real agent invocation. Still just the
    // one genuine chat run from before.
    assert.equal(after.overview.totalRuns, 1, 'synthetic history run must not count as a run');
    // successRate is derived from byStatus; the synthetic run's manufactured
    // status='succeeded' must not feed the terminal/succeeded counts it uses.
    const historyStatusRow = getConnection()
      .prepare(`SELECT status FROM agent_runs WHERE source = 'history'`)
      .get() as { status: string } | undefined;
    assert.equal(historyStatusRow?.status, 'succeeded');
    assert.equal(before.overview.successRate, after.overview.successRate);

    // Synthetic run inherits session created_at so date filters include it.
    const historyRuns = getConnection()
      .prepare(
        `SELECT run_id, source, created_at, app_session_id FROM agent_runs WHERE source = 'history'`,
      )
      .all() as Array<{ run_id: string; source: string; created_at: string; app_session_id: string }>;
    assert.equal(historyRuns.length, 1);
    assert.equal(historyRuns[0].app_session_id, 'sess-no-runs');
    assert.equal(historyRuns[0].created_at, '2026-06-15T09:00:00.000Z');

    // Outside the June window: no tokens.
    const july = runService.globalStats({
      from: '2026-07-01T00:00:00.000Z',
      to: '2026-07-31T23:59:59.999Z',
    });
    assert.equal(july.overview.totalTokens, 0);
  } finally {
    await temp.restore();
  }
});

test('a synthetic history run does not inflate byHour or the per-day/provider run counts', async () => {
  const temp = await useTempDatabase();
  try {
    seedSession({
      sessionId: 'sess-hist-only',
      provider: 'claude',
      createdAt: '2026-06-20T14:00:00.000Z',
    });
    await backfillHistoricalRunTokens({
      readUsage: fixedReader({ 'sess-hist-only': { input: 500, output: 50 } }),
    });

    const stats = runService.globalStats({
      from: '2026-06-01T00:00:00.000Z',
      to: '2026-06-30T23:59:59.999Z',
    });
    // Tokens show up in the daily/provider breakdown...
    const day = stats.daily.find((d) => d.day === '2026-06-20');
    assert.ok(day);
    assert.equal(day!.tokens, 550);
    // ...but the synthetic run does not count as a "run" in that bucket.
    assert.equal(day!.runs, 0);
    const provider = stats.providers.find((p) => p.provider === 'claude');
    assert.ok(provider);
    assert.equal(provider!.tokens, 550);
    assert.equal(provider!.runs, 0);
    // byHour: 14:00 UTC must not show a run from the synthetic backfill row.
    const hour14 = stats.byHourUtc.find((h) => h.hour === 14);
    assert.ok(hour14);
    assert.equal(hour14!.runs, 0);
  } finally {
    await temp.restore();
  }
});

test('a synthetic history run\'s real cost DOES show up in overview/daily/provider/model totals', async () => {
  const temp = await useTempDatabase();
  try {
    // claude-opus-5: $5/M in, $25/M out.
    seedSession({
      sessionId: 'sess-hist-cost',
      provider: 'claude',
      createdAt: '2026-06-21T09:00:00.000Z',
    });
    const reader: HistoricalUsageReader = (session) =>
      session.session_id === 'sess-hist-cost'
        ? { input: 1_000_000, output: 100_000, model: 'claude-opus-5' }
        : null;
    await backfillHistoricalRunTokens({ readUsage: reader });
    const expectedCost = 1 * 5 + 0.1 * 25; // 7.5

    const stats = runService.globalStats({
      from: '2026-06-01T00:00:00.000Z',
      to: '2026-06-30T23:59:59.999Z',
    });
    // Cost is real spend, exactly like tokens — a history row must NOT be
    // excluded from it just because it is excluded from the *run* count.
    assert.equal(stats.overview.totalCostUsd, expectedCost);
    assert.equal(stats.overview.totalRuns, 0);

    const day = stats.daily.find((d) => d.day === '2026-06-21');
    assert.ok(day);
    assert.equal(day!.costUsd, expectedCost);

    const provider = stats.providers.find((p) => p.provider === 'claude');
    assert.ok(provider);
    assert.equal(provider!.costUsd, expectedCost);

    const model = stats.models.find((m) => m.model === 'claude-opus-5');
    assert.ok(model);
    assert.equal(model!.costUsd, expectedCost);
    assert.equal(model!.runs, 0, 'a history row never counts as a "run" even though its cost counts');
  } finally {
    await temp.restore();
  }
});

test('retention never deletes a synthetic history run, however old its stamped timestamp', async () => {
  const temp = await useTempDatabase();
  try {
    // A session from "years ago" — the whole point of "historical".
    seedSession({
      sessionId: 'sess-ancient',
      provider: 'claude',
      createdAt: '2020-01-01T00:00:00.000Z',
    });
    const result = await backfillHistoricalRunTokens({
      readUsage: fixedReader({ 'sess-ancient': { input: 10, output: 5 } }),
    });
    assert.equal(result.runsCreated, 1);

    const before = getConnection()
      .prepare(`SELECT COUNT(*) AS n FROM agent_runs WHERE source = 'history'`)
      .get() as { n: number };
    assert.equal(before.n, 1);

    // Retention's cutoff is far more recent than 2020-01-01 — a real run this
    // old would be deleted. The synthetic history row must survive.
    const retention = applyRunRetention();
    assert.equal(retention.runsDeleted, 0);

    const after = getConnection()
      .prepare(`SELECT COUNT(*) AS n FROM agent_runs WHERE source = 'history'`)
      .get() as { n: number };
    assert.equal(after.n, 1, 'retention must not delete synthetic history rows');

    // Which means a follow-up backfill pass does not need to recreate it —
    // the session is still covered, so it drops out of the candidate set.
    const rerun = await backfillHistoricalRunTokens({
      readUsage: fixedReader({ 'sess-ancient': { input: 10, output: 5 } }),
    });
    assert.equal(rerun.sessionsScanned, 0, 'no delete-then-recreate churn');
  } finally {
    await temp.restore();
  }
});

test('an unrecoverable session is durably marked so a later pass advances into deeper history', async () => {
  const temp = await useTempDatabase();
  try {
    // Newest-first candidate order: unrecoverable, unrecoverable, then the
    // genuinely recoverable OLDEST session. With only 2 slots per pass and
    // no durable marker, the recoverable session would never be reached.
    seedSession({ sessionId: 'sess-newest-dead', provider: 'claude', createdAt: '2026-06-03T00:00:00.000Z' });
    seedSession({ sessionId: 'sess-middle-dead', provider: 'claude', createdAt: '2026-06-02T00:00:00.000Z' });
    seedSession({ sessionId: 'sess-oldest-alive', provider: 'claude', createdAt: '2026-06-01T00:00:00.000Z' });

    const reader = fixedReader({
      'sess-newest-dead': null,
      'sess-middle-dead': null,
      'sess-oldest-alive': { input: 700, output: 80 },
    });

    // Pass 1, capped at 2 candidates: only the two newest (both dead) are visited.
    const first = await backfillHistoricalRunTokens({ limit: 2, readUsage: reader });
    assert.equal(first.sessionsScanned, 2);
    assert.equal(first.sessionsMarkedUnrecoverable, 2);
    assert.equal(first.runsCreated, 0);
    assert.equal(runService.globalStats({}).overview.totalTokens, 0);

    // The two dead sessions are now durably marked (token_total = 0), so the
    // next capped-at-2 pass advances past them to the recoverable session.
    const remaining = listSessionsNeedingTokenBackfill(10).map((s) => s.session_id);
    assert.deepEqual(remaining, ['sess-oldest-alive']);

    const second = await backfillHistoricalRunTokens({ limit: 2, readUsage: reader });
    assert.equal(second.sessionsScanned, 1);
    assert.equal(second.runsCreated, 1);
    assert.equal(runService.globalStats({}).overview.totalTokens, 780);

    // The zero-token markers must not themselves count as runs/tokens.
    assert.equal(runService.globalStats({}).overview.totalRuns, 0);
  } finally {
    await temp.restore();
  }
});

test('backfill is idempotent and multi-run sessions get single attribution', async () => {
  const temp = await useTempDatabase();
  try {
    seedSession({
      sessionId: 'sess-multi',
      provider: 'claude',
      createdAt: '2026-05-01T00:00:00.000Z',
    });
    const older = runService.create({
      source: 'chat',
      provider: 'claude',
      appSessionId: 'sess-multi',
    });
    const newer = runService.create({
      source: 'chat',
      provider: 'claude',
      appSessionId: 'sess-multi',
    });
    getConnection()
      .prepare(`UPDATE agent_runs SET created_at = ? WHERE run_id = ?`)
      .run('2026-05-01T10:00:00.000Z', older.run_id);
    getConnection()
      .prepare(`UPDATE agent_runs SET created_at = ? WHERE run_id = ?`)
      .run('2026-05-01T11:00:00.000Z', newer.run_id);

    const reader = fixedReader({
      'sess-multi': { input: 900, output: 100 },
    });

    const first = await backfillHistoricalRunTokens({ readUsage: reader });
    assert.equal(first.runsUpdated, 1);
    assert.equal(first.runsCreated, 0);

    // Only the latest run receives the session total.
    assert.deepEqual(readUsage(newer.run_id), {
      token_input: 900,
      token_output: 100,
      token_total: 1000,
    });
    assert.deepEqual(readUsage(older.run_id), {
      token_input: null,
      token_output: null,
      token_total: null,
    });

    const statsOnce = runService.globalStats({});
    assert.equal(statsOnce.overview.totalTokens, 1000);
    assert.equal(statsOnce.overview.runsWithTokens, 1);

    // Second pass: session already covered → no extra writes, no double count.
    const second = await backfillHistoricalRunTokens({ readUsage: reader });
    assert.equal(second.runsUpdated, 0);
    assert.equal(second.runsCreated, 0);
    assert.equal(second.sessionsScanned, 0, 'sessions with token coverage drop out of the candidate set');

    const statsTwice = runService.globalStats({});
    assert.equal(statsTwice.overview.totalTokens, 1000, 're-run does not double-count');
  } finally {
    await temp.restore();
  }
});

test('live token_budget after backfill updates without double-counting (cumulative + delta)', async () => {
  const temp = await useTempDatabase();
  try {
    // --- Codex (cumulative): live max after absolute backfill.
    seedSession({
      sessionId: 'sess-codex-live',
      provider: 'codex',
      createdAt: '2026-07-01T00:00:00.000Z',
    });
    const codexRun = runService.create({
      source: 'chat',
      provider: 'codex',
      appSessionId: 'sess-codex-live',
    });

    await backfillHistoricalRunTokens({
      readUsage: fixedReader({
        'sess-codex-live': { input: 3000, output: 400 },
      }),
    });
    assert.deepEqual(readUsage(codexRun.run_id), {
      token_input: 3000,
      token_output: 400,
      token_total: 3400,
    });

    // Live cumulative snapshot higher than backfill → supersedes via max.
    recordNormalizedRunEvent(
      codexRun.run_id,
      tokenBudgetMessage(
        'codex',
        buildCodexTokenUsage({
          total: { inputTokens: 5000, outputTokens: 700 },
          last: { inputTokens: 2000, outputTokens: 300 },
          modelContextWindow: 272_000,
        }),
      ),
      'chat',
    );
    assert.deepEqual(readUsage(codexRun.run_id), {
      token_input: 5000,
      token_output: 700,
      token_total: 5700,
    });

    // Stale / equal cumulative snapshot must not inflate.
    recordNormalizedRunEvent(
      codexRun.run_id,
      tokenBudgetMessage(
        'codex',
        buildCodexTokenUsage({
          total: { inputTokens: 5000, outputTokens: 700 },
          last: { inputTokens: 2000, outputTokens: 300 },
          modelContextWindow: 272_000,
        }),
      ),
      'chat',
    );
    assert.deepEqual(readUsage(codexRun.run_id), {
      token_input: 5000,
      token_output: 700,
      token_total: 5700,
    });

    // --- Claude (delta): backfill is absolute session total; new turns add.
    seedSession({
      sessionId: 'sess-claude-live',
      provider: 'claude',
      createdAt: '2026-07-01T00:00:00.000Z',
    });
    const claudeRun = runService.create({
      source: 'chat',
      provider: 'claude',
      appSessionId: 'sess-claude-live',
    });
    await backfillHistoricalRunTokens({
      readUsage: fixedReader({
        'sess-claude-live': { input: 1000, output: 100 },
      }),
    });
    assert.deepEqual(readUsage(claudeRun.run_id), {
      token_input: 1000,
      token_output: 100,
      token_total: 1100,
    });

    // New live turn (delta) after backfill of historical turns.
    recordNormalizedRunEvent(
      claudeRun.run_id,
      tokenBudgetMessage('claude', {
        billedInputTokens: 200,
        billedOutputTokens: 50,
      }),
      'chat',
    );
    assert.deepEqual(readUsage(claudeRun.run_id), {
      token_input: 1200,
      token_output: 150,
      token_total: 1350,
    });

    const stats = runService.globalStats({});
    // codex 5700 + claude 1350
    assert.equal(stats.overview.totalTokens, 5700 + 1350);
    assert.equal(stats.overview.runsWithTokens, 2);

    // Re-running backfill must not rewrite / double-count now-covered sessions.
    const again = await backfillHistoricalRunTokens({
      readUsage: fixedReader({
        'sess-codex-live': { input: 3000, output: 400 },
        'sess-claude-live': { input: 1000, output: 100 },
      }),
    });
    assert.equal(again.runsUpdated, 0);
    assert.equal(again.runsCreated, 0);
    assert.equal(runService.globalStats({}).overview.totalTokens, 5700 + 1350);
  } finally {
    await temp.restore();
  }
});

test('missing/zero provider usage never throws and is durably marked, not left NULL forever', async () => {
  const temp = await useTempDatabase();
  try {
    seedSession({
      sessionId: 'sess-missing',
      provider: 'claude',
      createdAt: '2026-04-01T00:00:00.000Z',
    });
    seedSession({
      sessionId: 'sess-zero',
      provider: 'codex',
      createdAt: '2026-04-02T00:00:00.000Z',
    });

    const result = await backfillHistoricalRunTokens({
      readUsage: fixedReader({
        'sess-missing': null,
        'sess-zero': { input: 0, output: 0 },
      }),
    });

    assert.equal(result.errors, 0);
    assert.equal(result.runsCreated, 0, 'no run carrying nonzero usage');
    assert.equal(result.runsUpdated, 0);
    assert.equal(result.sessionsSkipped, 2);
    assert.equal(result.sessionsMarkedUnrecoverable, 2);
    assert.equal(runService.globalStats({}).overview.totalTokens, 0);
    assert.equal(runService.globalStats({}).overview.totalRuns, 0, 'markers are not real runs');

    // Both sessions are now durably covered (token_total = 0), so they drop
    // out of the candidate set on the next pass instead of being retried
    // forever.
    assert.deepEqual(listSessionsNeedingTokenBackfill(10), []);
  } finally {
    await temp.restore();
  }
});

test('skipSyntheticRuns suppresses both real synthetic runs and unrecoverable markers', async () => {
  const temp = await useTempDatabase();
  try {
    seedSession({ sessionId: 'sess-a', provider: 'claude', createdAt: '2026-04-01T00:00:00.000Z' });
    seedSession({ sessionId: 'sess-b', provider: 'claude', createdAt: '2026-04-02T00:00:00.000Z' });

    const result = await backfillHistoricalRunTokens({
      skipSyntheticRuns: true,
      readUsage: fixedReader({
        'sess-a': { input: 100, output: 10 },
        'sess-b': null,
      }),
    });
    assert.equal(result.runsCreated, 0);
    assert.equal(result.sessionsMarkedUnrecoverable, 0);
    assert.equal(
      (getConnection().prepare(`SELECT COUNT(*) AS n FROM agent_runs`).get() as { n: number }).n,
      0,
    );
  } finally {
    await temp.restore();
  }
});

test('backfill does not overwrite higher live values with lower historical totals', async () => {
  const temp = await useTempDatabase();
  try {
    seedSession({
      sessionId: 'sess-live-higher',
      provider: 'codex',
      createdAt: '2026-07-10T00:00:00.000Z',
    });
    const run = runService.create({
      source: 'chat',
      provider: 'codex',
      appSessionId: 'sess-live-higher',
    });
    // Live path already wrote a complete total.
    runService.attachUsage(run.run_id, { input: 8000, output: 900, total: 8900 });

    // Candidate query should exclude this session entirely.
    const result = await backfillHistoricalRunTokens({
      readUsage: fixedReader({
        'sess-live-higher': { input: 100, output: 10 },
      }),
    });
    assert.equal(result.sessionsScanned, 0);
    assert.deepEqual(readUsage(run.run_id), {
      token_input: 8000,
      token_output: 900,
      token_total: 8900,
    });
    assert.equal(runService.globalStats({}).overview.totalTokens, 8900);
  } finally {
    await temp.restore();
  }
});

test('a live token_budget event resolves a claude run off the "default" request-time sentinel', async () => {
  const temp = await useTempDatabase();
  try {
    seedSession({
      sessionId: 'sess-default-model',
      provider: 'claude',
      createdAt: '2026-07-01T00:00:00.000Z',
    });
    const run = runService.create({
      source: 'chat',
      provider: 'claude',
      model: 'default',
      appSessionId: 'sess-default-model',
    });
    assert.equal(runService.get(run.run_id)?.model, 'default');

    recordNormalizedRunEvent(
      run.run_id,
      tokenBudgetMessage('claude', {
        billedInputTokens: 500,
        billedOutputTokens: 50,
        model: 'claude-sonnet-5',
      }),
      'chat',
    );

    assert.equal(runService.get(run.run_id)?.model, 'claude-sonnet-5');
    assert.deepEqual(readUsage(run.run_id), {
      token_input: 500,
      token_output: 50,
      token_total: 550,
    });

    // A later event with no model field must not clobber the resolved value.
    recordNormalizedRunEvent(
      run.run_id,
      tokenBudgetMessage('claude', { billedInputTokens: 700, billedOutputTokens: 60 }),
      'chat',
    );
    assert.equal(runService.get(run.run_id)?.model, 'claude-sonnet-5');

    // And a run whose model was explicitly chosen by the caller must never
    // be overwritten by a differently-reported resolved model.
    const explicit = runService.create({
      source: 'chat',
      provider: 'claude',
      model: 'claude-opus-5',
      appSessionId: 'sess-default-model',
    });
    recordNormalizedRunEvent(
      explicit.run_id,
      tokenBudgetMessage('claude', {
        billedInputTokens: 10,
        billedOutputTokens: 5,
        model: 'claude-sonnet-5',
      }),
      'chat',
    );
    assert.equal(runService.get(explicit.run_id)?.model, 'claude-opus-5');
  } finally {
    await temp.restore();
  }
});

test('resolveUnresolvedModels backfills the model for existing runs stuck on "default"', async () => {
  const temp = await useTempDatabase();
  try {
    seedSession({
      sessionId: 'sess-stuck-default',
      provider: 'claude',
      createdAt: '2026-07-05T00:00:00.000Z',
    });
    const run = runService.create({
      source: 'chat',
      provider: 'claude',
      model: 'default',
      appSessionId: 'sess-stuck-default',
    });
    // Live path already covered tokens — this run would never be selected by
    // backfillHistoricalRunTokens's "missing tokens" candidate query.
    runService.attachUsage(run.run_id, { input: 200, output: 30, total: 230 });
    assert.equal(runService.get(run.run_id)?.model, 'default');

    const reader: HistoricalUsageReader = (session) =>
      session.session_id === 'sess-stuck-default'
        ? { input: 200, output: 30, model: 'claude-sonnet-5' }
        : null;

    const result = await resolveUnresolvedModels({ readUsage: reader });
    assert.equal(result.runsScanned, 1);
    assert.equal(result.runsResolved, 1);
    assert.equal(result.errors, 0);
    assert.equal(runService.get(run.run_id)?.model, 'claude-sonnet-5');

    // Idempotent: a second pass finds nothing left to resolve.
    const second = await resolveUnresolvedModels({ readUsage: reader });
    assert.equal(second.runsScanned, 0);
  } finally {
    await temp.restore();
  }
});

test('generation-agnostic claude aliases (not just "default") get normalized to their resolved model', async () => {
  const temp = await useTempDatabase();
  try {
    seedSession({ sessionId: 'sess-alias-sonnet', provider: 'claude', createdAt: '2026-07-06T00:00:00.000Z' });
    const sonnetRun = runService.create({
      source: 'chat',
      provider: 'claude',
      model: 'sonnet',
      appSessionId: 'sess-alias-sonnet',
    });

    // Live path: a token_budget event reporting the resolved model must
    // supersede the 'sonnet' alias, not just the literal 'default' sentinel.
    recordNormalizedRunEvent(
      sonnetRun.run_id,
      tokenBudgetMessage('claude', {
        billedInputTokens: 300,
        billedOutputTokens: 40,
        model: 'claude-sonnet-5',
      }),
      'chat',
    );
    assert.equal(runService.get(sonnetRun.run_id)?.model, 'claude-sonnet-5');

    // Historical path: an already-token-covered run stuck on an alias
    // ('opus[1m]') gets swept up by resolveUnresolvedModels, not just 'default'.
    seedSession({ sessionId: 'sess-alias-opus', provider: 'claude', createdAt: '2026-07-07T00:00:00.000Z' });
    const opusRun = runService.create({
      source: 'chat',
      provider: 'claude',
      model: 'opus[1m]',
      appSessionId: 'sess-alias-opus',
    });
    runService.attachUsage(opusRun.run_id, { input: 900, output: 90, total: 990 });

    const reader: HistoricalUsageReader = (session) =>
      session.session_id === 'sess-alias-opus'
        ? { input: 900, output: 90, model: 'claude-opus-5[1m]' }
        : null;
    const result = await resolveUnresolvedModels({ readUsage: reader });
    assert.equal(result.runsResolved, 1);
    assert.equal(runService.get(opusRun.run_id)?.model, 'claude-opus-5[1m]');

    // A resolved model that happens to equal another alias must never be
    // written back over a real value — only genuine resolved ids apply.
    seedSession({ sessionId: 'sess-alias-noop', provider: 'claude', createdAt: '2026-07-08T00:00:00.000Z' });
    const noopRun = runService.create({
      source: 'chat',
      provider: 'claude',
      model: 'haiku',
      appSessionId: 'sess-alias-noop',
    });
    recordNormalizedRunEvent(
      noopRun.run_id,
      tokenBudgetMessage('claude', { billedInputTokens: 5, billedOutputTokens: 1, model: 'sonnet' }),
      'chat',
    );
    assert.equal(runService.get(noopRun.run_id)?.model, 'haiku', 'an alias-shaped "resolved" value must not overwrite');
  } finally {
    await temp.restore();
  }
});

test('readHistoricalSessionUsage recovers the resolved model from a real codex session JSONL', async () => {
  const temp = await useTempDatabase();
  try {
    const jsonlPath = path.join(temp.directory, 'codex-session.jsonl');
    const lines = [
      { type: 'session_meta', payload: { model_provider: 'openai' } },
      { type: 'turn_context', payload: { model: 'gpt-5.6-luna' } },
      {
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            last_token_usage: { input_tokens: 400, output_tokens: 50, total_tokens: 450 },
            total_token_usage: { input_tokens: 4000, output_tokens: 500, total_tokens: 4500 },
          },
        },
      },
      // A later turn switched models — the LAST turn_context wins.
      { type: 'turn_context', payload: { model: 'gpt-5.6-sol' } },
      {
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            last_token_usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
            total_token_usage: { input_tokens: 4100, output_tokens: 520, total_tokens: 4620 },
          },
        },
      },
    ];
    await writeFile(jsonlPath, lines.map((line) => JSON.stringify(line)).join('\n'));

    const session: BackfillSessionRow = {
      session_id: 'sess-codex-real',
      provider: 'codex',
      provider_session_id: 'sess-codex-real',
      project_path: null,
      runtime_project_path: null,
      jsonl_path: jsonlPath,
      created_at: '2026-07-01T00:00:00.000Z',
    };
    const snapshot = await readHistoricalSessionUsage(session);
    assert.ok(snapshot);
    assert.equal(snapshot!.model, 'gpt-5.6-sol', 'the most recent turn_context model wins');
    assert.equal(snapshot!.input, 4100);
    assert.equal(snapshot!.output, 520);
  } finally {
    await temp.restore();
  }
});

test('backfillHistoricalRunTokens computes and attaches a cost estimate for a recovered model', async () => {
  const temp = await useTempDatabase();
  try {
    seedSession({ sessionId: 'sess-cost-claude', provider: 'claude', createdAt: '2026-07-09T00:00:00.000Z' });
    const reader: HistoricalUsageReader = (session) =>
      session.session_id === 'sess-cost-claude'
        ? { input: 1_000_000, output: 200_000, model: 'claude-sonnet-5' }
        : null;

    const result = await backfillHistoricalRunTokens({ readUsage: reader });
    assert.equal(result.runsCreated, 1);

    const created = getConnection()
      .prepare(`SELECT run_id, cost_usd_estimate FROM agent_runs WHERE source = 'history'`)
      .get() as { run_id: string; cost_usd_estimate: number };
    // claude-sonnet-5: $2/M in, $10/M out -> 1M*2 + 0.2M*10 = 2 + 2 = 4
    assert.equal(created.cost_usd_estimate, 4);
  } finally {
    await temp.restore();
  }
});

test('backfillHistoricalRunTokens prefers a provider-reported real cost over the pricing-table estimate', async () => {
  const temp = await useTempDatabase();
  try {
    seedSession({ sessionId: 'sess-cost-real', provider: 'opencode', createdAt: '2026-07-09T00:00:00.000Z' });
    // OpenCode's own billed cost (1.10) deliberately differs from what our
    // pricing table would estimate for this input/output — the real value
    // must win.
    const reader: HistoricalUsageReader = (session) =>
      session.session_id === 'sess-cost-real'
        ? { input: 151_920, output: 8_377, model: 'kimi-k3', costUsdEstimate: 1.1025642 }
        : null;

    await backfillHistoricalRunTokens({ readUsage: reader });
    const created = getConnection()
      .prepare(`SELECT cost_usd_estimate FROM agent_runs WHERE source = 'history'`)
      .get() as { cost_usd_estimate: number };
    assert.equal(created.cost_usd_estimate, 1.1025642);
  } finally {
    await temp.restore();
  }
});

test('backfillMissingCosts retroactively prices runs that already had a resolved model but no cost', async () => {
  const temp = await useTempDatabase();
  try {
    seedSession({ sessionId: 'sess-retro-cost', provider: 'claude', createdAt: '2026-07-10T00:00:00.000Z' });
    const run = runService.create({
      source: 'chat',
      provider: 'claude',
      model: 'claude-opus-5',
      appSessionId: 'sess-retro-cost',
    });
    runService.attachUsage(run.run_id, { input: 2_000_000, output: 100_000, total: 2_100_000 });
    assert.equal(runService.get(run.run_id)?.cost_usd_estimate, null);

    const result = backfillMissingCosts();
    assert.equal(result.runsUpdated, 1);
    // claude-opus-5: $5/M in, $25/M out -> 2M*5 + 0.1M*25 = 10 + 2.5 = 12.5
    assert.equal(runService.get(run.run_id)?.cost_usd_estimate, 12.5);

    // Idempotent: already-priced rows are not re-scanned.
    const second = backfillMissingCosts();
    assert.equal(second.runsScanned, 0);
  } finally {
    await temp.restore();
  }
});

test('backfillMissingCosts prices a run at the rate in effect when it happened, not the rate current when backfilled', async () => {
  const temp = await useTempDatabase();
  try {
    // A July run — inside claude-sonnet-5's $2/$10 introductory window,
    // which ends 2026-09-01 in the pricing table. Backfilling this run
    // (however long after the fact, even after the table's rate has since
    // changed) must never charge it the later $3/$15 rate.
    seedSession({ sessionId: 'sess-old-era', provider: 'claude', createdAt: '2026-07-01T00:00:00.000Z' });
    const julyRun = runService.create({
      source: 'chat',
      provider: 'claude',
      model: 'claude-sonnet-5',
      appSessionId: 'sess-old-era',
    });
    getConnection()
      .prepare(`UPDATE agent_runs SET created_at = ? WHERE run_id = ?`)
      .run('2026-07-01T00:00:00.000Z', julyRun.run_id);
    runService.attachUsage(julyRun.run_id, { input: 1_000_000, output: 500_000, total: 1_500_000 });

    // A run from after the rate change, same model.
    seedSession({ sessionId: 'sess-new-era', provider: 'claude', createdAt: '2026-10-01T00:00:00.000Z' });
    const octoberRun = runService.create({
      source: 'chat',
      provider: 'claude',
      model: 'claude-sonnet-5',
      appSessionId: 'sess-new-era',
    });
    getConnection()
      .prepare(`UPDATE agent_runs SET created_at = ? WHERE run_id = ?`)
      .run('2026-10-01T00:00:00.000Z', octoberRun.run_id);
    runService.attachUsage(octoberRun.run_id, { input: 1_000_000, output: 500_000, total: 1_500_000 });

    const result = backfillMissingCosts();
    assert.equal(result.runsUpdated, 2);
    // July: $2/M in, $10/M out -> 1*2 + 0.5*10 = 7
    assert.equal(runService.get(julyRun.run_id)?.cost_usd_estimate, 7);
    // October: $3/M in, $15/M out -> 1*3 + 0.5*15 = 10.5
    assert.equal(runService.get(octoberRun.run_id)?.cost_usd_estimate, 10.5);
  } finally {
    await temp.restore();
  }
});

test('a live token_budget event computes cost alongside resolving the model', async () => {
  const temp = await useTempDatabase();
  try {
    seedSession({ sessionId: 'sess-live-cost', provider: 'claude', createdAt: '2026-07-11T00:00:00.000Z' });
    const run = runService.create({
      source: 'chat',
      provider: 'claude',
      model: 'default',
      appSessionId: 'sess-live-cost',
    });

    recordNormalizedRunEvent(
      run.run_id,
      tokenBudgetMessage('claude', {
        billedInputTokens: 1_000_000,
        billedOutputTokens: 100_000,
        model: 'claude-haiku-4-5',
      }),
      'chat',
    );

    const updated = runService.get(run.run_id);
    assert.equal(updated?.model, 'claude-haiku-4-5');
    // claude-haiku-4-5: $1/M in, $5/M out -> 1*1 + 0.1*5 = 1.5
    assert.equal(updated?.cost_usd_estimate, 1.5);
  } finally {
    await temp.restore();
  }
});

test('a live token_budget event with a cache split prices the cache read cheap and stores the split', async () => {
  const temp = await useTempDatabase();
  try {
    seedSession({ sessionId: 'sess-live-cache', provider: 'claude', createdAt: '2026-07-12T00:00:00.000Z' });
    const run = runService.create({
      source: 'chat',
      provider: 'claude',
      model: 'claude-sonnet-5',
      appSessionId: 'sess-live-cache',
    });
    // Pin inside the introductory rate window — recordProviderUsage prices
    // off run.created_at, and this must not silently start asserting the
    // wrong number once real wall-clock time passes 2026-09-01.
    getConnection()
      .prepare(`UPDATE agent_runs SET created_at = ? WHERE run_id = ?`)
      .run('2026-07-12T00:00:00.000Z', run.run_id);

    recordNormalizedRunEvent(
      run.run_id,
      tokenBudgetMessage('claude', {
        billedInputTokens: 1_000_000,
        billedOutputTokens: 0,
        cacheReadTokens: 900_000,
        cacheCreationTokens: 0,
        model: 'claude-sonnet-5',
      }),
      'chat',
    );

    const updated = runService.get(run.run_id);
    assert.equal(updated?.token_cache_read, 900_000);
    // 100k plain @ $2/M + 900k cache-read @ $0.2/M = 0.2 + 0.18 = 0.38 — far
    // below the $2 it would cost with no cache credit at all.
    assert.equal(updated?.cost_usd_estimate, 0.38);
  } finally {
    await temp.restore();
  }
});

test('readHistoricalSessionUsage recovers the cache split from a real claude session JSONL', async () => {
  const temp = await useTempDatabase();
  try {
    const jsonlPath = path.join(temp.directory, 'claude-session.jsonl');
    const lines = [
      {
        type: 'assistant',
        message: {
          model: 'claude-opus-5',
          usage: {
            input_tokens: 50_000,
            cache_read_input_tokens: 900_000,
            cache_creation_input_tokens: 50_000,
            output_tokens: 2_000,
          },
        },
      },
    ];
    await writeFile(jsonlPath, lines.map((line) => JSON.stringify(line)).join('\n'));

    const session: BackfillSessionRow = {
      session_id: 'sess-claude-cache-real',
      provider: 'claude',
      provider_session_id: 'sess-claude-cache-real',
      project_path: null,
      runtime_project_path: null,
      jsonl_path: jsonlPath,
      created_at: '2026-07-01T00:00:00.000Z',
    };
    const snapshot = await readHistoricalSessionUsage(session);
    assert.ok(snapshot);
    // Claude's own reader sums input_tokens + both cache fields into `input`.
    assert.equal(snapshot!.input, 50_000 + 900_000 + 50_000);
    assert.equal(snapshot!.cacheReadTokens, 900_000);
    assert.equal(snapshot!.cacheCreationTokens, 50_000);
  } finally {
    await temp.restore();
  }
});
