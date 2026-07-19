import type { LLMProvider } from '@/shared/types.js';

/** Canonical list of providers a task can be assigned to. Mirrors LLMProvider. */
export const KANBAN_PROVIDERS: readonly LLMProvider[] = [
  'claude',
  'codex',
  'cursor',
  'opencode',
  'grok',
  'kimi',
  'agy',
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

export type KanbanRunTrigger = 'manual' | 'schedule' | 'column_move' | 'dependency';
export type KanbanRunStatus = 'running' | 'done' | 'failed' | 'aborted';

/** A single column definition, stored inside `kanban_boards.columns_json`. */
export type KanbanColumn = {
  id: string;
  name: string;
  order: number;
  runOnEnter?: boolean;
  permissionMode?: string;
};

/** Per-task tool permissions, stored inside `kanban_tasks.tools_json`. */
export type KanbanTaskTools = {
  allowedCommands?: string[];
  disallowedCommands?: string[];
  [key: string]: unknown;
};

export type KanbanBoardScope = 'project' | 'global';

/** Raw board row as stored in SQLite. */
export type KanbanBoardRow = {
  board_id: string;
  project_id: string | null;
  name: string;
  columns_json: string;
  scope: KanbanBoardScope;
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
  assignee_provider: string | null;
  permission_mode: string;
  tools_json: string;
  schedule_cron: string | null;
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
  status: KanbanRunStatus;
  exit_code: number | null;
  started_at: string;
  finished_at: string | null;
};

export type CreateBoardInput = {
  projectId: string | null;
  name: string;
  columns?: KanbanColumn[];
  scope?: KanbanBoardScope;
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
  permissionMode?: string;
  tools?: KanbanTaskTools;
  scheduleCron?: string | null;
};

export type UpdateTaskInput = {
  title?: string;
  description?: string;
  prompt?: string;
  projectId?: string;
  columnId?: string;
  position?: number;
  assigneeProvider?: LLMProvider | null;
  permissionMode?: string;
  tools?: KanbanTaskTools;
  scheduleCron?: string | null;
  status?: KanbanTaskStatus;
};

/** Default columns created for a new board. */
export const DEFAULT_COLUMNS: KanbanColumn[] = [
  { id: 'backlog', name: 'Backlog', order: 0 },
  { id: 'in_progress', name: 'In Progress', order: 1 },
  { id: 'review', name: 'Review', order: 2 },
  { id: 'done', name: 'Done', order: 3 },
];
