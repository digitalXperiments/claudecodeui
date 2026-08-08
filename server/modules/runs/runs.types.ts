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
