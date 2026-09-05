import type { LLMProvider } from '../../../types/app';
import type { ContinuityMode, ContinuityPolicy, ContinuityRecovery } from '../types/continuity';

const LIVE_USAGE_PROVIDERS = new Set<LLMProvider>(['claude', 'codex', 'grok', 'kimi', 'antigravity']);

export function formatContinuityCountdown(retryAt: string | null, now = Date.now()): string | null {
  if (!retryAt) return null;
  const remaining = Date.parse(retryAt) - now;
  if (!Number.isFinite(remaining)) return null;
  if (remaining <= 0) return 'due now';
  const totalMinutes = Math.ceil(remaining / 60_000);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
}

/** Waiting copy: poll-based waits should not look like a long hardcoded timer. */
export function formatContinuityWaitingLabel(
  recovery: Pick<ContinuityRecovery, 'action' | 'retryAt' | 'resetTimeSource' | 'sourceProvider'> | null,
  now = Date.now(),
): string | null {
  if (!recovery) return null;
  if (
    recovery.action === 'resume'
    && recovery.resetTimeSource === 'fallback'
    && LIVE_USAGE_PROVIDERS.has(recovery.sourceProvider)
  ) {
    return 'checking usage';
  }
  return formatContinuityCountdown(recovery.retryAt, now);
}

export function buildContinuityModePatch(
  mode: ContinuityMode,
  configuredProviders: LLMProvider[],
  currentProvider: LLMProvider,
  suggestedFallback: LLMProvider | null,
): Partial<ContinuityPolicy> {
  const needsFallback = mode === 'switch' || mode === 'smart';
  const alreadyHasFallback = configuredProviders.some((provider) => provider !== currentProvider);
  if (!needsFallback || alreadyHasFallback || !suggestedFallback) return { mode };
  return { mode, fallbackProviders: [suggestedFallback] };
}
