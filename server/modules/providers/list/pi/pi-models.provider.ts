import crossSpawn from 'cross-spawn';

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
  writeProviderSessionActiveModelChange,
} from '@/shared/utils.js';

// Sensible catalog when `pi --list-models` is empty (no auth yet) or the CLI
// is unavailable. Values use Pi's `provider/id` form so they round-trip to
// `--model` / RPC `set_model`.
export const PI_FALLBACK_MODELS: ProviderModelsDefinition = {
  OPTIONS: [
    { value: 'anthropic/claude-sonnet-4-20250514', label: 'Claude Sonnet 4 (Anthropic)' },
    { value: 'anthropic/claude-opus-4-20250514', label: 'Claude Opus 4 (Anthropic)' },
    { value: 'openai/gpt-4o', label: 'GPT-4o (OpenAI)' },
    { value: 'openai/gpt-4.1', label: 'GPT-4.1 (OpenAI)' },
    { value: 'google/gemini-2.5-pro', label: 'Gemini 2.5 Pro (Google)' },
    { value: 'google/gemini-2.5-flash', label: 'Gemini 2.5 Flash (Google)' },
    { value: 'openrouter/auto', label: 'OpenRouter Auto' },
    { value: 'xai/grok-3', label: 'Grok 3 (xAI)' },
  ],
  DEFAULT: 'anthropic/claude-sonnet-4-20250514',
};

const PI_MODELS_CACHE_TTL_MS = 60 * 60 * 1000;
const PI_MODELS_TIMEOUT_MS = 20 * 1000;

let cachedModels: ProviderModelsDefinition | null = null;
let cachedAtMs = 0;
let refreshInFlight: Promise<ProviderModelsDefinition | null> | null = null;

/**
 * Parse `pi --list-models` output. Formats vary slightly by version; accept
 * lines that look like `provider/model-id` or `provider/model-id  Name`.
 */
function parseListModelsOutput(stdout: string): ProviderModelOption[] {
  const options: ProviderModelOption[] = [];
  const seen = new Set<string>();

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('No models') || line.startsWith('Use /login')) {
      continue;
    }

    // Prefer an explicit provider/id token at the start of the line.
    const match = line.match(/^([a-zA-Z0-9._-]+\/[a-zA-Z0-9._:@+/-]+)/);
    if (!match) {
      continue;
    }

    const value = match[1];
    if (seen.has(value)) {
      continue;
    }
    seen.add(value);

    const rest = line.slice(match[0].length).trim().replace(/^[-–—:]\s*/, '');
    options.push({
      value,
      label: rest || value,
    });
  }

  return options;
}

const runPiListModels = (): Promise<ProviderModelsDefinition | null> =>
  new Promise((resolve) => {
    let child: ReturnType<typeof crossSpawn>;
    try {
      child = crossSpawn('pi', ['--list-models', '--offline'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env },
      });
    } catch {
      resolve(null);
      return;
    }

    let stdout = '';
    const timer = setTimeout(() => {
      try {
        child.kill('SIGTERM');
      } catch {
        // Already gone.
      }
      resolve(null);
    }, PI_MODELS_TIMEOUT_MS);

    child.stdout?.on('data', (data) => {
      stdout += data.toString();
    });

    child.on('error', () => {
      clearTimeout(timer);
      resolve(null);
    });

    child.on('close', () => {
      clearTimeout(timer);
      const options = parseListModelsOutput(stdout);
      if (options.length === 0) {
        resolve(null);
        return;
      }

      const preferredDefault = PI_FALLBACK_MODELS.DEFAULT;
      resolve({
        OPTIONS: options,
        DEFAULT: options.some((option) => option.value === preferredDefault)
          ? preferredDefault
          : options[0].value,
      });
    });
  });

const getModels = async (): Promise<ProviderModelsDefinition> => {
  if (cachedModels && Date.now() - cachedAtMs < PI_MODELS_CACHE_TTL_MS) {
    return cachedModels;
  }

  if (!refreshInFlight) {
    refreshInFlight = runPiListModels().finally(() => {
      refreshInFlight = null;
    });
  }

  const fetched = await refreshInFlight;
  if (fetched) {
    cachedModels = fetched;
    cachedAtMs = Date.now();
    return fetched;
  }

  return cachedModels ?? PI_FALLBACK_MODELS;
};

export class PiProviderModels implements IProviderModels {
  async getSupportedModels(): Promise<ProviderModelsDefinition> {
    return getModels();
  }

  async getCurrentActiveModel(sessionId?: string): Promise<ProviderCurrentActiveModel> {
    void sessionId;
    return buildDefaultProviderCurrentActiveModel(await this.getSupportedModels());
  }

  async changeActiveModel(
    input: ProviderChangeActiveModelInput,
  ): Promise<ProviderSessionActiveModelChange> {
    return writeProviderSessionActiveModelChange('pi', input);
  }
}
