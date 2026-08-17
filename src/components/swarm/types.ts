import type { ProviderModelOption } from '../../types/app';

export type SwarmAgentKind =
  | 'orchestrator'
  | 'explorer'
  | 'implementer'
  | 'reviewer'
  | 'tester'
  | 'security'
  | 'docs'
  | 'custom'
  | string;

export type SwarmLifecycleStatus =
  | 'queued'
  | 'planning'
  | 'awaiting_plan_approval'
  | 'running'
  | 'handing_off'
  | 'awaiting_approval'
  | 'succeeded'
  | 'failed'
  | 'aborted';

export type SwarmWorkspaceStatus =
  | 'active'
  | 'merging'
  | 'merged'
  | 'discarded'
  | 'error'
  | 'orphan';

/** Quantitative capability tier of a seat, mirrored from its agent profile. */
export type SwarmAgentLevel = 'basic' | 'medium' | 'advanced';

export type SwarmAgentSpec = {
  id?: string;
  kind: SwarmAgentKind;
  label: string;
  provider?: string | null;
  model?: string | null;
  effort?: string | null;
  permissionMode?: string | null;
  skills?: string[];
  focus?: string;
  /** Capability tier the orchestrator matches against step difficulty. */
  level?: SwarmAgentLevel | null;
  profileId?: string | null;
};

export type SwarmMember = {
  member_id: string;
  swarm_id: string;
  role: string;
  kind?: string | null;
  label: string | null;
  provider: string | null;
  model: string | null;
  effort?: string | null;
  permission_mode?: string | null;
  step_id?: string | null;
  run_id: string | null;
  status: SwarmLifecycleStatus | string;
  findings_summary: string | null;
  error: string | null;
  created_at: string;
  finished_at: string | null;
};

export type SwarmPlanStep = {
  id: string;
  title: string;
  kind: string;
  assignTo?: string | null;
  /** Capability tier the orchestrator judged this step to need. */
  difficulty?: SwarmAgentLevel | null;
  /** Replacement step that recovered an earlier failed step. */
  replacesStepId?: string | null;
  acceptanceCriteria?: string[];
  verificationCommands?: string[];
  requiresChanges?: boolean;
  provider?: string | null;
  model?: string | null;
  effort?: string | null;
  permissionMode?: string | null;
  wave?: number;
  status?: string;
  prompt?: string;
};

export type SwarmPlan = {
  summary: string;
  strategy: string;
  costNotes?: string;
  steps: SwarmPlanStep[];
  generatedAt: string;
};

export type SwarmWorktreeFingerprint = {
  head: string | null;
  dirty: boolean;
  signature: string;
};

export type SwarmCritiquePacket = {
  file: string | null;
  severity: 'critical' | 'warning' | 'info' | string;
  ask: string;
  evidence: string;
};

export type SwarmSupervisorDecision = {
  tick: number;
  at: string;
  action: 'dispatch' | 'done' | 'blocked' | string;
  kind: string | null;
  title: string | null;
  reason: string;
  policy: string;
  coerced: boolean;
  stepId: string | null;
};

export type SwarmGoalCard = {
  status: string;
  mode: 'plan' | 'supervisor' | string;
  fingerprint: SwarmWorktreeFingerprint | null;
  lastWriter: string | null;
  lastWriterKind: string | null;
  lastReview: {
    verdict: 'approved' | 'changes_requested' | 'failed' | string;
    blockers: SwarmCritiquePacket[];
    blockerHash: string;
    shaReviewed: string | null;
    fingerprint: string | null;
    seatLabel: string | null;
    stepId: string | null;
    vague: boolean;
  } | null;
  repeatBlockerCount: number;
  ticksUsed: number;
  tickBudget: number;
  decisions: SwarmSupervisorDecision[];
  updatedAt: string;
};

export type SwarmMessage = {
  id: string;
  from: string;
  to?: string | null;
  kind: string;
  content: string;
  stepId?: string | null;
  at: string;
};

export type SwarmValidationCheckStatus =
  | 'passed'
  | 'failed'
  | 'skipped'
  | 'degraded'
  | string;

export type SwarmValidationCheck = {
  id: string;
  label: string;
  status: SwarmValidationCheckStatus;
};

/** Compact pre-PR validation gate outcome persisted on the handoff. */
export type SwarmValidationSummary = {
  passed: boolean;
  /** True when smoke/PDF tooling was missing and the gate ran static-only. */
  degraded: boolean;
  summary: string;
  checks: SwarmValidationCheck[];
  reportPdfPath: string | null;
  reportHtmlPath: string | null;
  generatedAt: string;
  /** Remediation-loop history (absent on older single-attempt data). */
  attempts?: Array<{
    attempt: number;
    passed: boolean;
    failedChecks: string[];
    remediationSteps?: string[];
  }>;
};

