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
  /**
   * Relay workspaces only: commit on the feature branch that captures the
   * primary checkout's uncommitted files copied in at creation. Changes after
   * it are the worker's; landing applies exactly those.
   */
  snapshot_sha?: string | null;
  /** Where this workspace's own changes start (predecessor tip when stacked). */
  start_sha?: string | null;
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
  /**
   * Commit the primary's uncommitted files (copied in by the overlay) as a
   * snapshot commit, so later changes are exactly the worker's. Git only.
   */
  snapshotPrimaryChanges?: boolean;
  /**
   * Start from these refs instead of the base (stacked pipelines): the first
   * is checked out, the rest are merged in. No overlay/snapshot is taken; the
   * predecessor's snapshot is inherited via `inheritSnapshotSha`.
   */
  startRefs?: string[];
  inheritSnapshotSha?: string | null;
};

export type MergeToBaseOptions = {
  strategy?: MergeStrategy; // default: 'merge' (--no-ff)
  deleteAfter?: boolean; // discard worktree + delete feature branch after a successful merge
  /** Refuse to merge if the primary checkout changed since a verified rehearsal. */
  expectedBaseSha?: string;
};

export type DiscardOptions = {
  deleteBranch?: boolean; // default: false
};

export type GetDiffOptions = {
  base?: 'merge-base' | 'base_sha'; // default: 'merge-base'
};

export type ApplyToPrimaryOptions = {
  /** Stage + commit the applied paths in the primary repo. Default: false. */
  commit?: boolean;
  /** Required when `commit` is true. */
  message?: string;
};

export type ApplyToPrimarySkipReason = 'dirty_overlap';

export type ApplyToPrimarySkip = {
  path: string;
  reason: ApplyToPrimarySkipReason;
};

export type ApplyToPrimaryResult = {
  /** Paths copied (or deleted) onto the primary checkout. */
  applied: string[];
  /** Paths left untouched because the primary checkout is dirty there. */
  skipped: ApplyToPrimarySkip[];
  committed: boolean;
  commit_sha: string | null;
};

/** Per-file outcome of applying a committed range onto a target checkout. */
export type RangeApplyResult = {
  fromSha: string;
  toSha: string;
  /** Target had the range's base content; the new content was written. */
  applied: string[];
  /** Target had its own edits there; a clean three-way merge was written. */
  merged: string[];
  /** Target already had the range's end content. */
  alreadyApplied: string[];
  /** Nothing was written for these paths (overlapping edits or binary). */
  conflicts: Array<{ path: string; reason: string }>;
  /** Paths whose target had uncommitted edits before the apply. */
  targetDirty: string[];
};

export type LandOntoPrimaryOptions = {
  /** Commit message for the landed paths. Default: a message naming the branch. */
  message?: string;
  /**
   * Commit the landed paths that were clean in the primary before landing.
   * Paths that also carried the operator's uncommitted edits are written but
   * never committed, so their edits are not swept into the commit. Default true.
   */
  commit?: boolean;
};

export type LandOntoPrimaryResult = RangeApplyResult & {
  committed: boolean;
  commit_sha: string | null;
  /** Written into the primary but left uncommitted (see `commit`). */
  leftUncommitted: string[];
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
  /**
   * Copy the workspace's changed files onto the primary checkout without
   * `git merge`/`git rebase`/`git checkout`. File-copy only; see
   * workspace.service.ts `applyToPrimary` for the dirty-overlap rules.
   */
  applyToPrimary(workspaceId: string, opts?: ApplyToPrimaryOptions): Promise<ApplyToPrimaryResult>;
  discard(workspaceId: string, opts?: DiscardOptions): Promise<void>;
  cleanup(workspaceId: string): Promise<void>;
  /** Rebind an existing task workspace to the current canonical run. */
  bindRun(workspaceId: string, runId: string | null): AgentWorkspace;
  resolveCwd(workspaceId: string): string;
  /** Boot-time reconcile (§5.10): mark rows with missing dirs as `orphan`. */
  reconcileOrphanedWorkspaces(projectId?: string): Promise<AgentWorkspace[]>;
  /** Three-way, per-file apply of a committed range onto another checkout. */
  applyCommittedRange(input: {
    sourceRoot: string;
    fromRef: string;
    toRef: string;
    targetRoot: string;
    scratchDir: string;
    pathspec?: string;
  }): Promise<RangeApplyResult>;
  /** Land a Relay workspace's own commits onto a (possibly dirty) primary. */
  landOntoPrimary(workspaceId: string, opts?: LandOntoPrimaryOptions): Promise<LandOntoPrimaryResult>;
  /** Commit anything left uncommitted in a git workspace; returns the new tip or null. */
  commitPendingChanges(workspaceId: string, message: string): Promise<string | null>;
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
