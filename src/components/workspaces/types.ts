export type WorkspaceMode = 'git_worktree' | 'sandbox_copy';
export type WorkspaceStatus = 'active' | 'merging' | 'merged' | 'discarded' | 'error' | 'orphan';

export type AgentWorkspace = {
  workspace_id: string;
  project_id: string;
  run_id: string | null;
  task_id: string | null;
  mode: WorkspaceMode;
  root_path: string;
  base_branch: string;
  base_sha: string | null;
  feature_branch: string;
  head_sha: string | null;
  status: WorkspaceStatus;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  cleaned_at: string | null;
};

export type WorkspaceDirtyFile = { path: string; status: string };

export type WorkspaceLiveStatus = {
  workspace_id: string;
  status: WorkspaceStatus;
  head_sha: string | null;
  ahead: number;
  behind: number;
  dirty_files: WorkspaceDirtyFile[];
  conflicts: string[];
};

export type WorkspaceDiff = {
  files: Array<{ path: string; status: string; patch?: string }>;
  summary: { additions: number; deletions: number };
};

export type WorkspaceTestReport = {
  workspace_id: string;
  command: string;
  cwd: string;
  passed: boolean;
  exit_code: number | null;
  timed_out: boolean;
  stdout: string;
  stderr: string;
  duration_ms: number;
  started_at: string;
  finished_at: string;
};

export type WorkspacePullRequest = {
  provider: 'github' | 'gitlab';
  url: string;
  number: number | null;
  title: string;
  head_branch: string;
  base_branch: string;
  draft: boolean;
  test_report: WorkspaceTestReport;
  warnings: string[];
};

export type WorkspaceCiStatus = {
  provider: 'github' | 'gitlab' | 'none';
  pull_request_url: string | null;
  state: 'pending' | 'success' | 'failure' | 'unknown';
  checks: Array<{ name: string; state: string; conclusion?: string | null; url?: string | null }>;
  fetched_at: string;
  message?: string;
};
