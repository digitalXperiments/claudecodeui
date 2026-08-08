export type InterruptKind =
  | 'permission_pending'
  | 'approval_pending'
  | 'run_failed'
  | 'run_stuck'
  | 'auth_unhealthy'
  | 'mcp_unhealthy'
  | 'task_overdue'
  | 'task_blocked'
  | 'workspace_conflict'
  | 'secret_missing'
  | 'ci_failed';

export type InterruptSeverity = 'info' | 'warning' | 'error' | 'critical';
export type InterruptStatus = 'open' | 'snoozed' | 'resolved' | 'dismissed';

export type InterruptAction = {
  id: string;
  label: string;
  style?: 'primary' | 'secondary' | 'destructive';
};

export type Interrupt = {
  interrupt_id: string;
  project_id: string | null;
  kind: InterruptKind | string;
  severity: InterruptSeverity | string;
  title: string;
  body: string;
  run_id: string | null;
  task_id: string | null;
  workspace_id: string | null;
  href: string | null;
  actions: InterruptAction[];
  status: InterruptStatus;
  snooze_until: string | null;
  resolved_at: string | null;
  resolved_by: string | null;
  resolution: string | null;
  priority: number;
  created_at: string;
  updated_at: string;
  meta: Record<string, unknown>;
};

export type CreateInterruptInput = {
  projectId?: string | null;
  kind: InterruptKind | string;
  severity?: InterruptSeverity | string;
  title: string;
  body?: string;
  runId?: string | null;
  taskId?: string | null;
  workspaceId?: string | null;
  href?: string | null;
  actions?: InterruptAction[];
  priority?: number;
  meta?: Record<string, unknown>;
  dedupeKey?: string;
};

export type InterruptListFilter = {
  projectId?: string;
  status?: InterruptStatus | InterruptStatus[];
  limit?: number;
};

export type InterruptActionInput = {
  key: string;
  actor?: string | null;
  body?: Record<string, unknown>;
};

