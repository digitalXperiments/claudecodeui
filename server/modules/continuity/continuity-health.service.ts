import {
  providerDisplayName,
  type ProviderUsage,
  type ProviderUsageResponse,
} from '@/modules/provider-usage/index.js';
import { providerAuthService } from '@/modules/providers/index.js';
import type { LLMProvider } from '@/shared/types.js';

import { continuityRepository } from './continuity.repository.js';
import {
  classifyProviderQuota,
  CONTINUITY_RESET_JITTER_MS,
  isLiveUsageProvider,
  loadContinuityUsage,
} from './continuity-usage.js';
import {
  CONTINUITY_PROVIDERS,
  continuityService,
  normalizePolicy,
} from './continuity.service.js';
import type {
  ContinuityPolicyInput,
  ContinuityPolicySettings,
  ContinuityPolicySource,
  ContinuityRecoveryAction,
} from './continuity.types.js';

const RECOVERY_WINDOW_MS = 24 * 60 * 60 * 1000;

export type ContinuityQuotaStatus = 'available' | 'exhausted' | 'inconclusive';

export type ContinuityProviderQuota = {
  status: ContinuityQuotaStatus;
  remainingRatio: number | null;
  resetsAt: string | null;
  planName: string | null;
};

export type ContinuityProviderHealth = {
  provider: LLMProvider;
  displayName: string;
  authenticated: boolean;
  authError: string | null;
  installed: boolean;
  liveUsageSupported: boolean;
  quota: ContinuityProviderQuota;
  recoveries24h: number;
};

export type ContinuityHealthMatrix = {
  generatedAt: string;
  usageFetchedAt: string | null;
  usageError: string | null;
  providers: ContinuityProviderHealth[];
};

/** Simulated recoveries never touch the database, so `none` marks a no-op policy. */
export type ContinuitySimulationAction = ContinuityRecoveryAction | 'none';
export type ContinuitySimulationStatus = 'waiting' | 'needs_attention' | 'skipped';

export type ContinuitySimulationInput = {
  sessionId: string;
  policy?: ContinuityPolicyInput;
  sourceProvider: LLMProvider;
  detectedReason?: string;
  retryAt?: string | null;
  attempt?: number;
};

export type ContinuitySimulationTraceStep = {
  step: string;
  detail: string;
};

export type ContinuitySimulation = {
  action: ContinuitySimulationAction;
  status: ContinuitySimulationStatus;
  retryAt: string | null;
  fallbackProvider: LLMProvider | null;
  /** Seconds between now and `retryAt`; zero when the decision fires immediately. */
  waitSeconds: number;
  resetTimeSource: 'provider' | 'message' | 'fallback';
  attempt: number;
  detectedReason: string;
  policy: ContinuityPolicySettings;
  policySource: ContinuityPolicySource | 'override';
  trace: ContinuitySimulationTraceStep[];
};

function windowRatio(usage: ProviderUsage | undefined): number | null {
  const ratios: number[] = [];
  for (const window of usage?.windows ?? []) {
    if (typeof window.remainingRatio === 'number' && Number.isFinite(window.remainingRatio)) {
      ratios.push(window.remainingRatio);
      continue;
    }
    if (
      typeof window.used === 'number' && Number.isFinite(window.used)
      && typeof window.limit === 'number' && Number.isFinite(window.limit) && window.limit > 0
    ) {
      ratios.push((window.limit - window.used) / window.limit);
    }
  }
  if (ratios.length === 0) return null;
  // The tightest window is the one that will block a resume first.
  return Math.max(0, Math.min(1, Math.min(...ratios)));
}

function earliestFutureReset(usage: ProviderUsage | undefined, nowMs: number): string | null {
  const resets = (usage?.windows ?? [])
    .map((window) => (window.resetsAt ? Date.parse(window.resetsAt) : Number.NaN))
    .filter((timestamp) => Number.isFinite(timestamp) && timestamp > nowMs);
  return resets.length === 0 ? null : new Date(Math.min(...resets)).toISOString();
}

