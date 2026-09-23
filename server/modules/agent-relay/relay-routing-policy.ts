import type { LLMProvider, ProviderModelOption } from '@/shared/types.js';

export type RelayTaskClass = 'scout' | 'implement' | 'verify' | 'judge';
export type RelayRoutingObjective = 'quality' | 'cost' | 'speed';
export type RelayExecutionMode = 'read_only' | 'isolated_write';
export type RelayFailureClass =
  | 'quota'
  | 'rate_limit'
  | 'auth'
  | 'permission'
  | 'spawn'
  | 'timeout'
  | 'task_failure';
export type RelaySideEffectState = 'none' | 'started' | 'unknown';

export type RelayRuntimeReadiness = {
  installed: boolean;
  authenticated: boolean;
  available: boolean;
};

export type RelaySeatAvailability = {
  /** A provider/runtime seat that enforces the read-only assignment boundary. */
  readOnly: boolean;
  /** A seat with the requested MCP grant attached and usable. */
  mcp: boolean;
};

/**
 * One candidate must contain the actual provider catalog row. This prevents a
 * caller from inventing a model/effort pair while still keeping this policy
 * independent from the provider and database services.
 */
export type RelayRoutingCandidate = {
  provider: LLMProvider;
  catalog: ProviderModelOption;
  runtime: RelayRuntimeReadiness;
  seats?: Partial<RelaySeatAvailability>;
  /** Optional measured/default capability facts, normalized to 0..1. */
  qualityScore?: number;
  speedScore?: number;
  /** Positive cost estimate in USD per successful task; absent means unknown. */
  costPerSuccessUsd?: number;
};

export type RelayOutcome = {
  attempts: number;
  successes?: number;
  firstTrySuccessRate?: number;
  usableOutputRate?: number;
  qualityScore?: number;
  costPerSuccessUsd?: number | null;
  medianDurationMs?: number | null;
};

export type RelayCandidateSelection = {
  provider?: LLMProvider;
  model?: string;
  effort?: string;
};

export type RelayRoutingRequest = {
  taskClass: RelayTaskClass;
  optimize: RelayRoutingObjective;
  mode: RelayExecutionMode;
  requiresMcp?: boolean;
  selection?: RelayCandidateSelection;
  candidates: readonly RelayRoutingCandidate[];
  outcomes?: Readonly<Record<string, RelayOutcome>>;
  attemptedCandidates?: readonly string[];
};

export type RelaySelectedModel = {
  provider: LLMProvider;
  /** The provider catalog's selectable `value`, suitable for dispatch. */
  model: string;
  /** The provider catalog's concrete resolution, when advertised. */
  resolvedModel: string | null;
  /** Catalog effort id, or null when the catalog has no effort setting. */
  effort: string | null;
};

export type RelayRoutingProfile = {
  candidateKey: string;
  selected: RelaySelectedModel;
  rankScore: number;
  estimatedCostUsd: number;
  costKnown: boolean;
  reasons: string[];
  provenance: string[];
};

export type RelayCandidateRejection = {
  candidateKey: string;
  reasons: string[];
  provenance: string[];
};

export type RelayRoutingPlan = {
  profiles: RelayRoutingProfile[];
  selected: RelayRoutingProfile;
  rejected: RelayCandidateRejection[];
  reasons: string[];
  provenance: string[];
};

export type RelayFailureClassification = {
  kind: RelayFailureClass;
  reason: string;
  provenance: string[];
};

export type RelayFallbackContext = {
  mode: RelayExecutionMode;
  failure: RelayFailureClassification | RelayFailureClass;
  /** Set this to `unknown` for a write whose side effects cannot be ruled out. */
  sideEffects?: RelaySideEffectState;
  /** Compatibility shorthand for integrations that have a boolean fact. */
  sideEffectsStarted?: boolean;
  usableOutput?: boolean;
  attemptedCandidates: readonly string[];
  fallbackCount?: number;
  maxFallbacks?: number;
};

export type RelayFallbackDecision = {
  allowed: boolean;
  action: 'retry_next_candidate' | 'require_explicit_recovery' | 'stop';
  reason: string;
  provenance: string[];
};

export class RelayRoutingPolicyError extends Error {
  readonly code: 'INVALID_SELECTION' | 'NO_ELIGIBLE_CANDIDATE';
  readonly reasons: string[];

  constructor(
    code: RelayRoutingPolicyError['code'],
    message: string,
    reasons: string[] = [],
  ) {
    super(message);
    this.name = 'RelayRoutingPolicyError';
    this.code = code;
    this.reasons = reasons;
  }
}

