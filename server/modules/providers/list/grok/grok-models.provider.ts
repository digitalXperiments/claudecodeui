import { readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import crossSpawn from 'cross-spawn';
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

// Fallback used ONLY when Grok's own model cache (~/.grok/models_cache.json)
// is absent — e.g. a fresh machine where the Grok CLI has not run or logged in
// yet. It must list only models xAI actually exposes, otherwise the UI would
// advertise models that fail on use. Once the cache exists it is authoritative
// (see readGrokModelsCache), so newly released models appear automatically as
// soon as the Grok CLI refreshes its cache — no code change needed here.
export const GROK_FALLBACK_MODELS: ProviderModelsDefinition = {
  OPTIONS: [
    {
      value: 'grok-4.5',
      label: 'Grok 4.5',
      description: "xAI's frontier model (powers Grok Build)",
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

// How long a cached model list is trusted before we ask the Grok CLI to refresh
// it. The Grok CLI writes ~/.grok/models_cache.json from xAI's live endpoint, so
// this is the upper bound on how long a newly released model can stay invisible
// in cloudcli if the user never runs the `grok` CLI directly.
const GROK_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
// How long we wait on `grok models` before giving up and reading whatever cache
// exists — a refresh must never block the model list for long.
const GROK_REFRESH_TIMEOUT_MS = 20 * 1000;

// In-memory guard so a stale cache does not spawn `grok models` on every single
// request. When Grok's endpoint returns 304 (etag match) the cache file's mtime
// stays old, so mtime alone cannot tell us "we already tried recently" — this
// timestamp does. Coalesces concurrent callers onto one in-flight refresh.
let lastRefreshAttemptMs = 0;
let refreshInFlight: Promise<void> | null = null;

const isGrokCacheFresh = async (): Promise<boolean> => {
  try {
    const stats = await stat(GROK_MODELS_CACHE_PATH);
    return Date.now() - stats.mtimeMs < GROK_CACHE_TTL_MS;
  } catch {
    return false;
  }
};

// Best-effort: run `grok models` (which performs a conditional, etag-based fetch
// and rewrites the cache when the model set changed). Failures are swallowed —
// the caller falls back to the existing cache or the hardcoded fallback list.
const spawnGrokModelsRefresh = (): Promise<void> =>
  new Promise((resolve) => {
    let child: ReturnType<typeof crossSpawn>;
    try {
      child = crossSpawn('grok', ['models'], { stdio: 'ignore', env: { ...process.env } });
    } catch {
      resolve();
      return;
    }

    const timer = setTimeout(() => {
      try {
        child.kill('SIGTERM');
      } catch {
        // Already gone.
      }
      resolve();
    }, GROK_REFRESH_TIMEOUT_MS);

    child.on('close', () => {
      clearTimeout(timer);
      resolve();
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve();
    });
  });

const refreshGrokModelsCacheIfStale = async (): Promise<void> => {
  if (await isGrokCacheFresh()) {
    return;
  }
  // Don't retry more often than once per TTL even if the cache stays stale
  // (e.g. offline, or Grok keeps returning 304 without touching the file).
  if (Date.now() - lastRefreshAttemptMs < GROK_CACHE_TTL_MS) {
    return;
  }
  if (!refreshInFlight) {
    lastRefreshAttemptMs = Date.now();
    refreshInFlight = spawnGrokModelsRefresh().finally(() => {
      refreshInFlight = null;
    });
  }
  await refreshInFlight;
};

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
    // Ask the Grok CLI to refresh its cache at most once a day so newly
    // released models surface without the user having to run `grok` directly.
    // Best-effort and time-bounded; never blocks on a hanging refresh.
    await refreshGrokModelsCacheIfStale();
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
