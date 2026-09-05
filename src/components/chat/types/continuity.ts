import type { LLMProvider } from '../../../types/app';

export type ContinuityMode = 'off' | 'wait' | 'switch' | 'smart' | 'ask';
export type BoomerangMode = 'off' | 'prompt' | 'auto';
export type PreflightGuardMode = 'off' | 'warn' | 'block';
export type ModelTier = 'flagship' | 'reasoning' | 'fast' | 'lightweight';

export type ContinuityPolicy = {
  sessionId: string;
  mode: ContinuityMode;
  fallbackProviders: LLMProvider[];
  handoffMode: 'summary' | 'full';
  maxAttempts: number;
  maxWaitSeconds: number;
  unknownResetDelaySeconds: number;
  inPlaceHandoff?: boolean;
  boomerangMode?: BoomerangMode;
  preflightQuotaGuard?: PreflightGuardMode;
  preflightThresholdRatio?: number;
  tierMappingEnabled?: boolean;
  checkpointToolsEnabled?: boolean;
  subagentContinuityEnabled?: boolean;
  createdAt: string;
  updatedAt: string;
};

export type ContinuityPolicySettings = Pick<
  ContinuityPolicy,
  | 'mode'
  | 'fallbackProviders'
  | 'handoffMode'
  | 'maxAttempts'
  | 'maxWaitSeconds'
  | 'unknownResetDelaySeconds'
> & {
  inPlaceHandoff?: boolean;
  boomerangMode?: BoomerangMode;
  preflightQuotaGuard?: PreflightGuardMode;
  preflightThresholdRatio?: number;
  tierMappingEnabled?: boolean;
  checkpointToolsEnabled?: boolean;
  subagentContinuityEnabled?: boolean;
};

export type ContinuityRecovery = {
  recoveryId: string;
  sourceRunId: string;
  sessionId: string;
  sourceProvider: LLMProvider;
  status: 'waiting' | 'running' | 'completed' | 'failed' | 'cancelled' | 'needs_attention';
  action: 'resume' | 'handoff';
  fallbackProvider: LLMProvider | null;
  detectedReason: string;
  retryAt: string | null;
  resetTimeSource: 'provider' | 'message' | 'fallback' | 'manual';
  attempt: number;
  maxAttempts: number;
  lastError: string | null;
  resumedSessionId: string | null;
  targetModel?: string | null;
  tierMatch?: string | null;
  scope?: string;
  ownerRef?: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
};

export type ContinuityState = {
  policy: ContinuityPolicy;
  recovery: ContinuityRecovery | null;
};

/**
 * Mirrors `ContinuityProviderHealth` / `ContinuityHealthMatrix` in
 * `server/modules/continuity/continuity-health.service.ts`.
 *
 * `providers` is an ARRAY keyed by its own `provider` field, not a record, and
 * there is no server-computed `summary` — the earlier shape here described a
 * response the API never sent, which crashed the Settings tab on every load.
 * Keep these in step with the service when its response changes.
 */
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

export type ContinuitySimulationResult = {
  action: 'resume' | 'handoff' | 'blocked' | 'noop';
  decisionReason: string;
  targetProvider: LLMProvider | null;
  targetModel: string | null;
  tierMatch: string | null;
  retryAt: string | null;
  waitTimeSeconds: number | null;
  inPlaceEligible: boolean;
  checkpointSummary?: string | null;
};

export type ContinuityBoomerangStatus = {
  ready: boolean;
  originalProvider: LLMProvider | null;
  currentProvider: LLMProvider;
  reason: string;
};

export type ContinuityPreflightResult = {
  allowed: boolean;
  action: 'proceed' | 'warn' | 'block';
  reason?: string;
  percentRemaining?: number | null;
};

export type ContinuityCheckpoint = {
  checkpointId: string;
  sessionId: string;
  lineageRootSessionId: string;
  provider: LLMProvider;
  runId: string | null;
  summary: string;
  nextSteps: string[];
  openQuestions: string[];
  filesTouched: string[];
  commands: string[];
  doNotRepeat: string[];
  tags: string[];
  createdAt: string;
};
