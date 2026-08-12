/**
 * Durable backfill of historical provider token spend into agent_runs.token_*.
 *
 * Why this exists
 * ---------------
 * globalStats token KPIs are pure SQL over agent_runs (SUM of token_*). Live
 * persistence only started writing those columns when token_budget events
 * began flowing through recordNormalizedRunEvent. Older sessions still show
 * up in conversationCount (sessions table) but contribute 0 tokens.
 *
 * Historical spend already lives on provider disk — the same readers the
 * GET .../token-usage route uses. This module copies that spend into
 * agent_runs once so the dashboard stays SQL-only and does not re-hit the
 * filesystem on every stats request.
 *
 * Attribution rules
 * -----------------
 * - One row per session: full session totals are absolute snapshots. We never
 *   re-apply delta accumulation across multiple runs for the same session.
 * - Prefer an existing run linked by app_session_id (latest created_at).
 * - If the session has no runs, create a synthetic terminal run (source
 *   `history`) stamped with the session's created_at so date filters work.
 *   `runs.repository.ts`'s globalStats() excludes source='history' rows from
 *   every non-token dimension (runs/duration/cost/status/byHour) — see the
 *   comment there — so this never inflates totalRuns/successRate/avgDuration.
 * - `runs-maintenance.service.ts`'s retention sweep excludes source='history'
 *   rows outright: they are stamped with the session's original (often very
 *   old) timestamp by design, and deleting+recreating them nightly would be
 *   a permanent churn loop.
 * - Skip sessions that already have any non-null token_total on a linked run
 *   (live path already owns those numbers).
 * - A session confirmed unrecoverable (no usable disk snapshot) still gets a
 *   durable token_total=0 marker (existing run patched, or a zero synthetic
 *   run created) — never left permanently NULL. `listSessionsNeedingTokenBackfill`
 *   selects on "NOT EXISTS a run with non-null token_total", so an
 *   unmarked, unrecoverable session would be re-selected by every single
 *   future pass, permanently occupying a slot in the newest-first LIMIT
 *   window and starving genuinely recoverable older sessions from ever being
 *   reached. The marker makes each pass a net forward advance.
 * - Merge with Math.max so re-runs never lower a more complete live value.
 * - Session totals are always applied as absolute snapshots (not delta),
 *   including for Claude — readClaudeSessionTokenUsage already sums turns.
 */

import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';

import { getConnection } from '@/modules/database/index.js';
import { readTokenBudgetUsage, type ProviderUsageSnapshot } from '@/modules/runs/runs-usage.js';
import { runsDb } from '@/modules/runs/runs.repository.js';
import { runService } from '@/modules/runs/runs.service.js';
import type { AgentRun, TokenUsage } from '@/modules/runs/runs.types.js';
import { getOpenCodeDatabasePath } from '@/shared/utils.js';

/** Providers whose disk stores we know how to read. */
const BACKFILL_PROVIDERS = new Set(['claude', 'codex', 'kimi', 'grok', 'opencode']);

/** Default batch size so a large session table does not block boot forever. */
const DEFAULT_LIMIT = 500;

/** Meta flag written on synthetic / backfilled rows for observability. */
export const TOKEN_BACKFILL_META_KEY = 'tokenBackfill';

const ZERO_SNAPSHOT: ProviderUsageSnapshot = { input: 0, output: 0 };

export type BackfillSessionRow = {
  session_id: string;
  provider: string;
  provider_session_id: string | null;
  project_path: string | null;
  runtime_project_path: string | null;
  jsonl_path: string | null;
  created_at: string;
};

export type HistoricalUsageReader = (
  session: BackfillSessionRow,
) => ProviderUsageSnapshot | null | Promise<ProviderUsageSnapshot | null>;

export type BackfillHistoricalTokensOptions = {
  /** Max sessions to consider in this pass (default 500). */
  limit?: number;
  /**
   * Override the disk reader — tests inject fixed snapshots so they never
   * touch ~/.claude / ~/.codex / etc.
   */
  readUsage?: HistoricalUsageReader;
  /** When true, do not create synthetic runs (only fill existing null-token runs). */
  skipSyntheticRuns?: boolean;
};

