export type TestReport = {
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

export type PrInput = {
  title?: string;
  body?: string;
  baseBranch?: string;
  draft?: boolean;
  reviewers?: string[];
  provider?: 'github' | 'gitlab';
  tokenRef?: string;
};

export type PullRequest = {
  provider: 'github' | 'gitlab';
  url: string;
  number: number | null;
  title: string;
  head_branch: string;
  base_branch: string;
  draft: boolean;
  test_report: TestReport;
  warnings: string[];
};

export type CiCheck = {
  name: string;
  state: string;
  conclusion?: string | null;
  url?: string | null;
};

export type CiStatus = {
  provider: 'github' | 'gitlab' | 'none';
  pull_request_url: string | null;
  state: 'pending' | 'success' | 'failure' | 'unknown';
  checks: CiCheck[];
  fetched_at: string;
  message?: string;
};

export type ShipService = {
  runTests(workspaceId: string): Promise<TestReport>;
  createPullRequest(workspaceId: string, input?: PrInput): Promise<PullRequest>;
  getCiStatus(workspaceId: string, prUrlOrId?: string): Promise<CiStatus>;
  openFixRun(input: { parentRunId: string; failureSummary: string }): ReturnType<import('@/modules/runs/runs.service.js').RunService['create']>;
};