async function authSnapshot(provider: LLMProvider): Promise<{
  installed: boolean;
  authenticated: boolean;
  authError: string | null;
}> {
  try {
    const status = await providerAuthService.getProviderAuthStatus(provider);
    return {
      installed: status.installed,
      authenticated: status.authenticated,
      authError: status.error ?? null,
    };
  } catch (error) {
    return {
      installed: false,
      authenticated: false,
      authError: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Health matrix across every provider continuity can act on: whether the CLI is
 * installed and connected, what its quota evidence currently says, and how often
 * it has needed a recovery in the last day.
 */
export async function getContinuityHealth(nowMs = Date.now()): Promise<ContinuityHealthMatrix> {
  let usage: ProviderUsageResponse | null = null;
  let usageError: string | null = null;
  try {
    usage = await loadContinuityUsage(nowMs);
  } catch (error) {
    usageError = error instanceof Error ? error.message : String(error);
  }
  const usageByProvider = new Map(
    (usage?.providers ?? []).map((provider) => [provider.providerId, provider]),
  );
  const recoveryCounts = continuityRepository.countRecoveriesSince(
    new Date(nowMs - RECOVERY_WINDOW_MS).toISOString(),
  );

  const providers = await Promise.all(CONTINUITY_PROVIDERS.map(async (provider): Promise<ContinuityProviderHealth> => {
    const row = usageByProvider.get(provider);
    const evidence = classifyProviderQuota(row, nowMs);
    const auth = await authSnapshot(provider);
    return {
      provider,
      displayName: row?.displayName ?? providerDisplayName(provider),
      authenticated: auth.authenticated,
      authError: auth.authError,
      installed: auth.installed,
      liveUsageSupported: isLiveUsageProvider(provider),
      quota: {
        status: evidence.kind,
        remainingRatio: windowRatio(row),
        resetsAt: evidence.kind === 'exhausted'
          ? evidence.resetsAt ?? earliestFutureReset(row, nowMs)
          : earliestFutureReset(row, nowMs),
        planName: row?.planName ?? null,
      },
      recoveries24h: recoveryCounts[provider] ?? 0,
    };
  }));

  return {
    generatedAt: new Date(nowMs).toISOString(),
    usageFetchedAt: usage?.fetchedAt ?? null,
    usageError,
    providers,
  };
}

/**
 * Replays the recovery decision the scheduler would make for a hypothetical
 * limit signal. Reads live quota evidence but never writes a recovery row and
 * never dispatches a run, so it is safe to call from the UI on every keystroke.
 */
export async function simulateRecovery(
  input: ContinuitySimulationInput,
  nowMs = Date.now(),
): Promise<ContinuitySimulation> {
  const trace: ContinuitySimulationTraceStep[] = [];
  const state = continuityService.getState(input.sessionId);
  const override = input.policy && Object.keys(input.policy).length > 0;
  const policy = normalizePolicy(override ? input.policy! : {}, state.policy);
  const policySource: ContinuitySimulation['policySource'] = override ? 'override' : state.policySource;
  trace.push({
    step: 'policy',
    detail: override
      ? `Using the submitted policy override on top of the ${state.policySource} policy: mode=${policy.mode}.`
      : `Using the ${state.policySource} policy for ${input.sessionId}: mode=${policy.mode}.`,
  });

  const detectedReason = input.detectedReason?.trim() || 'Simulated provider usage limit';
  const attempt = Number.isFinite(input.attempt) ? Math.max(1, Math.trunc(input.attempt!)) : 1;
  const settled = (
    action: ContinuitySimulationAction,
    status: ContinuitySimulationStatus,
    retryAt: string | null,
    fallbackProvider: LLMProvider | null,
    resetTimeSource: ContinuitySimulation['resetTimeSource'],
  ): ContinuitySimulation => ({
    action,
    status,
    retryAt,
    fallbackProvider,
    waitSeconds: retryAt ? Math.max(0, (Date.parse(retryAt) - nowMs) / 1000) : 0,
    resetTimeSource,
    attempt,
    detectedReason,
    policy,
    policySource,
    trace,
  });

  if (policy.mode === 'off') {
    trace.push({ step: 'decision', detail: 'Continuity is off, so no recovery would be scheduled.' });
    return settled('none', 'skipped', null, null, 'fallback');
  }

  // Simulation has no run lineage to inspect, so the first configured fallback
  // that is not the blocked provider is the candidate.
  const fallbackProvider = policy.fallbackProviders.find((provider) => provider !== input.sourceProvider) ?? null;
  trace.push({
    step: 'fallback',
    detail: fallbackProvider
      ? `First unused fallback provider: ${fallbackProvider}.`
      : 'No unused fallback provider is configured.',
  });

  if (attempt > policy.maxAttempts) {
    trace.push({
      step: 'attempts',
      detail: `Attempt ${attempt} exceeds maxAttempts=${policy.maxAttempts}; the recovery would need attention.`,
    });
    return settled('resume', 'needs_attention', null, fallbackProvider, 'fallback');
  }
  trace.push({ step: 'attempts', detail: `Attempt ${attempt} of ${policy.maxAttempts}.` });

  // An unparseable reset time proves nothing, so it is treated like no signal at all.
  const signalRetryAt = typeof input.retryAt === 'string' && Number.isFinite(Date.parse(input.retryAt.trim()))
    ? input.retryAt.trim()
    : null;
  let resetTime = signalRetryAt;
  let resetTimeSource: ContinuitySimulation['resetTimeSource'] = signalRetryAt ? 'message' : 'fallback';
  let fallbackMs = policy.unknownResetDelaySeconds * 1000;
  if (signalRetryAt) {
    trace.push({ step: 'reset', detail: `The limit message carries a reset time of ${signalRetryAt}.` });
  } else {
    const evidence = await quotaEvidence(input.sourceProvider, nowMs);
    if (evidence.kind === 'available') {
      resetTime = new Date(nowMs).toISOString();
      resetTimeSource = 'provider';
      trace.push({ step: 'reset', detail: `Live usage reports ${input.sourceProvider} quota is available now.` });
    } else if (evidence.kind === 'exhausted' && evidence.resetsAt) {
      resetTime = evidence.resetsAt;
      resetTimeSource = 'provider';
      trace.push({ step: 'reset', detail: `Live usage reports ${input.sourceProvider} resets at ${evidence.resetsAt}.` });
    } else if (isLiveUsageProvider(input.sourceProvider)) {
      fallbackMs = policy.maxWaitSeconds * 1000;
      trace.push({
        step: 'reset',
        detail: `No reset time is known; the scheduler would poll ${input.sourceProvider} usage up to maxWaitSeconds=${policy.maxWaitSeconds}.`,
      });
    } else {
      trace.push({
        step: 'reset',
        detail: `No reset time is known; falling back to unknownResetDelaySeconds=${policy.unknownResetDelaySeconds}.`,
      });
    }
  }

  const resetMs = resetTime ? Date.parse(resetTime) + CONTINUITY_RESET_JITTER_MS : nowMs + fallbackMs;
  const waitSeconds = Math.max(0, (resetMs - nowMs) / 1000);
  trace.push({ step: 'wait', detail: `Projected wait before the source provider recovers: ${Math.round(waitSeconds)}s.` });

  let action: ContinuitySimulationAction = 'resume';
  let status: ContinuitySimulationStatus = 'waiting';
  let retryAt: string | null = new Date(Math.max(nowMs, resetMs)).toISOString();
  if (policy.mode === 'switch') {
    action = 'handoff';
    retryAt = new Date(nowMs).toISOString();
    trace.push({ step: 'decision', detail: 'Mode switch always hands off immediately.' });
  } else if (policy.mode === 'smart' && fallbackProvider && waitSeconds > policy.maxWaitSeconds) {
    action = 'handoff';
    retryAt = new Date(nowMs).toISOString();
    trace.push({
      step: 'decision',
      detail: `Mode smart hands off because the wait (${Math.round(waitSeconds)}s) exceeds maxWaitSeconds=${policy.maxWaitSeconds}.`,
    });
  } else if (policy.mode === 'ask') {
    status = 'needs_attention';
    retryAt = null;
    trace.push({ step: 'decision', detail: 'Mode ask waits for a human decision.' });
  } else {
    trace.push({ step: 'decision', detail: `Mode ${policy.mode} resumes ${input.sourceProvider} at ${retryAt}.` });
  }
  if (action === 'handoff' && !fallbackProvider) {
    status = 'needs_attention';
    retryAt = null;
    trace.push({ step: 'decision', detail: 'The handoff cannot run without a configured fallback provider.' });
  }

  return settled(action, status, retryAt, fallbackProvider, resetTimeSource);
}

async function quotaEvidence(provider: LLMProvider, nowMs: number) {
  try {
    const usage = await loadContinuityUsage(nowMs);
    return classifyProviderQuota(
      usage.providers.find((candidate) => candidate.providerId === provider),
      nowMs,
    );
  } catch {
    return { kind: 'inconclusive' } as const;
  }
}
