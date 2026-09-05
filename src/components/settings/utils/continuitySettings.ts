import type { LLMProvider } from '../../../types/app';
import type {
  BoomerangMode,
  ContinuityMode,
  ContinuityPolicySettings,
  ContinuityProviderHealth,
  PreflightGuardMode,
} from '../../chat/types/continuity';

export const CONTINUITY_NUMBER_LIMITS = {
  maxAttempts: { min: 1, max: 10 },
  maxWaitSeconds: { min: 0, max: 604800 },
  unknownResetDelaySeconds: { min: 30, max: 86400 },
} as const;

export const PREFLIGHT_THRESHOLD_LIMITS = { min: 0.01, max: 0.5 } as const;

export type ContinuityNumericSetting = keyof typeof CONTINUITY_NUMBER_LIMITS;

export function clampContinuityInteger(
  value: number,
  fallback: number,
  min: number,
  max: number,
): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

export function clampContinuityFloat(
  value: number,
  fallback: number,
  min: number,
  max: number,
): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Number(value.toFixed(2))));
}

export function normalizeContinuitySettings(
  defaults: ContinuityPolicySettings,
): ContinuityPolicySettings {
  const boomerangModes: BoomerangMode[] = ['off', 'prompt', 'auto'];
  const preflightModes: PreflightGuardMode[] = ['off', 'warn', 'block'];

  return {
    ...defaults,
    maxAttempts: clampContinuityInteger(
      defaults.maxAttempts,
      3,
      CONTINUITY_NUMBER_LIMITS.maxAttempts.min,
      CONTINUITY_NUMBER_LIMITS.maxAttempts.max,
    ),
    maxWaitSeconds: clampContinuityInteger(
      defaults.maxWaitSeconds,
      21600,
      CONTINUITY_NUMBER_LIMITS.maxWaitSeconds.min,
      CONTINUITY_NUMBER_LIMITS.maxWaitSeconds.max,
    ),
    unknownResetDelaySeconds: clampContinuityInteger(
      defaults.unknownResetDelaySeconds,
      900,
      CONTINUITY_NUMBER_LIMITS.unknownResetDelaySeconds.min,
      CONTINUITY_NUMBER_LIMITS.unknownResetDelaySeconds.max,
    ),
    inPlaceHandoff: Boolean(defaults.inPlaceHandoff),
    boomerangMode: boomerangModes.includes(defaults.boomerangMode as BoomerangMode)
      ? defaults.boomerangMode
      : 'off',
    preflightQuotaGuard: preflightModes.includes(defaults.preflightQuotaGuard as PreflightGuardMode)
      ? defaults.preflightQuotaGuard
      : 'warn',
    preflightThresholdRatio: clampContinuityFloat(
      defaults.preflightThresholdRatio ?? 0.05,
      0.05,
      PREFLIGHT_THRESHOLD_LIMITS.min,
      PREFLIGHT_THRESHOLD_LIMITS.max,
    ),
    tierMappingEnabled: defaults.tierMappingEnabled ?? true,
    checkpointToolsEnabled: defaults.checkpointToolsEnabled ?? true,
    subagentContinuityEnabled: defaults.subagentContinuityEnabled ?? true,
  };
}

export function toggleFallbackProvider(
  providers: LLMProvider[],
  provider: LLMProvider,
): LLMProvider[] {
  return providers.includes(provider)
    ? providers.filter((candidate) => candidate !== provider)
    : [...providers, provider];
}

export function moveFallbackProvider(
  providers: LLMProvider[],
  index: number,
  direction: -1 | 1,
): LLMProvider[] {
  const nextIndex = index + direction;
  if (index < 0 || index >= providers.length || nextIndex < 0 || nextIndex >= providers.length) {
    return providers;
  }
  const next = [...providers];
  [next[index], next[nextIndex]] = [next[nextIndex], next[index]];
  return next;
}

export function modeUsesFallback(mode: ContinuityMode): boolean {
  return mode === 'smart' || mode === 'switch' || mode === 'ask';
}

export type ContinuityHealthSummary = {
  authenticated: number;
  healthy: number;
  recoveries24h: number;
};

/**
 * Roll up the provider list from `GET /api/continuity/health`.
 *
 * The endpoint returns the raw provider ARRAY and no server-computed summary —
 * the Settings tab previously read a `summary.healthyCount` the API never sent,
 * which threw on every render and white-screened the app. Returning `null` for
 * anything that is not an array keeps a shape change from doing that again.
 */
export function summarizeContinuityHealth(
  providers: ContinuityProviderHealth[] | null | undefined,
): ContinuityHealthSummary | null {
  if (!Array.isArray(providers)) return null;
  return {
    authenticated: providers.filter((entry) => entry?.authenticated).length,
    healthy: providers.filter((entry) => entry?.authenticated && entry?.quota?.status !== 'exhausted').length,
    recoveries24h: providers.reduce((total, entry) => total + (entry?.recoveries24h || 0), 0),
  };
}
