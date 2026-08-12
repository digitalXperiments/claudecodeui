/**
 * Best-effort $/token pricing lookup for cost estimation (agent_runs.cost_usd_estimate).
 *
 * This is an ESTIMATE, not a billing record: batch-API discounts and a few
 * unverified cache rates (noted inline below) are not modeled. Treat
 * `cost_usd_estimate` as "roughly what this cost," not an invoice line.
 *
 * OpenCode is a deliberate exception: OpenCode already computes and stores a
 * real cost per session in its own sqlite `session.cost` column (it knows
 * the exact provider/model rate it billed), so the backfill reads that
 * directly instead of estimating from this table — see
 * `runs-token-backfill.ts` `readOpenCodeHistoricalUsage`.
 *
 * Cache reads are cheap; cache WRITES are not
 * --------------------------------------------
 * A cache hit (re-reading a previously-cached prompt prefix) is billed far
 * below the base input rate — but priming that cache (a cache write/creation)
 * is billed ABOVE the base input rate, not below. Folding both into one
 * "cache is cheap" number would underprice every cache-writing turn. Verified
 * cache rates are set explicitly per model below; unverified ones are left
 * unset, which falls back to the base input rate (no assumed discount OR
 * markup) rather than guessing a ratio.
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
  /** USD per 1,000,000 cached-read input tokens. Omit if unverified — falls back to inputPerMillion. */
  cacheReadPerMillion?: number;
  /** USD per 1,000,000 cache-write (priming) tokens — ABOVE input rate, not below. Omit if unverified. */
  cacheWritePerMillion?: number;
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
      // Cache read/write follow Anthropic's standard 0.1x / 1.25x of input.
      { effectiveTo: '2026-09-01', inputPerMillion: 2.0, outputPerMillion: 10.0, cacheReadPerMillion: 0.2, cacheWritePerMillion: 2.5 },
      { effectiveFrom: '2026-09-01', inputPerMillion: 3.0, outputPerMillion: 15.0, cacheReadPerMillion: 0.3, cacheWritePerMillion: 3.75 },
    ],
    'claude-opus-5': [{ inputPerMillion: 5.0, outputPerMillion: 25.0, cacheReadPerMillion: 0.5, cacheWritePerMillion: 6.25 }],
    'claude-fable-5': [{ inputPerMillion: 10.0, outputPerMillion: 50.0, cacheReadPerMillion: 1.0, cacheWritePerMillion: 12.5 }],
    'claude-haiku-4-5': [{ inputPerMillion: 1.0, outputPerMillion: 5.0, cacheReadPerMillion: 0.1, cacheWritePerMillion: 1.25 }],
    'claude-haiku-4-5-20251001': [{ inputPerMillion: 1.0, outputPerMillion: 5.0, cacheReadPerMillion: 0.1, cacheWritePerMillion: 1.25 }],
    // Prior generation, still seen on older runs.
    'claude-opus-4-8': [{ inputPerMillion: 5.0, outputPerMillion: 25.0, cacheReadPerMillion: 0.5, cacheWritePerMillion: 6.25 }],
    'claude-opus-4-7': [{ inputPerMillion: 5.0, outputPerMillion: 25.0, cacheReadPerMillion: 0.5, cacheWritePerMillion: 6.25 }],
    'claude-opus-4-6': [{ inputPerMillion: 5.0, outputPerMillion: 25.0, cacheReadPerMillion: 0.5, cacheWritePerMillion: 6.25 }],
    'claude-sonnet-4-6': [{ inputPerMillion: 3.0, outputPerMillion: 15.0, cacheReadPerMillion: 0.3, cacheWritePerMillion: 3.75 }],
    'claude-opus-4-1': [{ inputPerMillion: 15.0, outputPerMillion: 75.0, cacheReadPerMillion: 1.5, cacheWritePerMillion: 18.75 }],
    'claude-haiku-3': [{ inputPerMillion: 0.25, outputPerMillion: 1.25, cacheReadPerMillion: 0.03, cacheWritePerMillion: 0.3 }],
  },
  codex: {
    // Codex has no separate cache-write concept — only a cached-read
    // discount, verified at ~10% of base input for this family.
    'gpt-5.6-sol': [{ inputPerMillion: 5.0, outputPerMillion: 30.0, cacheReadPerMillion: 0.5 }],
    'gpt-5.6-terra': [{ inputPerMillion: 2.0, outputPerMillion: 12.0, cacheReadPerMillion: 0.2 }],
    'gpt-5.6-luna': [{ inputPerMillion: 0.2, outputPerMillion: 1.2, cacheReadPerMillion: 0.02 }],
    'gpt-5.5': [{ inputPerMillion: 5.0, outputPerMillion: 30.0, cacheReadPerMillion: 0.5 }],
    'gpt-5.4': [{ inputPerMillion: 2.5, outputPerMillion: 15.0, cacheReadPerMillion: 0.25 }],
  },
  grok: {
    // No verified cache rate found for xAI — left unset (falls back to the
    // base input rate) rather than guessing a discount ratio.
    'grok-4.5': [{ inputPerMillion: 2.0, outputPerMillion: 6.0 }],
    'grok-4.3': [{ inputPerMillion: 1.25, outputPerMillion: 2.5 }],
    'grok-4.1-fast': [{ inputPerMillion: 0.2, outputPerMillion: 0.5 }],
  },
  kimi: {
    // Published cache-read rates; no verified cache-write rate for any Kimi
    // tier, left unset.
    'kimi-code/k3': [{ inputPerMillion: 3.0, outputPerMillion: 15.0, cacheReadPerMillion: 0.3 }],
    'kimi-code/k3-256k': [{ inputPerMillion: 3.0, outputPerMillion: 15.0, cacheReadPerMillion: 0.3 }],
    k3: [{ inputPerMillion: 3.0, outputPerMillion: 15.0, cacheReadPerMillion: 0.3 }],
    'kimi-k2.7-code': [{ inputPerMillion: 0.95, outputPerMillion: 4.0, cacheReadPerMillion: 0.19 }],
    'kimi-k2.6': [{ inputPerMillion: 0.95, outputPerMillion: 4.0, cacheReadPerMillion: 0.16 }],
    'kimi-k2.5': [{ inputPerMillion: 0.6, outputPerMillion: 3.0, cacheReadPerMillion: 0.1 }],
    // "Kimi Code" for-coding tier (K2.5-based, 256K context) — API pricing
    // separate from the membership plan cost.
    'kimi-code/kimi-for-coding': [{ inputPerMillion: 0.6, outputPerMillion: 2.5, cacheReadPerMillion: 0.1 }],
    'kimi-for-coding': [{ inputPerMillion: 0.6, outputPerMillion: 2.5, cacheReadPerMillion: 0.1 }],
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
    'kimi-k3': [{ inputPerMillion: 3.0, outputPerMillion: 15.0, cacheReadPerMillion: 0.3 }],
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
  const { inputPerMillion, outputPerMillion, cacheReadPerMillion, cacheWritePerMillion } = matching[0];
  // Only include cache keys when actually set — an explicit `undefined`
  // property vs. an absent one is an easy source of confusing equality bugs
  // for callers (and tests) that compare the returned object by shape.
  return {
    inputPerMillion,
    outputPerMillion,
    ...(cacheReadPerMillion != null ? { cacheReadPerMillion } : {}),
    ...(cacheWritePerMillion != null ? { cacheWritePerMillion } : {}),
  };
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
 * omit only for a current-moment live estimate). `cacheReadTokens`/
 * `cacheCreationTokens` are a SUBSET of `inputTokens`, not additional to it —
 * they get priced at the cache rate instead of the base input rate; the
 * remainder of `inputTokens` is priced normally. Returns null (never a
 * guessed number) when the model has no pricing entry for that date.
 */
