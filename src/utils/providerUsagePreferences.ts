export const PROVIDER_USAGE_LEGEND_COLLAPSED_KEY = 'provider-usage-legend-collapsed';
export const PROVIDER_USAGE_DISABLED_PROVIDERS_KEY = 'provider-usage-disabled-providers';
export const PROVIDER_USAGE_AUTH_CHANGED_EVENT = 'cloudcli:provider-auth-changed';
export const PROVIDER_USAGE_COLLAPSE_CHANGED_EVENT = 'cloudcli:provider-usage-collapse-changed';
export const PROVIDER_USAGE_VISIBILITY_CHANGED_EVENT = 'cloudcli:provider-usage-visibility-changed';

export const PROVIDER_USAGE_PROVIDERS = [
  { id: 'claude', label: 'Claude' },
  { id: 'codex', label: 'Codex' },
  { id: 'cursor', label: 'Cursor' },
  { id: 'opencode', label: 'OpenCode' },
  { id: 'kilo', label: 'Kilo Code' },
  { id: 'cline', label: 'Cline' },
  { id: 'grok', label: 'Grok' },
  { id: 'kimi', label: 'Kimi' },
  { id: 'qwencode', label: 'Qwen Code' },
  { id: 'pi', label: 'Pi' },
] as const;

export type ProviderUsageProviderId = typeof PROVIDER_USAGE_PROVIDERS[number]['id'];
export type ProviderUsageVisibility = Record<ProviderUsageProviderId, boolean>;

const readStorageBoolean = (key: string, fallback: boolean): boolean => {
  try {
    const value = localStorage.getItem(key);
    return value === null ? fallback : value === 'true';
  } catch {
    return fallback;
  }
};

export const readProviderUsageLegendCollapsed = (): boolean => (
  readStorageBoolean(PROVIDER_USAGE_LEGEND_COLLAPSED_KEY, false)
);

export const writeProviderUsageLegendCollapsed = (collapsed: boolean): void => {
  try {
    localStorage.setItem(PROVIDER_USAGE_LEGEND_COLLAPSED_KEY, String(collapsed));
    window.dispatchEvent(new Event(PROVIDER_USAGE_COLLAPSE_CHANGED_EVENT));
  } catch {
    // Storage is optional; the current tab still remembers the state.
  }
};

export const readDisabledProviderUsageIds = (): string[] => {
  try {
    const stored = localStorage.getItem(PROVIDER_USAGE_DISABLED_PROVIDERS_KEY);
    if (!stored) return [];
    const parsed: unknown = JSON.parse(stored);
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === 'string')
      : [];
  } catch {
    return [];
  }
};

export const readProviderUsageVisibility = (): ProviderUsageVisibility => {
  const disabled = new Set(readDisabledProviderUsageIds());
  return Object.fromEntries(
    PROVIDER_USAGE_PROVIDERS.map(({ id }) => [id, !disabled.has(id)]),
  ) as ProviderUsageVisibility;
};

export const isProviderUsageVisible = (providerId: string): boolean => (
  !readDisabledProviderUsageIds().includes(providerId)
);

export const writeProviderUsageVisible = (providerId: string, visible: boolean): void => {
  try {
    const disabled = new Set(readDisabledProviderUsageIds());
    if (visible) disabled.delete(providerId);
    else disabled.add(providerId);
    localStorage.setItem(PROVIDER_USAGE_DISABLED_PROVIDERS_KEY, JSON.stringify([...disabled]));
    window.dispatchEvent(new Event(PROVIDER_USAGE_VISIBILITY_CHANGED_EVENT));
  } catch {
    // Storage is optional; callers still update their current-tab state.
  }
};