const UNKNOWN_COST_PRIOR_USD = 1;
const DEFAULT_MAX_FALLBACKS = 1;

const COLD_START_QUALITY: Record<RelayTaskClass, number> = {
  scout: 0.68,
  implement: 0.80,
  verify: 0.78,
  judge: 0.86,
};

const COLD_START_SPEED: Record<RelayTaskClass, number> = {
  scout: 0.88,
  implement: 0.70,
  verify: 0.74,
  judge: 0.62,
};

const clamp = (value: number, fallback: number): number => (
  Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : fallback
);

const modelKey = (provider: LLMProvider, model: string): string => `${provider}:${model}`;

export function relayCandidateKey(candidate: RelayRoutingCandidate): string {
  return modelKey(candidate.provider, candidate.catalog.value);
}

function outcomeFor(
  candidate: RelayRoutingCandidate,
  outcomes: Readonly<Record<string, RelayOutcome>> | undefined,
): RelayOutcome | null {
  const key = relayCandidateKey(candidate);
  return outcomes?.[key] ?? outcomes?.[candidate.catalog.resolvedModel ?? ''] ?? null;
}

function selectedEffort(candidate: RelayRoutingCandidate, requested?: string): string | null {
  const values = candidate.catalog.effort?.values ?? [];
  if (requested) {
    if (requested === 'default') return candidate.catalog.effort?.default ?? null;
    if (!values.some((entry) => entry.value === requested)) {
      throw new RelayRoutingPolicyError(
        'INVALID_SELECTION',
        `Effort "${requested}" is not advertised for model "${candidate.catalog.value}".`,
        [`catalog effort values: ${values.map((entry) => entry.value).join(', ') || 'none'}`],
      );
    }
    return requested;
  }
  return candidate.catalog.effort?.default ?? null;
}

function selectionMatches(candidate: RelayRoutingCandidate, selection: RelayCandidateSelection): boolean {
  if (selection.provider && selection.provider !== candidate.provider) return false;
  if (!selection.model) return true;
  return selection.model === candidate.catalog.value || selection.model === candidate.catalog.resolvedModel;
}

function rejectReasons(
  candidate: RelayRoutingCandidate,
  request: RelayRoutingRequest,
): { reasons: string[]; provenance: string[] } {
  const reasons: string[] = [];
  const provenance = ['runtime readiness supplied by caller'];
  if (!candidate.runtime.installed) reasons.push('runtime is not installed');
  if (!candidate.runtime.authenticated) reasons.push('runtime is not authenticated');
  if (!candidate.runtime.available) reasons.push('runtime is not available');
  if (request.mode === 'read_only' && candidate.seats?.readOnly !== true) {
    reasons.push('required read-only seat is unavailable');
    provenance.push('read-only seat requirement');
  }
  if (request.requiresMcp && candidate.seats?.mcp !== true) {
    reasons.push('required MCP seat is unavailable');
    provenance.push('MCP seat requirement');
  }
  return { reasons, provenance };
}

function rankCandidate(
  candidate: RelayRoutingCandidate,
  request: RelayRoutingRequest,
): RelayRoutingProfile {
  const outcome = outcomeFor(candidate, request.outcomes);
  const measuredQuality = outcome?.qualityScore ?? outcome?.usableOutputRate;
  const quality = measuredQuality == null
    ? clamp(candidate.qualityScore ?? COLD_START_QUALITY[request.taskClass], COLD_START_QUALITY[request.taskClass])
    : clamp(measuredQuality, COLD_START_QUALITY[request.taskClass]);
  const measuredSpeed = outcome?.medianDurationMs != null && outcome.medianDurationMs > 0
    ? clamp(60_000 / outcome.medianDurationMs, 0.01)
    : null;
  const speed = measuredSpeed ?? clamp(candidate.speedScore ?? COLD_START_SPEED[request.taskClass], COLD_START_SPEED[request.taskClass]);
  const measuredCost = outcome?.costPerSuccessUsd != null && outcome.costPerSuccessUsd > 0
    ? outcome.costPerSuccessUsd
    : candidate.costPerSuccessUsd != null && candidate.costPerSuccessUsd > 0
      ? candidate.costPerSuccessUsd
      : UNKNOWN_COST_PRIOR_USD;
  const costKnown = Boolean(
    (outcome?.costPerSuccessUsd != null && outcome.costPerSuccessUsd > 0)
      || (candidate.costPerSuccessUsd != null && candidate.costPerSuccessUsd > 0),
  );
  const reliability = outcome && outcome.attempts > 0
    ? clamp(outcome.firstTrySuccessRate ?? (outcome.successes == null ? 0.5 : outcome.successes / outcome.attempts), 0.5)
    : 0.5;
  const rankScore = request.optimize === 'quality'
    ? quality * 0.70 + reliability * 0.20 + speed * 0.10
    : request.optimize === 'speed'
      ? speed * 0.70 + quality * 0.20 + reliability * 0.10
      : (1 / (1 + measuredCost)) * 0.65 + quality * 0.20 + reliability * 0.15;
  const provenance = [
    outcome ? 'measured outcome history' : 'cold-start task-class prior',
    costKnown ? 'measured/provider cost' : `unknown cost uses positive $${UNKNOWN_COST_PRIOR_USD.toFixed(2)} prior`,
    'provider catalog selection fields',
  ];
  const reasons = [
    `${request.optimize} objective score ${rankScore.toFixed(3)}`,
    `${request.taskClass} quality estimate ${quality.toFixed(3)}`,
  ];
  if (outcome) reasons.push(`${outcome.attempts} measured attempt(s)`);
  if (!costKnown) reasons.push('cost is unknown; it is not treated as free');
  const effort = selectedEffort(candidate, request.selection?.effort);
  return {
    candidateKey: relayCandidateKey(candidate),
    selected: {
      provider: candidate.provider,
      model: candidate.catalog.value,
      resolvedModel: candidate.catalog.resolvedModel ?? null,
      effort,
    },
    rankScore,
    estimatedCostUsd: measuredCost,
    costKnown,
    reasons,
    provenance,
  };
}

