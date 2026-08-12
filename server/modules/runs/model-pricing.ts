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
 * Rates are effective-dated, not a single current number
 * ------------------------------------------------------
 * Providers change prices without changing the model id (Sonnet 5's own
 * intro→standard step is a real example below). A run must always be priced
 * at the rate that was in effect when it actually happened, not whatever the
 * table says today — otherwise, backfilling an old session (or the nightly
 * cost sweep touching a run that predates this feature) after a price change
 * would silently misprice it at the wrong-era rate. Every model therefore
 * maps to a chronological list of `PricedWindow`s rather than one flat rate.
 * Once a run's `cost_usd_estimate` is written, nothing here ever recomputes
 * it — `backfillMissingCosts` only ever touches NULL costs — so a rate
 * correction below never retroactively rewrites an already-priced run
 * either; only genuinely un-costed rows pick up (correctly time-matched)
 * pricing going forward.
 *
 * Keeping this current
 * ---------------------
 * Prices change. To refresh:
 * 1. Check each vendor's own pricing page (Anthropic, OpenAI, xAI, Moonshot).
 * 2. On a genuine rate change for an existing model: close the current
 *    window with `effectiveTo` (the date the new rate starts) and append a
 *    new window starting there. Do not just edit the numbers in place — that
 *    would misprice every run from before the change on the next backfill.
 * 3. Bump `PRICING_LAST_VERIFIED`.
 */

/** Update this whenever any entry below changes. */
export const PRICING_LAST_VERIFIED = '2026-08-12';

export type ModelPriceRate = {
  /** USD per 1,000,000 input tokens. */
  inputPerMillion: number;
  /** USD per 1,000,000 output tokens. */
  outputPerMillion: number;
};

/**
 * One effective-dated rate. `effectiveFrom`/`effectiveTo` are ISO date (or
 * datetime) strings compared lexicographically against the run's own
 * timestamp — `effectiveFrom` is inclusive, `effectiveTo` is exclusive.
 * Omit `effectiveFrom` when the true launch date is unknown (treated as
 * "since the beginning of time"); omit `effectiveTo` while the rate is still
 * current.
 */
type PricedWindow = ModelPriceRate & {
  effectiveFrom?: string;
  effectiveTo?: string;
};

type ProviderPricingTable = Record<string, PricedWindow[]>;

/**
 * Keys are normalized model ids (see `normalizeModelKey`): lowercased, with
 * a trailing `[Nm]` context-window suffix stripped (context length does not
 * change the per-token rate for any provider verified here).
 */
