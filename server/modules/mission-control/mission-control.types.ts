import type { LLMProvider } from '@/shared/types.js';

export const MC_PROVIDERS = [
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

] as const satisfies readonly LLMProvider[];

export type McProvider = (typeof MC_PROVIDERS)[number];

export function isMcProvider(value: unknown): value is McProvider {
  return typeof value === 'string' && (MC_PROVIDERS as readonly string[]).includes(value);
}

/**
 * Legacy column. Bots now run one pipeline (propose → resolve → work); every
 * section is normalized to 'review' and `fire_and_forget` is only read by the
 * one-time migration.
 */
export type McSectionMode = 'review';
export type McSectionScope = 'global' | 'project';
export type McToolPolicyDecision = 'allow' | 'ask' | 'deny';
export type McToolPolicy = Record<string, Record<string, McToolPolicyDecision>>;

/**
 * Pipeline position of an item:
 * pending (awaiting a resolve/approval decision) → resolving → awaiting_work
 * (ready for a manual Start work) → working (session queued/running) → in_qa
 * (session finished, awaiting human QA) → resolved. `failed` keeps
 * `work_ready_at` when the failure happened in the work stage.
 */
export type McItemStatus =
  | 'pending'
  | 'resolving'
  | 'awaiting_work'
  | 'working'
  | 'in_qa'
  | 'resolved'
  | 'dismissed'
  | 'failed'
  | 'expired';

export type McActionStyle = 'primary' | 'secondary' | 'destructive';

export type McAction = {
  id: string;
  label: string;
  kind: string;
  style: McActionStyle;
  /** When false, successful resolve returns the item to pending with patched body. */
  terminal?: boolean;
};

/** Always offered on items so a re-run can free the dedupe key. */
export const MC_DELETE_ACTION: McAction = {
  id: 'delete',
  label: 'Delete',
  kind: 'delete',
  style: 'destructive',
  terminal: true,
};

export const MC_WORK_ACTION: McAction = {
  id: 'work',
  label: 'Open work chat',
  kind: 'work',
  style: 'secondary',
  terminal: false,
};

export const DEFAULT_MC_ACTIONS: McAction[] = [
  { id: 'approve', label: 'Approve', kind: 'approve', style: 'primary', terminal: true },
  MC_WORK_ACTION,
  { id: 'deny', label: 'Deny', kind: 'dismiss', style: 'secondary', terminal: true },
  MC_DELETE_ACTION,
];

/** Ensure the system Delete action is present (older items / custom action lists). */
export function withSystemItemActions(actions: McAction[]): McAction[] {
  const withDelete = actions.some((a) => a.id === 'delete' || a.kind === 'delete')
    ? actions
    : [...actions, MC_DELETE_ACTION];
  if (withDelete.some((a) => a.id === 'work' || a.kind === 'work')) {
    return withDelete;
  }
  const deleteIndex = withDelete.findIndex((a) => a.id === 'delete' || a.kind === 'delete');
  if (deleteIndex === -1) {
    return [...withDelete, MC_WORK_ACTION];
  }
  return [
    ...withDelete.slice(0, deleteIndex),
    MC_WORK_ACTION,
    ...withDelete.slice(deleteIndex),
  ];
}

export type McWorkProfile = {
  auto_start: boolean;
  provider: McProvider;
  model: string;
  /** Model effort level; null uses the model's default. */
  effort: string | null;
  mcp_servers: string[];
  /** The work prompt: instructions for every work session. */
  context: string;
  /** Project used when no client route matches. */
  default_project_id: string | null;
  routes: Array<{ client: string; aliases: string[]; project_id: string; context: string }>;
};

export type McSection = {
  section_id: string;
  title: string;
  icon: string;
  sort_order: number;
  enabled: boolean;
  scope: McSectionScope;
  project_id: string | null;
  /** Project used when an operator opens Work this for an item. */
  work_project_id?: string | null;
  work_profile?: McWorkProfile | null;
  mode: McSectionMode;
  schedule_cron: string | null;
  /** Propose (and retry) agent. */
  provider: McProvider;
  model: string | null;
  /** Propose effort; null uses the model default. */
  effort: string | null;
  /** Resolve agent; null means "same as Propose" (provider/model/effort). */
  resolve_provider: McProvider | null;
  resolve_model: string | null;
  resolve_effort: string | null;
  permission_mode: string;
  dry_run: boolean;
  auto_approve: boolean;
  produce_prompt: string;
  produce_tools: string[];
  resolve_prompt: string;
  resolve_tools: string[];
  tool_policy: McToolPolicy;
  actions: McAction[];
  last_run_at: string | null;
  last_run_error: string | null;
  created_at: string;
  updated_at: string;
};

export type McItem = {
  item_id: string;
  section_id: string;
  status: McItemStatus;
  title: string;
  summary: string;
  body: Record<string, unknown>;
  source: Record<string, unknown>;
  actions: McAction[];
  confidence: number;
  provider: string;
  model: string;
  dedupe_key: string;
  result: Record<string, unknown> | null;
  error: string | null;
  /** Set when the item passed the resolve gate and became eligible for work. */
  work_ready_at: string | null;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
};

export type CreateMcSectionInput = {
  title: string;
  icon?: string;
  sort_order?: number;
  enabled?: boolean;
  scope?: McSectionScope;
  project_id?: string | null;
  work_project_id?: string | null;
  work_profile?: McWorkProfile | null;
  mode?: McSectionMode;
  schedule_cron?: string | null;
  provider?: McProvider;
  model?: string | null;
  effort?: string | null;
  resolve_provider?: McProvider | null;
  resolve_model?: string | null;
  resolve_effort?: string | null;
  permission_mode?: string;
  dry_run?: boolean;
  auto_approve?: boolean;
  produce_prompt?: string;
  produce_tools?: string[];
  resolve_prompt?: string;
  resolve_tools?: string[];
  tool_policy?: McToolPolicy;
  actions?: McAction[];
};

export type UpdateMcSectionInput = Partial<CreateMcSectionInput>;

export type McDraftItem = {
  title: string;
  summary: string;
  body: Record<string, unknown>;
  dedupeKey: string;
  confidence?: number;
  source?: Record<string, unknown>;
  actions?: McAction[];
};
