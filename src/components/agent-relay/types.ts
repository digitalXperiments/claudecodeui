import type { LLMProvider } from '../../types/app';

export type AgentRelayMode = 'read_only' | 'isolated_write';
export type AgentRelayApprovalPolicy = 'auto' | 'manual';
export type AgentRelayStatus =
  | 'queued'
  | 'running'
  | 'waiting_approval'
  | 'completed'
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
  decided_at: string | null;
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
