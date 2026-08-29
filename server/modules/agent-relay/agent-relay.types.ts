import type { LLMProvider } from '@/shared/types.js';

export const AGENT_RELAY_PROVIDERS: LLMProvider[] = [
  'claude',
  'codex',
  'cursor',
  'opencode',
  'kilo',
  'cline',
  'grok',
  'kimi',
  'qwencode',
  'pi',
];

export type AgentRelayMode = 'read_only' | 'isolated_write';
/**
 * `auto` enforces the task envelope without involving the lead for routine
 * work. `manual` keeps safe reads automatic, but asks before a writer mutates
 * its isolated worktree.
 */
export type AgentRelayApprovalPolicy = 'auto' | 'manual';
export type AgentRelayStatus =
  | 'queued'
  | 'running'
  | 'waiting_approval'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'timed_out';

export const AGENT_RELAY_TERMINAL_STATUSES = new Set<AgentRelayStatus>([
  'completed',
  'failed',
  'cancelled',
  'timed_out',
]);

export type AgentRelayApprovalStatus = 'pending' | 'approved' | 'denied' | 'expired';

/**
 * One out-of-envelope worker permission request awaiting a lead decision.
 * Durable so a lead that reconnects (or the operator) can still answer it.
 */
export type AgentRelayApproval = {
  approval_id: string;
  relay_id: string;
  request_id: string;
  tool_name: string | null;
  command: string | null;
  paths: string[];
  cwd: string | null;
  reason: string;
  status: AgentRelayApprovalStatus;
  decision_reason: string | null;
  decided_by: string | null;
  created_at: string;
  decided_at: string | null;
};

export type CreateAgentRelayApprovalInput = {
  approvalId: string;
  relayId: string;
  requestId: string;
  toolName: string | null;
  command: string | null;
  paths: string[];
  cwd: string | null;
  reason: string;
};

export type AgentRelayStructuredResult = {
  status: 'completed' | 'failed' | 'blocked';
  summary: string;
  evidence: string[];
  filesTouched: string[];
  testsRun: string[];
  openQuestions: string[];
  /** Worker-returned JSON for a task that declared an `outputSchema`. */
  structuredOutput?: unknown;
  /** Validation verdict for `structuredOutput` against the declared schema. */
  outputValidation?: { valid: boolean; errors: string[] };
};

export type AgentRelayResult = AgentRelayStructuredResult & {
  output: string;
  workspace?: {
    workspaceId: string;
    rootPath: string;
    featureBranch: string;
    files: Array<{ path: string; status: string }>;
    additions: number;
    deletions: number;
  };
};

export type AgentRelayJob = {
  relay_id: string;
  batch_id: string;
  project_id: string;
  project_path: string;
  source_session_id: string | null;
  app_session_id: string | null;
  run_id: string | null;
  workspace_id: string | null;
  provider: LLMProvider;
  model: string | null;
  effort: string | null;
  mode: AgentRelayMode;
  approval_policy: AgentRelayApprovalPolicy;
  status: AgentRelayStatus;
  /** Short lead-chosen display name, used in titles and compact listings. */
  label: string | null;
  task: string;
  last_prompt: string;
  mcp_servers: string[];
  /** JSON Schema the worker's structured output must satisfy, when declared. */
  output_schema: Record<string, unknown> | null;
  /** Relay ids this job waits on before it may start (same-batch pipeline). */
  depends_on: string[];
  /** Automatic re-dispatches allowed after an infrastructure failure. */
  retries: number;
  retry_count: number;
  schema_retry_count: number;
  result: AgentRelayResult | null;
  error: string | null;
  timeout_ms: number;
  attempt: number;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  updated_at: string;
};

export type CreateAgentRelayJobInput = {
  relayId: string;
  batchId: string;
  projectId: string;
  projectPath: string;
  sourceSessionId?: string | null;
  provider: LLMProvider;
  model?: string | null;
  effort?: string | null;
  mode: AgentRelayMode;
  approvalPolicy?: AgentRelayApprovalPolicy;
  label?: string | null;
  task: string;
  prompt: string;
  mcpServers: string[];
  outputSchema?: Record<string, unknown> | null;
  dependsOn?: string[];
  retries?: number;
  timeoutMs: number;
};

export type AgentRelayTaskInput = {
  task: string;
  label?: string | null;
  provider?: LLMProvider;
  model?: string | null;
  effort?: string | null;
  mode?: AgentRelayMode;
  approvalPolicy?: AgentRelayApprovalPolicy;
  timeoutMs?: number;
  mcpServers?: string[];
  outputSchema?: Record<string, unknown> | null;
  /** Zero-based indices of earlier tasks in the same batch this task needs. */
  dependsOn?: number[];
  retries?: number;
};

/**
 * Compact job view for the MCP surface. Full raw output stays behind
 * `relay_result` so fleet-wide status/wait reads do not flood the lead's
 * context with up to 100k characters per worker.
 */
export type AgentRelayJobSummary = {
  relayId: string;
  batchId: string;
  label: string | null;
  provider: LLMProvider;
  model: string | null;
  effort: string | null;
  mode: AgentRelayMode;
  approvalPolicy: AgentRelayApprovalPolicy;
  status: AgentRelayStatus;
  /** One-based global FIFO position while queued; null once admitted. */
  queuePosition: number | null;
  task: string;
  dependsOn: string[];
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  timeoutMs: number;
  attempt: number;
  retryCount: number;
  pendingApprovalCount: number;
  usage: { totalTokens: number | null; costUsd: number | null; runs: number } | null;
  result: {
    status: AgentRelayStructuredResult['status'];
    summary: string;
    evidence: string[];
    filesTouched: string[];
    testsRun: string[];
    openQuestions: string[];
    structuredOutput?: unknown;
    outputValidation?: { valid: boolean; errors: string[] };
    hasFullOutput: boolean;
    workspace?: { workspaceId: string; featureBranch: string; files: number; additions: number; deletions: number };
  } | null;
};

export type AgentRelaySettings = {
  enabled: boolean;
  leadProviders: LLMProvider[];
  workerProviders: LLMProvider[];
  /**
   * Per-provider whitelist of worker model ids. A missing key means that
   * provider's full catalog is allowed. A present key (including `[]`) means
   * only those models may be used as Relay workers.
   */
  allowedWorkerModels: Partial<Record<LLMProvider, string[]>>;
  maxConcurrency: number;
  defaultTimeoutMs: number;
  defaultMode: AgentRelayMode;
  defaultApprovalPolicy: AgentRelayApprovalPolicy;
  installSkill: boolean;
  /**
   * How long an out-of-envelope worker request waits for a lead decision
   * before the broker denies it. Must stay well under the job timeout so the
   * worker still gets to report back instead of being killed mid-answer.
   */
  approvalTimeoutMs: number;
};

export type AgentRelaySettingsPatch = Partial<AgentRelaySettings>;

export type AgentRelayBatchInput = {
  projectPath: string;
  sourceSessionId?: string | null;
  tasks: AgentRelayTaskInput[];
};

/**
 * Every relay read/write is scoped by the lead session that owns the job.
 * `sourceSessionId` is the caller's identity, not a filter the caller chooses:
 * a lead may only ever see and steer the workers it dispatched itself.
 */
export type AgentRelayScope = {
  sourceSessionId?: string | null;
  /** Set only by trusted operator surfaces (the UI panel's "all sessions" view). */
  allowUnscoped?: boolean;
};
