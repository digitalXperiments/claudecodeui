/**
 * Provider token-usage normalization for the canonical run spine.
 *
 * Every provider adapter already publishes usage on the normalized message
 * stream as `{ kind: 'status', text: 'token_budget', tokenBudget }`. This
 * module turns one of those snapshots into the `token_input` / `token_output`
 * numbers the run spine (and therefore the Stats dashboard) stores, without
 * touching the DB — so it stays unit-testable on its own.
 *
 * Two things make this less trivial than reading a pair of fields:
 *
 * 1. Which fields mean "spend". `billedInputTokens` / `billedOutputTokens` are
 *    the documented session-spend pair (sum of turns) and are what we want.
 *    OpenCode's reader does not emit them, so we fall back to the generic
 *    `inputTokens` / `outputTokens` pair, which for that provider is already a
 *    cumulative session total read out of OpenCode's own sqlite store.
 *    We deliberately ignore `used` / `contextUsed` / `total`: those describe
 *    *context-window occupancy* for the composer badge, not tokens spent.
 *
 * 2. Whether a snapshot is cumulative or a per-turn delta. Claude's live SDK
 *    stream emits one `token_budget` per assistant message carrying that
 *    message's usage only (see buildClaudeTokenBudgetFromUsage in
 *    server/modules/providers/list/claude/claude-token-usage.ts, whose spend
 *    fields are explicitly "the current turn"), so its snapshots must be
 *    summed. Codex reports `tokenUsage.total`, and kimi/grok/opencode read the
 *    session store after the turn, so those snapshots are already
 *    session-to-date and must supersede rather than add.
 *
 * Anything unrecognised defaults to 'cumulative': taking the max of what we
 * have and what was reported can never inflate a total, whereas defaulting to
 * summing would double-count on every repeated snapshot.
 */

import type { TokenUsage } from '@/modules/runs/runs.types.js';

/** How successive `token_budget` snapshots from one provider combine. */
export type UsageAccumulationMode = 'cumulative' | 'delta';

/**
 * Providers whose `token_budget` payload carries a single turn rather than a
 * session-to-date total. Everything else is treated as cumulative.
 */
const DELTA_USAGE_PROVIDERS = new Set<string>(['claude']);

/** Usage read off a single provider snapshot, before accumulation. */
export type ProviderUsageSnapshot = {
  input: number;
  output: number;
  /** Concrete resolved model, when the disk record carries one (e.g. Claude's session JSONL). */
  model?: string | null;
};

export function usageAccumulationMode(
  provider: string | null | undefined,
): UsageAccumulationMode {
  return provider && DELTA_USAGE_PROVIDERS.has(provider) ? 'delta' : 'cumulative';
}

function readCount(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.round(parsed);
}

/**
 * Pull the spend pair out of a `token_budget` payload.
 * Returns null when the payload carries no usable numbers.
 */
export function readTokenBudgetUsage(tokenBudget: unknown): ProviderUsageSnapshot | null {
  if (!tokenBudget || typeof tokenBudget !== 'object' || Array.isArray(tokenBudget)) {
    return null;
  }
  const budget = tokenBudget as Record<string, unknown>;
  // Prefer the explicit billed/spend pair; fall back to the generic pair for
  // providers (opencode) that only expose that one.
  const input = readCount(budget.billedInputTokens) ?? readCount(budget.inputTokens);
  const output = readCount(budget.billedOutputTokens) ?? readCount(budget.outputTokens);
  if (input == null && output == null) return null;
  return { input: input ?? 0, output: output ?? 0 };
}

/**
 * Combine a snapshot with what the run row already holds.
 *
 * Returns null when the result would not change the stored row, so callers can
 * skip a redundant write on the many no-op snapshots a chatty provider sends.
 */
export function mergeRunUsage(
  current: { token_input: number | null; token_output: number | null },
  snapshot: ProviderUsageSnapshot,
  mode: UsageAccumulationMode,
): TokenUsage | null {
  const currentInput = current.token_input ?? 0;
  const currentOutput = current.token_output ?? 0;
  const input =
    mode === 'delta' ? currentInput + snapshot.input : Math.max(currentInput, snapshot.input);
  const output =
    mode === 'delta' ? currentOutput + snapshot.output : Math.max(currentOutput, snapshot.output);

  const unchanged =
    input === current.token_input &&
    output === current.token_output &&
    current.token_input != null &&
    current.token_output != null;
  if (unchanged) return null;

  return { input, output, total: input + output };
}