export type BackfillHistoricalTokensResult = {
  sessionsScanned: number;
  sessionsWithUsage: number;
  runsUpdated: number;
  runsCreated: number;
  sessionsSkipped: number;
  /** Unrecoverable sessions durably marked (token_total=0) so future passes advance past them. */
  sessionsMarkedUnrecoverable: number;
  errors: number;
};

const SQLITE_UTC_TIMESTAMP_REGEX = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

/** Normalize sessions.created_at (ISO or SQLite CURRENT_TIMESTAMP) to ISO-8601. */
export function normalizeSessionTimestamp(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalized = SQLITE_UTC_TIMESTAMP_REGEX.test(value)
    ? `${value.replace(' ', 'T')}Z`
    : value;
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

function nowIso(): string {
  return new Date().toISOString();
}

function resolveProjectId(projectPath: string | null | undefined): string | null {
  if (!projectPath) return null;
  const db = getConnection();
  const row = db
    .prepare(`SELECT project_id FROM projects WHERE project_path = ? LIMIT 1`)
    .get(projectPath) as { project_id: string } | undefined;
  return row?.project_id ?? null;
}

/**
 * Sessions that still lack any linked run with non-null token_total.
 * Newest first so recent gaps fill before deep history when the limit bites
 * — forward progress into deeper history across passes comes from durably
 * marking unrecoverable sessions (see markSessionUnrecoverable), not from
 * changing this order.
 */
export function listSessionsNeedingTokenBackfill(limit: number): BackfillSessionRow[] {
  const db = getConnection();
  const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.trunc(limit) : DEFAULT_LIMIT;
  return db
    .prepare(
      `SELECT
         s.session_id,
         s.provider,
         s.provider_session_id,
         s.project_path,
         s.runtime_project_path,
         s.jsonl_path,
         s.created_at
       FROM sessions s
       WHERE COALESCE(s.provider, 'claude') IN ('claude', 'codex', 'kimi', 'grok', 'opencode')
         AND NOT EXISTS (
           SELECT 1 FROM agent_runs r
           WHERE r.app_session_id = s.session_id
             AND r.token_total IS NOT NULL
         )
       ORDER BY s.created_at DESC
       LIMIT ?`,
    )
    .all(safeLimit) as BackfillSessionRow[];
}

/** Latest run for a session (for single-attribution writes). */
function findLatestRunForSession(sessionId: string): AgentRun | null {
  const db = getConnection();
  const row = db
    .prepare(
      `SELECT run_id FROM agent_runs
       WHERE app_session_id = ?
       ORDER BY created_at DESC, run_id DESC
       LIMIT 1`,
    )
    .get(sessionId) as { run_id: string } | undefined;
  return row ? runsDb.getById(row.run_id) : null;
}

/**
 * Absolute snapshot merge: never lower existing live values, never delta-add.
 * Returns null when the row would not change.
 */
export function mergeBackfillUsage(
  current: { token_input: number | null; token_output: number | null },
  snapshot: ProviderUsageSnapshot,
): TokenUsage | null {
  const input = Math.max(current.token_input ?? 0, snapshot.input);
  const output = Math.max(current.token_output ?? 0, snapshot.output);
  const unchanged =
    current.token_input != null &&
    current.token_output != null &&
    input === current.token_input &&
    output === current.token_output;
  if (unchanged) return null;
  return { input, output, total: input + output };
}

function applyUsageToRun(run: AgentRun, snapshot: ProviderUsageSnapshot): boolean {
  const merged = mergeBackfillUsage(run, snapshot);
  if (!merged) return false;
  // Direct DB write — no extra token.usage timeline event (same rationale as
  // recordProviderUsage for chatty snapshots).
  runsDb.attachUsage(run.run_id, merged);
  return true;
}

function patchRunTimestamps(
  runId: string,
  createdAt: string | null,
  finishedAt: string | null,
): void {
  if (!createdAt && !finishedAt) return;
  const db = getConnection();
  db.prepare(
    `UPDATE agent_runs SET
       created_at = COALESCE(?, created_at),
       started_at = COALESCE(?, started_at),
       finished_at = COALESCE(?, finished_at),
       updated_at = COALESCE(?, updated_at)
     WHERE run_id = ?`,
  ).run(createdAt, createdAt, finishedAt ?? createdAt, finishedAt ?? createdAt, runId);
}

function createSyntheticHistoryRun(
  session: BackfillSessionRow,
  snapshot: ProviderUsageSnapshot,
): AgentRun {
  const projectId =
    resolveProjectId(session.project_path) ?? resolveProjectId(session.runtime_project_path);
  const createdAt = normalizeSessionTimestamp(session.created_at) ?? nowIso();
  const run = runService.create({
    source: 'history',
    projectId,
    appSessionId: session.session_id,
    provider: session.provider || null,
    status: 'succeeded',
    title: 'Historical session usage',
    trigger: 'token_backfill',
    meta: {
      [TOKEN_BACKFILL_META_KEY]: true,
      tokenBackfillAt: nowIso(),
      providerSessionId: session.provider_session_id,
    },
  });
  patchRunTimestamps(run.run_id, createdAt, createdAt);
  runsDb.attachUsage(run.run_id, {
    input: snapshot.input,
    output: snapshot.output,
    total: snapshot.input + snapshot.output,
  });
  const updated = runsDb.getById(run.run_id);
  if (!updated) {
    throw new Error(`Failed to re-load synthetic run ${run.run_id}`);
  }
  return updated;
}

/**
 * Durably record "attempted this session, nothing recoverable" so the next
 * pass's `listSessionsNeedingTokenBackfill` excludes it and advances into
 * deeper history instead of re-selecting the same unrecoverable head slots
 * forever. Prefers patching an existing null-token run over creating a new
 * one, matching the normal attribution rule.
 */
function markSessionUnrecoverable(session: BackfillSessionRow): void {
  const existing = findLatestRunForSession(session.session_id);
  if (existing) {
    if (existing.token_total == null) {
      runsDb.attachUsage(existing.run_id, { input: 0, output: 0, total: 0 });
    }
    return;
  }
  createSyntheticHistoryRun(session, ZERO_SNAPSHOT);
}

// ---------------------------------------------------------------------------
// Default disk readers (mirrors GET /api/projects/:id/sessions/:id/token-usage)
// ---------------------------------------------------------------------------

function findCodexSessionFile(providerSessionId: string, jsonlPath: string | null): string | null {
  if (jsonlPath && fsSync.existsSync(jsonlPath)) {
    return jsonlPath;
  }
  const root = path.join(os.homedir(), '.codex', 'sessions');
  if (!fsSync.existsSync(root)) return null;

  const stack: string[] = [root];
  let visited = 0;
  const MAX_ENTRIES = 50_000;
  while (stack.length > 0 && visited < MAX_ENTRIES) {
    const dir = stack.pop()!;
    let entries: fsSync.Dirent[];
    try {
      entries = fsSync.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      visited += 1;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.name.includes(providerSessionId) && entry.name.endsWith('.jsonl')) {
        return full;
      }
    }
  }
  return null;
}

