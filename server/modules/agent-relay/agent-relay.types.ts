import type { JevResultAdvice } from '@/modules/agent-relay/jev-relay.service.js';
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
  'omp',
  'antigravity',
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
  /**
   * The worker finished its turn but reported it could not complete the
   * assignment (a denied action, missing capability, or open question). A
   * first-class outcome so it is never counted as success.
   */
  | 'blocked'
  | 'failed'
  | 'cancelled'
  | 'timed_out';

export const AGENT_RELAY_TERMINAL_STATUSES = new Set<AgentRelayStatus>([
  'completed',
  'blocked',
  'failed',
  'cancelled',
  'timed_out',
]);

export type AgentRelayApprovalStatus = 'pending' | 'approved' | 'denied' | 'expired';

export type AgentRelayModelSelectionSource = 'requested' | 'catalog_default' | 'allowlist_fallback';

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
  /** Validation verdict for the standard relay result envelope. */
  contractValidation?: { valid: boolean; errors: string[] };
  /**
   * Advisory Jev assessment of this finished report. Attached after the job
   * has already reached a terminal status, so it never influences the
   * lifecycle — it exists for the lead and for rollout measurement.
   */
  jevAssessment?: JevResultAdvice;
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
  /** Backward-compatible selected model id passed to the provider runtime. */
  model: string | null;
  /** Explicit model supplied by the lead; null when the lead omitted it. */
  requested_model: string | null;
  /** Human label snapshotted from the provider catalog at submission time. */
  model_label: string | null;
  /** Provider catalog default observed when the job was submitted. */
  catalog_default_model: string | null;
  /** Concrete id advertised by the catalog for an alias such as Claude `default`. */
  catalog_resolved_model: string | null;
  /** Concrete id reported by the running provider, when available. */
  runtime_resolved_model: string | null;
  model_selection_source: AgentRelayModelSelectionSource | null;
  effort: string | null;
  mode: AgentRelayMode;
  approval_policy: AgentRelayApprovalPolicy;
  status: AgentRelayStatus;
  /** Short lead-chosen display name, used in titles and compact listings. */
  label: string | null;
  task: string;
  last_prompt: string;
  /**
   * A lead follow-up sent while this job was non-terminal (running, queued, or
   * parked on an approval) that could not be injected into a live provider
   * turn. Delivered as the prompt for the job's next attempt, then cleared.
   */
  pending_follow_up: string | null;
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
  /**
   * Worker actions the envelope refused (policy, Jev, or approval timeout).
   * Durable so the lead learns what was blocked without the worker having to
   * mention it, and can do those steps itself after review.
   */
  denied_actions: AgentRelayDeniedAction[];
  /** Provider switches Relay made after quota/auth/launch failures, oldest first. */
  failovers: AgentRelayFailover[];
  error: string | null;
  timeout_ms: number;
  attempt: number;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  updated_at: string;
};

export type AgentRelayFailover = {
  at: string;
  fromProvider: LLMProvider;
  fromModel: string | null;
  toProvider: LLMProvider;
  toModel: string | null;
  failure: string;
  reason: string;
};

export type AgentRelayDeniedAction = {
  at: string;
  attempt: number;
  tool: string | null;
  command: string | null;
  paths: string[];
  reason: string;
  via: 'policy' | 'jev' | 'timeout' | 'lead' | 'operator';
};

export type CreateAgentRelayJobInput = {
  relayId: string;
  batchId: string;
  projectId: string;
  projectPath: string;
  sourceSessionId?: string | null;
  provider: LLMProvider;
  model?: string | null;
  requestedModel?: string | null;
  modelLabel?: string | null;
  catalogDefaultModel?: string | null;
  catalogResolvedModel?: string | null;
  modelSelectionSource?: AgentRelayModelSelectionSource | null;
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
  /**
   * What the worker needs to do the job, checked before dispatch instead of
   * discovered mid-run: MCP servers (granted automatically), network egress,
   * and command-line tools that must be installed on the host.
   */
  requires?: AgentRelayTaskRequirements;
};

export type AgentRelayTaskRequirements = {
  mcpServers?: string[];
  network?: boolean;
  commands?: string[];
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
  requestedModel: string | null;
  selectedModel: string | null;
  modelLabel: string | null;
  catalogDefaultModel: string | null;
  catalogResolvedModel: string | null;
  runtimeResolvedModel: string | null;
  modelSelectionSource: AgentRelayModelSelectionSource | null;
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
  /** Most recent actions the envelope refused, so the lead can do them after review. */
  deniedActions: Array<Pick<AgentRelayDeniedAction, 'tool' | 'command' | 'reason' | 'via'>>;
  /** Writers only: where the server's verify → rehearse → land pipeline stands. */
  delivery?: { stage: string; rehearsalId: string | null; landedSha: string | null } | null;
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
    contractValidation?: { valid: boolean; errors: string[] };
    jevAssessment?: JevResultAdvice;
    hasFullOutput: boolean;
    workspace?: { workspaceId: string; featureBranch: string; files: number; additions: number; deletions: number };
  } | null;
};

export type AgentRelayWorkerProfile = {
  /** Catalog names this provider may receive as worker MCP grants. */
  mcpServers?: string[];
  /** null/omit = use global defaultMode. */
  defaultMode?: AgentRelayMode | null;
  defaultApprovalPolicy?: AgentRelayApprovalPolicy | null;
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
  /**
   * Per-provider worker defaults: MCP grant allowlists and optional mode /
   * approval overrides used when a task omits those fields.
   */
  workerProfiles: Partial<Record<LLMProvider, AgentRelayWorkerProfile>>;
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
  /**
   * OS sandbox for workers. `enforce` confines each worker (Claude SDK
   * sandbox, Codex seatbelt, or `sandbox-exec` around ACP CLIs) so in-sandbox
   * actions are auto-approved and only boundary crossings need a decision.
   */
  workerSandbox: 'enforce' | 'off';
  /** Network for sandboxed workers: `open` (default) or `restricted` (no egress). */
  workerNetwork: 'open' | 'restricted';
  /** Domain allowlist for providers that filter egress by domain (Claude). Empty = built-in dev defaults. */
  workerAllowedDomains: string[];
  /**
   * Whether a lead may choose `approvalPolicy: "manual"` per task. Off by
   * default: leads reach for manual out of caution and then spend their turns
   * approving routine work. The operator's own default policy always applies.
   */
  allowLeadManualApproval: boolean;
  /** Server runs host checks on every writer as soon as it finishes. */
  autoVerify: boolean;
  /** When a batch settles, the server rehearses its verified final-stage writers together. */
  autoRehearse: boolean;
  /** Land a passing automatic rehearsal without waiting for the lead. Off by default. */
  autoLand: 'off' | 'on_pass';
  /**
   * MCP servers granted to every worker whose provider honors grants (e.g.
   * project memory, a localhost browser), on top of task grants.
   */
  defaultWorkerMcpServers: string[];
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
