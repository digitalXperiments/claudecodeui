/**
 * Reconcile completed runs from providers' persisted ledgers.
 *
 * Live SDK/ACP messages are useful for an in-progress estimate, but they are not a
 * durable accounting ledger: result aggregates can repeat earlier usage and
 * some nested responses are not forwarded live.
 *
 * For Claude:
 *   Claude's session JSONL holds the final billed usage for every assistant API
 *   response, including cache splits, so it is authoritative once a run has finished.
 *
 * For Antigravity:
 *   Antigravity's on-disk conversation SQLite stores (<sessionId>.db) hold
 *   Gemini UsageMetadata and concrete model identifiers in `gen_metadata`,
 *   which authoritative reconciliation reads to attach exact token counts and costs.
 */

import fsSync from 'node:fs';

import { getConnection } from '@/modules/database/index.js';
import {
  CLAUDE_MODEL_ALIASES,
  readAntigravityRunSnapshots,
  readClaudeRunTokenUsage,
  resolveAntigravityDbPath,
} from '@/modules/providers/index.js';
import { estimateCostUsd } from '@/modules/runs/model-pricing.js';
import { runsDb } from '@/modules/runs/runs.repository.js';

type ClaudeRunRow = {
  run_id: string;
  model: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string;
  jsonl_path: string | null;
};

const ANTIGRAVITY_MODEL_ALIASES: readonly string[] = ['default'];

type AntigravityRunRow = {
  run_id: string;
  app_session_id: string | null;
  provider_session_id: string | null;
  jsonl_path: string | null;
  model: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
};

function markClaudeReconciled(runId: string): void {
  const db = getConnection();
  db.prepare(
    `UPDATE agent_runs
     SET meta_json = json_set(
       CASE WHEN json_valid(meta_json) THEN meta_json ELSE '{}' END,
       '$.claudeUsageReconciledVersion', ?
     )
     WHERE run_id = ?`,
  ).run(1, runId);
}

function markAntigravityReconciled(runId: string): void {
  const db = getConnection();
  db.prepare(
    `UPDATE agent_runs
     SET meta_json = json_set(
       CASE WHEN json_valid(meta_json) THEN meta_json ELSE '{}' END,
       '$.antigravityUsageReconciledVersion', ?
     )
     WHERE run_id = ?`,
  ).run(1, runId);
}

function reconcileClaudeRow(row: ClaudeRunRow): 'updated' | 'skipped' {
  if (!row.jsonl_path || !fsSync.existsSync(row.jsonl_path)) return 'skipped';
  const usage = readClaudeRunTokenUsage(
    row.jsonl_path,
    row.started_at ?? row.created_at,
    row.finished_at,
  );
  if (!usage) return 'skipped';

  const model = usage.model ?? row.model;
  const cost = estimateCostUsd(
    'claude',
    model,
    usage.billedInputTokens,
    usage.billedOutputTokens,
    row.created_at,
    usage.cacheReadTokens,
    usage.cacheCreationTokens,
  );

  runsDb.attachUsage(row.run_id, {
    input: usage.billedInputTokens,
    output: usage.billedOutputTokens,
    total: usage.billedInputTokens + usage.billedOutputTokens,
    cacheReadTokens: usage.cacheReadTokens,
    cacheCreationTokens: usage.cacheCreationTokens,
    ...(cost != null ? { costUsdEstimate: cost } : {}),
  });
  if (model) runsDb.resolveModel(row.run_id, model, CLAUDE_MODEL_ALIASES);
  markClaudeReconciled(row.run_id);
  return 'updated';
}

/** Repair one just-completed Claude run without waiting for nightly maintenance. */
export function reconcileCompletedClaudeRunUsage(runId: string): boolean {
  const db = getConnection();
  const row = db
    .prepare(
      `SELECT r.run_id, r.model, r.created_at, r.started_at, r.finished_at, s.jsonl_path\n       FROM agent_runs r\n       JOIN sessions s ON s.session_id = r.app_session_id\n       WHERE r.run_id = ?\n         AND r.provider = 'claude'\n         AND COALESCE(r.source, '') != 'history'\n         AND r.finished_at IS NOT NULL`,
    )
    .get(runId) as ClaudeRunRow | undefined;
  return row ? reconcileClaudeRow(row) === 'updated' : false;
}

