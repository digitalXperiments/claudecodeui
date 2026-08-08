export type SwarmAgentKind =
  | 'orchestrator'
  | 'explorer'
  | 'implementer'
  | 'reviewer'
  | 'custom'
  | string;

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
  status: string;
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

export type SwarmMessage = {
  id: string;
  from: string;
  to?: string | null;
  kind: string;
  content: string;
  stepId?: string | null;
  at: string;
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
  /** @deprecated Never populated by Agent Swarm (handoff-only). */
  actionItems?: Array<{ title: string; prompt: string; priority?: string }>;
  /** @deprecated Always 0 — swarm does not create Kanban tasks. */
  tasksCreated?: number;
  /** @deprecated Always empty. */
  createdTaskIds?: string[];
};

export type SwarmRun = {
  swarm_id: string;
  project_id: string;
  parent_run_id: string | null;
  goal: string;
  status: string;
  roles: SwarmAgentSpec[];
  findings?: Array<{ memberId: string; role: string; summary: string; at: string }>;
  synthesis: SwarmHandoff | null;
  plan: SwarmPlan | null;
  blackboard: SwarmMessage[];
  skills: string[];
  config?: {
    requireApproval?: boolean;
    requirePlanApproval?: boolean;
    stepTimeoutMs?: number | null;
    maxConcurrency?: number | null;
  } | null;
  workspace_id?: string | null;
  feature_branch?: string | null;
  pr_url?: string | null;
  approval_status: 'pending' | 'approved' | 'rejected' | 'plan_pending' | 'plan_approved' | null;
  /** ISO when archived; null while active in history. */
  archived_at?: string | null;
  created_at: string;
  finished_at: string | null;
  members?: SwarmMember[];
  usage?: {
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
  } | null;
};

export const SWARM_PROVIDERS = [
  'claude',
  'codex',
  'cursor',
  'opencode',
  'grok',
  'kimi',
  'agy',
  'pi',
] as const;

export const SWARM_EFFORTS = ['default', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

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
  grok: ['default', 'acceptEdits', 'auto', 'bypassPermissions', 'plan'],
  kimi: ['default', 'plan', 'auto', 'bypassPermissions'],
  agy: ['plan', 'acceptEdits', 'bypassPermissions'],
  pi: ['plan', 'bypassPermissions'],
};

export const SWARM_PROVIDER_DEFAULT_PERMISSION: Record<string, string> = {
  claude: 'default',
  cursor: 'default',
  codex: 'default',
  opencode: 'default',
  grok: 'default',
  kimi: 'bypassPermissions',
  agy: 'bypassPermissions',
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

export const SWARM_KINDS: Array<{ value: SwarmAgentKind; label: string }> = [
  { value: 'orchestrator', label: 'Orchestrator' },
  { value: 'explorer', label: 'Explorer' },
  { value: 'implementer', label: 'Implementer' },
  { value: 'reviewer', label: 'Reviewer' },
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
      permissionMode: clampPermissionMode('claude', 'bypassPermissions'),
      focus: 'Plan, assign, and hand off the goal cost-efficiently.',
    },
    {
      id: 'explorer',
      kind: 'explorer',
      label: 'Explorer',
      provider: 'grok',
      effort: 'low',
      permissionMode: clampPermissionMode('grok', 'bypassPermissions'),
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
      permissionMode: clampPermissionMode('claude', 'bypassPermissions'),
      focus: 'Review work for correctness and risk.',
    },
  ];
}
