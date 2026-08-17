export type UsageWindowUnit = 'tokens' | 'requests' | 'credits' | 'percent' | 'unknown';

export type UsageWindow = {
  id: string;
  label: string;
  used: number | null;
  limit: number | null;
  remaining: number | null;
  remainingRatio: number | null;
  resetsAt: string | null;
  unit: UsageWindowUnit;
};

export type ProviderUsageStatus = 'ok' | 'unavailable' | 'error' | 'stale';

export type ProviderUsage = {
  providerId: string;
  displayName: string;
  signedIn: boolean;
  planName: string | null;
  primaryWindowId: string | null;
  windows: UsageWindow[];
  status: ProviderUsageStatus;
  error: string | null;
  fetchedAt: string | null;
};

/**
 * The browser receives only this aggregate. Provider credentials and raw
 * vendor payloads stay inside the server-side adapters.
 */
export type ProviderUsageResponse = {
  fetchedAt: string | null;
  attemptedAt: string;
  providers: ProviderUsage[];
  cached: boolean;
  refreshSuppressed?: boolean;
};

export type ProviderUsageRefreshReason = 'poll' | 'manual' | 'auth-change';