/**
 * Build an ordered, explainable route from an already-filtered candidate
 * catalog. A requested provider/model/effort is an assertion, never a hint:
 * invalid selections throw instead of silently falling back.
 */
export function buildRelayRoutingPlan(request: RelayRoutingRequest): RelayRoutingPlan {
  if (request.candidates.length === 0) {
    throw new RelayRoutingPolicyError('NO_ELIGIBLE_CANDIDATE', 'No allowed relay models were supplied.');
  }
  const selection = request.selection;
  const selectionRequested = Boolean(selection?.provider || selection?.model || selection?.effort);
  const matching = request.candidates.filter((candidate) => !selection || selectionMatches(candidate, selection));
  if (selectionRequested && matching.length === 0) {
    throw new RelayRoutingPolicyError(
      'INVALID_SELECTION',
      `Requested relay selection ${JSON.stringify(selection)} is not in the supplied allowed catalog.`,
      ['selection is validated against supplied provider/model catalog rows only'],
    );
  }
  const rejected: RelayCandidateRejection[] = [];
  const eligible: RelayRoutingProfile[] = [];
  for (const candidate of request.candidates) {
    const readiness = rejectReasons(candidate, request);
    if (readiness.reasons.length > 0) {
      rejected.push({ candidateKey: relayCandidateKey(candidate), ...readiness });
      continue;
    }
    eligible.push(rankCandidate(candidate, request));
  }
  if (eligible.length === 0) {
    throw new RelayRoutingPolicyError(
      selectionRequested ? 'INVALID_SELECTION' : 'NO_ELIGIBLE_CANDIDATE',
      selectionRequested
        ? 'The explicitly selected relay candidate is not runnable with the requested mode/seats/runtime.'
        : 'No supplied relay candidate satisfies runtime and seat requirements.',
      rejected.flatMap((entry) => entry.reasons),
    );
  }
  if (selectionRequested) {
    const explicitSelection = selection!;
    const requested = eligible.find((profile) => profile.selected.provider === explicitSelection.provider
      && (explicitSelection.model === undefined
        || profile.selected.model === explicitSelection.model
        || profile.selected.resolvedModel === explicitSelection.model));
    if (!requested) {
      throw new RelayRoutingPolicyError(
        'INVALID_SELECTION',
        'The explicitly selected relay candidate is not runnable with the requested mode/seats/runtime.',
        rejected.flatMap((entry) => entry.reasons),
      );
    }
    return {
      profiles: [requested],
      selected: requested,
      rejected,
      reasons: ['explicit selection validated; automatic fallback is disabled for selection errors'],
      provenance: ['caller-supplied allowed catalog', 'caller-supplied runtime and seat readiness'],
    };
  }
  const attempted = new Set(request.attemptedCandidates ?? []);
  const profiles = eligible
    .filter((profile) => !attempted.has(profile.candidateKey))
    .sort((left, right) => right.rankScore - left.rankScore || left.candidateKey.localeCompare(right.candidateKey));
  if (profiles.length === 0) {
    throw new RelayRoutingPolicyError('NO_ELIGIBLE_CANDIDATE', 'All eligible relay candidates were already attempted.', [
      'attempted candidates are excluded to prevent retry loops',
    ]);
  }
  return {
    profiles,
    selected: profiles[0]!,
    rejected,
    reasons: [`ordered ${profiles.length} candidate profile(s) for ${request.optimize}`],
    provenance: ['caller-supplied allowed catalog', 'caller-supplied runtime and seat readiness', 'pure policy ranking'],
  };
}

