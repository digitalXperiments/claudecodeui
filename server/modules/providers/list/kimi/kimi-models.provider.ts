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

export const KIMI_FALLBACK_MODELS: ProviderModelsDefinition = {
  OPTIONS: [
    {
      value: 'kimi-code/kimi-for-coding',
      label: 'K2.7 Coding',
      description: "Moonshot AI's managed coding model",
    },
  ],
  DEFAULT: 'kimi-code/kimi-for-coding',
};

const KIMI_CONFIG_PATH = path.join(os.homedir(), '.kimi-code', 'config.toml');

type KimiConfigModelEntry = {
  provider?: string;
  model?: string;
  display_name?: string;
  max_context_size?: number;
  support_efforts?: string[];
  default_effort?: string;
};

const mapKimiModel = (id: string, info: KimiConfigModelEntry): ProviderModelOption => {
  const effortValues = Array.isArray(info.support_efforts)
    ? info.support_efforts
        .filter((value): value is string => typeof value === 'string')
        .map((value) => ({ value }))
    : [];

  return {
    value: id,
    label: info.display_name || id,
    description: typeof info.max_context_size === 'number'
      ? `${info.model ?? id} · ${info.max_context_size.toLocaleString('en-US')} token context`
      : info.model,
    effort: effortValues.length > 0
      ? { default: info.default_effort, values: effortValues }
      : undefined,
  };
};

/**
 * Kimi Code CLI has no `kimi models` subcommand — the model catalog is
 * defined directly in config.toml under `[models."<id>"]` tables (also
 * mirrored by `kimi provider list --json`, which is just a formatted view of
 * the same config). Reading the TOML file directly avoids an extra spawn.
 */
export class KimiProviderModels implements IProviderModels {
  async getSupportedModels(): Promise<ProviderModelsDefinition> {
    try {
      const content = await readFile(KIMI_CONFIG_PATH, 'utf8');
      const parsed = TOML.parse(content) as Record<string, unknown>;
      const models = readObjectRecord(parsed.models);
      if (!models) {
        return KIMI_FALLBACK_MODELS;
      }

      const options: ProviderModelOption[] = [];
      for (const [id, rawInfo] of Object.entries(models)) {
        const info = readObjectRecord(rawInfo);
        if (!info) {
          continue;
        }
        options.push(mapKimiModel(id, info as KimiConfigModelEntry));
      }

      if (options.length === 0) {
        return KIMI_FALLBACK_MODELS;
      }

      const defaultModel = readOptionalString(parsed.default_model);

      return {
        OPTIONS: options,
        DEFAULT: defaultModel && options.some((option) => option.value === defaultModel)
          ? defaultModel
          : options[0].value,
      };
    } catch {
      return KIMI_FALLBACK_MODELS;
    }
  }

  async getCurrentActiveModel(sessionId?: string): Promise<ProviderCurrentActiveModel> {
    // Resume is driven by the app's persisted session-scoped override (see
    // changeActiveModel) rather than anything recorded in Kimi's own session
    // state.json, so config default is the correct source of truth here —
    // mirrors Grok/Codex's provider default fallback.
    void sessionId;
    return buildDefaultProviderCurrentActiveModel(await this.getSupportedModels());
  }

  async changeActiveModel(
    input: ProviderChangeActiveModelInput,
  ): Promise<ProviderSessionActiveModelChange> {
    return writeProviderSessionActiveModelChange('kimi', input);
  }
}
