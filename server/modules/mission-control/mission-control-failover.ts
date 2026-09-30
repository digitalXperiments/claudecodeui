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
 * Classify a failed run's provider error. Returns null for normal task failures and for anything
 * that mentions a gate denial. Only `errorMessage` (what the provider/runtime reported) is read:
 * the model's own output text is attacker-influenced, and a prompt-injected "429 rate limit" in it
 * must not be able to steer a run onto another provider. `_outputText` is accepted for call-site
 * compatibility and deliberately ignored.
 */
export function classifyFailoverFailure(
  provider: string,
  errorMessage: string | null | undefined,
  _outputText?: string | null,
): FailoverClassification | null {
  if (isGateDenialText(errorMessage)) return null;

  const auth = resolveProviderAuthFailure(provider, errorMessage, null);
  if (auth) return { reason: 'auth', detail: auth.slice(0, 300) };

  const combined = scan(errorMessage);
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

// ---------------------------------------------------------------------------
// Side-effect detection: a failed run that may already have acted must not be retried elsewhere.
// ---------------------------------------------------------------------------

/** Claude built-in tools that only read or keep local bookkeeping; every other native tool counts as acting. */
const READ_ONLY_NATIVE_TOOLS: ReadonlySet<string> = new Set([
  'Read',
  'Glob',
  'Grep',
  'LS',
  'NotebookRead',
  'TodoWrite',
  'ToolSearch',
  'ExitPlanMode',
]);

/** First-party gateway tools that never change anything. */
const READ_ONLY_FIRST_PARTY_TOOLS: ReadonlySet<string> = new Set(['bot__space_read', 'bot__search_memory']);

const FIRST_PARTY_TOOL = /(?:^|__)(bot__[a-z0-9_]+)$/i;

export type ToolSideEffect = 'none' | 'acted' | 'covered-by-gate';

/**
 * Classify one recorded tool call by its name. `covered-by-gate` is an MCP call routed through the
 * tool gateway: the Action Gate recorded a decision (with its risk) for it, so the decision rows
 * answer the question, not the name.
 */
export function classifyToolCallName(toolName: unknown): ToolSideEffect {
  if (typeof toolName !== 'string' || !toolName.trim()) return 'acted'; // unknown: assume it acted
  const name = toolName.trim();
  const firstParty = FIRST_PARTY_TOOL.exec(name);
  if (firstParty) return READ_ONLY_FIRST_PARTY_TOOLS.has(firstParty[1].toLowerCase()) ? 'none' : 'acted';
  if (name.startsWith('mcp__')) return 'covered-by-gate';
  return READ_ONLY_NATIVE_TOOLS.has(name) ? 'none' : 'acted';
}

export interface RunSideEffectEvidence {
  provider: string;
  /** Gate decisions recorded for the run (first-party, upstream MCP and built-in). */
  decisions: Array<{ decision: string; outcome: string | null; risk: string }>;
  /** Tool names from the run's `tool.call` events. */
  toolNames: unknown[];
}

const NOT_EXECUTED_OUTCOMES: ReadonlySet<string> = new Set(['denied', 'rejected', 'expired']);

/**
 * True when the failed run may already have changed something, so failing over could do it twice.
 *  - any non-read gate decision that was allowed/approved (outcome executed/approved/error, or an
 *    allow whose outcome was never recorded because the run died mid-call);
 *  - Claude: a native tool call other than the read-only ones, or a first-party bot__ tool that is
 *    not a pure read (bot__handoff, bot__ask_bot, bot__commit, bot__space_write ... record no gate row);
 *  - any other provider: the built-in tools are ungated there, so any tool use at all counts.
 */
export function runShowsSideEffects(evidence: RunSideEffectEvidence): boolean {
  for (const decision of evidence.decisions) {
    if (decision.risk === 'read') continue;
    const outcome = decision.outcome ?? '';
    if (NOT_EXECUTED_OUTCOMES.has(outcome)) continue;
    if (decision.decision === 'deny') continue;
    if (decision.decision === 'allow' || outcome === 'executed' || outcome === 'approved' || outcome === 'error') return true;
  }
  if (evidence.provider !== 'claude') return evidence.toolNames.length > 0;
  return evidence.toolNames.some((name) => classifyToolCallName(name) === 'acted');
}
