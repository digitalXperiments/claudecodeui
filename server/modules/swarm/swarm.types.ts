/** Agent Swarm — goal-oriented multi-agent orchestration. */

export type SwarmStatus =
  | 'queued'
  | 'planning'
  | 'awaiting_plan_approval'
  | 'running'
  | 'handing_off'
  | 'awaiting_approval'
  | 'succeeded'
  | 'failed'
  | 'aborted';

/** Kind of agent in the swarm roster. */
export type SwarmAgentKind =
  | 'orchestrator'
  | 'explorer'
  | 'implementer'
  | 'reviewer'
  | 'tester'
  | 'security'
  | 'docs'
  | 'custom';

/**
 * Quantitative capability tier of a seat, mirrored from the agent profile's
 * `swarm_level`. The orchestrator matches this against a step's `difficulty`,
 * and a retried step escalates to an equal-or-stronger tier.
 */
export type SwarmAgentLevel = 'basic' | 'medium' | 'advanced';

/**
 * One seat in the swarm roster (user-defined before start).
 * Orchestrator is also listed here (exactly one recommended).
 */
export type SwarmAgentSpec = {
  /** Stable id for assignment (generated if omitted). */
  id?: string;
  kind: SwarmAgentKind | string;
  label: string;
  provider?: string | null;
  model?: string | null;
  effort?: string | null;
  permissionMode?: string | null;
  /** Skill names/ids the agent should use when available. */
  skills?: string[];
  focus?: string;
  /** Capability tier (from the source agent profile). Defaults to 'medium'. */
  level?: SwarmAgentLevel | null;
  /** Agent profile this seat was auto-selected from, when applicable. */
  profileId?: string | null;
};

/** @deprecated Prefer SwarmAgentSpec — kept for older clients. */
export type SwarmRoleName =
  | 'planner'
  | 'implementer'
  | 'tester'
  | 'security'
  | 'docs'
  | 'custom';

/** @deprecated Prefer SwarmAgentSpec. */
export type SwarmRoleConfig = {
  role?: SwarmRoleName | string;
  kind?: SwarmAgentKind | string;
  label?: string;
  provider?: string | null;
  model?: string | null;
  effort?: string | null;
  permissionMode?: string | null;
  skills?: string[];
  focus?: string;
  id?: string;
};

export type SwarmMember = {
  member_id: string;
  swarm_id: string;
  role: string;
  kind: string | null;
  label: string | null;
  provider: string | null;
  model: string | null;
  effort: string | null;
  permission_mode: string | null;
  skills_json: string | null;
  step_id: string | null;
  run_id: string | null;
  status: string;
  findings_summary: string | null;
  error: string | null;
  created_at: string;
  finished_at: string | null;
};

export type SwarmFinding = {
  memberId: string;
  role: string;
  summary: string;
  at: string;
  stepId?: string | null;
};

export type SwarmActionItem = {
  title: string;
  prompt: string;
  priority?: 'high' | 'medium' | 'low';
};

/** One validation attempt in the remediation loop (audit + report history). */
export type SwarmValidationAttemptRecord = {
  attempt: number;
  passed: boolean;
  /** Labels of the checks that failed in this attempt (empty when passed). */
  failedChecks: string[];
  /** Titles of the remediation steps dispatched after this failed attempt. */
  remediationSteps?: string[];
};

/** Compact validation-gate outcome persisted on the handoff for the UI. */
export type SwarmValidationSummary = {
  passed: boolean;
  /** True when smoke/PDF tooling was missing and the gate ran static-only. */
  degraded: boolean;
  summary: string;
  checks: Array<{ id: string; label: string; status: string }>;
  reportPdfPath: string | null;
  reportHtmlPath: string | null;
  generatedAt: string;
  /** Remediation-loop history (additive; absent on single-attempt runs from older data). */
  attempts?: SwarmValidationAttemptRecord[];
};

/** Final orchestrator overview (also stored in synthesis_json for approve path). */
export type SwarmHandoff = {
  summary: string;
  completed: string[];
  remaining: string[];
  recommendations: string[];
  risks: string[];
  memberCount: number;
  generatedAt: string;
  actionItems?: SwarmActionItem[];
  createdTaskIds?: string[];
  tasksCreated?: number;
  /** Routes/screens the orchestrator flagged for smoke verification. */
  verificationTargets?: string[];
  /** Pre-PR stability gate outcome (null/absent when the gate was skipped). */
  validation?: SwarmValidationSummary | null;
  /** Pull request opened from the swarm worktree (if any). */
  prUrl?: string | null;
  prNumber?: number | null;
  featureBranch?: string | null;
  workspaceId?: string | null;
  prError?: string | null;
  /** Whether the feature branch actually reached the remote (set once finalizeSwarmPullRequest attempts a push). */
  pushed?: boolean;
};

