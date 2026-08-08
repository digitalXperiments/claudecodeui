export type RunStatus =
  | 'queued'
  | 'starting'
  | 'running'
  | 'waiting_permission'
  | 'waiting_approval'
  | 'succeeded'
  | 'failed'
  | 'aborted'
  | 'timed_out';

export type AgentRunSummary = {
  run_id: string;
  project_id: string | null;
  source: string;
  source_ref: string | null;
  workspace_id: string | null;
  app_session_id: string | null;
  provider: string | null;
  model: string | null;
  effort: string | null;
  status: RunStatus;
  trigger: string | null;
  parent_run_id: string | null;
  root_run_id: string | null;
  title: string | null;
  error_summary: string | null;
  token_input: number | null;
  token_output: number | null;
  token_total: number | null;
  cost_usd_estimate: number | null;
  duration_ms: number | null;
  is_stuck?: boolean;
  tool_call_count?: number | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
};

export type RunEvent = {
  event_id: string;
  run_id: string;
  seq: number;
  ts: string;
  source: string;
  type: string;
  severity?: 'debug' | 'info' | 'warn' | 'error';
  payload: Record<string, unknown>;
};

export type ProjectRunStats = {
  total: number;
  byStatus: Record<string, number>;
  tokensMonth: number;
  costMonth: number;
  stuckCount: number;
  activeCount: number;
  avgDurationMs: number | null;
};

export type ProjectRunBudget = {
  project_id: string;
  monthly_token_budget: number | null;
  monthly_cost_usd_budget: number | null;
  stuck_minutes: number;
  created_at: string;
  updated_at: string;
};

export type RunListFilters = {
  status?: RunStatus | '';
  source?: string;
  search?: string;
  limit?: number;
  from?: string;
  to?: string;
};

export type BudgetUpdate = {
  monthlyTokenBudget?: number | null;
  monthlyCostUsdBudget?: number | null;
  stuckMinutes?: number | null;
};
