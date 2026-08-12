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

// Pi's global `--thinking <level>` / RPC `set_thinking_level` scale (see
// docs/rpc.md in @earendil-works/pi-coding-agent). Not every "thinking: yes"
// model supports the full range (xhigh/max are gated per-model), but Pi
// itself is the one that validates that at request time — CloudCLI has no
// cheaper way to know the exact ceiling per model without an extra RPC round
// trip per catalog entry.
const THINKING_LEVEL_OPTIONS: NonNullable<ProviderModelOption['effort']>['values'] = [
  { value: 'off' },
  { value: 'minimal' },
  { value: 'low' },
  { value: 'medium' },
  { value: 'high' },
  { value: 'xhigh' },
  { value: 'max' },
];

// Sensible catalog when `pi --list-models` is empty (no auth yet) or the CLI
// is unavailable. Values use Pi's `provider/id` form so they round-trip to
// `--model` / RPC `set_model`. Kept intentionally current with what Pi
// actually serves through the `openai-codex` provider group today — this is
// a last-resort fallback, not a claim about the live catalog (see
// `runPiListModels`, which is the real source of truth).
export const PI_FALLBACK_MODELS: ProviderModelsDefinition = {
  OPTIONS: [
    {
      value: 'openai-codex/gpt-5.6-luna',
      label: 'GPT-5.6 Luna',
      effort: { values: THINKING_LEVEL_OPTIONS },
    },
    {
      value: 'openai-codex/gpt-5.6-sol',
      label: 'GPT-5.6 Sol',
      effort: { values: THINKING_LEVEL_OPTIONS },
    },
    {
      value: 'openai-codex/gpt-5.6-terra',
      label: 'GPT-5.6 Terra',
      effort: { values: THINKING_LEVEL_OPTIONS },
    },
    {
      value: 'openai-codex/gpt-5.5',
      label: 'GPT-5.5',
      effort: { values: THINKING_LEVEL_OPTIONS },
    },
    {
      value: 'openai-codex/gpt-5.4',
      label: 'GPT-5.4',
      effort: { values: THINKING_LEVEL_OPTIONS },
    },
  ],
  DEFAULT: 'openai-codex/gpt-5.6-luna',
};

const PI_MODELS_CACHE_TTL_MS = 60 * 60 * 1000;
const PI_MODELS_TIMEOUT_MS = 20 * 1000;

let cachedModels: ProviderModelsDefinition | null = null;
let cachedAtMs = 0;
let refreshInFlight: Promise<ProviderModelsDefinition | null> | null = null;

/**
 * Parse `pi --list-models` output: a padded text table with columns
 * `provider  model  context  max-out  thinking  images` (see
 * `dist/cli/list-models.js` in @earendil-works/pi-coding-agent — columns are
 * joined with a 2-space separator and no field itself contains whitespace,
 * so splitting each line on runs of 2+ spaces is safe).
 */
function parseListModelsOutput(stdout: string): ProviderModelOption[] {
  const options: ProviderModelOption[] = [];
  const seen = new Set<string>();

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('No models') || line.startsWith('Use /login') || line.startsWith('Warning:')) {
      continue;
    }

    const columns = line.split(/\s{2,}/);
    const [provider, modelId, , , thinking] = columns;
    if (!provider || !modelId || provider === 'provider') {
      // Header row or malformed line.
      continue;
    }

    const value = `${provider}/${modelId}`;
    if (seen.has(value)) {
      continue;
    }
    seen.add(value);

    options.push({
      value,
      label: modelId,
      description: provider,
      effort: thinking === 'yes' ? { values: THINKING_LEVEL_OPTIONS } : undefined,
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