export function estimateCostUsd(
  provider: string | null | undefined,
  model: string | null | undefined,
  inputTokens: number | null | undefined,
  outputTokens: number | null | undefined,
  atIso?: string,
  cacheReadTokens?: number | null,
  cacheCreationTokens?: number | null,
): number | null {
  const rate = atIso
    ? resolveModelPriceRate(provider, model, atIso)
    : resolveModelPriceRate(provider, model);
  if (!rate) return null;
  const totalInput = Math.max(0, inputTokens ?? 0);
  const cacheRead = Math.max(0, Math.min(cacheReadTokens ?? 0, totalInput));
  const cacheCreation = Math.max(0, Math.min(cacheCreationTokens ?? 0, totalInput - cacheRead));
  const plainInput = Math.max(0, totalInput - cacheRead - cacheCreation);
  const output = Math.max(0, outputTokens ?? 0);
  const cacheReadRate = rate.cacheReadPerMillion ?? rate.inputPerMillion;
  const cacheWriteRate = rate.cacheWritePerMillion ?? rate.inputPerMillion;
  return (
    (plainInput / 1_000_000) * rate.inputPerMillion +
    (cacheRead / 1_000_000) * cacheReadRate +
    (cacheCreation / 1_000_000) * cacheWriteRate +
    (output / 1_000_000) * rate.outputPerMillion
  );
}
