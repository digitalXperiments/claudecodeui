import type { LLMProvider, ProviderModelOption } from '../../../types/app';

export const DEFAULT_EFFORT_VALUE = 'default';

export const FALLBACK_PROVIDER_EFFORT_VALUES: Partial<Record<LLMProvider, readonly string[]>> = {
  claude: ['low', 'medium', 'high', 'xhigh', 'max'],
  codex: ['low', 'medium', 'high', 'xhigh'],
  opencode: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
  kilo: ['low', 'medium', 'high'],
  pi: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
  // Mirrors THINKING_LEVEL_OPTIONS in omp-models.provider.ts (Oh My Pi's
  // `--thinking` scale). Without this the picker doesn't know OMP supports a
  // thinking control until the capability matrix loads from the backend.
  omp: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
};

export const toProviderEffortOptions = (
  values: readonly string[],
): NonNullable<ProviderModelOption['effort']>['values'] => values.map((value) => ({ value }));
