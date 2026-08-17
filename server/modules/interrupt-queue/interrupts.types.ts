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
  | 'ci_failed'
  | 'spend_cap'
  | 'shift_report';

export type InterruptSeverity = 'info' | 'warning' | 'error' | 'critical';
export type InterruptStatus = 'open' | 'snoozed' | 'resolved' | 'dismissed' | 'expired';

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
  /** Approval-gate deadline: past this the interrupt is no longer actionable. */
  expires_at: string | null;
  /** Viewport mark-as-read timestamp. Read ≠ resolved: the item stays actionable. */
  read_at: string | null;
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
  /**
   * ISO deadline after which the interrupt auto-expires. `undefined` applies
   * the kind default (permission_pending gets a bounded TTL); `null` opts out.
   */
  expiresAt?: string | null;
};

export type InterruptListFilter = {
  projectId?: string;
  status?: InterruptStatus | InterruptStatus[];
  limit?: number;
  /** Only decisions or configuration fixes that require a person right now. */
  attentionOnly?: boolean;
};

export type InterruptActionInput = {
  key: string;
  actor?: string | null;
  body?: Record<string, unknown>;
};
