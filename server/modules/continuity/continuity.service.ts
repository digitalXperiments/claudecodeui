import { appConfigDb, getConnection, sessionsDb } from '@/modules/database/index.js';
import { interruptsService } from '@/modules/interrupt-queue/index.js';
import { providerAuthService, sessionHandoffService } from '@/modules/providers/index.js';
import { recordNormalizedRunEvent, runService } from '@/modules/runs/index.js';
import {
  broadcastSystemEvent,
  DETACHED_CONNECTION,
  startProviderRun,
  type ProviderSpawnFn,
} from '@/modules/websocket/index.js';
import { TERMINAL_RUN_STATUSES } from '@/shared/run-events.js';
import type { AnyRecord, LLMProvider, NormalizedMessage } from '@/shared/types.js';
import type { ProviderUsage } from '../provider-usage/index.js';

import { formatCheckpointForPrompt, getLatestCheckpoint } from './continuity-checkpoints.js';
import { continuityRepository } from './continuity.repository.js';
import { pickEquivalentModel, resolveModelTier } from './continuity-tiers.js';
import {
  classifyProviderQuota,
  CONTINUITY_RESET_JITTER_MS,
  isLiveUsageProvider,
  loadContinuityUsage,
  type ProviderQuotaEvidence,
} from './continuity-usage.js';
import type {
  ContinuityMode,
  ContinuityPolicy,
  ContinuityPolicyInput,
  ContinuityPolicySettings,
  ContinuityPolicySource,
  ContinuityRecovery,
  ContinuityRecoveryAction,
  ContinuityState,
  ProviderLimitSignal,
} from './continuity.types.js';
import { detectProviderLimit } from './limit-detection.js';

/** Providers continuity can observe, resume, or hand off to. */
export const CONTINUITY_PROVIDERS: readonly LLMProvider[] = [
  'claude', 'codex', 'cursor', 'opencode', 'kilo', 'cline',
  'grok', 'kimi', 'qwencode', 'pi', 'omp', 'antigravity',
];
const PROVIDERS: readonly LLMProvider[] = CONTINUITY_PROVIDERS;
const MODES: readonly ContinuityMode[] = ['off', 'wait', 'switch', 'smart', 'ask'];
const SOURCE_RUN_SETTLE_DELAY_MS = 5_000;
export const CONTINUITY_DEFAULTS_KEY = 'continuity.defaults';

let runtimeSpawnFns: Partial<Record<LLMProvider, ProviderSpawnFn>> = {};

export const DEFAULT_CONTINUITY_POLICY = {
  mode: 'off',
  fallbackProviders: [] as LLMProvider[],
  handoffMode: 'summary',
  maxAttempts: 3,
  maxWaitSeconds: 6 * 60 * 60,
  unknownResetDelaySeconds: 15 * 60,
  inPlaceHandoff: false,
  boomerangMode: 'off',
  preflightQuotaGuard: 'warn',
  preflightThresholdRatio: 0.05,
  tierMappingEnabled: true,
  checkpointToolsEnabled: true,
  subagentContinuityEnabled: true,
} satisfies ContinuityPolicySettings;

export function configureContinuityRuntimes(
  spawnFns: Partial<Record<LLMProvider, ProviderSpawnFn>>,
): void {
  runtimeSpawnFns = spawnFns;
}

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

