/**
 * Canonical run spine contracts (PRD §4.3–4.4, §6.4).
 *
 * Every durable event emitted by chat / kanban / mission-control / webhook /
 * automation executions uses the RunEventEnvelope below. Event type strings
 * are registered in server/shared/run-event-types.md — add new types there
 * first, then extend RUN_EVENT_TYPES.
 */

export type RunEventSource =
  | 'chat'
  | 'kanban'
  | 'mission_control'
  | 'webhook'
  | 'system'
  | 'ship'
  | 'automation'
  | 'swarm';

export type RunEventSeverity = 'debug' | 'info' | 'warn' | 'error';

export type RunEventEnvelope = {
  event_id: string; // evt_<ulid>
  run_id: string;
  ts: string; // ISO-8601
  source: RunEventSource;
  type: string; // dotted, e.g. run.started — see run-event-types.md
  severity?: RunEventSeverity;
  payload: Record<string, unknown>; // JSON-serializable; secrets redacted
  seq?: number; // monotonic per run_id
};

/** v1 minimum event type registry (PRD §6.4). Keep in sync with run-event-types.md. */
export const RUN_EVENT_TYPES = [
  'run.queued',
  'run.started',
  'run.first_token',
  'run.status',
  'model.selected',
  'workspace.bound',
  'tool.call',
  'tool.result',
  'permission.requested',
  'permission.resolved',
  'approval.requested',
  'approval.resolved',
  'token.usage',
  'git.commit',
  'git.diff_summary',
  'test.started',
  'test.finished',
  'run.completed',
  'run.failed',
  'run.aborted',
  'failover.triggered',
  'pack.attached',
] as const;

export type RunEventType = (typeof RUN_EVENT_TYPES)[number];

export type CloudErrorCode =
  | 'WORKSPACE_DIRTY_CONFLICT'
  | 'WORKSPACE_CREATE_FAILED'
  | 'WORKSPACE_NOT_FOUND'
  | 'RUN_NOT_FOUND'
  | 'RUN_ALREADY_TERMINAL'
  | 'SECRET_NOT_FOUND'
  | 'SECRET_RESOLVE_FAILED'
  | 'INTERRUPT_NOT_FOUND'
  | 'INTERRUPT_ALREADY_RESOLVED'
  | 'INTERRUPT_ACTION_REQUIRES_WAIT'
  | 'INTERRUPT_EXPIRED'
  | 'PACK_BUDGET_EXCEEDED'
  | 'PLAYBOOK_NO_CANDIDATE'
  | 'SHIP_PR_FAILED'
  | 'STACK_DOCTOR_FAILED'
  | 'AUTOMATION_CYCLE'
  | 'AUTOMATION_TIMEOUT'
  | 'SWARM_NOT_AWAITING_PLAN_APPROVAL'
  | 'SWARM_STILL_RUNNING'
  | 'SWARM_STEP_NOT_FOUND';

export class CloudError extends Error {
  readonly code: CloudErrorCode;

  constructor(code: CloudErrorCode, message: string) {
    super(message);
    this.name = 'CloudError';
    this.code = code;
  }
}

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

export const TERMINAL_RUN_STATUSES: ReadonlySet<RunStatus> = new Set([
  'succeeded',
  'failed',
  'aborted',
  'timed_out',
]);

/** Summary shape broadcast over WS and used by list endpoints. */
export type AgentRunSummary = {
  run_id: string;
  project_id: string | null;
  source: RunEventSource | string;
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
  /** Elapsed ms from started_at (or created_at) to finished_at (or now). */
  duration_ms: number | null;
  /** True when in-flight and last activity exceeds project stuck threshold. */
  is_stuck?: boolean;
  /** Optional count of tool.call events for this run. */
  tool_call_count?: number | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
};

/** WS fan-out envelope (PRD §4.6). */
export type SystemWsEvent =
  | { kind: 'run_event'; run_id: string; event: RunEventEnvelope }
  | { kind: 'run_updated'; run: AgentRunSummary }
  | { kind: 'interrupt_created' | 'interrupt_updated'; interrupt: unknown }
  | { kind: 'workspace_updated'; workspace: unknown }
  | { kind: 'secret_rotated'; secret_id: string }
  | { kind: 'notification_created' }
  | {
      kind: 'swarm_updated';
      swarm_id: string;
      project_id: string;
      status: string;
      version: number;
      updated_at: string;
    };
