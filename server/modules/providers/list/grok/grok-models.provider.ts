import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import TOML from '@iarna/toml';

import type { IProviderModels } from '@/shared/interfaces.js';
import type {
  ProviderChangeActiveModelInput,
  ProviderCurrentActiveModel,
  ProviderModelOption,
  ProviderModelsDefinition,
  ProviderSessionActiveModelChange,
} from '@/shared/types.js';
import {
  buildDefaultProviderCurrentActiveModel,
  readObjectRecord,
  readOptionalString,
  writeProviderSessionActiveModelChange,
} from '@/shared/utils.js';

export const GROK_FALLBACK_MODELS: ProviderModelsDefinition = {
  OPTIONS: [
    {
      value: 'grok-4.5',
      label: 'Grok 4.5',
      description: "xAI's frontier model",
      effort: {
        default: 'high',
        values: [{ value: 'high' }, { value: 'medium' }, { value: 'low' }],
      },
    },
  ],
  DEFAULT: 'grok-4.5',
};

const GROK_MODELS_CACHE_PATH = path.join(os.homedir(), '.grok', 'models_cache.json');
const GROK_CONFIG_PATH = path.join(os.homedir(), '.grok', 'config.toml');

type GrokCachedModelInfo = {
  id?: string;
  name?: string;
  description?: string;
  hidden?: boolean;
  reasoning_efforts?: Array<{ value?: string; description?: string; default?: boolean }>;
};

const mapGrokModel = (id: string, info: GrokCachedModelInfo): ProviderModelOption => {
  const effortValues = Array.isArray(info.reasoning_efforts)
    ? info.reasoning_efforts
        .filter((entry): entry is { value: string; description?: string; default?: boolean } => typeof entry?.value === 'string')
        .map((entry) => ({ value: entry.value, description: entry.description }))
    : [];

  const defaultEffort = info.reasoning_efforts?.find((entry) => entry.default)?.value;

  return {
    value: id,
    label: info.name || id,
    description: info.description,
    effort: effortValues.length > 0
      ? { default: defaultEffort, values: effortValues }
      : undefined,
  };
};

const readGrokModelsCache = async (): Promise<ProviderModelsDefinition | null> => {
  try {
    const content = await readFile(GROK_MODELS_CACHE_PATH, 'utf8');
    const parsed = readObjectRecord(JSON.parse(content));
    const models = readObjectRecord(parsed?.models);
    if (!models) {
      return null;
    }

    const options: ProviderModelOption[] = [];
    for (const [id, rawInfo] of Object.entries(models)) {
      const entry = readObjectRecord(rawInfo);
      const info = readObjectRecord(entry?.info);
      if (!info || info.hidden === true) {
        continue;
      }
      options.push(mapGrokModel(id, info as GrokCachedModelInfo));
    }

    if (options.length === 0) {
      return null;
    }

    const configDefault = await readGrokConfigDefaultModel();

    return {
      OPTIONS: options,
      DEFAULT: configDefault && options.some((option) => option.value === configDefault)
        ? configDefault
        : options[0].value,
    };
  } catch {
    return null;
  }
};

const readGrokConfigDefaultModel = async (): Promise<string | null> => {
  try {
    const content = await readFile(GROK_CONFIG_PATH, 'utf8');
    const parsed = TOML.parse(content) as Record<string, unknown>;
    const models = readObjectRecord(parsed.models);
    return readOptionalString(models?.default) ?? null;
  } catch {
    return null;
  }
};

export class GrokProviderModels implements IProviderModels {
  async getSupportedModels(): Promise<ProviderModelsDefinition> {
    const cached = await readGrokModelsCache();
    return cached ?? GROK_FALLBACK_MODELS;
  }

  async getCurrentActiveModel(sessionId?: string): Promise<ProviderCurrentActiveModel> {
    // Grok's own session summary.json records `current_model_id`, but the
    // resume path is driven by the app's persisted session-scoped override
    // (see changeActiveModel), so config/cache default is the correct source
    // of truth here — mirrors Codex's provider default fallback.
    void sessionId;
    return buildDefaultProviderCurrentActiveModel(await this.getSupportedModels());
  }

  async changeActiveModel(
    input: ProviderChangeActiveModelInput,
  ): Promise<ProviderSessionActiveModelChange> {
    return writeProviderSessionActiveModelChange('grok', input);
  }
}