export function normalizePolicy(
  input: ContinuityPolicyInput,
  fallback: ContinuityPolicySettings = DEFAULT_CONTINUITY_POLICY,
): ContinuityPolicySettings {
  const mode = MODES.includes(input.mode as ContinuityMode)
    ? input.mode as ContinuityMode
    : fallback.mode;
  const fallbackProviders = Array.isArray(input.fallbackProviders)
    ? [...new Set(input.fallbackProviders.filter((provider): provider is LLMProvider =>
        PROVIDERS.includes(provider as LLMProvider)))]
    : [...fallback.fallbackProviders];
  return {
    mode,
    fallbackProviders,
    handoffMode: input.handoffMode === 'full' || input.handoffMode === 'summary'
      ? input.handoffMode
      : fallback.handoffMode,
    maxAttempts: clampInteger(input.maxAttempts, fallback.maxAttempts, 1, 10),
    maxWaitSeconds: clampInteger(input.maxWaitSeconds, fallback.maxWaitSeconds, 0, 7 * 24 * 60 * 60),
    unknownResetDelaySeconds: clampInteger(
      input.unknownResetDelaySeconds,
      fallback.unknownResetDelaySeconds,
      30,
      24 * 60 * 60,
    ),
    inPlaceHandoff: typeof input.inPlaceHandoff === 'boolean'
      ? input.inPlaceHandoff
      : fallback.inPlaceHandoff,
    boomerangMode: input.boomerangMode === 'auto' || input.boomerangMode === 'prompt' || input.boomerangMode === 'off'
      ? input.boomerangMode
      : fallback.boomerangMode,
    preflightQuotaGuard: input.preflightQuotaGuard === 'block' || input.preflightQuotaGuard === 'warn' || input.preflightQuotaGuard === 'off'
      ? input.preflightQuotaGuard
      : fallback.preflightQuotaGuard,
    preflightThresholdRatio: typeof input.preflightThresholdRatio === 'number' && !Number.isNaN(input.preflightThresholdRatio)
      ? Math.max(0, Math.min(1, input.preflightThresholdRatio))
      : fallback.preflightThresholdRatio,
    tierMappingEnabled: typeof input.tierMappingEnabled === 'boolean'
      ? input.tierMappingEnabled
      : fallback.tierMappingEnabled,
    checkpointToolsEnabled: typeof input.checkpointToolsEnabled === 'boolean'
      ? input.checkpointToolsEnabled
      : fallback.checkpointToolsEnabled,
    subagentContinuityEnabled: typeof input.subagentContinuityEnabled === 'boolean'
      ? input.subagentContinuityEnabled
      : fallback.subagentContinuityEnabled,
  };
}

function policySettings(policy: ContinuityPolicy): ContinuityPolicySettings {
  return {
    mode: policy.mode,
    fallbackProviders: policy.fallbackProviders,
    handoffMode: policy.handoffMode,
    maxAttempts: policy.maxAttempts,
    maxWaitSeconds: policy.maxWaitSeconds,
    unknownResetDelaySeconds: policy.unknownResetDelaySeconds,
    inPlaceHandoff: policy.inPlaceHandoff,
    boomerangMode: policy.boomerangMode,
    preflightQuotaGuard: policy.preflightQuotaGuard,
    preflightThresholdRatio: policy.preflightThresholdRatio,
    tierMappingEnabled: policy.tierMappingEnabled,
    checkpointToolsEnabled: policy.checkpointToolsEnabled,
    subagentContinuityEnabled: policy.subagentContinuityEnabled,
  };
}

function readSavedDefaults(): ContinuityPolicyInput | null {
  const raw = appConfigDb.get(CONTINUITY_DEFAULTS_KEY);
  if (!raw) return null;
  try {
    const value = JSON.parse(raw);
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as ContinuityPolicyInput
      : null;
  } catch {
    return null;
  }
}

function getDefaultsWithSource(): {
  defaults: ContinuityPolicySettings;
  source: Exclude<ContinuityPolicySource, 'session'>;
} {
  const saved = readSavedDefaults();
  return saved
    ? { defaults: normalizePolicy(saved), source: 'global' }
    : { defaults: { ...DEFAULT_CONTINUITY_POLICY, fallbackProviders: [] }, source: 'builtin' };
}

function resolvePolicy(sessionId: string): { policy: ContinuityPolicy; source: ContinuityPolicySource } {
  const stored = continuityRepository.getPolicy(sessionId);
  if (stored) return { policy: stored, source: 'session' };
  const { defaults, source } = getDefaultsWithSource();
  return {
    policy: { sessionId, ...defaults, createdAt: '', updatedAt: '' },
    source,
  };
}

function broadcastRecovery(recovery: ContinuityRecovery | null): void {
  if (!recovery) return;
  broadcastSystemEvent({
    kind: 'continuity_updated',
    sessionId: recovery.sessionId,
    recovery,
  });
}

function providerWindowRatio(usage: ProviderUsage | undefined): number | null {
  const ratios: number[] = [];
  for (const window of usage?.windows ?? []) {
    if (typeof window.remainingRatio === "number" && Number.isFinite(window.remainingRatio)) {
      ratios.push(window.remainingRatio);
      continue;
    }
    if (
      typeof window.used === "number" && Number.isFinite(window.used)
      && typeof window.limit === "number" && Number.isFinite(window.limit) && window.limit > 0
    ) {
      ratios.push((window.limit - window.used) / window.limit);
    }
  }
  if (ratios.length === 0) return null;
  return Math.max(0, Math.min(1, Math.min(...ratios)));
}

