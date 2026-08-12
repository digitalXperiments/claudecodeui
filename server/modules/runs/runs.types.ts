/**
 * Canonical run spine types (PRD §6.3, §6.5).
 *
 * `AgentRun` mirrors the `agent_runs` table row; `AgentRunSummary`
 * (from server/shared/run-events.ts) is the lighter shape used by list
 * endpoints and WS fan-out.
 */

import type { RunEventSource, RunStatus } from '@/shared/run-events.js';

/** Full `agent_runs` row. */
export type AgentRun = {
  run_id: string; // run_<ulid>
  project_id: string | null;
  source: RunEventSource | string;
  source_ref: string | null;
  workspace_id: string | null;
  app_session_id: string | null;
  provider: string | null;
  model: string | null;
  effort: string | null;
  permission_mode: string | null;
  profile_id: string | null;
  status: RunStatus;
  trigger: string | null;
  parent_run_id: string | null;
  root_run_id: string | null;
  title: string | null;
  error_summary: string | null;
  exit_code: number | null;
  token_input: number | null;
  token_output: number | null;
  token_total: number | null;
  /** Cheap re-read of a previously-cached prompt prefix (folded into token_input). */
  token_cache_read: number | null;
  /** Priming the cache for later reads — priced ABOVE the base input rate, not below. */
  token_cache_write: number | null;
  cost_usd_estimate: number | null;
  started_at: string | null;
  first_token_at: string | null;
  finished_at: string | null;
  created_at: string;
  updated_at: string;
  meta: Record<string, unknown>;
};

/** Input accepted by `runService.create` (PRD §6.5). */
export type CreateRunInput = {
  /** Optional bridge id so source-specific rows can share the spine identity. */
  runId?: string;
  source: RunEventSource | string;
  projectId?: string | null;
  sourceRef?: string | null;
  workspaceId?: string | null;
  appSessionId?: string | null;
  provider?: string | null;
  model?: string | null;
  effort?: string | null;
  permissionMode?: string | null;
  profileId?: string | null;
  status?: RunStatus; // defaults to 'queued'
  trigger?: string | null;
  parentRunId?: string | null;
  rootRunId?: string | null;
  title?: string | null;
  meta?: Record<string, unknown>;
};

/** Filters for `runService.list` (PRD §6.5, §6.7). Cursor is opaque. */
export type RunListFilter = {
  projectId?: string;
  status?: RunStatus | RunStatus[];
  source?: string;
  /** ISO-8601 lower bound on created_at (inclusive). */
  from?: string;
  /** ISO-8601 upper bound on created_at (inclusive). */
  to?: string;
  cursor?: string;
  limit?: number;
};

/** Usage snapshot attached to a run (PRD §6.4 `token.usage`). */
export type TokenUsage = {
  input?: number | null;
  output?: number | null;
  total?: number | null;
  /** Subset of `input` that was a cheap cache re-read, when the provider reports it. */
  cacheReadTokens?: number | null;
  /** Subset of `input` that primed the cache — priced above the base rate, not below. */
  cacheCreationTokens?: number | null;
  costUsdEstimate?: number | null;
};

/** Result recorded when a run reaches a terminal status. */
export type TerminalResult = {
  status: Extract<RunStatus, 'succeeded' | 'failed' | 'aborted' | 'timed_out'>;
  errorSummary?: string | null;
  exitCode?: number | null;
};

/** error_summary written by reconcileOrphans() (PRD §6.5). */
export const ORPHAN_ERROR_SUMMARY = 'orphaned by server restart';

/** Default stuck threshold when no project budget row exists. */
export const DEFAULT_STUCK_MINUTES = 15;

/** Per-project run budget / stuck settings. */
export type ProjectRunBudget = {
  project_id: string;
  monthly_token_budget: number | null;
  monthly_cost_usd_budget: number | null;
  stuck_minutes: number;
  created_at: string;
  updated_at: string;
};

export type ProjectRunBudgetInput = {
  projectId: string;
  monthlyTokenBudget?: number | null;
  monthlyCostUsdBudget?: number | null;
  stuckMinutes?: number | null;
};