/** Orchestrator conclusion only — no Kanban task side effects. */
export type SwarmHandoff = {
  summary: string;
  completed?: string[];
  remaining?: string[];
  recommendations?: string[];
  risks?: string[];
  prUrl?: string | null;
  prNumber?: number | null;
  featureBranch?: string | null;
  workspaceId?: string | null;
  prError?: string | null;
  /** Whether the feature branch actually reached the remote. */
  pushed?: boolean;
  /** Pre-PR stability gate outcome (null/absent when the gate was skipped). */
  validation?: SwarmValidationSummary | null;
  /** @deprecated Never populated by Agent Swarm (handoff-only). */
  actionItems?: Array<{ title: string; prompt: string; priority?: string }>;
  /** @deprecated Always 0 — swarm does not create Kanban tasks. */
  tasksCreated?: number;
  /** @deprecated Always empty. */
  createdTaskIds?: string[];
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

/** Goal-context file uploaded with the swarm (PRD, screenshot, design doc, …). */
export type SwarmAttachment = {
  path: string;
  name?: string;
  mimeType?: string;
  size?: number;
  /** Workspace-relative path after the pipeline copies the file into the worktree. */
  workspacePath?: string | null;
};

export type SwarmRun = {
  swarm_id: string;
  project_id: string;
  parent_run_id: string | null;
  goal: string;
  status: SwarmLifecycleStatus | string;
  roles: SwarmAgentSpec[];
  findings?: Array<{ memberId: string; role: string; summary: string; at: string }>;
  synthesis: SwarmHandoff | null;
  plan: SwarmPlan | null;
  blackboard: SwarmMessage[];
  skills: string[];
  goalCard?: SwarmGoalCard | null;
  /** Files attached to the goal at create time. */
  attachments?: SwarmAttachment[];
  config?: {
    requireApproval?: boolean;
    requirePlanApproval?: boolean;
    stepTimeoutMs?: number | null;
    maxConcurrency?: number | null;
    parallelWriters?: boolean;
    autonomous?: boolean;
  } | null;
  workspace_id?: string | null;
  /** Persisted workspace state when supplied by newer API responses. */
  workspace_status?: SwarmWorkspaceStatus | null;
  workspaceStatus?: SwarmWorkspaceStatus | null;
  /** Persisted cleanup marker when supplied by newer API responses. */
  workspace_cleaned_at?: string | null;
  workspaceCleanedAt?: string | null;
  feature_branch?: string | null;
  pr_url?: string | null;
  /** Server-authoritative actions when exposed by newer API versions. */
  allowedActions?: string[];
  /** Snake-case compatibility for persisted/API DTOs. */
  allowed_actions?: string[];
  version?: number;
  cancel_requested_at?: string | null;
  cancelRequestedAt?: string | null;
  last_error?: string | null;
  approval_status: 'pending' | 'approved' | 'rejected' | 'plan_pending' | 'plan_approved' | null;
  /** ISO when archived; null while active in history. */
  archived_at?: string | null;
  created_at: string;
  finished_at: string | null;
  members?: SwarmMember[];
  artifacts?: SwarmArtifact[];
  usage?: {
    totalTokens: number;
    totalCostUsd: number;
    totalDurationMs?: number | null;
    billedDurationMs?: number | null;
    memberRuns: Array<{
      memberId: string;
      runId: string | null;
      stepId?: string | null;
      label: string | null;
      tokens: number;
      costUsd: number;
      durationMs: number | null;
    }>;
  } | null;
};

export const SWARM_PROVIDERS = [
  'claude',
  'codex',
  'cursor',
  'opencode',
  'kilo',
  'cline',
  'grok',
  'kimi',
  'pi',
] as const;

export const SWARM_EFFORTS = ['default', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

/** Fallback effort values used only before a provider's live model catalog loads. */
export const SWARM_PROVIDER_EFFORTS: Record<string, string[]> = {
  claude: ['low', 'medium', 'high', 'xhigh', 'max'],
  codex: ['low', 'medium', 'high', 'xhigh'],
  opencode: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
  kilo: ['low', 'medium', 'high'],
  cline: [],
  grok: ['low', 'medium', 'high'],
};

/** Fallback labels — UI prefers provider capability matrix when loaded. */
export const SWARM_PERMISSION_MODES = [
  'default',
  'auto',
  'acceptEdits',
  'bypassPermissions',
  'plan',
] as const;

export const SWARM_PERMISSION_LABELS: Record<string, string> = {
  default: 'Default',
  auto: 'Auto',
  acceptEdits: 'Accept Edits',
  bypassPermissions: 'Bypass Permissions',
  plan: 'Plan',
};

/**
 * Provider-specific permission modes (mirrors server provider-capabilities).
 * Used until /api/providers/capabilities loads; then the API is source of truth.
 */
export const SWARM_PROVIDER_PERMISSION_MODES: Record<string, string[]> = {
  claude: ['default', 'auto', 'acceptEdits', 'bypassPermissions', 'plan'],
  cursor: ['default', 'bypassPermissions'],
  codex: ['default', 'auto', 'bypassPermissions'],
  opencode: ['default', 'acceptEdits', 'auto', 'plan'],
  kilo: ['default', 'acceptEdits', 'auto', 'bypassPermissions', 'plan'],
  cline: ['default', 'auto', 'bypassPermissions'],
  grok: ['default', 'acceptEdits', 'auto', 'bypassPermissions', 'plan'],
  kimi: ['default', 'plan', 'auto', 'bypassPermissions'],
  pi: ['plan', 'bypassPermissions'],
};

export const SWARM_PROVIDER_DEFAULT_PERMISSION: Record<string, string> = {
  claude: 'default',
  cursor: 'default',
  codex: 'default',
  opencode: 'default',
  kilo: 'default',
  cline: 'default',
  grok: 'default',
  kimi: 'bypassPermissions',
  pi: 'bypassPermissions',
};

export function permissionModesForProvider(
  provider: string,
  capabilityMap?: Record<string, string[]> | null,
): string[] {
  const key = (provider || 'claude').toLowerCase();
  const fromCap = capabilityMap?.[key];
  if (Array.isArray(fromCap) && fromCap.length > 0) return fromCap;
  return SWARM_PROVIDER_PERMISSION_MODES[key] ?? [...SWARM_PERMISSION_MODES];
}

export function clampPermissionMode(
  provider: string,
  mode: string | null | undefined,
  capabilityMap?: Record<string, string[]> | null,
): string {
  const modes = permissionModesForProvider(provider, capabilityMap);
  if (mode && modes.includes(mode)) return mode;
  const def = SWARM_PROVIDER_DEFAULT_PERMISSION[(provider || 'claude').toLowerCase()];
  if (def && modes.includes(def)) return def;
  return modes[0] ?? 'default';
}

export function effortOptionsForProvider(
  provider: string,
  model: string | null | undefined,
  modelOptions: ProviderModelOption[] = [],
): NonNullable<ProviderModelOption['effort']>['values'] {
  const selected = modelOptions.find((option) => option.value === model);
  if (selected) return selected.effort?.values ?? [];
  if (modelOptions.length > 0) return [];
  return (SWARM_PROVIDER_EFFORTS[(provider || 'claude').toLowerCase()] ?? []).map((value) => ({
    value,
  }));
}

export function clampEffort(
  provider: string,
  model: string | null | undefined,
  effort: string | null | undefined,
  modelOptions: ProviderModelOption[] = [],
): string {
  if (!effort || effort === 'default') return 'default';
  const allowed = effortOptionsForProvider(provider, model, modelOptions).map((option) => option.value);
  return allowed.includes(effort) ? effort : 'default';
}

export const SWARM_KINDS: Array<{ value: SwarmAgentKind; label: string }> = [
  { value: 'orchestrator', label: 'Orchestrator' },
  { value: 'explorer', label: 'Explorer' },
  { value: 'implementer', label: 'Implementer' },
  { value: 'reviewer', label: 'Reviewer' },
  { value: 'tester', label: 'Tester' },
  { value: 'security', label: 'Security' },
  { value: 'docs', label: 'Docs' },
  { value: 'custom', label: 'Custom' },
];

export function defaultRoster(): SwarmAgentSpec[] {
  return [
    {
      id: 'orchestrator',
      kind: 'orchestrator',
      label: 'Orchestrator',
      provider: 'claude',
      effort: 'medium',
      // Matches the server-side default (normalizeAgentSpec) — the
      // orchestrator drives the whole swarm unattended and must never stall
      // on a permission prompt.
      permissionMode: clampPermissionMode('claude', 'bypassPermissions'),
      focus: 'Plan, assign, and hand off the goal cost-efficiently.',
    },
    {
      id: 'explorer',
      kind: 'explorer',
      label: 'Explorer',
      provider: 'grok',
      effort: 'low',
      permissionMode: clampPermissionMode('grok', 'default'),
      focus: 'Map the codebase and gather facts.',
    },
    {
      id: 'implementer',
      kind: 'implementer',
      label: 'Implementer',
      provider: 'claude',
      effort: 'high',
      permissionMode: clampPermissionMode('claude', 'acceptEdits'),
      focus: 'Implement planned changes.',
    },
    {
      id: 'reviewer',
      kind: 'reviewer',
      label: 'Reviewer',
      provider: 'claude',
      effort: 'medium',
      permissionMode: clampPermissionMode('claude', 'default'),
      focus: 'Review work for correctness and risk.',
    },
  ];
}
