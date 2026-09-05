import type { LLMProvider } from '@/shared/types.js';

export type ContinuityMode = 'off' | 'wait' | 'switch' | 'smart' | 'ask';
export type ContinuityHandoffMode = 'summary' | 'full';
export type ContinuityRecoveryStatus =
  | 'waiting'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'needs_attention';
export type ContinuityRecoveryAction = 'resume' | 'handoff';

export type ContinuityPolicySettings = {
  mode: ContinuityMode;
  fallbackProviders: LLMProvider[];
  handoffMode: ContinuityHandoffMode;
  maxAttempts: number;
  maxWaitSeconds: number;
  unknownResetDelaySeconds: number;

  // Feature Toggles (all 7 suggestions can be toggled on/off)
  // Feature 2: In-place handoff in existing session vs spawning a new session
  inPlaceHandoff: boolean;
  // Feature 3: Boomerang mode (auto/prompt/off return to primary provider when quota resets)
  boomerangMode: 'off' | 'prompt' | 'auto';
  // Feature 4: Pre-flight quota guard before starting runs
  preflightQuotaGuard: 'off' | 'warn' | 'block';
  preflightThresholdRatio: number;
  // Feature 5: Intelligent Capability tier mapping for fallback models
  tierMappingEnabled: boolean;
  // Feature 6: Tool state, MCP checkpoints & scratchpad
  checkpointToolsEnabled: boolean;
  // Feature 7: Subagent & relay continuity isolation
  subagentContinuityEnabled: boolean;
};

export type ContinuityPolicy = ContinuityPolicySettings & {
  sessionId: string;
  createdAt: string;
  updatedAt: string;
};

export type ContinuityPolicyInput = Partial<ContinuityPolicySettings>;
export type ContinuityPolicySource = 'session' | 'global' | 'builtin';

export type ContinuityState = {
  policy: ContinuityPolicy;
  policySource: ContinuityPolicySource;
  recovery: ContinuityRecovery | null;
};

export type ContinuityRecovery = {
  recoveryId: string;
  sourceRunId: string;
  sessionId: string;
  sourceProvider: LLMProvider;
  status: ContinuityRecoveryStatus;
  action: ContinuityRecoveryAction;
  fallbackProvider: LLMProvider | null;
  detectedReason: string;
  retryAt: string | null;
  resetTimeSource: 'provider' | 'message' | 'fallback' | 'manual';
  attempt: number;
  maxAttempts: number;
  policy: ContinuityPolicyInput;
  lastError: string | null;
  resumedSessionId: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
};

export type ProviderLimitSignal = {
  reason: string;
  retryAt: string | null;
  resetTimeSource: 'message' | 'fallback';
  rawText: string;
};
