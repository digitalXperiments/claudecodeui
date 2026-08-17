import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { IProviderModels } from '@/shared/interfaces.js';
import type { ProviderChangeActiveModelInput, ProviderCurrentActiveModel, ProviderModelOption, ProviderModelsDefinition, ProviderSessionActiveModelChange } from '@/shared/types.js';
import { buildDefaultProviderCurrentActiveModel, readObjectRecord, readOptionalString, writeProviderSessionActiveModelChange } from '@/shared/utils.js';

export const QWEN_FALLBACK_MODELS: ProviderModelsDefinition = {
  OPTIONS: [
    { value: 'qwen3-coder-plus', label: 'Qwen3 Coder Plus', description: 'Qwen Code coding model' },
    { value: 'qwen3.5-plus', label: 'Qwen3.5 Plus', description: 'Qwen general-purpose model' },
  ],
  DEFAULT: 'qwen3-coder-plus',
};

const settingsPath = path.join(os.homedir(), '.qwen', 'settings.json');

export class QwenCodeProviderModels implements IProviderModels {
  async getSupportedModels(): Promise<ProviderModelsDefinition> {
    try {
      const settings = readObjectRecord(JSON.parse(await readFile(settingsPath, 'utf8')));
      const providers = readObjectRecord(settings?.modelProviders);
      const options: ProviderModelOption[] = [];
      for (const provider of Object.values(providers ?? {})) {
        if (!Array.isArray(provider)) continue;
        for (const entry of provider) {
          const model = readObjectRecord(entry);
          const id = readOptionalString(model?.id);
          if (!id || options.some((option) => option.value === id)) continue;
          options.push({
            value: id,
            label: readOptionalString(model?.name) ?? id,
            description: readOptionalString(model?.description),
          });
        }
      }
      const configured = readOptionalString(readObjectRecord(settings?.model)?.name)
        ?? process.env.QWEN_MODEL ?? process.env.OPENAI_MODEL;
      if (options.length === 0) return QWEN_FALLBACK_MODELS;
      return { OPTIONS: options, DEFAULT: configured && options.some((option) => option.value === configured) ? configured : options[0].value };
    } catch { return QWEN_FALLBACK_MODELS; }
  }

  async getCurrentActiveModel(): Promise<ProviderCurrentActiveModel> {
    return buildDefaultProviderCurrentActiveModel(await this.getSupportedModels());
  }

  async changeActiveModel(input: ProviderChangeActiveModelInput): Promise<ProviderSessionActiveModelChange> {
    return writeProviderSessionActiveModelChange('qwencode', input);
  }
}
