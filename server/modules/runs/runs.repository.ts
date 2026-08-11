/**
 * better-sqlite3 data access for the canonical run spine (PRD §6.3).
 *
 * All methods are synchronous (better-sqlite3 style) and use the shared
 * connection from the database module. Event sequence numbers are assigned
 * inside a transaction so `seq` stays monotonic per run_id.
 */

import { getConnection } from '@/modules/database/index.js';
import { newEventId, newRunId } from '@/shared/ids.js';
import {
  TERMINAL_RUN_STATUSES,
  type RunEventEnvelope,
  type RunEventSeverity,
  type RunStatus,
} from '@/shared/run-events.js';
import type {
  AgentRun,
  CreateRunInput,
  GlobalRunStats,
  GlobalStatsFilter,
  ProjectRunBudget,
  ProjectRunBudgetInput,
  ProjectRunStats,
  RunListFilter,
  StatsDayBucket,
  StatsHourBucket,
  StatsModelRow,
  StatsProviderRow,
  StatsSourceRow,
  StatsStatusCount,
  TerminalResult,
  TokenUsage,
} from '@/modules/runs/runs.types.js';
import { DEFAULT_STUCK_MINUTES, ORPHAN_ERROR_SUMMARY } from '@/modules/runs/runs.types.js';

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;
const DEFAULT_EVENT_LIMIT = 200;
const MAX_EVENT_LIMIT = 1000;

/** Cap on model breakdown rows so the stats payload stays bounded. */
const MAX_MODEL_ROWS = 100;

/**
 * Wall-clock duration of one run in ms: finished (or now for in-flight runs)
 * minus started (or created). Clamped at 0 to absorb clock skew.
 */
const RUN_DURATION_MS_SQL = `MAX(0, (julianday(COALESCE(finished_at, CURRENT_TIMESTAMP)) - julianday(COALESCE(started_at, created_at))) * 86400000.0)`;

type RunRow = {
  run_id: string;
  project_id: string | null;
  source: string;
  source_ref: string | null;
  workspace_id: string | null;
  app_session_id: string | null;
  provider: string | null;
  model: string | null;
  effort: string | null;
  permission_mode: string | null;
  profile_id: string | null;
  status: string;
  trigger: string | null;
  parent_run_id: string | null;
  root_run_id: string | null;
  title: string | null;
  error_summary: string | null;
  exit_code: number | null;
  token_input: number | null;
  token_output: number | null;
  token_total: number | null;
  cost_usd_estimate: number | null;
  started_at: string | null;
  first_token_at: string | null;
  finished_at: string | null;
  created_at: string;
  updated_at: string;
  meta_json: string | null;
};

type EventRow = {
  event_id: string;
  run_id: string;
  seq: number;
  ts: string;
  source: string | null;
  type: string;
  severity: string | null;
  payload_json: string | null;
};

function nowIso(): string {
  return new Date().toISOString();
}

function parseJsonObject(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function mapRun(row: RunRow): AgentRun {
  return {
    run_id: row.run_id,
    project_id: row.project_id,
    source: row.source,
    source_ref: row.source_ref,
    workspace_id: row.workspace_id,
    app_session_id: row.app_session_id,
    provider: row.provider,
    model: row.model,
    effort: row.effort,
    permission_mode: row.permission_mode,
    profile_id: row.profile_id,
    status: (row.status || 'queued') as RunStatus,
    trigger: row.trigger,
    parent_run_id: row.parent_run_id,
    root_run_id: row.root_run_id,
    title: row.title,
    error_summary: row.error_summary,
    exit_code: row.exit_code,
    token_input: row.token_input,
    token_output: row.token_output,
    token_total: row.token_total,
    cost_usd_estimate: row.cost_usd_estimate,
    started_at: row.started_at,
    first_token_at: row.first_token_at,
    finished_at: row.finished_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
    meta: parseJsonObject(row.meta_json),
  };
}

function mapEvent(row: EventRow): RunEventEnvelope {
  return {
    event_id: row.event_id,
    run_id: row.run_id,
    seq: row.seq,
    ts: row.ts,
    source: (row.source || 'system') as RunEventEnvelope['source'],
    type: row.type,
    severity: (row.severity || 'info') as RunEventSeverity,
    payload: parseJsonObject(row.payload_json),
  };
}

/**
 * Opaque keyset cursor over (created_at DESC, run_id DESC). run_id is a ULID,
 * so it is a deterministic tiebreaker for rows sharing a created_at stamp.
 */
type CursorPosition = { created_at: string; run_id: string };

function encodeCursor(position: CursorPosition): string {
  return Buffer.from(JSON.stringify(position), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): CursorPosition | null {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof parsed.created_at === 'string' &&
      typeof parsed.run_id === 'string'
    ) {
      return { created_at: parsed.created_at, run_id: parsed.run_id };
    }
    return null;
  } catch {
    return null;
  }
}