function futureIso(timestampMs: number): string {
  return new Date(Math.max(Date.now(), timestampMs)).toISOString();
}

async function quotaEvidenceFor(provider: LLMProvider): Promise<ProviderQuotaEvidence> {
  try {
    const usage = await loadContinuityUsage();
    const row = usage.providers.find((candidate) => candidate.providerId === provider);
    return classifyProviderQuota(row, Date.now());
  } catch {
    return { kind: 'inconclusive' };
  }
}

function usedProviders(runId: string): Set<string> {
  const used = new Set<string>();
  let current = runService.get(runId);
  while (current) {
    if (current.provider) used.add(current.provider);
    current = current.parent_run_id ? runService.get(current.parent_run_id) : null;
  }
  return used;
}

function chooseFallback(policy: ContinuityPolicy, runId: string): LLMProvider | null {
  const used = usedProviders(runId);
  return policy.fallbackProviders.find((provider) => !used.has(provider)) ?? null;
}

async function chooseConnectedFallback(
  recovery: ContinuityRecovery,
  policy: ContinuityPolicySettings,
): Promise<LLMProvider> {
  const used = usedProviders(recovery.sourceRunId);
  const candidates = [...new Set([
    recovery.fallbackProvider,
    ...policy.fallbackProviders,
  ])].filter((provider): provider is LLMProvider => provider !== null && !used.has(provider));
  if (candidates.length === 0) throw new Error('No unused fallback provider is configured');

  const failures: string[] = [];
  for (const provider of candidates) {
    try {
      const auth = await providerAuthService.getProviderAuthStatus(provider);
      if (auth.authenticated) return provider;
      failures.push(`${provider}${auth.error ? `: ${auth.error}` : ''}`);
    } catch (error) {
      failures.push(`${provider}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`No configured fallback provider is connected (${failures.join('; ')})`);
}

function inheritedAttempt(runId: string): number {
  const run = runService.get(runId);
  const value = run?.meta?.continuityAttempt;
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) + 1 : 1;
}

async function scheduleLimitRecovery(runId: string, signal: ProviderLimitSignal): Promise<ContinuityRecovery | null> {
  const existing = continuityRepository.getBySourceRun(runId);
  if (existing) return existing;

  const run = runService.get(runId);
  if (!run?.app_session_id || !run.provider || !PROVIDERS.includes(run.provider as LLMProvider)) return null;
  const { policy } = resolvePolicy(run.app_session_id);
  if (policy.mode === 'off') return null;

  const attempt = inheritedAttempt(runId);
  const fallbackProvider = chooseFallback(policy, runId);
  if (attempt > policy.maxAttempts) {
    const recovery = continuityRepository.create({
      sourceRunId: runId,
      sessionId: run.app_session_id,
      sourceProvider: run.provider as LLMProvider,
      status: 'needs_attention',
      action: 'resume',
      fallbackProvider,
      detectedReason: signal.reason,
      retryAt: null,
      resetTimeSource: signal.resetTimeSource,
      attempt,
      maxAttempts: policy.maxAttempts,
      policy: policySettings(policy),
    });
    broadcastRecovery(recovery);
    return recovery;
  }

  let resetTime = signal.retryAt;
  let resetTimeSource: ContinuityRecovery['resetTimeSource'] = signal.retryAt ? 'message' : 'fallback';
  let fallbackMs = policy.unknownResetDelaySeconds * 1000;
  if (!signal.retryAt) {
    const evidence = await quotaEvidenceFor(run.provider as LLMProvider);
    if (evidence.kind === 'available') {
      resetTime = new Date().toISOString();
      resetTimeSource = 'provider';
    } else if (evidence.kind === 'exhausted' && evidence.resetsAt) {
      resetTime = evidence.resetsAt;
      resetTimeSource = 'provider';
    } else if (isLiveUsageProvider(run.provider)) {
      // Poll usage until quota returns; maxWaitSeconds is only a safety cap.
      fallbackMs = policy.maxWaitSeconds * 1000;
    }
  }
  const fallbackTime = Date.now() + fallbackMs;
  const resetMs = resetTime ? Date.parse(resetTime) + CONTINUITY_RESET_JITTER_MS : fallbackTime;
  const waitSeconds = Math.max(0, (resetMs - Date.now()) / 1000);

  let action: ContinuityRecoveryAction = 'resume';
  let status: ContinuityRecovery['status'] = 'waiting';
  let retryAt: string | null = futureIso(resetMs);
  if (policy.mode === 'switch') {
    action = 'handoff';
    retryAt = new Date().toISOString();
  } else if (policy.mode === 'smart') {
    if (waitSeconds > policy.maxWaitSeconds) {
      action = 'handoff';
      retryAt = new Date().toISOString();
    }
  } else if (policy.mode === 'ask') {
    status = 'needs_attention';
    retryAt = null;
  }

  const recovery = continuityRepository.create({
    sourceRunId: runId,
    sessionId: run.app_session_id,
    sourceProvider: run.provider as LLMProvider,
    status,
    action,
    fallbackProvider,
    detectedReason: signal.reason,
    retryAt,
    resetTimeSource,
    attempt,
    maxAttempts: policy.maxAttempts,
    policy: policySettings(policy),
  });

  if (status === 'needs_attention') {
    interruptsService.create({
      projectId: run.project_id,
      kind: 'run_failed',
      severity: 'warning',
      title: 'Provider limit reached',
      body: fallbackProvider
        ? `${run.provider} reached its limit. Choose whether to wait or continue with ${fallbackProvider}.`
        : `${run.provider} reached its limit. No unused fallback provider is configured.`,
      runId,
      href: `/chat?sessionId=${encodeURIComponent(run.app_session_id)}`,
      actions: [{ id: 'dismiss', label: 'Open chat', style: 'primary' }],
      meta: { recoveryId: recovery.recoveryId, sessionId: run.app_session_id },
      dedupeKey: `continuity:${recovery.recoveryId}`,
    });
  }
  broadcastRecovery(recovery);
  return recovery;
}

function continuationPrompt(sourceProvider: string): string {
  return `CloudCLI automatically resumed this session after the ${sourceProvider} usage limit reset. Continue the unfinished task from where execution stopped. Inspect the current conversation and repository state before acting, and do not repeat a completed side effect.`;
}

async function startRecoveryRun(
  recovery: ContinuityRecovery,
  target: { sessionId: string; provider: LLMProvider; prompt: string },
): Promise<void> {
  const sourceRun = runService.get(recovery.sourceRunId);
  const session = sessionsDb.getSessionById(target.sessionId);
  const spawnFn = runtimeSpawnFns[target.provider];
  if (!sourceRun || !session || !spawnFn) {
    throw new Error(`The ${target.provider} runtime or continuation session is unavailable`);
  }
  const projectPath = session.runtime_project_path ?? session.project_path;
  if (!projectPath) throw new Error('The continuation session has no project path');

  const { policy } = resolvePolicy(target.sessionId);

  // Feature 5: Capability tier model mapping
  let targetModel: string | null = null;
  const targetEffort = sourceRun.effort ?? null;
  if (target.provider === recovery.sourceProvider) {
    targetModel = sourceRun.model;
  } else if (policy.tierMappingEnabled !== false && sourceRun.model) {
    const sourceTier = resolveModelTier(recovery.sourceProvider, sourceRun.model);
    const { model: mappedModel } = pickEquivalentModel(target.provider, sourceTier);
    targetModel = mappedModel;
  }

  // Feature 6: Prepend checkpoint context to prompt if available
  let promptContent = target.prompt;
  if (policy.checkpointToolsEnabled !== false) {
    const checkpoint = getLatestCheckpoint(target.sessionId) ?? getLatestCheckpoint(recovery.sessionId);
    if (checkpoint) {
      promptContent = `${formatCheckpointForPrompt(checkpoint)}

${target.prompt}`;
    }
  }

  const child = runService.create({
    source: 'system',
    sourceRef: recovery.recoveryId,
    projectId: sourceRun.project_id,
    workspaceId: sourceRun.workspace_id,
    appSessionId: target.sessionId,
    provider: target.provider,
    model: targetModel,
    effort: targetEffort,
    permissionMode: session.permission_mode,
    title: `Continuity: ${sourceRun.title ?? sourceRun.run_id}`,
    trigger: 'continuity',
    parentRunId: sourceRun.run_id,
    rootRunId: sourceRun.root_run_id ?? sourceRun.run_id,
    meta: {
      continuityAttempt: recovery.attempt,
      continuityRecoveryId: recovery.recoveryId,
      previousProvider: recovery.sourceProvider,
      action: recovery.action,
      targetModel,
    },
  });

  let blockedAgain = false;
  const started = await startProviderRun({
    appSessionId: target.sessionId,
    provider: target.provider,
    providerSessionId: session.provider_session_id,
    projectPath,
    spawnFn,
    content: promptContent,
    options: {
      cwd: projectPath,
      projectPath,
      model: child.model ?? undefined,
      effort: child.effort ?? undefined,
      permissionMode: child.permission_mode ?? undefined,
      unattended: true,
    } as AnyRecord,
    connection: DETACHED_CONNECTION,
    userId: null,
    onEvent: (message) => {
      recordNormalizedRunEvent(child.run_id, message, 'system');
      if (detectProviderLimit(message)) blockedAgain = true;
      void continuityService.observeRunEvent(child.run_id, message);
      if (message.kind === 'complete') {
        const succeeded = message.success === true || message.exitCode === 0;
        const updated = continuityRepository.update(recovery.recoveryId, {
          status: blockedAgain || succeeded ? 'completed' : 'needs_attention',
          completedAt: new Date().toISOString(),
          lastError: blockedAgain || succeeded ? null : 'The automatic continuation failed',
        });
        broadcastRecovery(updated);
      }
    },
  });
  if (!started.ok) throw new Error('A run is already active in the continuation session');
  runService.linkSession(child.run_id, target.sessionId);
  if (runService.get(child.run_id)?.status === 'queued' || runService.get(child.run_id)?.status === 'starting') {
    runService.updateStatus(child.run_id, 'running');
  }
  void started.completion.catch((error) => {
    const updated = continuityRepository.update(recovery.recoveryId, {
      status: 'needs_attention',
      lastError: error instanceof Error ? error.message : String(error),
      completedAt: new Date().toISOString(),
    });
    broadcastRecovery(updated);
  });
}

export async function dispatchContinuityRecovery(recovery: ContinuityRecovery): Promise<void> {
  const { policy: currentPolicy } = resolvePolicy(recovery.sessionId);
  if (currentPolicy.mode === 'off') {
    broadcastRecovery(continuityRepository.update(recovery.recoveryId, {
      status: 'cancelled',
      completedAt: new Date().toISOString(),
    }));
    return;
  }
  const sourceRun = runService.get(recovery.sourceRunId);
  if (!sourceRun) throw new Error(`Source run ${recovery.sourceRunId} no longer exists`);
  if (!TERMINAL_RUN_STATUSES.has(sourceRun.status)) {
    const updated = continuityRepository.update(recovery.recoveryId, {
      status: 'waiting',
      retryAt: new Date(Date.now() + SOURCE_RUN_SETTLE_DELAY_MS).toISOString(),
      startedAt: null,
    });
    broadcastRecovery(updated);
    return;
  }

  if (recovery.action === 'resume') {
    await startRecoveryRun(recovery, {
      sessionId: recovery.sessionId,
      provider: recovery.sourceProvider,
      prompt: continuationPrompt(recovery.sourceProvider),
    });
    return;
  }

  const storedPolicy = continuityRepository.getPolicy(recovery.sessionId);
  const recoveryPolicy = normalizePolicy(recovery.policy);
  const targetProvider = await chooseConnectedFallback(recovery, recoveryPolicy);
  if (targetProvider !== recovery.fallbackProvider) {
    broadcastRecovery(continuityRepository.update(recovery.recoveryId, {
      fallbackProvider: targetProvider,
    }));
  }

  // Feature 2: In-place handoff without creating detached sessions
  if (recoveryPolicy.inPlaceHandoff) {
    const currentSession = sessionsDb.getSessionById(recovery.sessionId);
    if (currentSession && targetProvider !== currentSession.provider) {
      getConnection().prepare(
        'UPDATE sessions SET provider = ?, provider_session_id = NULL, updated_at = CURRENT_TIMESTAMP WHERE session_id = ?',
      ).run(targetProvider, recovery.sessionId);
    }
    const updated = continuityRepository.update(recovery.recoveryId, {
      resumedSessionId: recovery.sessionId,
    });
    broadcastRecovery(updated);
    await startRecoveryRun(recovery, {
      sessionId: recovery.sessionId,
      provider: targetProvider,
      prompt: `[System Continuity Handoff to ${targetProvider}]

${continuationPrompt(targetProvider)}`,
    });
    return;
  }

  const handoff = await sessionHandoffService.createHandoffSession({
    sourceSessionId: recovery.sessionId,
    targetProvider,
    mode: recoveryPolicy.handoffMode,
    saveToFile: recoveryPolicy.handoffMode === 'full',
    includeGitState: true,
    includeKanbanState: true,
  });
  if (storedPolicy) continuityRepository.putPolicy(handoff.sessionId, policySettings(storedPolicy));
  const updated = continuityRepository.update(recovery.recoveryId, {
    resumedSessionId: handoff.sessionId,
  });
  broadcastRecovery(updated);
  await startRecoveryRun(recovery, {
    sessionId: handoff.sessionId,
    provider: targetProvider,
    prompt: handoff.handoffPrompt ?? 'Continue the unfinished task from the source session.',
  });
}

export const continuityService = {
  getDefaults(): ContinuityPolicySettings {
    return getDefaultsWithSource().defaults;
  },

  putDefaults(input: ContinuityPolicyInput): ContinuityPolicySettings {
    const defaults = normalizePolicy(input, getDefaultsWithSource().defaults);
    appConfigDb.set(CONTINUITY_DEFAULTS_KEY, JSON.stringify(defaults));
    if (defaults.mode === 'off') {
      for (const recovery of continuityRepository.cancelPendingWithoutPolicyOverrides()) {
        broadcastRecovery(recovery);
      }
    }
    return defaults;
  },

  getState(sessionId: string): ContinuityState {
    const { policy, source: policySource } = resolvePolicy(sessionId);
    return {
      policy,
      policySource,
      recovery: continuityRepository.getLatestForSession(sessionId),
    };
  },

  putPolicy(sessionId: string, input: ContinuityPolicyInput): ContinuityPolicy {
    const existing = continuityRepository.getPolicy(sessionId);
    const base = existing ? policySettings(existing) : getDefaultsWithSource().defaults;
    const policy = continuityRepository.putPolicy(sessionId, normalizePolicy(input, base));
    if (policy.mode === 'off') {
      const recovery = continuityRepository.getLatestForSession(sessionId);
      if (recovery && ['waiting', 'needs_attention'].includes(recovery.status)) {
        broadcastRecovery(continuityRepository.update(recovery.recoveryId, {
          status: 'cancelled',
          completedAt: new Date().toISOString(),
        }));
      }
    }
    return policy;
  },

  async observeRunEvent(runId: string, message: NormalizedMessage): Promise<ContinuityRecovery | null> {
    const signal = detectProviderLimit(message);
    return signal ? scheduleLimitRecovery(runId, signal) : null;
  },

  act(recoveryId: string, action: 'resume_now' | 'switch_now' | 'cancel', targetProvider?: LLMProvider): ContinuityRecovery {
    const recovery = continuityRepository.getRecovery(recoveryId);
    if (!recovery) throw new Error(`Recovery ${recoveryId} was not found`);
    if (action === 'cancel') {
      const updated = continuityRepository.update(recoveryId, {
        status: 'cancelled',
        completedAt: new Date().toISOString(),
      })!;
      broadcastRecovery(updated);
      return updated;
    }
    const fallbackProvider = action === 'switch_now'
      ? targetProvider ?? recovery.fallbackProvider
      : recovery.fallbackProvider;
    if (action === 'switch_now' && !fallbackProvider) throw new Error('Choose a fallback provider first');
    if (fallbackProvider && !PROVIDERS.includes(fallbackProvider)) {
      throw new Error(`Unknown fallback provider: ${fallbackProvider}`);
    }
    const updated = continuityRepository.update(recoveryId, {
      status: 'waiting',
      action: action === 'switch_now' ? 'handoff' : 'resume',
      fallbackProvider,
      retryAt: new Date().toISOString(),
      resetTimeSource: 'manual',
      lastError: null,
      completedAt: null,
    })!;
    broadcastRecovery(updated);
    return updated;
  },

  // Feature 4: Pre-flight Quota Guard
  async checkPreflight(sessionId: string, provider: LLMProvider): Promise<{
    status: 'ok' | 'warn' | 'blocked';
    message?: string;
    suggestedProvider?: LLMProvider;
    remainingRatio?: number | null;
  }> {
    const { policy } = resolvePolicy(sessionId);
    if (policy.preflightQuotaGuard === 'off') {
      return { status: 'ok' };
    }
    const usageResponse = await loadContinuityUsage();
    const row = usageResponse.providers.find((candidate) => candidate.providerId === provider);
    const quota = classifyProviderQuota(row, Date.now());
    const remaining = providerWindowRatio(row);
    const isUnderThreshold = quota.kind === 'exhausted' || (typeof remaining === 'number' && remaining <= policy.preflightThresholdRatio);

    if (!isUnderThreshold) {
      return { status: 'ok', remainingRatio: remaining };
    }

    let suggestedProvider: LLMProvider | undefined;
    if (policy.fallbackProviders.length > 0) {
      for (const fallback of policy.fallbackProviders) {
        const fbRow = usageResponse.providers.find((candidate) => candidate.providerId === fallback);
        const fbQuota = classifyProviderQuota(fbRow, Date.now());
        const fbRemaining = providerWindowRatio(fbRow);
        if (fbQuota.kind !== 'exhausted' && (fbRemaining === null || fbRemaining > policy.preflightThresholdRatio)) {
          suggestedProvider = fallback;
          break;
        }
      }
    }

    const pct = typeof remaining === 'number' ? `${Math.round(remaining * 100)}%` : '0%';
    const message = `Provider ${provider} quota is low (${pct} remaining).`;

    if (policy.preflightQuotaGuard === 'block') {
      return { status: 'blocked', message, suggestedProvider, remainingRatio: remaining };
    }
    return { status: 'warn', message, suggestedProvider, remainingRatio: remaining };
  },

  // Feature 3: Boomerang mode return check & execution
  async checkBoomerang(sessionId: string): Promise<{
    canBoomerang: boolean;
    primaryProvider: LLMProvider | null;
    currentProvider: LLMProvider | null;
    status: 'ready' | 'waiting' | 'none';
  }> {
    const { policy } = resolvePolicy(sessionId);
    if (policy.boomerangMode === 'off') {
      return { canBoomerang: false, primaryProvider: null, currentProvider: null, status: 'none' };
    }
    const session = sessionsDb.getSessionById(sessionId);
    if (!session) return { canBoomerang: false, primaryProvider: null, currentProvider: null, status: 'none' };

    let originProvider: LLMProvider | null = null;
    let cursorId = session.continued_from_session_id ?? null;
    const seen = new Set<string>();
    while (cursorId && !seen.has(cursorId)) {
      seen.add(cursorId);
      const ancestor = sessionsDb.getSessionById(cursorId);
      if (!ancestor) break;
      originProvider = ancestor.provider as LLMProvider;
      cursorId = ancestor.continued_from_session_id ?? null;
    }

    if (!originProvider || originProvider === session.provider) {
      const recovery = continuityRepository.getLatestForSession(sessionId);
      if (recovery && recovery.sourceProvider && recovery.sourceProvider !== session.provider) {
        originProvider = recovery.sourceProvider;
      } else {
        return { canBoomerang: false, primaryProvider: null, currentProvider: session.provider as LLMProvider, status: 'none' };
      }
    }

    const usageResponse = await loadContinuityUsage();
    const row = usageResponse.providers.find((candidate) => candidate.providerId === originProvider);
    const quota = classifyProviderQuota(row, Date.now());
    const isAvailable = quota.kind !== 'exhausted';

    return {
      canBoomerang: isAvailable,
      primaryProvider: originProvider,
      currentProvider: session.provider as LLMProvider,
      status: isAvailable ? 'ready' : 'waiting',
    };
  },

  async executeBoomerang(sessionId: string): Promise<{ resumedSessionId: string }> {
    const check = await this.checkBoomerang(sessionId);
    if (!check.canBoomerang || !check.primaryProvider) {
      throw new Error('Primary provider is not currently available for boomerang return.');
    }
    const { policy } = resolvePolicy(sessionId);
    if (policy.inPlaceHandoff) {
      getConnection().prepare(
        'UPDATE sessions SET provider = ?, provider_session_id = NULL, updated_at = CURRENT_TIMESTAMP WHERE session_id = ?',
      ).run(check.primaryProvider, sessionId);
      return { resumedSessionId: sessionId };
    }
    const result = await sessionHandoffService.reverseHandoffSession({
      sessionId,
      targetProvider: check.primaryProvider,
      mode: policy.handoffMode,
    });
    return { resumedSessionId: result.sessionId };
  },
};
