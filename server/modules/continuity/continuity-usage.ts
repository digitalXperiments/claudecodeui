import {
  getProviderUsage,
  type ProviderUsage,
  type ProviderUsageResponse,
  type UsageWindow,
} from '@/modules/provider-usage/index.js';
import type { LLMProvider } from '@/shared/types.js';

export type ContinuityUsageLoader = (options: {
  fresh: true;
  reason: 'manual';
  now: number;
}) => Promise<ProviderUsageResponse>;

let usageLoader: ContinuityUsageLoader = getProviderUsage;

export function configureContinuityUsageLoader(loader?: ContinuityUsageLoader): void {
  usageLoader = loader ?? getProviderUsage;
}

export function loadContinuityUsage(nowMs = Date.now()): Promise<ProviderUsageResponse> {
  return usageLoader({ fresh: true, reason: 'manual', now: nowMs });
}

export const CONTINUITY_RESET_JITTER_MS = 15_000;
export const CONTINUITY_USAGE_EVIDENCE_MAX_AGE_MS = 30_000;
/** How long to defer a due resume when quota is still exhausted and has no reset time. */
export const CONTINUITY_USAGE_POLL_DEFER_MS = 60_000;
const CONTINUITY_USAGE_CLOCK_SKEW_MS = 5_000;

export const LIVE_USAGE_PROVIDERS = ['claude', 'codex', 'grok', 'kimi', 'antigravity'] as const satisfies readonly LLMProvider[];

export function isLiveUsageProvider(provider: string): provider is typeof LIVE_USAGE_PROVIDERS[number] {
  return (LIVE_USAGE_PROVIDERS as readonly string[]).includes(provider);
}

export type ProviderQuotaEvidence =
  | { kind: 'available' }
  | { kind: 'exhausted'; resetsAt: string | null }
  | { kind: 'inconclusive' };

function windowAvailability(window: UsageWindow): 'available' | 'exhausted' | null {
  const remainingSignals = [window.remainingRatio, window.remaining]
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  if (
    typeof window.used === 'number'
    && Number.isFinite(window.used)
    && typeof window.limit === 'number'
    && Number.isFinite(window.limit)
    && window.limit > 0
  ) {
    remainingSignals.push(window.limit - window.used);
  }
  if (remainingSignals.length === 0) return null;
  return remainingSignals.some((remaining) => remaining <= 0) ? 'exhausted' : 'available';
}

/**
 * Treat every normalized quota window as a constraint: one exhausted window
 * blocks the provider, while an empty or unquantified snapshot proves nothing.
 */
export function classifyProviderQuota(
  provider: ProviderUsage | undefined,
  nowMs: number,
): ProviderQuotaEvidence {
  if (provider?.status !== 'ok' || !provider.signedIn || !provider.fetchedAt) {
    return { kind: 'inconclusive' };
  }
  const fetchedAtMs = Date.parse(provider.fetchedAt);
  if (
    !Number.isFinite(fetchedAtMs)
    || fetchedAtMs > nowMs + CONTINUITY_USAGE_CLOCK_SKEW_MS
    || nowMs - fetchedAtMs > CONTINUITY_USAGE_EVIDENCE_MAX_AGE_MS
  ) {
    return { kind: 'inconclusive' };
  }

  const usable = provider.windows
    .map((window) => ({ window, availability: windowAvailability(window) }))
    .filter((entry): entry is { window: UsageWindow; availability: 'available' | 'exhausted' } => (
      entry.availability !== null
    ));
  if (usable.length === 0) return { kind: 'inconclusive' };

  const exhausted = usable.filter((entry) => entry.availability === 'exhausted');
  if (exhausted.length === 0) return { kind: 'available' };

  // All exhausted windows are blockers, so the latest known reset is the safe wake-up time.
  const resetTimes = exhausted
    .map(({ window }) => window.resetsAt ? Date.parse(window.resetsAt) : Number.NaN)
    .filter((timestamp) => Number.isFinite(timestamp) && timestamp > nowMs);
  const resetAtMs = resetTimes.length > 0 ? Math.max(...resetTimes) : null;
  return {
    kind: 'exhausted',
    resetsAt: resetAtMs === null ? null : new Date(resetAtMs).toISOString(),
  };
}
