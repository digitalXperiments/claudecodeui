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

export type IntegrationRehearsalWorkspaceInput = {
  workspace_id: string;
  feature_branch: string;
  head_sha: string;
  status: string;
};

export type IntegrationRehearsalTestReport = {
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

export type IntegrationRehearsalResult = {
  rehearsal_id: string;
  project_id: string;
  outcome: 'success' | 'merge_conflict' | 'test_failed' | 'timeout' | 'invalid_input';
  message: string;
  inputs: IntegrationRehearsalWorkspaceInput[];
  base_sha: string;
  merge_conflicts: string[];
  test: IntegrationRehearsalTestReport | null;
  warnings: string[];
  cleaned_up: boolean;
  rehearsal_branch: string;
  rehearsal_path: string | null;
  started_at: string;
  finished_at: string;
};

export type WorkspaceCiStatus = {
  provider: 'github' | 'gitlab' | 'none';
  pull_request_url: string | null;
  state: 'pending' | 'success' | 'failure' | 'unknown';
  checks: Array<{ name: string; state: string; conclusion?: string | null; url?: string | null }>;
  fetched_at: string;
  message?: string;
};
