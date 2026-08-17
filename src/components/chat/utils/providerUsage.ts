import type { ProviderUsage, UsageWindow } from '../types/providerUsage';

export const PROVIDER_USAGE_POLL_INTERVAL_MS = 5 * 60 * 1000;
export const PROVIDER_USAGE_MANUAL_REFRESH_GUARD_MS = 15 * 1000;

/** Expanded rail width (192px) — inside the PRD 160–200px band. */
export const PROVIDER_USAGE_RAIL_EXPANDED_CLASS = 'w-48';
/** Closed rail releases all transcript width; its edge handle remains visible. */
export const PROVIDER_USAGE_RAIL_COLLAPSED_CLASS = 'w-0';

export const getPrimaryUsageWindow = (provider: ProviderUsage): UsageWindow | null => (
  provider.windows.find((window) => window.id === provider.primaryWindowId)
  ?? provider.windows[0]
  ?? null
);

export const getRemainingRatio = (window: UsageWindow | null): number | null => {
  if (!window) {
    return null;
  }
  if (typeof window.remainingRatio === 'number' && Number.isFinite(window.remainingRatio)) {
    return Math.min(1, Math.max(0, window.remainingRatio));
  }
  if (
    typeof window.remaining === 'number'
    && Number.isFinite(window.remaining)
    && typeof window.limit === 'number'
    && Number.isFinite(window.limit)
    && window.limit > 0
  ) {
    return Math.min(1, Math.max(0, window.remaining / window.limit));
  }
  return null;
};

export const formatRelativeUpdated = (timestamp: string | null, now = Date.now()): string => {
  if (!timestamp) {
    return 'Not updated';
  }
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed)) {
    return 'Not updated';
  }

  const elapsedSeconds = Math.max(0, Math.floor((now - parsed) / 1000));
  if (elapsedSeconds < 10) return 'just now';
  if (elapsedSeconds < 60) return `${elapsedSeconds}s ago`;
  const elapsedMinutes = Math.floor(elapsedSeconds / 60);
  if (elapsedMinutes < 60) return `${elapsedMinutes}m ago`;
  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) return `${elapsedHours}h ago`;
  return `${Math.floor(elapsedHours / 24)}d ago`;
};

export const formatCountdown = (timestamp: string | null, now = Date.now()): string | null => {
  if (!timestamp) {
    return null;
  }
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed)) {
    return null;
  }

  const remainingSeconds = Math.max(0, Math.ceil((parsed - now) / 1000));
  if (remainingSeconds === 0) {
    return 'resets now';
  }

  const days = Math.floor(remainingSeconds / 86_400);
  const hours = Math.floor((remainingSeconds % 86_400) / 3_600);
  const minutes = Math.floor((remainingSeconds % 3_600) / 60);
  if (days > 0) return `resets in ${days}d ${hours}h`;
  if (hours > 0) return `resets in ${hours}h ${minutes}m`;
  return `resets in ${Math.max(1, minutes)}m`;
};

export type UsageTone = 'healthy' | 'warning' | 'critical' | 'neutral';

export const getUsageTone = (provider: ProviderUsage, window: UsageWindow | null): UsageTone => {
  if (provider.status !== 'ok' && provider.status !== 'stale') {
    return 'neutral';
  }
  const ratio = getRemainingRatio(window);
  if (ratio === null) {
    return 'neutral';
  }
  if (ratio < 0.1 || ratio === 0) return 'critical';
  if (ratio < 0.25) return 'warning';
  return 'healthy';
};

export const formatUsageNumber = (value: number | null): string => {
  if (value === null || !Number.isFinite(value)) return '—';
  if (Number.isInteger(value)) return value.toLocaleString();
  return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
};
