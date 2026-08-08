import type { LLMProvider } from '../../types/app';

export type KanbanTaskStatus = 'todo' | 'queued' | 'running' | 'done' | 'failed' | 'blocked';
export type KanbanRunTrigger = 'manual' | 'schedule' | 'column_move' | 'dependency' | 'review';
export type KanbanRunStatus = 'running' | 'done' | 'failed' | 'aborted';
export type KanbanRunRole = 'implement' | 'review';

export type KanbanColumn = {
  id: string;
  name: string;
  order: number;
  runOnEnter?: boolean;
  permissionMode?: string;
  /** Max concurrently active (queued/running) tasks; undefined = no limit. */
  wipLimit?: number;
};

export type KanbanTaskTools = {
  allowedCommands?: string[];
  disallowedCommands?: string[];
  /** MCP server names to prefer / allow-list for this task. */
  mcpServers?: string[];
  /** Project skill directory names to apply for this task. */
  skills?: string[];
  [key: string]: unknown;
};

export type KanbanBoard = {
  board_id: string;
  project_id: string | null;
  name: string;
  columns: KanbanColumn[];
  created_at: string;
  updated_at: string;
};

/** Minimal project reference for the global board's project badges/selector. */
export type ProjectRef = {
  projectId: string;
  displayName: string;
  /** Workspace path when available (needed for project skills). */
  path?: string;
};

export type KanbanTask = {
  task_id: string;
  board_id: string;
  project_id: string;
  title: string;
  description: string;
  prompt: string;
  column_id: string;
  position: number;
  /** Implementation agent. */
  assignee_provider: LLMProvider | null;
  /** Review agent (runs after implementation succeeds). */
  review_provider: LLMProvider | null;
  /** Named agent run profile for implement (optional). */
  implement_profile_id: string | null;
  /** Named agent run profile for review (optional). */
  review_profile_id: string | null;
  permission_mode: string;
  tools: KanbanTaskTools;
  schedule_cron: string | null;
  /** ISO deadline; overdue cards show an escalating badge. */
  due_date: string | null;
  /** Git branch auto-created when an implementation run starts. */
  feature_branch: string | null;
  /** Isolated agent workspace bound to this task (P1). */
  workspace_id?: string | null;
  /** ISO timestamp when the task was archived; null while active. */
  archived_at: string | null;
  status: KanbanTaskStatus;
  app_session_id: string | null;
  last_run_at: string | null;
  last_exit_code: number | null;
  dependsOn: string[];
  created_at: string;
  updated_at: string;
};

export type KanbanRun = {
  run_id: string;
  task_id: string;
  app_session_id: string | null;
  provider: string | null;
  trigger: KanbanRunTrigger | null;
  role: KanbanRunRole;
  status: KanbanRunStatus;
  exit_code: number | null;
  started_at: string;
  finished_at: string | null;
};

export type KanbanCommentAuthorType = 'human' | 'agent';

export type KanbanTaskComment = {
  comment_id: string;
  task_id: string;
  author_type: KanbanCommentAuthorType;
  author: string | null;
  body: string;
  run_id: string | null;
  created_at: string;
};

export const KANBAN_PROVIDERS: { value: LLMProvider; label: string }[] = [
  { value: 'claude', label: 'Claude' },
  { value: 'codex', label: 'Codex' },
  { value: 'cursor', label: 'Cursor' },
  { value: 'opencode', label: 'OpenCode' },
  { value: 'grok', label: 'Grok' },
  { value: 'kimi', label: 'Kimi' },
  { value: 'agy', label: 'Agy' },
  { value: 'pi', label: 'Pi' },
];

export const KANBAN_PERMISSION_MODES: { value: string; label: string }[] = [
  { value: 'default', label: 'Default (guarded)' },
  { value: 'plan', label: 'Plan' },
  { value: 'acceptEdits', label: 'Accept edits' },
  { value: 'bypassPermissions', label: 'Bypass permissions' },
];
