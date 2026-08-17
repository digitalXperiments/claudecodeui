import {
  ClaudeProviderAuth,
  providerAuthService,
  providerRegistry,
  type DetectedProviderAuthStatus,
} from '@/modules/providers/index.js';
import type { ProviderAuthStatus } from '@/shared/types.js';

import {
  createClaudeUsageAdapter,
  createCodexUsageAdapter,
  createKimiUsageAdapter,
  grokUsageAdapter,
  providerDisplayName,
  unavailableUsageAdapter,
  type ProviderUsageAdapter,
  type ProviderUsageAdapterResult,
} from './provider-usage.adapters.js';
import type {
  ProviderUsage,
  ProviderUsageRefreshReason,
  ProviderUsageResponse,
} from './provider-usage.types.js';

export const PROVIDER_USAGE_CACHE_TTL_MS = 5 * 60 * 1000;
export const PROVIDER_USAGE_MIN_REFRESH_INTERVAL_MS = 15 * 1000;

type ProviderUsageCache = {
  response: ProviderUsageResponse;
  attemptedAtMs: number;
  successfulAtMs: number | null;
};

const adapters: Record<string, ProviderUsageAdapter> = {
  claude: createClaudeUsageAdapter(),
  codex: createCodexUsageAdapter(),
  grok: grokUsageAdapter,
  kimi: createKimiUsageAdapter(),
};

/** Exported for adapter tests and future provider modules. */
export const providerUsageAdapters = adapters;

let cache: ProviderUsageCache | null = null;
let inFlight: Promise<ProviderUsageResponse> | null = null;

const asIso = (timestampMs: number): string => new Date(timestampMs).toISOString();

const staleProvider = (provider: ProviderUsage, error: string): ProviderUsage => ({
  ...provider,
  status: 'stale',
  error,
});

const adapterError = (provider: ProviderUsage, error: unknown): ProviderUsage => (
  staleProvider(
    provider,
    error instanceof Error ? error.message : String(error),
  )
);

const createProviderRow = ({
  providerId,
  fetchedAt,
  result,
}: {
  providerId: string;
  fetchedAt: string;
  result: ProviderUsageAdapterResult;
}): ProviderUsage => ({
  providerId,
  displayName: providerDisplayName(providerId),
  signedIn: true,
  planName: result.planName,
  primaryWindowId: result.primaryWindowId,
  windows: result.windows,
  status: result.status,
  error: result.error,
  // Adapters may report an older fetch time for cached (stale) snapshots.
  fetchedAt: result.fetchedAt ?? fetchedAt,
});

const getPreviousProvider = (providerId: string): ProviderUsage | null => (
  cache?.response.providers.find((provider) => provider.providerId === providerId) ?? null
);

/**
 * I/O, parse, timeout, and spawn failures are not a confirmed logout.
 * Claude also sets `detection: 'inconclusive'` on those paths.
 * Codex/Grok pass through raw JSON.parse messages (e.g. "Expected property
 * name or '}' in JSON"). A bare JSON match is safe only after the
 * confirmed-logout check: vendor logout copy never mentions JSON.
 */
const CONFIRMED_UNAUTHENTICATED_ERROR = /not logged in|not configured|no valid tokens(?: found)?|no credentials/i;
const INCONCLUSIVE_AUTH_ERROR = /unable to read|unreadable|timed out|timeout|failed to (read|spawn)|EACCES|EPERM|EIO|EAGAIN|ETIMEDOUT|ENOSPC|ENOTDIR|keychain|invalid credential|not valid JSON|invalid JSON|JSON/i;

export const isInconclusiveProviderAuthStatus = (status: ProviderAuthStatus): boolean => {
  const detected = status as DetectedProviderAuthStatus;
  if (detected.detection === 'inconclusive') {
    return true;
  }
  if (detected.detection === 'authenticated' || detected.detection === 'unauthenticated') {
    return false;
  }
  const error = status.error ?? '';
  if (CONFIRMED_UNAUTHENTICATED_ERROR.test(error)) {
    return false;
  }
  return INCONCLUSIVE_AUTH_ERROR.test(error);
};

const createTransientErrorRow = (providerId: string, error: unknown): ProviderUsage => ({
  providerId,
  displayName: providerDisplayName(providerId),
  signedIn: true,
  planName: null,
  primaryWindowId: null,
  windows: [],
  status: 'error',
  error: error instanceof Error ? error.message : String(error),
  fetchedAt: null,
});

const keepPreviousAsStale = (
  providerId: string,
  error: unknown,
  providers: ProviderUsage[],
): void => {
  const previous = getPreviousProvider(providerId);
  if (previous) {
    providers.push(adapterError(previous, error));
    return;
  }
  // Cold cache: keep a signed-in error row so the rail/refresh stay visible.
  providers.push(createTransientErrorRow(providerId, error));
};

async function readProviderAuth(
  providerId: string,
  options: { bypassAuthCache: boolean },
): Promise<ProviderAuthStatus> {
  if (providerId === 'claude') {
    return (await new ClaudeProviderAuth().detectAuth({
      bypassCache: options.bypassAuthCache,
    })).status;
  }
  return providerAuthService.getProviderAuthStatus(providerId);
}

