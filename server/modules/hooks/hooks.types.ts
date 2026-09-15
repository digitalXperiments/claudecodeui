export const HOOK_EVENTS = ['session_start'] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];

export const HOOK_PROVIDER_ALL = 'all';

export type CloudcliHook = {
  id: string;
  name: string;
  /** Slash command name without leading `/`. Unique in the catalog. */
  slug: string;
  enabled: boolean;
  event: HookEvent;
  instruction: string;
  /** `all` or a provider id such as `claude`. */
  provider: string;
  createdAt: string;
  updatedAt: string;
};

export type CloudcliHookCreateInput = {
  name: string;
  instruction: string;
  enabled?: boolean;
  event?: HookEvent;
  provider?: string;
  slug?: string;
};

export type CloudcliHookUpdateInput = Partial<CloudcliHookCreateInput>;

export const isHookEvent = (value: unknown): value is HookEvent =>
  typeof value === 'string' && (HOOK_EVENTS as readonly string[]).includes(value);
