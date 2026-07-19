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

// Antigravity's `agy models` prints one human-readable model label per line
// (e.g. "Gemini 3.5 Flash (Medium)"). The label IS the identifier `agy --model`
// expects — there is no separate model id or JSON catalog — so each line maps
// directly to `{ value: label, label }`. The reasoning effort is baked into the
// label ("(Medium/High/Low)"), so there is no separate effort dimension to
// model here (unlike Grok).
export const AGY_FALLBACK_MODELS: ProviderModelsDefinition = {
  OPTIONS: [
    { value: 'Gemini 3.5 Flash (Medium)', label: 'Gemini 3.5 Flash (Medium)' },
    { value: 'Gemini 3.5 Flash (High)', label: 'Gemini 3.5 Flash (High)' },
    { value: 'Gemini 3.5 Flash (Low)', label: 'Gemini 3.5 Flash (Low)' },
    { value: 'Gemini 3.1 Pro (Low)', label: 'Gemini 3.1 Pro (Low)' },
    { value: 'Gemini 3.1 Pro (High)', label: 'Gemini 3.1 Pro (High)' },
    { value: 'Claude Sonnet 4.6 (Thinking)', label: 'Claude Sonnet 4.6 (Thinking)' },
    { value: 'Claude Opus 4.6 (Thinking)', label: 'Claude Opus 4.6 (Thinking)' },
    { value: 'GPT-OSS 120B (Medium)', label: 'GPT-OSS 120B (Medium)' },
  ],
  DEFAULT: 'Gemini 3.5 Flash (Medium)',
};

// How long a fetched model list is trusted before we re-run `agy models`. The
// list rarely changes, and spawning the Antigravity language server on every
// request would be wasteful, so an in-memory cache with a generous TTL is the
// right trade-off.
const AGY_MODELS_CACHE_TTL_MS = 60 * 60 * 1000;
// `agy models` boots the language-server sidecar; a few seconds is plenty for
// the model list, and a refresh must never block the UI for long.
const AGY_MODELS_TIMEOUT_MS = 15 * 1000;

let cachedModels: ProviderModelsDefinition | null = null;
let cachedAtMs = 0;
let refreshInFlight: Promise<ProviderModelsDefinition | null> | null = null;

const runAgyModels = (): Promise<ProviderModelsDefinition | null> =>
  new Promise((resolve) => {
    let child: ReturnType<typeof crossSpawn>;
    try {
      child = crossSpawn('agy', ['models'], { stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env } });
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
    }, AGY_MODELS_TIMEOUT_MS);

    child.stdout?.on('data', (data) => {
      stdout += data.toString();
    });

    child.on('error', () => {
      clearTimeout(timer);
      resolve(null);
    });

    child.on('close', () => {
      clearTimeout(timer);
      const options: ProviderModelOption[] = stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => ({ value: line, label: line }));

      if (options.length === 0) {
        resolve(null);
        return;
      }

      const preferredDefault = AGY_FALLBACK_MODELS.DEFAULT;
      resolve({
        OPTIONS: options,
        DEFAULT: options.some((option) => option.value === preferredDefault)
          ? preferredDefault
          : options[0].value,
      });
    });
  });

const getModels = async (): Promise<ProviderModelsDefinition> => {
  if (cachedModels && Date.now() - cachedAtMs < AGY_MODELS_CACHE_TTL_MS) {
    return cachedModels;
  }

  if (!refreshInFlight) {
    refreshInFlight = runAgyModels().finally(() => {
      refreshInFlight = null;
    });
  }

  const fetched = await refreshInFlight;
  if (fetched) {
    cachedModels = fetched;
    cachedAtMs = Date.now();
    return fetched;
  }

  return cachedModels ?? AGY_FALLBACK_MODELS;
};

export class AgyProviderModels implements IProviderModels {
  async getSupportedModels(): Promise<ProviderModelsDefinition> {
    return getModels();
  }

  async getCurrentActiveModel(sessionId?: string): Promise<ProviderCurrentActiveModel> {
    // Antigravity persists the active model inside its own conversation store
    // (protobuf), which is not readable here; the app's session-scoped model
    // override (see changeActiveModel) is the source of truth for resume, so
    // the catalog default is the correct fallback — mirrors Grok/Codex.
    void sessionId;
    return buildDefaultProviderCurrentActiveModel(await this.getSupportedModels());
  }

  async changeActiveModel(
    input: ProviderChangeActiveModelInput,
  ): Promise<ProviderSessionActiveModelChange> {
    return writeProviderSessionActiveModelChange('agy', input);
  }
}