async function readCodexHistoricalUsage(
  session: BackfillSessionRow,
  providerSessionId: string,
): Promise<ProviderUsageSnapshot | null> {
  const sessionFilePath = findCodexSessionFile(providerSessionId, session.jsonl_path);
  if (!sessionFilePath) return null;
  let content: string;
  try {
    content = fsSync.readFileSync(sessionFilePath, 'utf8');
  } catch {
    return null;
  }
  const lines = content.trim().split('\n');
  let latestTokenInfo: Record<string, unknown> | null = null;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      const entry = JSON.parse(lines[i]) as {
        type?: string;
        payload?: { type?: string; info?: Record<string, unknown> };
      };
      if (entry.type === 'event_msg' && entry.payload?.type === 'token_count' && entry.payload?.info) {
        latestTokenInfo = entry.payload.info;
        break;
      }
    } catch {
      // skip
    }
  }
  if (!latestTokenInfo) return null;
  const { buildCodexTokenUsage } = await import('@/modules/providers/index.js');
  const usage = buildCodexTokenUsage({
    total: latestTokenInfo.total_token_usage,
    last: latestTokenInfo.last_token_usage,
    modelContextWindow: latestTokenInfo.model_context_window,
  });
  return readTokenBudgetUsage(usage);
}

function readOpenCodeHistoricalUsage(providerSessionId: string): ProviderUsageSnapshot | null {
  const dbPath = getOpenCodeDatabasePath();
  if (!fsSync.existsSync(dbPath)) return null;
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const columns = db.prepare('PRAGMA table_info(session)').all() as { name: string }[];
    const columnNames = new Set(columns.map((column) => column.name));
    const requiredColumns = [
      'tokens_input',
      'tokens_output',
      'tokens_reasoning',
      'tokens_cache_read',
      'tokens_cache_write',
    ];
    if (!requiredColumns.every((column) => columnNames.has(column))) {
      // Fall back to message aggregation is heavy; leave null when columns missing.
      return null;
    }
    const row = db
      .prepare(
        `SELECT
           tokens_input AS inputTokens,
           tokens_output AS outputTokens,
           tokens_reasoning AS reasoningTokens,
           tokens_cache_read AS cacheReadTokens,
           tokens_cache_write AS cacheWriteTokens
         FROM session
         WHERE id = ?`,
      )
      .get(providerSessionId) as
      | {
          inputTokens: number;
          outputTokens: number;
          reasoningTokens: number;
          cacheReadTokens: number;
          cacheWriteTokens: number;
        }
      | undefined;
    if (!row) return null;
    const input = Number(row.inputTokens || 0) + Number(row.cacheReadTokens || 0);
    const output = Number(row.outputTokens || 0);
    if (input <= 0 && output <= 0) return null;
    return { input, output };
  } catch {
    return null;
  } finally {
    db.close();
  }
}

