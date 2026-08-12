/**
 * Isolated Agent Workspaces (PRD §5) — shared types.
 *
 * Field naming follows the repo's existing API convention: persisted entities
 * keep the snake_case column names of the `agent_workspaces` table (see
 * `server/modules/database/schema.ts`), computed structs (status, diff,
 * merge result) are plain JSON shapes.
 */

/** How the workspace isolates the run's file mutations. */
export type WorkspaceMode = 'git_worktree' | 'sandbox_copy';

export const WORKSPACE_MODES: readonly WorkspaceMode[] = ['git_worktree', 'sandbox_copy'] as const;

/** Workspace lifecycle (PRD §5.4). */
export type WorkspaceLifecycleStatus =
  | 'active'
  | 'merging'
  | 'merged'
  | 'discarded'
  | 'error'
  | 'orphan';

export const WORKSPACE_LIFECYCLE_STATUSES: readonly WorkspaceLifecycleStatus[] = [
  'active',
  'merging',
  'merged',
  'discarded',
  'error',
  'orphan',
] as const;

/** Row shape of the `agent_workspaces` table (snake_case, mirrors schema.ts). */
export type AgentWorkspace = {
  workspace_id: string; // ws_<ulid>
  project_id: string;
  run_id: string | null;
  task_id: string | null;
  mode: WorkspaceMode;
  root_path: string; // absolute path under project or tmp/cloudcli
  base_branch: string; // '' for sandbox_copy
  base_sha: string | null;
  feature_branch: string; // '' for sandbox_copy
  head_sha: string | null;
  status: WorkspaceLifecycleStatus;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  cleaned_at: string | null;
};

/** One dirty (uncommitted) entry from `git status --porcelain`. */
export type WorkspaceDirtyFile = {
  path: string;
  status: string; // raw two-letter porcelain code, e.g. ' M', '??', 'UU'
};

/** Live status of a workspace (PRD §5.5 `refreshStatus`). */
export type WorkspaceStatus = {
  workspace_id: string;
  status: WorkspaceLifecycleStatus;
  head_sha: string | null;
  ahead: number; // commits on feature branch not on base
  behind: number; // commits on base not on feature branch
  dirty_files: WorkspaceDirtyFile[];
  conflicts: string[]; // paths with unmerged entries
};

/** Per-file diff entry (`git diff --name-status` + optional patch). */
export type DiffFile = {
  path: string;
  status: string; // 'added' | 'modified' | 'deleted' | 'renamed' | ...
  patch?: string;
};

export type DiffResult = {
  files: DiffFile[];
  summary: { additions: number; deletions: number };
};

export type MergeStrategy = 'ff-only' | 'merge' | 'squash';

export const MERGE_STRATEGIES: readonly MergeStrategy[] = ['ff-only', 'merge', 'squash'] as const;

export type MergeResult = {
  merged: boolean;
  strategy: MergeStrategy;
  status: WorkspaceLifecycleStatus;
  merge_sha: string | null;
  message?: string;
};

// --- Service input types (PRD §5.5 — camelCase per the interface) ----------

export type CreateWorkspaceInput = {
  projectId: string;
  projectPath: string;
  baseBranch?: string; // default: current branch or main/master
  branchName?: string; // default: feat/<task-or-run-slug-or-workspace_id>
  taskId?: string;
  runId?: string;
  mode?: WorkspaceMode; // default: git_worktree, auto-falls back to sandbox_copy for non-git projects
};

export type MergeToBaseOptions = {
  strategy?: MergeStrategy; // default: 'merge' (--no-ff)
  deleteAfter?: boolean; // discard worktree + delete feature branch after a successful merge
};

export type DiscardOptions = {
  deleteBranch?: boolean; // default: false
};

export type GetDiffOptions = {
  base?: 'merge-base' | 'base_sha'; // default: 'merge-base'
};

/** Event hook so later waves can wire WS fan-out (PRD §4.6 `workspace_updated`). */
export type WorkspaceEventType =
  | 'workspace.created'
  | 'workspace.updated'
  | 'workspace.merged'
  | 'workspace.discarded'
  | 'workspace.cleaned'
  | 'workspace.orphaned'
  | 'workspace.error';

export type WorkspaceEventHandler = (type: WorkspaceEventType, workspace: AgentWorkspace) => void;

/** Service contract (PRD §5.5). */
export interface WorkspaceService {
  create(input: CreateWorkspaceInput): Promise<AgentWorkspace>;
  get(workspaceId: string): AgentWorkspace | null;
  list(projectId: string, filter?: { status?: string[] }): AgentWorkspace[];
  refreshStatus(workspaceId: string): Promise<WorkspaceStatus>;
  getDiff(workspaceId: string, opts?: GetDiffOptions): Promise<DiffResult>;
  mergeToBase(workspaceId: string, opts?: MergeToBaseOptions): Promise<MergeResult>;
  discard(workspaceId: string, opts?: DiscardOptions): Promise<void>;
  cleanup(workspaceId: string): Promise<void>;
  /** Rebind an existing task workspace to the current canonical run. */
  bindRun(workspaceId: string, runId: string | null): AgentWorkspace;
  resolveCwd(workspaceId: string): string;
  /** Boot-time reconcile (§5.10): mark rows with missing dirs as `orphan`. */
  reconcileOrphanedWorkspaces(projectId?: string): Promise<AgentWorkspace[]>;
}

export type WorkspaceServiceOptions = {
  onEvent?: WorkspaceEventHandler; // default: no-op
  /** Root for the tmp fallback (`<tmpRoot>/worktrees/<project_id>/<workspace_id>`). */
  tmpRoot?: string; // default: <cwd>/tmp/cloudcli
  /** Maximum time to wait for another process's project workspace lock. */
  lockWaitMs?: number;
  /** A lock heartbeat older than this can be recovered after a crash. */
  lockStaleMs?: number;
  /** Delay between cross-process lock acquisition attempts. */
  lockRetryMs?: number;
};
