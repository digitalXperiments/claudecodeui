import type { LLMProvider } from '@/shared/types.js';

export const MC_PROVIDERS = [
  'claude',
  'codex',
  'cursor',
  'opencode',
  'grok',
  'kimi',
  'agy',
] as const satisfies readonly LLMProvider[];

export type McProvider = (typeof MC_PROVIDERS)[number];

export function isMcProvider(value: unknown): value is McProvider {
  return typeof value === 'string' && (MC_PROVIDERS as readonly string[]).includes(value);
}

export type McSectionMode = 'review' | 'fire_and_forget';
export type McSectionScope = 'global' | 'project';

export type McItemStatus =
  | 'pending'
  | 'resolving'
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

export const DEFAULT_MC_ACTIONS: McAction[] = [
  { id: 'approve', label: 'Approve', kind: 'approve', style: 'primary', terminal: true },
  { id: 'deny', label: 'Deny', kind: 'dismiss', style: 'destructive', terminal: true },
];

export type McSection = {
  section_id: string;
  title: string;
  icon: string;
  sort_order: number;
  enabled: boolean;
  scope: McSectionScope;
  project_id: string | null;
  mode: McSectionMode;
  schedule_cron: string | null;
  provider: McProvider;
  model: string | null;
  permission_mode: string;
  dry_run: boolean;
  auto_approve: boolean;
  produce_prompt: string;
  produce_tools: string[];
  resolve_prompt: string;
  resolve_tools: string[];
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
  mode?: McSectionMode;
  schedule_cron?: string | null;
  provider?: McProvider;
  model?: string | null;
  permission_mode?: string;
  dry_run?: boolean;
  auto_approve?: boolean;
  produce_prompt?: string;
  produce_tools?: string[];
  resolve_prompt?: string;
  resolve_tools?: string[];
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
