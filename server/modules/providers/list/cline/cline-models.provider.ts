import type { IProviderModels } from '@/shared/interfaces.js';
import type {
  ProviderChangeActiveModelInput,
  ProviderCurrentActiveModel,
  ProviderModelsDefinition,
  ProviderSessionActiveModelChange,
} from '@/shared/types.js';
import {
  buildDefaultProviderCurrentActiveModel,
  writeProviderSessionActiveModelChange,
} from '@/shared/utils.js';

/** Cline's ACP endpoint does not expose a stable model listing command. */
export const CLINE_FALLBACK_MODELS: ProviderModelsDefinition = {
  OPTIONS: [
    {
      value: 'anthropic/claude-sonnet-4.6',
      label: 'Claude Sonnet 4.6',
      description: 'Cline default model',
      effort: { values: [{ value: 'low' }, { value: 'medium' }, { value: 'high' }] },
    },
  ],
  DEFAULT: 'anthropic/claude-sonnet-4.6',
};

export class ClineProviderModels implements IProviderModels {
  async getSupportedModels(): Promise<ProviderModelsDefinition> {
    return CLINE_FALLBACK_MODELS;
  }

  async getCurrentActiveModel(_sessionId?: string): Promise<ProviderCurrentActiveModel> {
    return buildDefaultProviderCurrentActiveModel(CLINE_FALLBACK_MODELS);
  }

  async changeActiveModel(input: ProviderChangeActiveModelInput): Promise<ProviderSessionActiveModelChange> {
    const model = input.model.trim();
    const supported = CLINE_FALLBACK_MODELS.OPTIONS.some((option) => option.value === model);
    if (!supported) {
      throw new Error(`Unsupported Cline model "${model}".`);
    }

    return writeProviderSessionActiveModelChange('cline', { ...input, model });
  }
}