function clampLimit(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.trunc(value), 1), max);
}

export const runsDb = {
  create(input: CreateRunInput): AgentRun {
    const db = getConnection();
    const runId = input.runId ?? newRunId();
    const now = nowIso();
    db.prepare(
      `INSERT INTO agent_runs (
        run_id, project_id, source, source_ref, workspace_id, app_session_id,
        provider, model, effort, permission_mode, profile_id, status,
        trigger, parent_run_id, root_run_id, title,
        created_at, updated_at, meta_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      runId,
      input.projectId ?? null,
      input.source,
      input.sourceRef ?? null,
      input.workspaceId ?? null,
      input.appSessionId ?? null,
      input.provider ?? null,
      input.model ?? null,
      input.effort ?? null,
      input.permissionMode ?? null,
      input.profileId ?? null,
      input.status ?? 'queued',
      input.trigger ?? null,
      input.parentRunId ?? null,
      input.rootRunId ?? null,
      input.title ?? null,
      now,
      now,
      JSON.stringify(input.meta ?? {}),
    );
    const created = this.getById(runId);
    if (!created) {
      throw new Error('Failed to create agent run');
    }
    return created;
  },

  getById(runId: string): AgentRun | null {
    const db = getConnection();
    const row = db.prepare(`SELECT * FROM agent_runs WHERE run_id = ?`).get(runId) as
      | RunRow
      | undefined;
    return row ? mapRun(row) : null;
  },

  /**
   * Keyset-paginated list ordered by (created_at DESC, run_id DESC).
   * Returns an opaque nextCursor when more rows are available.
   */
  list(filter: RunListFilter): { runs: AgentRun[]; nextCursor?: string } {
    const db = getConnection();
    const limit = clampLimit(filter.limit, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
    const where: string[] = [];
    const params: unknown[] = [];

    if (filter.projectId) {
      where.push(`project_id = ?`);
      params.push(filter.projectId);
    }
    if (filter.status) {
      const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
      if (statuses.length > 0) {
        where.push(`status IN (${statuses.map(() => '?').join(', ')})`);
        params.push(...statuses);
      }
    }
    if (filter.source) {
      where.push(`source = ?`);
      params.push(filter.source);
    }
    if (filter.from) {
      where.push(`created_at >= ?`);
      params.push(filter.from);
    }
    if (filter.to) {
      where.push(`created_at <= ?`);
      params.push(filter.to);
    }
    if (filter.cursor) {
      const position = decodeCursor(filter.cursor);
      if (position) {
        where.push(`(created_at < ? OR (created_at = ? AND run_id < ?))`);
        params.push(position.created_at, position.created_at, position.run_id);
      }
    }

    const sql =
      `SELECT * FROM agent_runs` +
      (where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '') +
      ` ORDER BY created_at DESC, run_id DESC LIMIT ?`;
    const rows = db.prepare(sql).all(...(params as never[]), limit + 1) as RunRow[];

    let nextCursor: string | undefined;
    const page = rows.length > limit ? rows.slice(0, limit) : rows;
    if (rows.length > limit && page.length > 0) {
      const last = page[page.length - 1];
      nextCursor = encodeCursor({ created_at: last.created_at, run_id: last.run_id });
    }
    return { runs: page.map(mapRun), nextCursor };
  },

  updateStatus(runId: string, status: RunStatus, patch: Partial<AgentRun> = {}): void {
    const db = getConnection();
    db.prepare(
      `UPDATE agent_runs SET
        status = ?,
        started_at = COALESCE(?, started_at),
        first_token_at = COALESCE(?, first_token_at),
        finished_at = COALESCE(?, finished_at),
        error_summary = COALESCE(?, error_summary),
        exit_code = COALESCE(?, exit_code),
        title = COALESCE(?, title),
        provider = COALESCE(?, provider),
        model = COALESCE(?, model),
        effort = COALESCE(?, effort),
        permission_mode = COALESCE(?, permission_mode),
        profile_id = COALESCE(?, profile_id),
        workspace_id = COALESCE(?, workspace_id),
        app_session_id = COALESCE(?, app_session_id),
        updated_at = ?
      WHERE run_id = ?`,
    ).run(
      status,
      patch.started_at ?? null,
      patch.first_token_at ?? null,
      patch.finished_at ?? null,
      patch.error_summary ?? null,
      patch.exit_code ?? null,
      patch.title ?? null,
      patch.provider ?? null,
      patch.model ?? null,
      patch.effort ?? null,
      patch.permission_mode ?? null,
      patch.profile_id ?? null,
      patch.workspace_id ?? null,
      patch.app_session_id ?? null,
      nowIso(),
      runId,
    );
  },

  /**
   * Append an event, assigning the next monotonic `seq` for the run inside a
   * transaction. The payload must already be redacted (service layer).
   */
  appendEvent(
    runId: string,
    event: Omit<RunEventEnvelope, 'event_id' | 'seq'>,
  ): RunEventEnvelope {
    const db = getConnection();
    const insert = db.transaction((): RunEventEnvelope => {
      const row = db
        .prepare(`SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq FROM agent_run_events WHERE run_id = ?`)
        .get(runId) as { next_seq: number };
      const stored: RunEventEnvelope = {
        ...event,
        event_id: newEventId(),
        seq: row.next_seq,
      };
      db.prepare(
        `INSERT INTO agent_run_events (event_id, run_id, seq, ts, source, type, severity, payload_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        stored.event_id,
        runId,
        stored.seq,
        stored.ts,
        stored.source,
        stored.type,
        stored.severity ?? 'info',
        JSON.stringify(stored.payload ?? {}),
      );
      return stored;
    });
    return insert();
  },

  listEvents(
    runId: string,
    opts: { afterSeq?: number; limit?: number } = {},
  ): RunEventEnvelope[] {
    const db = getConnection();
    const limit = clampLimit(opts.limit, DEFAULT_EVENT_LIMIT, MAX_EVENT_LIMIT);
    const rows = db
      .prepare(
        `SELECT * FROM agent_run_events
         WHERE run_id = ? AND seq > ?
         ORDER BY seq ASC
         LIMIT ?`,
      )
      .all(runId, opts.afterSeq ?? 0, limit) as EventRow[];
    return rows.map(mapEvent);
  },

  /** Set usage columns from a cumulative snapshot (PRD §6.4 token.usage). */
  attachUsage(runId: string, usage: TokenUsage): void {
    const db = getConnection();
    db.prepare(
      `UPDATE agent_runs SET
        token_input = COALESCE(?, token_input),
        token_output = COALESCE(?, token_output),
        token_total = COALESCE(?, token_total),
        cost_usd_estimate = COALESCE(?, cost_usd_estimate),
        updated_at = ?
      WHERE run_id = ?`,
    ).run(
      usage.input ?? null,
      usage.output ?? null,
      usage.total ?? null,
      usage.costUsdEstimate ?? null,
      nowIso(),
      runId,
    );
  },

  linkSession(runId: string, appSessionId: string): void {
    const db = getConnection();
    db.prepare(`UPDATE agent_runs SET app_session_id = ?, updated_at = ? WHERE run_id = ?`).run(
      appSessionId,
      nowIso(),
      runId,
    );
  },

  linkWorkspace(runId: string, workspaceId: string): void {
    const db = getConnection();
    db.prepare(`UPDATE agent_runs SET workspace_id = ?, updated_at = ? WHERE run_id = ?`).run(
      workspaceId,
      nowIso(),
      runId,
    );
  },

  markTerminal(runId: string, result: TerminalResult): void {
    const db = getConnection();
    db.prepare(
      `UPDATE agent_runs SET
        status = ?, error_summary = ?, exit_code = ?, finished_at = ?, updated_at = ?
      WHERE run_id = ?`,
    ).run(
      result.status,
      result.errorSummary ?? null,
      result.exitCode ?? null,
      nowIso(),
      nowIso(),
      runId,
    );
  },

  /**
   * Runs that were in flight when the server last stopped can never resume —
   * mark them failed. Returns the number of reconciled rows.
   */
  reconcileOrphans(): number {
    const db = getConnection();
    const now = nowIso();
    const result = db
      .prepare(
        `UPDATE agent_runs SET
          status = 'failed', error_summary = ?, finished_at = ?, updated_at = ?
        WHERE status IN ('queued', 'starting', 'running')`,
      )
      .run(ORPHAN_ERROR_SUMMARY, now, now);
    return result.changes;
  },

  /**
   * Last activity timestamp per run (max event ts, else started_at, else created_at).
   * Used for stuck detection without N+1 queries on list.
   */
  lastActivityByRunIds(runIds: string[]): Map<string, string> {
    const map = new Map<string, string>();
    if (runIds.length === 0) return map;
    const db = getConnection();
    const placeholders = runIds.map(() => '?').join(', ');
    const rows = db
      .prepare(
        `SELECT r.run_id AS run_id,
                COALESCE(
                  (SELECT MAX(e.ts) FROM agent_run_events e WHERE e.run_id = r.run_id),
                  r.started_at,
                  r.created_at
                ) AS last_activity
         FROM agent_runs r
         WHERE r.run_id IN (${placeholders})`,
      )
      .all(...runIds) as Array<{ run_id: string; last_activity: string | null }>;
    for (const row of rows) {
      if (row.last_activity) map.set(row.run_id, row.last_activity);
    }
    return map;
  },

  /** Optional tool.call counts for a set of run ids. */
  toolCallCounts(runIds: string[]): Map<string, number> {
    const map = new Map<string, number>();
    if (runIds.length === 0) return map;
    const db = getConnection();
    const placeholders = runIds.map(() => '?').join(', ');
    const rows = db
      .prepare(
        `SELECT run_id, COUNT(*) AS cnt
         FROM agent_run_events
         WHERE run_id IN (${placeholders}) AND type = 'tool.call'
         GROUP BY run_id`,
      )
      .all(...runIds) as Array<{ run_id: string; cnt: number }>;
    for (const row of rows) {
      map.set(row.run_id, Number(row.cnt) || 0);
    }
    return map;
  },

  getBudget(projectId: string): ProjectRunBudget {
    const db = getConnection();
    const row = db
      .prepare(`SELECT * FROM project_run_budgets WHERE project_id = ?`)
      .get(projectId) as
      | {
          project_id: string;
          monthly_token_budget: number | null;
          monthly_cost_usd_budget: number | null;
          stuck_minutes: number;
          created_at: string;
          updated_at: string;
        }
      | undefined;
    if (row) {
      return {
        project_id: row.project_id,
        monthly_token_budget: row.monthly_token_budget,
        monthly_cost_usd_budget: row.monthly_cost_usd_budget,
        stuck_minutes: row.stuck_minutes ?? DEFAULT_STUCK_MINUTES,
        created_at: row.created_at,
        updated_at: row.updated_at,
      };
    }
    const now = nowIso();
    return {
      project_id: projectId,
      monthly_token_budget: null,
      monthly_cost_usd_budget: null,
      stuck_minutes: DEFAULT_STUCK_MINUTES,
      created_at: now,
      updated_at: now,
    };
  },

  putBudget(input: ProjectRunBudgetInput): ProjectRunBudget {
    const db = getConnection();
    const existing = this.getBudget(input.projectId);
    const now = nowIso();
    const monthlyTokenBudget =
      input.monthlyTokenBudget !== undefined
        ? input.monthlyTokenBudget
        : existing.monthly_token_budget;
    const monthlyCostUsdBudget =
      input.monthlyCostUsdBudget !== undefined
        ? input.monthlyCostUsdBudget
        : existing.monthly_cost_usd_budget;
    let stuckMinutes =
      input.stuckMinutes !== undefined && input.stuckMinutes !== null
        ? Math.trunc(input.stuckMinutes)
        : existing.stuck_minutes;
    if (!Number.isFinite(stuckMinutes) || stuckMinutes < 1) {
      stuckMinutes = DEFAULT_STUCK_MINUTES;
    }

    db.prepare(
      `INSERT INTO project_run_budgets (
         project_id, monthly_token_budget, monthly_cost_usd_budget, stuck_minutes, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(project_id) DO UPDATE SET
         monthly_token_budget = excluded.monthly_token_budget,
         monthly_cost_usd_budget = excluded.monthly_cost_usd_budget,
         stuck_minutes = excluded.stuck_minutes,
         updated_at = excluded.updated_at`,
    ).run(
      input.projectId,
      monthlyTokenBudget ?? null,
      monthlyCostUsdBudget ?? null,
      stuckMinutes,
      existing.created_at || now,
      now,
    );
    return this.getBudget(input.projectId);
  },

  /**
   * Efficient single-pass aggregates for Run Observatory header stats.
   */
  projectStats(projectId: string): ProjectRunStats {
    const db = getConnection();
    const stuckMinutes = this.getBudget(projectId).stuck_minutes;
    const stuckCutoff = new Date(Date.now() - stuckMinutes * 60_000).toISOString();

    // Calendar month start (UTC) for monthly token/cost rollups.
    const now = new Date();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();

    const byStatusRows = db
      .prepare(
        `SELECT status, COUNT(*) AS cnt
         FROM agent_runs
         WHERE project_id = ?
         GROUP BY status`,
      )
      .all(projectId) as Array<{ status: string; cnt: number }>;

    const byStatus: Record<string, number> = {};
    let total = 0;
    for (const row of byStatusRows) {
      const n = Number(row.cnt) || 0;
      byStatus[row.status] = n;
      total += n;
    }

    const activeStatuses = [
      'queued',
      'starting',
      'running',
      'waiting_permission',
      'waiting_approval',
    ];
    const activeCount = activeStatuses.reduce((sum, s) => sum + (byStatus[s] || 0), 0);

    const monthRow = db
      .prepare(
        `SELECT
           COALESCE(SUM(token_total), 0) AS tokens_month,
           COALESCE(SUM(cost_usd_estimate), 0) AS cost_month
         FROM agent_runs
         WHERE project_id = ?
           AND created_at >= ?`,
      )
      .get(projectId, monthStart) as { tokens_month: number; cost_month: number };

    const stuckRow = db
      .prepare(
        `SELECT COUNT(*) AS cnt
         FROM agent_runs r
         WHERE r.project_id = ?
           AND r.status IN ('queued', 'starting', 'running', 'waiting_permission', 'waiting_approval')
           AND COALESCE(
             (SELECT MAX(e.ts) FROM agent_run_events e WHERE e.run_id = r.run_id),
             r.started_at,
             r.created_at
           ) < ?`,
      )
      .get(projectId, stuckCutoff) as { cnt: number };

    const avgRow = db
      .prepare(
        `SELECT AVG(
           (julianday(COALESCE(finished_at, CURRENT_TIMESTAMP)) - julianday(COALESCE(started_at, created_at)))
           * 86400000.0
         ) AS avg_ms
         FROM agent_runs
         WHERE project_id = ?
           AND COALESCE(started_at, created_at) IS NOT NULL`,
      )
      .get(projectId) as { avg_ms: number | null };

    const avgDurationMs =
      avgRow.avg_ms != null && Number.isFinite(avgRow.avg_ms)
        ? Math.max(0, Math.round(avgRow.avg_ms))
        : null;

    return {
      total,
      byStatus,
      tokensMonth: Number(monthRow.tokens_month) || 0,
      costMonth: Number(monthRow.cost_month) || 0,
      stuckCount: Number(stuckRow.cnt) || 0,
      activeCount,
      avgDurationMs,
    };
  },

  /**
   * Global cross-project aggregates for the Stats dashboard. Runs a constant
   * set of GROUP BY queries over agent_runs + sessions (no N+1); all date
   * bucketing is UTC (SQLite date()/strftime() on ISO timestamps).
   */
  globalStats(filter: GlobalStatsFilter = {}): GlobalRunStats {
    const db = getConnection();

    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.from) {
      where.push(`created_at >= ?`);
      params.push(filter.from);
    }
    if (filter.to) {
      where.push(`created_at <= ?`);
      params.push(filter.to);
    }
    const whereSql = where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '';

    const overviewRow = db
      .prepare(
        `SELECT
           COUNT(*) AS runs,
           COUNT(token_total) AS runs_with_tokens,
           COALESCE(SUM(token_total), 0) AS tokens,
           COALESCE(SUM(token_input), 0) AS input_tokens,
           COALESCE(SUM(token_output), 0) AS output_tokens,
           COUNT(cost_usd_estimate) AS runs_with_cost,
           SUM(cost_usd_estimate) AS cost,
           COALESCE(SUM(${RUN_DURATION_MS_SQL}), 0) AS duration_ms,
           COUNT(DISTINCT app_session_id) AS active_conversations
         FROM agent_runs${whereSql}`,
      )
      .get(...(params as never[])) as {
      runs: number;
      runs_with_tokens: number;
      tokens: number;
      input_tokens: number;
      output_tokens: number;
      runs_with_cost: number;
      cost: number | null;
      duration_ms: number;
      active_conversations: number;
    };

    const byStatusRows = db
      .prepare(`SELECT status, COUNT(*) AS cnt FROM agent_runs${whereSql} GROUP BY status`)
      .all(...(params as never[])) as Array<{ status: string; cnt: number }>;
    const byStatus: StatsStatusCount[] = byStatusRows.map((row) => ({
      status: row.status,
      count: Number(row.cnt) || 0,
    }));

    const dailyRows = db
      .prepare(
        `SELECT
           date(created_at) AS day,
           COUNT(*) AS runs,
           COALESCE(SUM(token_total), 0) AS tokens,
           COALESCE(SUM(token_input), 0) AS input_tokens,
           COALESCE(SUM(token_output), 0) AS output_tokens,
           COALESCE(SUM(cost_usd_estimate), 0) AS cost,
           COALESCE(SUM(${RUN_DURATION_MS_SQL}), 0) AS duration_ms
         FROM agent_runs${whereSql}
         GROUP BY day
         ORDER BY day ASC`,
      )
      .all(...(params as never[])) as Array<{
      day: string;
      runs: number;
      tokens: number;
      input_tokens: number;
      output_tokens: number;
      cost: number;
      duration_ms: number;
    }>;

    const providerRows = db
      .prepare(
        `SELECT
           provider,
           COUNT(*) AS runs,
           COALESCE(SUM(token_total), 0) AS tokens,
           COALESCE(SUM(token_input), 0) AS input_tokens,
           COALESCE(SUM(token_output), 0) AS output_tokens,
           SUM(cost_usd_estimate) AS cost,
           COALESCE(SUM(${RUN_DURATION_MS_SQL}), 0) AS duration_ms
         FROM agent_runs${whereSql}
         GROUP BY provider
         ORDER BY tokens DESC, runs DESC`,
      )
      .all(...(params as never[])) as Array<{
      provider: string | null;
      runs: number;
      tokens: number;
      input_tokens: number;
      output_tokens: number;
      cost: number | null;
      duration_ms: number;
    }>;

    const modelRows = db
      .prepare(
        `SELECT
           provider,
           model,
           COUNT(*) AS runs,
           COALESCE(SUM(token_total), 0) AS tokens,
           COALESCE(SUM(token_input), 0) AS input_tokens,
           COALESCE(SUM(token_output), 0) AS output_tokens,
           SUM(cost_usd_estimate) AS cost,
           COALESCE(SUM(${RUN_DURATION_MS_SQL}), 0) AS duration_ms
         FROM agent_runs${whereSql}
         GROUP BY provider, model
         ORDER BY tokens DESC, runs DESC
         LIMIT ${MAX_MODEL_ROWS}`,
      )
      .all(...(params as never[])) as Array<{
      provider: string | null;
      model: string | null;
      runs: number;
      tokens: number;
      input_tokens: number;
      output_tokens: number;
      cost: number | null;
      duration_ms: number;
    }>;

    const sourceRows = db
      .prepare(
        `SELECT
           source,
           COUNT(*) AS runs,
           COALESCE(SUM(token_total), 0) AS tokens
         FROM agent_runs${whereSql}
         GROUP BY source
         ORDER BY runs DESC`,
      )
      .all(...(params as never[])) as Array<{ source: string; runs: number; tokens: number }>;

    const hourRows = db
      .prepare(
        `SELECT CAST(strftime('%H', created_at) AS INTEGER) AS hour, COUNT(*) AS runs
         FROM agent_runs${whereSql}
         GROUP BY hour`,
      )
      .all(...(params as never[])) as Array<{ hour: number; runs: number }>;

    // Conversations come from the sessions table (same created_at range).
    const sessionsWhereSql = whereSql;
    const conversationOverviewRow = db
      .prepare(`SELECT COUNT(*) AS cnt FROM sessions${sessionsWhereSql}`)
      .get(...(params as never[])) as { cnt: number };

    const conversationDailyRows = db
      .prepare(
        `SELECT date(created_at) AS day, COUNT(*) AS cnt
         FROM sessions${sessionsWhereSql}
         GROUP BY day`,
      )
      .all(...(params as never[])) as Array<{ day: string; cnt: number }>;

    const conversationProviderRows = db
      .prepare(
        `SELECT provider, COUNT(*) AS cnt
         FROM sessions${sessionsWhereSql}
         GROUP BY provider`,
      )
      .all(...(params as never[])) as Array<{ provider: string | null; cnt: number }>;

    const firstRunRow = db
      .prepare(`SELECT MIN(created_at) AS first_run_at FROM agent_runs`)
      .get() as { first_run_at: string | null };

    // --- Assemble -----------------------------------------------------------

    const totalRuns = Number(overviewRow.runs) || 0;
    const totalTokens = Number(overviewRow.tokens) || 0;
    const runsWithCost = Number(overviewRow.runs_with_cost) || 0;
    const totalDurationMs = Math.round(Number(overviewRow.duration_ms) || 0);
    const activeConversations = Number(overviewRow.active_conversations) || 0;
    const conversationCount = Number(conversationOverviewRow.cnt) || 0;

    const terminalCount = byStatus
      .filter((row) => TERMINAL_RUN_STATUSES.has(row.status as RunStatus))
      .reduce((sum, row) => sum + row.count, 0);
    const succeededCount = byStatus.find((row) => row.status === 'succeeded')?.count ?? 0;

    const conversationsByDay = new Map<string, number>();
    for (const row of conversationDailyRows) {
      if (row.day) conversationsByDay.set(row.day, Number(row.cnt) || 0);
    }
    const daily: StatsDayBucket[] = dailyRows
      .filter((row) => row.day)
      .map((row) => ({
        day: row.day,
        runs: Number(row.runs) || 0,
        tokens: Number(row.tokens) || 0,
        inputTokens: Number(row.input_tokens) || 0,
        outputTokens: Number(row.output_tokens) || 0,
        costUsd: Number(row.cost) || 0,
        durationMs: Math.round(Number(row.duration_ms) || 0),
        conversations: conversationsByDay.get(row.day) ?? 0,
      }));
    // Days with conversations but no runs still belong on the timeline.
    const runDays = new Set(daily.map((row) => row.day));
    for (const row of conversationDailyRows) {
      if (row.day && !runDays.has(row.day)) {
        daily.push({
          day: row.day,
          runs: 0,
          tokens: 0,
          inputTokens: 0,
          outputTokens: 0,
          costUsd: 0,
          durationMs: 0,
          conversations: Number(row.cnt) || 0,
        });
      }
    }
    daily.sort((a, b) => a.day.localeCompare(b.day));

    const conversationsByProvider = new Map<string | null, number>();
    for (const row of conversationProviderRows) {
      conversationsByProvider.set(row.provider, Number(row.cnt) || 0);
    }
    const providers: StatsProviderRow[] = providerRows.map((row) => ({
      provider: row.provider,
      runs: Number(row.runs) || 0,
      tokens: Number(row.tokens) || 0,
      inputTokens: Number(row.input_tokens) || 0,
      outputTokens: Number(row.output_tokens) || 0,
      costUsd: row.cost == null ? null : Number(row.cost) || 0,
      durationMs: Math.round(Number(row.duration_ms) || 0),
      conversations: conversationsByProvider.get(row.provider) ?? 0,
    }));

    const models: StatsModelRow[] = modelRows.map((row) => ({
      provider: row.provider,
      model: row.model,
      runs: Number(row.runs) || 0,
      tokens: Number(row.tokens) || 0,
      inputTokens: Number(row.input_tokens) || 0,
      outputTokens: Number(row.output_tokens) || 0,
      costUsd: row.cost == null ? null : Number(row.cost) || 0,
      durationMs: Math.round(Number(row.duration_ms) || 0),
    }));

    const sources: StatsSourceRow[] = sourceRows.map((row) => ({
      source: row.source,
      runs: Number(row.runs) || 0,
      tokens: Number(row.tokens) || 0,
    }));

    const runsByHour = new Map<number, number>();
    for (const row of hourRows) {
      runsByHour.set(Number(row.hour), Number(row.runs) || 0);
    }
    const byHourUtc: StatsHourBucket[] = Array.from({ length: 24 }, (_, hour) => ({
      hour,
      runs: runsByHour.get(hour) ?? 0,
    }));

    return {
      range: { from: filter.from ?? null, to: filter.to ?? null },
      generatedAt: nowIso(),
      firstRunAt: firstRunRow.first_run_at ?? null,
      overview: {
        totalRuns,
        runsWithTokens: Number(overviewRow.runs_with_tokens) || 0,
        totalTokens,
        inputTokens: Number(overviewRow.input_tokens) || 0,
        outputTokens: Number(overviewRow.output_tokens) || 0,
        totalCostUsd: overviewRow.cost == null ? null : Number(overviewRow.cost) || 0,
        runsWithCost,
        totalDurationMs,
        avgDurationMs: totalRuns > 0 ? Math.round(totalDurationMs / totalRuns) : null,
        conversationCount,
        activeConversations,
        avgTokensPerConversation:
          activeConversations > 0 ? Math.round(totalTokens / activeConversations) : null,
        avgTokensPerRun: totalRuns > 0 ? Math.round(totalTokens / totalRuns) : null,
        successRate: terminalCount > 0 ? succeededCount / terminalCount : null,
      },
      byStatus,
      daily,
      providers,
      models,
      sources,
      byHourUtc,
    };
  },
};