/** Alias used by approve / older UI. */
export type SwarmSynthesis = SwarmHandoff;

export type SwarmPlanStep = {
  id: string;
  title: string;
  kind: SwarmAgentKind | string;
  /** Match roster agent by label or id. */
  assignTo?: string | null;
  /** Auto-roster: agent_run_profiles profile the orchestrator picked for this step. */
  profileId?: string | null;
  /** Replacement step that recovered an earlier failed step. */
  replacesStepId?: string | null;
  /**
   * How hard the orchestrator judged this step. Drives seat selection (a
   * `basic` seat is never staffed on an `advanced` step) and retry escalation.
   */
  difficulty?: SwarmAgentLevel | null;
  /** Machine-readable acceptance criteria the worker must report evidence for. */
  acceptanceCriteria?: string[];
  /** Optional read-only commands the worker should run to verify the step. */
  verificationCommands?: string[];
  /** Implementer steps can require a non-empty diff before being accepted. */
  requiresChanges?: boolean;
  /**
   * Files, globs or areas this step exclusively owns. Two steps in one wave are
   * only allowed to run together when their scopes are disjoint — overlapping
   * same-kind steps are the "several agents on one thing" smell, and get
   * serialized with a blackboard warning rather than dropped.
   */
  scope?: string[];
  provider?: string | null;
  model?: string | null;
  effort?: string | null;
  permissionMode?: string | null;
  prompt: string;
  dependsOn?: string[];
  /** Steps with the same wave number may run in parallel once deps clear. */
  wave?: number;
  status?: string;
};

/** One attempt at a single plan step (per-task retry loop, for the report). */
export type SwarmStepAttemptRecord = {
  attempt: number;
  /** Seat label that ran this attempt. */
  seatLabel: string;
  outcome: 'succeeded' | 'failed' | 'timed_out' | 'stalled';
  /** Failure text (truncated) when the attempt did not succeed. */
  error?: string | null;
  /** True when the next attempt went to a different seat. */
  reassigned?: boolean;
};

export type SwarmPlan = {
  summary: string;
  strategy: string;
  costNotes?: string;
  steps: SwarmPlanStep[];
  generatedAt: string;
};

/** Shared channel so agents can “talk” across turns. */
export type SwarmMessage = {
  id: string;
  from: string;
  to?: string | null;
  kind: 'plan' | 'result' | 'note' | 'handoff' | 'system' | 'question' | 'answer';
  content: string;
  stepId?: string | null;
  at: string;
};

export type SwarmConfig = {
  requireApproval: boolean;
  requirePlanApproval?: boolean;
  /** Hard wall-clock ceiling per agent run. Stall detection is the primary kill. */
  stepTimeoutMs?: number | null;
  /**
   * Silence budget per agent run: an agent that emits no events for this long
   * is stuck and gets killed + reassigned. Null uses the service default.
   */
  stallTimeoutMs?: number | null;
  /**
   * Attempts per plan step (initial + feedback retries) before the orchestrator
   * replans it. Default 3 (env CLOUDCLI_SWARM_STEP_MAX_ATTEMPTS), cap 5.
   */
  stepMaxAttempts?: number | null;
  maxConcurrency?: number | null;
  /** Run disjoint writer steps in isolated child worktrees and merge them back. */
  parallelWriters?: boolean;
  /** Orchestrator selects worker seats from swarm-tagged agent profiles. */
  autoRoster?: boolean;
  /** Pre-PR stability gate (static checks + smoke + report). Default true. */
  validateBeforePr?: boolean;
  /**
   * Max validation attempts (initial + remediation re-runs). Default 4 (env
   * CLOUDCLI_SWARM_VALIDATION_MAX_ATTEMPTS), hard-capped at 8.
   */
  validationMaxAttempts?: number | null;
  /**
   * Open the PR even when the gate is still red after every remediation
   * attempt, so the work + report are never lost (they become the input to a
   * follow-up swarm). Default true.
   */
  prOnRedValidation?: boolean;
  orchestrator: SwarmAgentSpec;
  agents: SwarmAgentSpec[];
  skills: string[];
};

