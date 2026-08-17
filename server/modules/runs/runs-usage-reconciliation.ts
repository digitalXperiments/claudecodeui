/**
 * Reconcile completed Claude runs from the provider's persisted JSONL.
 *
 * Live SDK messages are useful for an in-progress estimate, but they are not a
 * durable accounting ledger: result aggregates can repeat earlier usage and
 * some nested responses are not forwarded live. Claude's session JSONL holds
 * the final billed usage for every assistant API response, including cache
 * splits, so it is the authoritative source once a run has finished.
 */

import fsSync from 'node:fs';

import { getConnection } from '@/modules/database/index.js';
import { CLAUDE_MODEL_ALIASES, readClaudeRunTokenUsage } from '@/modules/providers/index.js';
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

function markReconciled(runId: string): void {
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

function reconcileRow(row: ClaudeRunRow): 'updated' | 'skipped' {
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
  markReconciled(row.run_id);
  return 'updated';
}

/** Repair one just-completed run without waiting for nightly maintenance. */
export function reconcileCompletedClaudeRunUsage(runId: string): boolean {
  const db = getConnection();
  const row = db
    .prepare(
      `SELECT r.run_id, r.model, r.created_at, r.started_at, r.finished_at, s.jsonl_path
       FROM agent_runs r
       JOIN sessions s ON s.session_id = r.app_session_id
       WHERE r.run_id = ?
         AND r.provider = 'claude'
         AND COALESCE(r.source, '') != 'history'
         AND r.finished_at IS NOT NULL`,
    )
    .get(runId) as ClaudeRunRow | undefined;
  return row ? reconcileRow(row) === 'updated' : false;
}
