import {
  OpenCodeProviderModels,
  type OpenCodeProviderModelsOptions,
} from '@/modules/providers/list/opencode/opencode-models.provider.js';
import type { ProviderModelsDefinition } from '@/shared/types.js';
import { getKiloDatabasePath } from '@/shared/utils.js';

/**
 * Used only when the Kilo CLI is not installed or model discovery is offline.
 * Kilo's ACP model ids are provider-qualified; keeping that prefix prevents
 * the ACP server from silently selecting a model from another provider.
 */
export const KILO_FALLBACK_MODELS: ProviderModelsDefinition = {
  OPTIONS: [
    {
      value: 'kilo/stealth/claude-sonnet-4.6',
      label: 'Claude Sonnet 4.6 (Kilo)',
      description: 'kilo - kilo/stealth/claude-sonnet-4.6',
      effort: {
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
        ],
      },
    },
  ],
  DEFAULT: 'kilo/stealth/claude-sonnet-4.6',
};

const KILO_MODEL_OPTIONS: OpenCodeProviderModelsOptions = {
  provider: 'kilo',
  command: 'kilo',
  databasePath: getKiloDatabasePath(),
  fallbackModels: KILO_FALLBACK_MODELS,
};

export class KiloProviderModels extends OpenCodeProviderModels {
  constructor() {
    super(KILO_MODEL_OPTIONS);
  }
}
