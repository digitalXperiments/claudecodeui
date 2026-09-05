export type CapabilityTier = 'frontier' | 'balanced' | 'fast' | 'unknown';
export type TierMatchResult = 'exact' | 'downgraded' | 'upgraded' | 'default';

type KnownTier = Exclude<CapabilityTier, 'unknown'>;

export type ModelTierRule = {
  defaultModel: string | null;
  defaultTier: CapabilityTier;
  models: Record<KnownTier, readonly string[]>;
};

const AGGREGATOR_MODELS = {
  frontier: [
    'claude-opus', 'claude-3.7-sonnet', 'claude-3-7-sonnet', 'gpt-4o',
    'o1', 'o3', 'grok-3', 'grok-2', 'kimi-k1.5', 'kimi-k1-5',
    'deepseek-r1', 'gemini-2.5-pro', 'gemini-2-5-pro',
    'gemini-2.5-flash-thinking', 'gemini-2-5-flash-thinking',
  ],
  balanced: [
    'claude-3.5-sonnet', 'claude-3-5-sonnet', 'claude-sonnet', 'gpt-4o-mini',
    'grok-2-mini', 'qwen2.5-coder-32b', 'qwen-2.5-coder-32b',
    'gemini-2.0', 'gemini-2-0', 'gemini-2.5-flash', 'gemini-2-5-flash',
  ],
  fast: [
    'claude-3.5-haiku', 'claude-3-5-haiku', 'claude-3-haiku', 'claude-haiku',
    'o3-mini-low', 'qwen2.5-coder-7b', 'qwen-2.5-coder-7b',
  ],
} as const;

function rule(
  defaultModel: string | null,
  defaultTier: CapabilityTier,
  additions: Partial<Record<KnownTier, readonly string[]>> = {},
): ModelTierRule {
  return {
    defaultModel,
    defaultTier,
    models: {
      frontier: [...(additions.frontier ?? []), ...AGGREGATOR_MODELS.frontier],
      balanced: [...(additions.balanced ?? []), ...AGGREGATOR_MODELS.balanced],
      fast: [...(additions.fast ?? []), ...AGGREGATOR_MODELS.fast],
    },
  };
}

/** Preferred model names and recognition rules used when continuity changes provider. */
export const MODEL_TIER_RULES: Readonly<Record<string, ModelTierRule>> = {
  claude: rule('sonnet', 'balanced', {
    frontier: ['opus', 'claude-3-7-sonnet-thinking'],
    balanced: ['default', 'sonnet'],
    fast: ['haiku'],
  }),
  codex: rule('gpt-4o', 'frontier', {
    frontier: ['gpt-4o', 'o1', 'o3', 'o3-mini'],
    balanced: ['gpt-4o-mini'],
    fast: ['o3-mini-low'],
  }),
  grok: rule('grok-3', 'frontier'),
  kimi: rule('kimi-k1.5', 'frontier'),
  opencode: rule('anthropic/claude-3.5-sonnet', 'balanced'),
  cursor: rule('claude-3.5-sonnet', 'balanced'),
  kilo: rule('anthropic/claude-3.5-sonnet', 'balanced'),
  cline: rule('anthropic/claude-3.5-sonnet', 'balanced'),
  qwencode: rule('qwen2.5-coder-32b', 'balanced'),
  pi: rule('openai/gpt-4o', 'frontier'),
  omp: rule('openai/gpt-4o', 'frontier'),
  antigravity: rule('gemini-2.5-pro', 'frontier'),
};

const PROVIDER_ALIASES: Readonly<Record<string, string>> = {
  anthropic: 'claude',
  openai: 'codex',
  xai: 'grok',
  qwen: 'qwencode',
  'qwen-code': 'qwencode',
  google: 'antigravity',
};

function normalize(value: string): string {
  return value.trim().toLowerCase().replaceAll('_', '-');
}

function providerRule(provider: string): ModelTierRule | undefined {
  const key = normalize(provider);
  return MODEL_TIER_RULES[key] ?? MODEL_TIER_RULES[PROVIDER_ALIASES[key]];
}

function matches(modelId: string, candidate: string): boolean {
  const normalizedCandidate = normalize(candidate);
  return modelId === normalizedCandidate
    || modelId.startsWith(`${normalizedCandidate}-`)
    || modelId.endsWith(`/${normalizedCandidate}`)
    || modelId.includes(`/${normalizedCandidate}-`);
}

export function resolveModelTier(
  provider: string,
  modelId: string | null | undefined,
): CapabilityTier {
  if (!modelId?.trim()) return 'unknown';
  const providerModels = providerRule(provider);
  if (!providerModels) return 'unknown';
  const normalizedModel = normalize(modelId);

  // Specific rules must win over their prefixes (o3-mini-low before o3, for example).
  const candidates = (Object.entries(providerModels.models) as Array<[KnownTier, readonly string[]]>)
    .flatMap(([tier, models]) => models.map((model) => ({ tier, model })))
    .sort((left, right) => right.model.length - left.model.length);
  return candidates.find(({ model }) => matches(normalizedModel, model))?.tier ?? 'unknown';
}

export function getTierForProviderDefault(provider: string): CapabilityTier {
  const providerModels = providerRule(provider);
  if (!providerModels) return 'unknown';
  return providerModels.defaultTier;
}

const FALLBACK_ORDER: Readonly<Record<KnownTier, readonly KnownTier[]>> = {
  frontier: ['frontier', 'balanced', 'fast'],
  balanced: ['balanced', 'fast', 'frontier'],
  fast: ['fast', 'balanced', 'frontier'],
};

function matchKind(source: KnownTier, selected: KnownTier): TierMatchResult {
  if (source === selected) return 'exact';
  const rank: Record<KnownTier, number> = { fast: 0, balanced: 1, frontier: 2 };
  return rank[selected] < rank[source] ? 'downgraded' : 'upgraded';
}

export function pickEquivalentModel(
  targetProvider: string,
  sourceTier: CapabilityTier,
  availableModels?: Array<{ value: string; label?: string }>,
): { model: string | null; tierMatch: TierMatchResult } {
  const providerModels = providerRule(targetProvider);
  if (!providerModels) return { model: null, tierMatch: 'default' };

  if (availableModels !== undefined) {
    if (availableModels.length === 0) return { model: null, tierMatch: 'default' };
    if (sourceTier !== 'unknown') {
      for (const tier of FALLBACK_ORDER[sourceTier]) {
        const option = availableModels.find(({ value }) => resolveModelTier(targetProvider, value) === tier);
        if (option) return { model: option.value, tierMatch: matchKind(sourceTier, tier) };
      }
    }
    const providerDefault = availableModels.find(({ value }) => value === providerModels.defaultModel);
    return { model: providerDefault?.value ?? availableModels[0]?.value ?? null, tierMatch: 'default' };
  }

  if (sourceTier !== 'unknown') {
    for (const tier of FALLBACK_ORDER[sourceTier]) {
      const model = providerModels.models[tier][0];
      if (model) return { model, tierMatch: matchKind(sourceTier, tier) };
    }
  }
  return { model: providerModels.defaultModel, tierMatch: 'default' };
}

export function listProviderTiers(): Record<string, { tier: CapabilityTier; defaultModel: string | null }> {
  return Object.fromEntries(Object.entries(MODEL_TIER_RULES).map(([provider, providerModels]) => [
    provider,
    { tier: providerModels.defaultTier, defaultModel: providerModels.defaultModel },
  ]));
}