/** Repair one just-completed Antigravity run. */
export function reconcileCompletedAntigravityRunUsage(runId: string): boolean {
  const db = getConnection();
  const run = db
    .prepare(
      `SELECT r.run_id, r.app_session_id, s.provider_session_id, s.jsonl_path, r.model, r.created_at, r.started_at, r.finished_at
       FROM agent_runs r
       LEFT JOIN sessions s ON s.session_id = r.app_session_id
       WHERE r.run_id = ?
         AND r.provider = 'antigravity'
         AND COALESCE(r.source, '') != 'history'`,
    )
    .get(runId) as AntigravityRunRow | undefined;
  if (!run || !run.app_session_id) return false;

  const sessionRuns = db
    .prepare(
      `SELECT run_id, model, created_at
       FROM agent_runs
       WHERE app_session_id = ?
         AND provider = 'antigravity'
         AND COALESCE(source, '') != 'history'
       ORDER BY created_at ASC, run_id ASC`,
    )
    .all(run.app_session_id) as Array<{ run_id: string; model: string | null; created_at: string }>;

  const turnIndex = sessionRuns.findIndex((r) => r.run_id === runId);
  if (turnIndex < 0) return false;

  const dbPath = resolveAntigravityDbPath(run.jsonl_path || run.provider_session_id || run.app_session_id);
  if (!dbPath) return false;

  const snapshots = readAntigravityRunSnapshots(dbPath);
  if (snapshots.length === 0) return false;

  const snapshotIndex = Math.min(turnIndex, snapshots.length - 1);
  const snapshot = snapshots[snapshotIndex];
  const model = snapshot.model || run.model || 'gemini-3.8-flash-high';
  const cost = estimateCostUsd(
    'antigravity',
    model,
    snapshot.cumulativeInput,
    snapshot.cumulativeOutput,
    run.created_at,
    snapshot.cumulativeCacheRead,
  );

  runsDb.attachUsage(run.run_id, {
    input: snapshot.cumulativeInput,
    output: snapshot.cumulativeOutput,
    total: snapshot.cumulativeInput + snapshot.cumulativeOutput,
    cacheReadTokens: snapshot.cumulativeCacheRead,
    ...(cost != null ? { costUsdEstimate: cost } : {}),
  });
  if (model) {
    runsDb.resolveModel(run.run_id, model, ANTIGRAVITY_MODEL_ALIASES);
  }
  markAntigravityReconciled(run.run_id);
  return true;
}

/**
 * Backfill and reconcile all historical Antigravity runs missing token usage or cost estimates.
 */
export function reconcileAllAntigravityRuns(): number {
  const db = getConnection();
  const unReconciled = db
    .prepare(
      `SELECT r.run_id, r.app_session_id, s.provider_session_id, s.jsonl_path, r.model, r.created_at, r.started_at, r.finished_at
       FROM agent_runs r
       LEFT JOIN sessions s ON s.session_id = r.app_session_id
       WHERE r.provider = 'antigravity'
         AND COALESCE(r.source, '') != 'history'
         AND (
           r.token_total IS NULL
           OR r.cost_usd_estimate IS NULL
           OR json_extract(r.meta_json, '$.antigravityUsageReconciledVersion') IS NULL
         )
       ORDER BY r.app_session_id ASC, r.created_at ASC, r.run_id ASC`,
    )
    .all() as AntigravityRunRow[];

  if (unReconciled.length === 0) return 0;

  const sessionIds = [...new Set(unReconciled.map((r) => r.app_session_id).filter(Boolean))] as string[];
  let updatedCount = 0;

  for (const sessionId of sessionIds) {
    const allSessionRuns = db
      .prepare(
        `SELECT r.run_id, r.model, r.created_at, s.provider_session_id, s.jsonl_path
         FROM agent_runs r
         LEFT JOIN sessions s ON s.session_id = r.app_session_id
         WHERE r.app_session_id = ?
           AND r.provider = 'antigravity'
           AND COALESCE(r.source, '') != 'history'
         ORDER BY r.created_at ASC, r.run_id ASC`,
      )
      .all(sessionId) as Array<{
        run_id: string;
        model: string | null;
        created_at: string;
        provider_session_id: string | null;
        jsonl_path: string | null;
      }>;

    if (allSessionRuns.length === 0) continue;
    const provId = allSessionRuns[0].jsonl_path || allSessionRuns[0].provider_session_id || sessionId;
    const dbPath = resolveAntigravityDbPath(provId);
    if (!dbPath) continue;

    const snapshots = readAntigravityRunSnapshots(dbPath);
    if (snapshots.length === 0) continue;

    for (let i = 0; i < allSessionRuns.length; i++) {
      const run = allSessionRuns[i];
      const needsRec = unReconciled.some((u) => u.run_id === run.run_id);
      if (!needsRec) continue;

      const snapshotIndex = Math.min(i, snapshots.length - 1);
      const snapshot = snapshots[snapshotIndex];
      const model = snapshot.model || run.model || 'gemini-3.8-flash-high';
      const cost = estimateCostUsd(
        'antigravity',
        model,
        snapshot.cumulativeInput,
        snapshot.cumulativeOutput,
        run.created_at,
        snapshot.cumulativeCacheRead,
      );

      runsDb.attachUsage(run.run_id, {
        input: snapshot.cumulativeInput,
        output: snapshot.cumulativeOutput,
        total: snapshot.cumulativeInput + snapshot.cumulativeOutput,
        cacheReadTokens: snapshot.cumulativeCacheRead,
        ...(cost != null ? { costUsdEstimate: cost } : {}),
      });
      if (model) {
        runsDb.resolveModel(run.run_id, model, ANTIGRAVITY_MODEL_ALIASES);
      }
      markAntigravityReconciled(run.run_id);
      updatedCount++;
    }
  }

  return updatedCount;
}