const PRICING: Record<string, ProviderPricingTable> = {
  claude: {
    'claude-sonnet-5': [
      // Introductory rate through 2026-08-31; standard $3/$15 begins 2026-09-01.
      { effectiveTo: '2026-09-01', inputPerMillion: 2.0, outputPerMillion: 10.0 },
      { effectiveFrom: '2026-09-01', inputPerMillion: 3.0, outputPerMillion: 15.0 },
    ],
    'claude-opus-5': [{ inputPerMillion: 5.0, outputPerMillion: 25.0 }],
    'claude-fable-5': [{ inputPerMillion: 10.0, outputPerMillion: 50.0 }],
    'claude-haiku-4-5': [{ inputPerMillion: 1.0, outputPerMillion: 5.0 }],
    'claude-haiku-4-5-20251001': [{ inputPerMillion: 1.0, outputPerMillion: 5.0 }],
    // Prior generation, still seen on older runs.
    'claude-opus-4-8': [{ inputPerMillion: 5.0, outputPerMillion: 25.0 }],
    'claude-opus-4-7': [{ inputPerMillion: 5.0, outputPerMillion: 25.0 }],
    'claude-opus-4-6': [{ inputPerMillion: 5.0, outputPerMillion: 25.0 }],
    'claude-sonnet-4-6': [{ inputPerMillion: 3.0, outputPerMillion: 15.0 }],
    'claude-opus-4-1': [{ inputPerMillion: 15.0, outputPerMillion: 75.0 }],
    'claude-haiku-3': [{ inputPerMillion: 0.25, outputPerMillion: 1.25 }],
  },
  codex: {
    'gpt-5.6-sol': [{ inputPerMillion: 5.0, outputPerMillion: 30.0 }],
    'gpt-5.6-terra': [{ inputPerMillion: 2.0, outputPerMillion: 12.0 }],
    'gpt-5.6-luna': [{ inputPerMillion: 0.2, outputPerMillion: 1.2 }],
    'gpt-5.5': [{ inputPerMillion: 5.0, outputPerMillion: 30.0 }],
    'gpt-5.4': [{ inputPerMillion: 2.5, outputPerMillion: 15.0 }],
  },
  grok: {
    'grok-4.5': [{ inputPerMillion: 2.0, outputPerMillion: 6.0 }],
    'grok-4.3': [{ inputPerMillion: 1.25, outputPerMillion: 2.5 }],
    'grok-4.1-fast': [{ inputPerMillion: 0.2, outputPerMillion: 0.5 }],
  },
  kimi: {
    'kimi-code/k3': [{ inputPerMillion: 3.0, outputPerMillion: 15.0 }],
    'kimi-code/k3-256k': [{ inputPerMillion: 3.0, outputPerMillion: 15.0 }],
    k3: [{ inputPerMillion: 3.0, outputPerMillion: 15.0 }],
    'kimi-k2.7-code': [{ inputPerMillion: 0.95, outputPerMillion: 4.0 }],
    'kimi-k2.6': [{ inputPerMillion: 0.95, outputPerMillion: 4.0 }],
    'kimi-k2.5': [{ inputPerMillion: 0.6, outputPerMillion: 3.0 }],
    // "Kimi Code" for-coding tier (K2.5-based, 256K context) — API pricing
    // separate from the membership plan cost.
    'kimi-code/kimi-for-coding': [{ inputPerMillion: 0.6, outputPerMillion: 2.5 }],
    'kimi-for-coding': [{ inputPerMillion: 0.6, outputPerMillion: 2.5 }],
    // No verified rate found for the "highspeed" for-coding variant — leave
    // unpriced (returns null) rather than guessing; add once published.
  },
  // Models routed through OpenCode's own harness (glm/deepseek/grok/kimi
  // aliases as OpenCode reports them) — only used as a live-path estimate;
  // the historical backfill prefers OpenCode's own real `session.cost`.
  opencode: {
    'glm-5.2': [{ inputPerMillion: 1.4, outputPerMillion: 4.4 }],
    'deepseek-v4-pro': [{ inputPerMillion: 0.435, outputPerMillion: 0.87 }],
    'deepseek-v4-flash': [{ inputPerMillion: 0.14, outputPerMillion: 0.28 }],
    'grok-4.5': [{ inputPerMillion: 2.0, outputPerMillion: 6.0 }],
    'kimi-k3': [{ inputPerMillion: 3.0, outputPerMillion: 15.0 }],
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

function nowIsoDate(): string {
  return new Date().toISOString();
}

/** Pick the window whose [effectiveFrom, effectiveTo) span contains `atIso`. */
function pickWindow(windows: PricedWindow[], atIso: string): ModelPriceRate | null {
  const matching = windows.filter(
    (w) => (!w.effectiveFrom || w.effectiveFrom <= atIso) && (!w.effectiveTo || atIso < w.effectiveTo),
  );
  if (matching.length === 0) return null;
  // Defensive: if windows ever overlap, the most recently-started one wins.
  matching.sort((a, b) => (b.effectiveFrom ?? '').localeCompare(a.effectiveFrom ?? ''));
  const { inputPerMillion, outputPerMillion } = matching[0];
  return { inputPerMillion, outputPerMillion };
}

/**
 * Look up the $/M rate for a provider/model pair as of a point in time.
 * `atIso` should be the run's own timestamp for historical pricing — omit
 * it only for a genuinely current-moment lookup (defaults to now). Returns
 * null when the model has no pricing entry, or no window covers `atIso`.
 */
export function resolveModelPriceRate(
  provider: string | null | undefined,
  model: string | null | undefined,
  atIso: string = nowIsoDate(),
): ModelPriceRate | null {
  if (!provider || !model) return null;
  if (isFreeTierModel(model)) return { inputPerMillion: 0, outputPerMillion: 0 };
  const table = PRICING[provider.toLowerCase()];
  if (!table) return null;
  const windows = table[normalizeModelKey(model)];
  if (!windows) return null;
  return pickWindow(windows, atIso);
}

/**
 * Estimate USD spend for a token count at a provider/model's rate as of
 * `atIso` (the run's own timestamp — pass this for historical backfills;
 * omit only for a current-moment live estimate). Returns null (never a
 * guessed number) when the model has no pricing entry for that date.
 */
export function estimateCostUsd(
  provider: string | null | undefined,
  model: string | null | undefined,
  inputTokens: number | null | undefined,
  outputTokens: number | null | undefined,
  atIso?: string,
): number | null {
  const rate = atIso
    ? resolveModelPriceRate(provider, model, atIso)
    : resolveModelPriceRate(provider, model);
  if (!rate) return null;
  const input = Math.max(0, inputTokens ?? 0);
  const output = Math.max(0, outputTokens ?? 0);
  return (input / 1_000_000) * rate.inputPerMillion + (output / 1_000_000) * rate.outputPerMillion;
}
