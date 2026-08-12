/**
 * Best-effort $/token pricing lookup for cost estimation (agent_runs.cost_usd_estimate).
 *
 * This is an ESTIMATE, not a billing record: a run's exact spend also depends
 * on cache-read/write splits and batch-API discounts that agent_runs does not
 * store separately from plain input/output totals. Treat `cost_usd_estimate`
 * as "roughly what this cost," not an invoice line.
 *
 * OpenCode is a deliberate exception: OpenCode already computes and stores a
 * real cost per session in its own sqlite `session.cost` column (it knows
 * the exact provider/model rate it billed), so the backfill reads that
 * directly instead of estimating from this table — see
 * `runs-token-backfill.ts` `readOpenCodeHistoricalUsage`.
 *
 * Keeping this current
 * ---------------------
 * Prices change. To refresh:
 * 1. Check each vendor's own pricing page (Anthropic, OpenAI, xAI, Moonshot).
 * 2. Update the affected entries below and bump `PRICING_LAST_VERIFIED`.
 * 3. Add a one-line comment on any entry whose price is time-limited (e.g. an
 *    introductory rate with a known end date) so it doesn't silently go stale.
 */

/** Update this whenever any entry below changes. */
export const PRICING_LAST_VERIFIED = '2026-08-12';

export type ModelPriceRate = {
  /** USD per 1,000,000 input tokens. */
  inputPerMillion: number;
  /** USD per 1,000,000 output tokens. */
  outputPerMillion: number;
};

type ProviderPricingTable = Record<string, ModelPriceRate>;

/**
 * Keys are normalized model ids (see `normalizeModelKey`): lowercased, with
 * a trailing `[Nm]` context-window suffix stripped (context length does not
 * change the per-token rate for any provider verified here).
 */
const PRICING: Record<string, ProviderPricingTable> = {
  claude: {
    // Sonnet 5 intro pricing runs through 2026-08-31; standard $3/$15 starts
    // 2026-09-01 — update this entry on/after that date.
    'claude-sonnet-5': { inputPerMillion: 2.0, outputPerMillion: 10.0 },
    'claude-opus-5': { inputPerMillion: 5.0, outputPerMillion: 25.0 },
    'claude-fable-5': { inputPerMillion: 10.0, outputPerMillion: 50.0 },
    'claude-haiku-4-5': { inputPerMillion: 1.0, outputPerMillion: 5.0 },
    'claude-haiku-4-5-20251001': { inputPerMillion: 1.0, outputPerMillion: 5.0 },
    // Prior generation, still seen on older runs.
    'claude-opus-4-8': { inputPerMillion: 5.0, outputPerMillion: 25.0 },
    'claude-opus-4-7': { inputPerMillion: 5.0, outputPerMillion: 25.0 },
    'claude-opus-4-6': { inputPerMillion: 5.0, outputPerMillion: 25.0 },
    'claude-sonnet-4-6': { inputPerMillion: 3.0, outputPerMillion: 15.0 },
    'claude-opus-4-1': { inputPerMillion: 15.0, outputPerMillion: 75.0 },
    'claude-haiku-3': { inputPerMillion: 0.25, outputPerMillion: 1.25 },
  },
  codex: {
    'gpt-5.6-sol': { inputPerMillion: 5.0, outputPerMillion: 30.0 },
    'gpt-5.6-terra': { inputPerMillion: 2.0, outputPerMillion: 12.0 },
    'gpt-5.6-luna': { inputPerMillion: 0.2, outputPerMillion: 1.2 },
    'gpt-5.5': { inputPerMillion: 5.0, outputPerMillion: 30.0 },
    'gpt-5.4': { inputPerMillion: 2.5, outputPerMillion: 15.0 },
  },
  grok: {
    'grok-4.5': { inputPerMillion: 2.0, outputPerMillion: 6.0 },
    'grok-4.3': { inputPerMillion: 1.25, outputPerMillion: 2.5 },
    'grok-4.1-fast': { inputPerMillion: 0.2, outputPerMillion: 0.5 },
  },
  kimi: {
    // K3 has no separately published rate yet — priced at the closest
    // published tier (K2.6) as a placeholder; replace once Moonshot
    // publishes K3's own rate.
    'kimi-code/k3': { inputPerMillion: 0.95, outputPerMillion: 4.0 },
    k3: { inputPerMillion: 0.95, outputPerMillion: 4.0 },
    'kimi-k2.7-code': { inputPerMillion: 0.95, outputPerMillion: 4.0 },
    'kimi-k2.6': { inputPerMillion: 0.95, outputPerMillion: 4.0 },
    'kimi-k2.5': { inputPerMillion: 0.6, outputPerMillion: 3.0 },
  },
  // Models routed through OpenCode's own harness (glm/deepseek/grok/kimi
  // aliases as OpenCode reports them) — only used as a live-path estimate;
  // the historical backfill prefers OpenCode's own real `session.cost`.
  opencode: {
    'glm-5.2': { inputPerMillion: 1.4, outputPerMillion: 4.4 },
    'deepseek-v4-pro': { inputPerMillion: 0.435, outputPerMillion: 0.87 },
    'deepseek-v4-flash': { inputPerMillion: 0.14, outputPerMillion: 0.28 },
    'grok-4.5': { inputPerMillion: 2.0, outputPerMillion: 6.0 },
    'kimi-k3': { inputPerMillion: 0.95, outputPerMillion: 4.0 },
  },
};

/**
 * Lowercase, strip a trailing context-window suffix ('[1m]', '[200k]', ...),
 * and drop a '-free' tag (handled separately as a zero-cost tier) so
 * 'claude-opus-5[1m]' and 'deepseek-v4-flash-free' key the same as their
 * base model.
 */
function normalizeModelKey(model: string): string {
  return model
    .trim()
    .toLowerCase()
    .replace(/\[[^\]]*\]$/, '')
    .replace(/-free$/, '');
}

/** True when the model id itself declares a free tier (e.g. '...-flash-free'). */
function isFreeTierModel(model: string): boolean {
  return /-free$/i.test(model.trim());
}

/** Look up the $/M rate for a provider/model pair; null when not in the table. */
export function resolveModelPriceRate(
  provider: string | null | undefined,
  model: string | null | undefined,
): ModelPriceRate | null {
  if (!provider || !model) return null;
  if (isFreeTierModel(model)) return { inputPerMillion: 0, outputPerMillion: 0 };
  const table = PRICING[provider.toLowerCase()];
  if (!table) return null;
  return table[normalizeModelKey(model)] ?? null;
}

/**
 * Estimate USD spend for a token count at a provider/model's rate. Returns
 * null (never a guessed number) when the model has no pricing entry.
 */
export function estimateCostUsd(
  provider: string | null | undefined,
  model: string | null | undefined,
  inputTokens: number | null | undefined,
  outputTokens: number | null | undefined,
): number | null {
  const rate = resolveModelPriceRate(provider, model);
  if (!rate) return null;
  const input = Math.max(0, inputTokens ?? 0);
  const output = Math.max(0, outputTokens ?? 0);
  return (input / 1_000_000) * rate.inputPerMillion + (output / 1_000_000) * rate.outputPerMillion;
}
