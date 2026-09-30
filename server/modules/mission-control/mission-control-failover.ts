/**
 * Failure classification for bot runtime v2 provider failover.
 *
 * A run may move to the next `routing.fallback` provider only when the *provider* failed: its
 * login is dead, it hit a rate/usage limit, or it is unreachable. A normal task failure (the model
 * answered badly, a tool errored, a parse failed) and a gate denial never fail over: retrying
 * those on another model would repeat the same mistake or sidestep the operator's decision.
 */
import { detectProviderLimit } from '@/modules/continuity/index.js';
import { resolveProviderAuthFailure } from '@/shared/provider-auth-failure.js';
import type { NormalizedMessage } from '@/shared/types.js';

export type FailoverReason = 'auth' | 'limit' | 'unavailable';

export interface FailoverClassification {
  reason: FailoverReason;
  detail: string;
}

/** Text the gateway returns when the gate (or the operator) stopped a call. */
const GATE_DENIAL_PATTERNS: readonly RegExp[] = [
  /blocked by the action gate/i,
  /the operator rejected this call/i,
  /no operator decision before the approval expired/i,
  /action gate failed, call refused/i,
  /approval failed, call refused/i,
];

/** `detectProviderLimit` matches the bare word "limit"; real provider limits also say one of these. */
const STRICT_LIMIT_PATTERN =
  /rate[\s_-]?limit|usage[\s_-]?limit|quota|too many requests|\b429\b|limit\s+(?:reached|exceeded)|hit\s+(?:your|the)\s+limit|resource[\s_-]?exhausted|out of (?:credits|usage)|credit balance/i;

/** Phrasings the shared detector does not know (OpenAI-style quota errors). */
const EXTRA_LIMIT_PATTERN = /exceeded your (?:current )?(?:quota|usage|rate limit)/i;

const UNAVAILABLE_PATTERNS: readonly RegExp[] = [
  /\b(?:ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH)\b/,
  /\bspawn\s+\S+\s+ENOENT\b/i,
  /command not found/i,
  /overloaded(?:_error)?/i,
  /service\s+(?:is\s+)?(?:temporarily\s+)?unavailable/i,
  /temporarily\s+unavailable/i,
  /\b(?:502|503|504|529)\b[^\n]{0,40}(?:bad gateway|unavailable|timeout|timed out|overloaded|error)/i,
  /(?:bad gateway|gateway time-?out)/i,
  /fetch failed/i,
  /(?:could not|couldn't|unable to|failed to)\s+(?:connect|reach)/i,
  /network\s+(?:error|is unreachable)/i,
  /api\s+(?:is\s+)?unreachable/i,
  /runtime is not available/i,
];

const MAX_SCAN = 6_000;

function scan(...parts: Array<string | null | undefined>): string {
  return parts
    .filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
    .map((part) => part.slice(0, MAX_SCAN))
    .join('\n');
}

export function isGateDenialText(...parts: Array<string | null | undefined>): boolean {
  const text = scan(...parts);
  return GATE_DENIAL_PATTERNS.some((pattern) => pattern.test(text));
}

function detail(text: string, pattern?: RegExp): string {
  const line = text.split('\n').map((entry) => entry.trim()).find((entry) => entry && (!pattern || pattern.test(entry)));
  return (line ?? text.trim()).slice(0, 300);
}

/**
 * Classify a failed run's provider error text. Returns null for normal task failures and for
 * anything that mentions a gate denial.
 */
export function classifyFailoverFailure(
  provider: string,
  errorMessage: string | null | undefined,
  text: string | null | undefined,
): FailoverClassification | null {
  if (isGateDenialText(errorMessage, text)) return null;

  const auth = resolveProviderAuthFailure(provider, errorMessage, text);
  if (auth) return { reason: 'auth', detail: auth.slice(0, 300) };

  const combined = scan(errorMessage, text);
  if (!combined) return null;

  const limit = detectProviderLimit({ kind: 'error', content: combined } as unknown as NormalizedMessage);
  if (limit && STRICT_LIMIT_PATTERN.test(limit.rawText)) {
    return { reason: 'limit', detail: detail(limit.rawText, STRICT_LIMIT_PATTERN) };
  }

  if (EXTRA_LIMIT_PATTERN.test(combined)) return { reason: 'limit', detail: detail(combined, EXTRA_LIMIT_PATTERN) };

  const unavailable = UNAVAILABLE_PATTERNS.find((pattern) => pattern.test(combined));
  if (unavailable) return { reason: 'unavailable', detail: detail(combined, unavailable) };
  return null;
}

/** Classify an error thrown while starting a run (spawn failure, missing runtime). */
export function classifyFailoverError(provider: string, error: unknown): FailoverClassification | null {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === 'MC_RUN_IN_PROGRESS') return null;
  const message = error instanceof Error ? error.message : String(error);
  if (code === 'MC_RUNTIME_UNAVAILABLE') return { reason: 'unavailable', detail: message.slice(0, 300) };
  return classifyFailoverFailure(provider, message, null);
}
