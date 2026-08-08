export type AutomationTriggerType = 'cron' | 'webhook_inbound' | 'kanban_event' | 'run_completed' | 'interrupt_created' | 'manual';

export type AutomationTrigger = {
  type: AutomationTriggerType;
  event?: string;
  cron?: string;
};

export type AutomationCondition = {
  path: string;
  equals?: unknown;
  notEquals?: unknown;
  contains?: string;
  exists?: boolean;
};

export type AutomationAction = {
  type: 'start_agent_run' | 'enqueue_kanban_task' | 'http_webhook_out' | 'notify' | 'create_interrupt' | 'noop' | 'emit_event';
  provider?: string;
  model?: string;
  title?: string;
  prompt?: string;
  taskId?: string;
  url?: string;
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  name?: string;
  message?: string;
  kind?: string;
  severity?: string;
  event?: string;
  payload?: Record<string, unknown>;
  [key: string]: unknown;
};

export type WorkflowStepKind = 'action' | 'parallel' | 'branch';

export type WorkflowStep = {
  id: string;
  name: string;
  kind: WorkflowStepKind;
  /** For kind=action: the action to run */
  action?: AutomationAction;
  /** For kind=parallel: child step ids to run concurrently */
  parallel?: string[];
  /** For kind=branch: conditions + next step ids */
  branch?: Array<{ when: AutomationCondition[]; next: string }>;
  /** Default next step id (linear edge). null = end */
  next?: string | null;
  /** Depends-on step ids that must succeed first (DAG). If empty, entry steps. */
  dependsOn?: string[];
  timeoutMs?: number;
  retry?: { max: number; backoffMs?: number };
};

export type WorkflowGraph = {
  version: 1;
  entry: string;
  steps: WorkflowStep[];
};

export type WorkflowStepState = {
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped';
  startedAt?: string | null;
  finishedAt?: string | null;
  result?: Record<string, unknown>;
  error?: string | null;
};

export type AutomationRecipe = {
  recipe_id: string;
  name: string;
  enabled: boolean;
  version: number;
  project_id: string | null;
  trigger: AutomationTrigger;
  conditions: AutomationCondition[];
  actions: AutomationAction[];
  /** null = use linear actions only */
  graph: WorkflowGraph | null;
  retry: { max: number; backoffMs?: number };
  timeout_ms: number | null;
  created_at: string;
  updated_at: string;
};

export type CreateAutomationRecipeInput = {
  name: string;
  enabled?: boolean;
  projectId?: string | null;
  trigger: AutomationTrigger;
  conditions?: AutomationCondition[];
  actions?: AutomationAction[];
  graph?: WorkflowGraph | null;
  retry?: { max?: number; backoffMs?: number };
  timeoutMs?: number | null;
};

export type AutomationRun = {
  automation_run_id: string;
  recipe_id: string;
  agent_run_id: string | null;
  status: string | null;
  attempt: number;
  trigger_payload: Record<string, unknown>;
  step_states: Record<string, WorkflowStepState>;
  error: string | null;
  started_at: string | null;
  finished_at: string | null;
};
