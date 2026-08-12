import type { LLMProvider } from '@/shared/types.js';

/** Canonical list of providers a task can be assigned to. Mirrors LLMProvider. */
export const KANBAN_PROVIDERS: readonly LLMProvider[] = [
  'claude',
  'codex',
  'cursor',
  'opencode',
  'grok',
  'kimi',
  'pi',
] as const;

export function isKanbanProvider(value: unknown): value is LLMProvider {
  return typeof value === 'string' && KANBAN_PROVIDERS.includes(value as LLMProvider);
}

/** Task lifecycle states. */
export type KanbanTaskStatus = 'todo' | 'queued' | 'running' | 'done' | 'failed' | 'blocked';

export const KANBAN_TASK_STATUSES: readonly KanbanTaskStatus[] = [
  'todo',
  'queued',
  'running',
  'done',
  'failed',
  'blocked',
] as const;

export type KanbanRunTrigger = 'manual' | 'schedule' | 'column_move' | 'dependency' | 'review';
export type KanbanRunStatus = 'running' | 'done' | 'failed' | 'aborted';

/** Which agent role a run is executing as. */
export type KanbanRunRole = 'implement' | 'review';

/** Canonical column ids used by the default board lifecycle. */
export const COLUMN_BACKLOG = 'backlog';
export const COLUMN_IN_PROGRESS = 'in_progress';
export const COLUMN_REVIEW = 'review';
export const COLUMN_DONE = 'done';

/** A single column definition, stored inside `kanban_boards.columns_json`. */
export type KanbanColumn = {
  id: string;
  name: string;
  order: number;
  runOnEnter?: boolean;
  permissionMode?: string;
  /**
   * Maximum number of concurrently active tasks (queued or running) allowed in
   * this column. `undefined`/`null` means no limit. Used to gate auto-starting
   * runs when a column is full.
   */
  wipLimit?: number;
};

/** Per-task tool permissions, stored inside `kanban_tasks.tools_json`. */
export type KanbanTaskTools = {
  allowedCommands?: string[];
  disallowedCommands?: string[];
  /**
   * Selected MCP server names (display names from the provider list).
   * Expanded into provider allow-list patterns at run time so the agent is
   * steered toward the right integrations without free-form tool strings.
   */
  mcpServers?: string[];
  /**
   * Project skill directory names to apply for this task (e.g. project-memory).
   * Injected into the run prompt so the agent reads project do/don't context.
   */
  skills?: string[];
  [key: string]: unknown;
};

/** Raw board row as stored in SQLite. */
export type KanbanBoardRow = {
  board_id: string;
  /**
   * Kept for schema compatibility only. Boards are global-only now, so this is
   * always null — a task's own `project_id` is the load-bearing project link.
   */
  project_id: string | null;
  name: string;
  columns_json: string;
  created_at: string;
  updated_at: string;
};

/** Board with parsed columns, as returned to callers. */
export type KanbanBoard = Omit<KanbanBoardRow, 'columns_json'> & {
  columns: KanbanColumn[];
};

/** Raw task row as stored in SQLite. */
export type KanbanTaskRow = {
  task_id: string;
  board_id: string;
  project_id: string;
  title: string;
  description: string;
  prompt: string;
  column_id: string;
  position: number;
  /** Implementation agent (provider) that executes the task when it enters In Progress. */
  assignee_provider: string | null;
  /** Review agent (provider) that runs after implementation succeeds. */
  review_provider: string | null;
  /** Optional named agent run profile for the implementation role. */
  implement_profile_id: string | null;
  /** Optional named agent run profile for the review role. */
  review_profile_id: string | null;
  permission_mode: string;
  tools_json: string;
  schedule_cron: string | null;
  /** ISO deadline; overdue cards can be escalated. */
  due_date: string | null;
  /** Git branch auto-created when an implementation run starts. */
  feature_branch: string | null;
  /** Latest isolated workspace used by this task, when workspaces are enabled. */
  workspace_id?: string | null;
  /** ISO timestamp of the last overdue escalation for this task. */
  escalated_at: string | null;
  /** ISO timestamp when the task was archived; null while active. */
  archived_at?: string | null;
  status: KanbanTaskStatus;
  app_session_id: string | null;
  last_run_at: string | null;
  last_exit_code: number | null;
  created_at: string;
  updated_at: string;
};

/** Task with parsed tools + dependency ids, as returned to callers. */
export type KanbanTask = Omit<KanbanTaskRow, 'tools_json'> & {
  tools: KanbanTaskTools;
  dependsOn: string[];
};

export type KanbanRunRow = {
  run_id: string;
  task_id: string;
  app_session_id: string | null;
  provider: string | null;
  trigger: KanbanRunTrigger | null;
  /** implement | review — which agent role this run was for. */
  role: KanbanRunRole;
  /** Canonical run-spine id; null for legacy rows created before P2 wiring. */
  agent_run_id?: string | null;
  status: KanbanRunStatus;
  exit_code: number | null;
  started_at: string;
  finished_at: string | null;
};

/** Who authored a task comment. */
export type KanbanCommentAuthorType = 'human' | 'agent';

/** A single comment / activity-trail entry on a task. */
export type KanbanTaskCommentRow = {
  comment_id: string;
  task_id: string;
  author_type: KanbanCommentAuthorType;
  author: string | null;
  body: string;
  run_id: string | null;
  created_at: string;
};

export type CreateCommentInput = {
  taskId: string;
  authorType: KanbanCommentAuthorType;
  author?: string | null;
  body: string;
  runId?: string | null;
};

export type CreateBoardInput = {
  name: string;
  columns?: KanbanColumn[];
};

export type CreateTaskInput = {
  boardId: string;
  projectId: string;
  title: string;
  description?: string;
  prompt?: string;
  columnId?: string;
  position?: number;
  assigneeProvider?: LLMProvider | null;
  reviewProvider?: LLMProvider | null;
  implementProfileId?: string | null;
  reviewProfileId?: string | null;
  permissionMode?: string;
  tools?: KanbanTaskTools;
  scheduleCron?: string | null;
  dueDate?: string | null;
  featureBranch?: string | null;
};

export type UpdateTaskInput = {
  title?: string;
  description?: string;
  prompt?: string;
  projectId?: string;
  columnId?: string;
  position?: number;
  assigneeProvider?: LLMProvider | null;
  reviewProvider?: LLMProvider | null;
  implementProfileId?: string | null;
  reviewProfileId?: string | null;
  permissionMode?: string;
  tools?: KanbanTaskTools;
  scheduleCron?: string | null;
  dueDate?: string | null;
  featureBranch?: string | null;
  /** Last escalation sweep timestamp (managed by the scheduler, not clients). */
  escalatedAt?: string | null;
  archivedAt?: string | null;
  status?: KanbanTaskStatus;
};

/**
 * Default columns for a new board.
 * In Progress auto-runs the implementation agent; Review auto-runs the review agent.
 */
export const DEFAULT_COLUMNS: KanbanColumn[] = [
  { id: COLUMN_BACKLOG, name: 'Backlog', order: 0 },
  { id: COLUMN_IN_PROGRESS, name: 'In Progress', order: 1, runOnEnter: true },
  { id: COLUMN_REVIEW, name: 'Review', order: 2, runOnEnter: true },
  { id: COLUMN_DONE, name: 'Done', order: 3 },
];