/**
 * Best-effort provider-disk reader. Never throws — missing files / unsupported
 * providers return null so a single bad session cannot abort the batch.
 */
export async function readHistoricalSessionUsage(
  session: BackfillSessionRow,
): Promise<ProviderUsageSnapshot | null> {
  const provider = (session.provider || 'claude').toLowerCase();
  if (!BACKFILL_PROVIDERS.has(provider)) return null;
  const providerSessionId = session.provider_session_id || session.session_id;
  if (!providerSessionId) return null;

  try {
    if (provider === 'claude') {
      let jsonlPath = session.jsonl_path;
      if (!jsonlPath && session.project_path) {
        const encoded = session.project_path.replace(/[^a-zA-Z0-9-]/g, '-');
        jsonlPath = path.join(
          os.homedir(),
          '.claude',
          'projects',
          encoded,
          `${providerSessionId}.jsonl`,
        );
      }
      if (!jsonlPath || !fsSync.existsSync(jsonlPath)) return null;
      const { readClaudeSessionTokenUsage } = await import('@/modules/providers/index.js');
      return readTokenBudgetUsage(readClaudeSessionTokenUsage(jsonlPath));
    }

    if (provider === 'codex') {
      return readCodexHistoricalUsage(session, providerSessionId);
    }

    if (provider === 'kimi') {
      const { findKimiSessionDir, readKimiSessionTokenUsage } = await import('@/modules/providers/index.js');
      const kimiDir = findKimiSessionDir(providerSessionId);
      if (!kimiDir) return null;
      return readTokenBudgetUsage(readKimiSessionTokenUsage(kimiDir));
    }

    if (provider === 'grok') {
      const projectPath = session.runtime_project_path || session.project_path;
      if (!projectPath) return null;
      const { readGrokSessionTokenUsage, resolveGrokSessionDir } = await import('@/modules/providers/index.js');
      const grokDir = resolveGrokSessionDir(projectPath, providerSessionId);
      if (!fsSync.existsSync(grokDir)) return null;
      return readTokenBudgetUsage(readGrokSessionTokenUsage(grokDir));
    }

    if (provider === 'opencode') {
      return readOpenCodeHistoricalUsage(providerSessionId);
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Copy recoverable historical session spend into agent_runs.
 *
 * Safe to call repeatedly: sessions that already have token coverage are
 * skipped, and writes use Math.max so higher live values win.
 */
export async function backfillHistoricalRunTokens(
  options: BackfillHistoricalTokensOptions = {},
): Promise<BackfillHistoricalTokensResult> {
  const limit = options.limit ?? DEFAULT_LIMIT;
  const readUsage = options.readUsage ?? readHistoricalSessionUsage;
  const result: BackfillHistoricalTokensResult = {
    sessionsScanned: 0,
    sessionsWithUsage: 0,
    runsUpdated: 0,
    runsCreated: 0,
    sessionsSkipped: 0,
    sessionsMarkedUnrecoverable: 0,
    errors: 0,
  };

  let candidates: BackfillSessionRow[];
  try {
    candidates = listSessionsNeedingTokenBackfill(limit);
  } catch (error) {
    console.error('[Runs] token backfill: failed to list sessions', error);
    result.errors += 1;
    return result;
  }

  for (const session of candidates) {
    result.sessionsScanned += 1;
    try {
      const snapshot = await readUsage(session);
      if (!snapshot || (snapshot.input <= 0 && snapshot.output <= 0)) {
        result.sessionsSkipped += 1;
        if (!options.skipSyntheticRuns) {
          markSessionUnrecoverable(session);
          result.sessionsMarkedUnrecoverable += 1;
        }
        continue;
      }
      result.sessionsWithUsage += 1;

      const existing = findLatestRunForSession(session.session_id);
      if (existing) {
        // Re-check: another path may have filled tokens between list and now.
        if (existing.token_total != null) {
          result.sessionsSkipped += 1;
          continue;
        }
        if (applyUsageToRun(existing, snapshot)) {
          result.runsUpdated += 1;
        } else {
          result.sessionsSkipped += 1;
        }
        continue;
      }

      if (options.skipSyntheticRuns) {
        result.sessionsSkipped += 1;
        continue;
      }

      createSyntheticHistoryRun(session, snapshot);
      result.runsCreated += 1;
    } catch (error) {
      result.errors += 1;
      console.error(
        `[Runs] token backfill failed for session ${session.session_id}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  return result;
}

let backfillInFlight: Promise<BackfillHistoricalTokensResult> | null = null;

/**
 * Fire-and-forget backfill suitable for server boot. Coalesces concurrent
 * callers onto a single in-flight pass.
 */
export function scheduleHistoricalTokenBackfill(
  options: BackfillHistoricalTokensOptions = {},
): Promise<BackfillHistoricalTokensResult> {
  if (backfillInFlight) return backfillInFlight;
  backfillInFlight = backfillHistoricalRunTokens(options)
    .then((result) => {
      if (result.runsUpdated > 0 || result.runsCreated > 0 || result.errors > 0) {
        console.log('[Runs] historical token backfill', result);
      }
      return result;
    })
    .catch((error) => {
      console.error('[Runs] historical token backfill failed', error);
      return {
        sessionsScanned: 0,
        sessionsWithUsage: 0,
        runsUpdated: 0,
        runsCreated: 0,
        sessionsSkipped: 0,
        sessionsMarkedUnrecoverable: 0,
        errors: 1,
      } satisfies BackfillHistoricalTokensResult;
    })
    .finally(() => {
      backfillInFlight = null;
    });
  return backfillInFlight;
}

/** Test helper: reset the in-flight coalescing latch. */
export function resetHistoricalTokenBackfillLatch(): void {
  backfillInFlight = null;
}