/** Aggregate observatory stats for a project. */
export type ProjectRunStats = {
  total: number;
  byStatus: Record<string, number>;
  tokensMonth: number;
  costMonth: number;
  stuckCount: number;
  activeCount: number;
  avgDurationMs: number | null;
};

// ---------------------------------------------------------------------------
// Global usage stats (Stats dashboard)
// ---------------------------------------------------------------------------

/**
 * Filter for global stats aggregates. ISO-8601 bounds on created_at
 * (inclusive), same semantics as RunListFilter. Missing bound = unbounded.
 */
export type GlobalStatsFilter = {
  from?: string;
  to?: string;
};

/** Headline KPIs for the Stats dashboard. */
export type StatsOverview = {
  totalRuns: number;
  /** Runs with a non-null token_total (token coverage). */
  runsWithTokens: number;
  /** SUM(token_total). Provider totals may include cache reads; cache detail is not stored. */
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  /** SUM(cost_usd_estimate); null when no run in range carries a cost estimate. */
  totalCostUsd: number | null;
  /** Runs with a non-null cost estimate (cost coverage). */
  runsWithCost: number;
  /**
   * Wall-clock run time: SUM(COALESCE(finished_at, now) - COALESCE(started_at, created_at)).
   * Concurrent runs accumulate independently.
   */
  totalDurationMs: number;
  avgDurationMs: number | null;
  /** Conversations (sessions rows) created in range, all providers. */
  conversationCount: number;
  /** Distinct conversations (app_session_id) with at least one run in range. */
  activeConversations: number;
  /** totalTokens / activeConversations; null when no conversation has runs in range. */
  avgTokensPerConversation: number | null;
  avgTokensPerRun: number | null;
  /** succeeded / terminal runs; null when no run reached a terminal status. */
  successRate: number | null;
};

export type StatsStatusCount = { status: string; count: number };

/** One UTC day of usage. `day` is YYYY-MM-DD (UTC). */
export type StatsDayBucket = {
  day: string;
  runs: number;
  tokens: number;
  inputTokens: number;
  outputTokens: number;
  /** Day-level cost sums default to 0 (no per-day coverage distinction). */
  costUsd: number;
  durationMs: number;
  conversations: number;
};

export type StatsProviderRow = {
  /** null = run rows without provider attribution (rendered as "Unknown"). */
  provider: string | null;
  runs: number;
  tokens: number;
  inputTokens: number;
  outputTokens: number;
  /** null when none of the provider's runs carry a cost estimate. */
  costUsd: number | null;
  durationMs: number;
  /** Conversations (sessions rows) attributed to this provider in range. */
  conversations: number;
};

export type StatsModelRow = {
  provider: string | null;
  /** null = run rows without model attribution (rendered as "Unknown"). */
  model: string | null;
  runs: number;
  tokens: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  durationMs: number;
};

export type StatsSourceRow = {
  source: string;
  runs: number;
  tokens: number;
};

/** Runs started per hour of day (UTC), hours 0-23 with zero-fill. */
export type StatsHourBucket = { hour: number; runs: number };

/** Full payload for the global Stats dashboard (GET /api/runs/stats/global). */
export type GlobalRunStats = {
  /** Echo of the applied range; null bound = unbounded. */
  range: { from: string | null; to: string | null };
  /** When the payload was computed. */
  generatedAt: string;
  /** Oldest run created_at across all time (unbounded); null when no runs exist. */
  firstRunAt: string | null;
  overview: StatsOverview;
  byStatus: StatsStatusCount[];
  /** Sparse day buckets (only days with runs or conversations), ascending. */
  daily: StatsDayBucket[];
  /** Providers ordered by tokens desc. */
  providers: StatsProviderRow[];
  /** Models ordered by tokens desc (capped). */
  models: StatsModelRow[];
  /** Sources ordered by runs desc. */
  sources: StatsSourceRow[];
  byHourUtc: StatsHourBucket[];
};
