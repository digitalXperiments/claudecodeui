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
  | 'custom';

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
  /** Pull request opened from the swarm worktree (if any). */
  prUrl?: string | null;
  prNumber?: number | null;
  featureBranch?: string | null;
  workspaceId?: string | null;
  prError?: string | null;
};

/** Alias used by approve / older UI. */
export type SwarmSynthesis = SwarmHandoff;

export type SwarmPlanStep = {
  id: string;
  title: string;
  kind: SwarmAgentKind | string;
  /** Match roster agent by label or id. */
  assignTo?: string | null;
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
  stepTimeoutMs?: number | null;
  maxConcurrency?: number | null;
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
  /** ISO timestamp when archived; null while active in history. */
  archived_at: string | null;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
  members?: SwarmMember[];
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
  /** Hard timeout (ms) per worker agent run; steps exceeding it fail. */
  stepTimeoutMs?: number;
  /** Max parallel workers in one wave; defaults to roster size. */
  maxConcurrency?: number;
  /** Fallback when a roster seat omits provider. */
  provider?: string | null;
  model?: string | null;
  effort?: string | null;
  permissionMode?: string | null;
};

/** Same as SwarmConfig (used by plan gate + execution options). */
export type SwarmExecutionOptions = {
  requireApproval: boolean;
  requirePlanApproval: boolean;
  stepTimeoutMs: number | null;
  maxConcurrency: number | null;
};