export const routeRelayTask = buildRelayRoutingPlan;

function errorText(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error instanceof Error) return `${error.name} ${error.message}`;
  if (error && typeof error === 'object') {
    const record = error as Record<string, unknown>;
    return [record.code, record.status, record.message, record.error, record.reason]
      .filter((value): value is string | number => typeof value === 'string' || typeof value === 'number')
      .join(' ');
  }
  return String(error ?? 'unknown relay failure');
}

/** Normalize provider/runtime failures without deciding whether replay is safe. */
export function classifyRelayFailure(error: unknown): RelayFailureClassification {
  const text = errorText(error).toLowerCase();
  let kind: RelayFailureClass = 'task_failure';
  if (/(quota|credit|billing|insufficient[_ -]?balance|budget)/.test(text)) kind = 'quota';
  else if (/(rate[_ -]?limit|too many requests|throttl|http\s*429)/.test(text)) kind = 'rate_limit';
  else if (/(unauthori[sz]|authentication|invalid[_ -]?(token|api[_ -]?key)|expired[_ -]?token|http\s*401)/.test(text)) kind = 'auth';
  else if (/(permission denied|forbidden|access denied|not allowed|http\s*403|eacces)/.test(text)) kind = 'permission';
  else if (/(spawn|enoent|executable|process launch)/.test(text)) kind = 'spawn';
  else if (/(timeout|timed out|deadline exceeded|etimedout)/.test(text)) kind = 'timeout';
  return {
    kind,
    reason: `classified relay failure as ${kind}`,
    provenance: [`failure text/code classification: ${kind}`],
  };
}

export function decideRelayFallback(context: RelayFallbackContext): RelayFallbackDecision {
  const kind = typeof context.failure === 'string' ? context.failure : context.failure.kind;
  const sideEffects = context.sideEffects
    ?? (context.sideEffectsStarted === undefined ? 'unknown' : context.sideEffectsStarted ? 'started' : 'none');
  const maxFallbacks = context.maxFallbacks ?? DEFAULT_MAX_FALLBACKS;
  if (context.fallbackCount != null && context.fallbackCount >= maxFallbacks) {
    return { allowed: false, action: 'stop', reason: 'bounded fallback limit reached', provenance: ['fallback budget'] };
  }
  if (context.mode === 'isolated_write' && sideEffects === 'unknown') {
    return {
      allowed: false,
      action: 'require_explicit_recovery',
      reason: 'isolated write side effects are ambiguous; automatic replay is unsafe',
      provenance: ['isolated_write safety boundary', 'side-effect state unknown'],
    };
  }
  if (context.mode === 'isolated_write' && sideEffects === 'started') {
    return {
      allowed: false,
      action: 'require_explicit_recovery',
      reason: 'isolated write already started side effects; recovery must be explicit',
      provenance: ['isolated_write safety boundary', 'side effects started'],
    };
  }
  if (context.mode === 'read_only' && context.usableOutput === true) {
    return {
      allowed: false,
      action: 'stop',
      reason: `read-only ${kind} produced usable output`,
      provenance: ['usable output prevents unnecessary replay'],
    };
  }
  const attempted = new Set(context.attemptedCandidates);
  return {
    allowed: true,
    action: 'retry_next_candidate',
    reason: `bounded fallback allowed after ${kind}; ${attempted.size} candidate(s) already attempted`,
    provenance: ['no write side effects', 'attempted candidates tracked to prevent loops'],
  };
}

/** Select the next unattempted profile after applying the safety/budget policy. */
export function nextRelayProfile(
  plan: RelayRoutingPlan,
  context: RelayFallbackContext,
): { profile: RelayRoutingProfile | null; decision: RelayFallbackDecision } {
  const decision = decideRelayFallback(context);
  if (!decision.allowed) return { profile: null, decision };
  const attempted = new Set(context.attemptedCandidates);
  const profile = plan.profiles.find((candidate) => !attempted.has(candidate.candidateKey)) ?? null;
  if (!profile) {
    return {
      profile: null,
      decision: {
        allowed: false,
        action: 'stop',
        reason: 'no unattempted candidate remains',
        provenance: [...decision.provenance, 'candidate attempt ledger'],
      },
    };
  }
  return { profile, decision };
}
