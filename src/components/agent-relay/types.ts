import type { LLMProvider } from '../../types/app';

export type AgentRelayMode = 'read_only' | 'isolated_write';
export type AgentRelayApprovalPolicy = 'auto' | 'manual';
export type AgentRelayStatus =
  | 'queued'
  | 'running'
  | 'waiting_approval'
  | 'completed'
  | 'blocked'
  | 'failed'
  | 'cancelled'
  | 'timed_out';

export type AgentRelayApprovalStatus = 'pending' | 'approved' | 'denied' | 'expired';
export type AgentRelayModelSelectionSource = 'requested' | 'catalog_default' | 'allowlist_fallback';

/** One worker permission request that fell outside the task's declared envelope. */
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
  expires_at?: string | null;
  decided_at: string | null;
};

export type AgentRelayVerificationEvidence = {
  command: string;
  cwd: string;
  testedCommit: string | null;
  exitCode: number | null;
  timedOut: boolean;
  cancelled: boolean;
  capped: boolean;
  output: string;
  stdout: string;
  stderr: string;
  passed: boolean;
  reason?: string;
};

export type AgentRelayVerification = {
  workspaceId: string;
  cwd: string;
  testedCommit: string | null;
  evidence: AgentRelayVerificationEvidence[];
  passed: boolean;
  unavailable: boolean;
  message?: string;
};

export type AgentRelayRehearsalResult = {
  deliveryId: string;
  passed: boolean;
  outcome: 'applied' | 'conflict' | 'error';
  conflicts: Array<{ relayId: string; path: string; reason: string }>;
  checks: AgentRelayVerification | null;
};

export type AgentRelayDeliveryStage =
  | 'pending'
  | 'verified'
  | 'verify_failed'
  | 'ready_to_land'
  | 'rehearsal_failed'
  | 'landed'
  | 'discarded';

/** Server-owned verify → rehearse → land state of one writer. */
export type AgentRelayDeliveryState = {
  stage: AgentRelayDeliveryStage;
  verifyId: string | null;
  verifyPassed: boolean | null;
  rehearsalId: string | null;
  rehearsalPassed: boolean | null;
  landId: string | null;
  landedSha: string | null;
};

export type AgentRelayUnlandedWorkspace = {
  relay_id: string;
  label: string | null;
  batch_id: string;
  status: AgentRelayStatus;
  result_status: string | null;
  workspace_id: string;
  branch: string;
  head_sha: string | null;
  changed_files: number;
  delivery: AgentRelayDeliveryState | null;
};

export type AgentRelayLandEntry = {
  relayId: string;
  deliveryId?: string;
  commitSha?: string | null;
  applied?: number;
  merged?: string[];
  conflicts?: Array<{ path: string; reason: string }>;
  leftUncommitted?: string[];
  cleanedUp?: boolean;
  skipped?: string;
};

export type AgentRelayLandResult = { landed: AgentRelayLandEntry[] };

export type AgentRelayDeniedAction = {
  at: string;
  attempt: number;
  tool: string | null;
  command: string | null;
  paths: string[];
  reason: string;
  via: string;
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

export type AgentRelayWorkerProfile = {
  mcpServers?: string[];
  defaultMode?: AgentRelayMode | null;
  defaultApprovalPolicy?: AgentRelayApprovalPolicy | null;
};

export type AgentRelaySettings = {
  enabled: boolean;
  leadProviders: LLMProvider[];
  workerProviders: LLMProvider[];
  /**
   * Per-provider whitelist of worker model ids. A missing key means that
   * provider's full catalog is allowed. A present key means only those models
   * may be used as Relay workers.
   */
  allowedWorkerModels: Partial<Record<LLMProvider, string[]>>;
  workerProfiles?: Partial<Record<LLMProvider, AgentRelayWorkerProfile>>;
  maxConcurrency: number;
  defaultTimeoutMs: number;
  defaultMode: AgentRelayMode;
  defaultApprovalPolicy: AgentRelayApprovalPolicy;
  installSkill: boolean;
  approvalTimeoutMs: number;
  workerSandbox: 'enforce' | 'off';
  workerNetwork: 'open' | 'restricted';
  workerAllowedDomains: string[];
  allowLeadManualApproval: boolean;
  autoVerify: boolean;
  autoRehearse: boolean;
  autoLand: 'off' | 'on_pass';
  defaultWorkerMcpServers: string[];
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
  /** Backward-compatible selected model id. */
  model: string | null;
  requested_model: string | null;
  model_label: string | null;
  catalog_default_model: string | null;
  catalog_resolved_model: string | null;
  runtime_resolved_model: string | null;
  model_selection_source: AgentRelayModelSelectionSource | null;
  effort: string | null;
  mode: AgentRelayMode;
  approval_policy: AgentRelayApprovalPolicy;
  status: AgentRelayStatus;
  /** One-based scheduler position while queued. */
  queue_position?: number | null;
  /** Short lead-chosen display name; falls back to the task text in UIs. */
  label: string | null;
  task: string;
  /** Relay ids this job waits on before starting (same-batch pipeline). */
  depends_on: string[];
  retries: number;
  retry_count: number;
  result: {
    status: 'completed' | 'failed' | 'blocked';
    summary: string;
    evidence: string[];
    filesTouched: string[];
    testsRun: string[];
    openQuestions: string[];
    /** Worker JSON for a task that declared an output schema. */
    structuredOutput?: unknown;
    outputValidation?: { valid: boolean; errors: string[] };
    output: string;
    workspace?: {
      workspaceId: string;
      rootPath: string;
      featureBranch: string;
      files: Array<{ path: string; status: string }>;
      additions: number;
      deletions: number;
    };
  } | null;
  error: string | null;
  timeout_ms: number;
  attempt: number;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  updated_at: string;
  usage?: { totalTokens: number | null; costUsd: number | null; runs: number } | null;
  /** Actions the worker's envelope refused (policy, Jev, or timeout). */
  denied_actions?: AgentRelayDeniedAction[];
  /** Provider switches after quota/auth/launch failures. */
  failovers?: AgentRelayFailover[];
  /** Writers only: delivery pipeline state from the server. */
  delivery?: AgentRelayDeliveryState | null;
};

export type AgentRelayRuntimeStatus = {
  enabled: boolean;
  activeCount: number;
  queuedCount: number;
  mcpServerName: string;
  skillName: string;
  providers: Array<{
    provider: LLMProvider;
    installed: boolean;
    authenticated: boolean;
    runtimeAvailable: boolean;
    error?: string;
  }>;
};