export type SwarmRun = {
  swarm_id: string;
  project_id: string;
  parent_run_id: string | null;
  goal: string;
  status: SwarmStatus | string;
  /** Roster + orchestrator (serialized agent specs). */
  roles: SwarmAgentSpec[];
  findings: SwarmFinding[];
  synthesis: SwarmHandoff | null;
  plan: SwarmPlan | null;
  blackboard: SwarmMessage[];
  skills: string[];
  config: SwarmConfig | null;
  /** Dedicated git worktree (or sandbox) for this swarm. */
  workspace_id: string | null;
  /** Feature branch on the worktree (git_worktree mode). */
  feature_branch: string | null;
  /** Opened PR URL after orchestrator handoff (if push/PR succeeded). */
  pr_url: string | null;
  approval_status: 'pending' | 'approved' | 'rejected' | 'plan_pending' | 'plan_approved' | null;
  interrupt_id: string | null;
  /** Monotonic optimistic-lock version for lifecycle compare-and-swap writes. */
  version: number;
  /** Persisted cancellation request; workers check this between every side effect. */
  cancel_requested_at: string | null;
  /** Last durable pipeline error, when one exists. */
  last_error: string | null;
  idempotency_key: string | null;
  lease_owner: string | null;
  lease_expires_at: string | null;
  /** ISO timestamp when archived; null while active in history. */
  archived_at: string | null;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
  members?: SwarmMember[];
  artifacts?: SwarmArtifact[];
  /** Aggregated cost/usage rollup from member runs (computed on read). */
  usage?: SwarmUsageRollup | null;
};

export type SwarmUsageRollup = {
  totalTokens: number;
  totalCostUsd: number;
  memberRuns: Array<{
    memberId: string;
    runId: string | null;
    label: string | null;
    tokens: number;
    costUsd: number;
    durationMs: number | null;
  }>;
};

export type StartSwarmInput = {
  projectId: string;
  goal: string;
  /** Full roster including orchestrator, or use `orchestrator` + `agents`. */
  agents?: SwarmAgentSpec[];
  orchestrator?: SwarmAgentSpec | null;
  /** @deprecated Mapped into agents when agents omitted. */
  roles?: SwarmRoleConfig[];
  skills?: string[];
  requireApproval?: boolean;
  /** Gate on the orchestrator plan before running any worker agents. */
  requirePlanApproval?: boolean;
  /** Hard wall-clock ceiling (ms) per worker agent run. */
  stepTimeoutMs?: number;
  /** Silence budget (ms) before an agent is treated as stuck and reassigned. */
  stallTimeoutMs?: number;
  /** Attempts per plan step before the orchestrator replans it (default 3, cap 5). */
  stepMaxAttempts?: number;
  /** Max parallel workers in one wave; defaults to roster size. */
  maxConcurrency?: number;
  /** Run disjoint writer steps in isolated child worktrees and merge them back. */
  parallelWriters?: boolean;
  /** Fallback when a roster seat omits provider. */
  provider?: string | null;
  model?: string | null;
  effort?: string | null;
  permissionMode?: string | null;
  /**
   * Let the orchestrator pick explorer/implementer/reviewer seats from
   * swarm-tagged agent profiles. Implied when only an orchestrator seat is
   * supplied; a full manual roster keeps today's behavior.
   */
  autoRoster?: boolean;
  /** Run the pre-PR stability gate (default true). Set false to opt out. */
  validateBeforePr?: boolean;
  /** Max validation attempts incl. remediation re-runs (default 4, cap 8). */
  validationMaxAttempts?: number;
  /** Open the PR even if the gate stays red after every attempt (default true). */
  prOnRedValidation?: boolean;
  /** Optional request key: repeated starts for one project return the first swarm. */
  idempotencyKey?: string | null;
};

export type SwarmArtifact = {
  artifact_id: string;
  swarm_id: string;
  step_id: string | null;
  attempt_id: string | null;
  kind: string;
  label: string;
  content: string | null;
  path: string | null;
  created_at: string;
};

export type SwarmStepAttempt = {
  attempt_id: string;
  swarm_id: string;
  step_id: string;
  member_id: string | null;
  run_id: string | null;
  phase: string;
  attempt_no: number;
  status: string;
  workspace_id: string | null;
  error: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  updated_at: string;
};

/** Same as SwarmConfig (used by plan gate + execution options). */
export type SwarmExecutionOptions = {
  requireApproval: boolean;
  requirePlanApproval: boolean;
  stepTimeoutMs: number | null;
  maxConcurrency: number | null;
};

export type SwarmStepAttemptPhase = 'plan' | 'step' | 'replan' | 'handoff' | 'validate' | 'publish';