async function fetchProviderUsageSnapshot(
  nowMs: number,
  options: { bypassAuthCache: boolean },
): Promise<{
  response: ProviderUsageResponse;
  successfulAtMs: number | null;
}> {
  const attemptedAt = asIso(nowMs);
  const previousFetchedAt = cache?.response.fetchedAt ?? null;
  const providers: ProviderUsage[] = [];
  let hadAdapterError = false;

  for (const provider of providerRegistry.listProviders()) {
    const providerId = provider.id;
    let authStatus: ProviderAuthStatus;

    try {
      authStatus = await readProviderAuth(providerId, options);
    } catch (error) {
      // Thrown auth lookups are inconclusive: keep last-known quota.
      hadAdapterError = true;
      keepPreviousAsStale(providerId, error, providers);
      continue;
    }

    if (isInconclusiveProviderAuthStatus(authStatus)) {
      hadAdapterError = true;
      keepPreviousAsStale(
        providerId,
        authStatus.error ?? 'Auth status could not be confirmed',
        providers,
      );
      continue;
    }

    // Membership is derived from the same provider auth implementations used
    // by Settings and auth-health. Only a definitive logout omits the row.
    if (!authStatus.authenticated) {
      continue;
    }

    const adapter = adapters[providerId] ?? unavailableUsageAdapter(providerId);
    try {
      const result = await adapter({ authStatus });
      providers.push(createProviderRow({ providerId, fetchedAt: attemptedAt, result }));
    } catch (error) {
      hadAdapterError = true;
      const previous = getPreviousProvider(providerId);
      if (previous) {
        providers.push(adapterError(previous, error));
      } else {
        providers.push(createTransientErrorRow(providerId, error));
      }
    }
  }

  const hasFreshOkProvider = providers.some((provider) => provider.status === 'ok');
  const successfulAtMs = hasFreshOkProvider || !hadAdapterError
    ? nowMs
    : cache?.successfulAtMs ?? null;
  return {
    response: {
      fetchedAt: successfulAtMs === null ? previousFetchedAt : asIso(successfulAtMs),
      attemptedAt,
      providers,
      cached: false,
    },
    successfulAtMs,
  };
}

export type GetProviderUsageOptions = {
  fresh?: boolean;
  now?: number;
  /**
   * `poll` respects the 5-minute TTL.
   * `manual` bypasses TTL but not the 15-second anti-stampede.
   * `auth-change` bypasses both so login/logout cannot return stale membership.
   */
  reason?: ProviderUsageRefreshReason;
};

const withCacheMetadata = (
  response: ProviderUsageResponse,
  metadata: Pick<ProviderUsageResponse, 'cached' | 'refreshSuppressed'>,
): ProviderUsageResponse => ({
  ...response,
  ...metadata,
});

const resolveReason = (options: GetProviderUsageOptions): ProviderUsageRefreshReason => {
  if (options.reason) {
    return options.reason;
  }
  return options.fresh === true ? 'manual' : 'poll';
};

/**
 * Reads the shared five-minute provider-usage snapshot.
 * The 15-second suppress-after-success window is a manual-refresh
 * anti-stampede only. Auth-change refreshes always re-read membership.
 */
export async function getProviderUsage(
  options: GetProviderUsageOptions = {},
): Promise<ProviderUsageResponse> {
  const nowMs = options.now ?? Date.now();
  const reason = resolveReason(options);

  if (cache) {
    const cacheAge = nowMs - cache.attemptedAtMs;
    // Cold/transient snapshots never set successfulAtMs. Do not occupy the
    // 5-minute poll TTL or the legend stays empty until expiry.
    if (
      reason === 'poll'
      && cache.successfulAtMs !== null
      && cacheAge < PROVIDER_USAGE_CACHE_TTL_MS
    ) {
      return withCacheMetadata(cache.response, { cached: true });
    }

    const successfulAge = cache.successfulAtMs === null
      ? Number.POSITIVE_INFINITY
      : nowMs - cache.successfulAtMs;
    if (reason === 'manual' && successfulAge < PROVIDER_USAGE_MIN_REFRESH_INTERVAL_MS) {
      return withCacheMetadata(cache.response, { cached: true, refreshSuppressed: true });
    }
  }

  if (inFlight) {
    if (reason !== 'auth-change') {
      return withCacheMetadata(await inFlight, { cached: true });
    }
    await inFlight;
  }

  if (reason === 'auth-change') {
    // Drop Claude's 30s authenticated memo so login/logout membership is fresh.
    ClaudeProviderAuth.invalidateStatusCache();
  }

  inFlight = fetchProviderUsageSnapshot(nowMs, {
    // Polls are already gated by the five-minute usage cache. Manual and
    // auth-change must not reuse Claude's 30-second authenticated memo.
    bypassAuthCache: reason !== 'poll',
  })
    .then(({ response, successfulAtMs }) => {
      const isEmptyTransientSnapshot = successfulAtMs === null && response.providers.length === 0;
      if (!isEmptyTransientSnapshot) {
        cache = {
          response,
          attemptedAtMs: nowMs,
          successfulAtMs,
        };
      }
      return response;
    })
    .finally(() => {
      inFlight = null;
    });

  return inFlight;
}

export function resetProviderUsageCache(): void {
  cache = null;
  inFlight = null;
}
