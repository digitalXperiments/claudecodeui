/**
 * Integration Rehearsal — combine committed workspace tips in a disposable
 * worktree, run the project's configured Ship test command, then throw the
 * tree away. Never mutates the primary checkout.
 */

export type IntegrationRehearsalOutcome =
  | 'success'
  | 'merge_conflict'
  | 'test_failed'
  | 'timeout'
  | 'invalid_input';

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
  outcome: IntegrationRehearsalOutcome;
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

export type IntegrationRehearsalInput = {
  projectId: string;
  workspaceIds: string[];
  /** Explicit common ancestor SHA (40 hex). Resolved via `git rev-parse --verify`. */
  baseSha: string;
};

export type IntegrationRehearsalServiceOptions = {
  tmpRoot?: string;
  testTimeoutMs?: number;
};
