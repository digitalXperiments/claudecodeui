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

const LEGACY_THINKING_LEVELS: NonNullable<ProviderModelOption['effort']>['values'] = [
  { value: 'off' },
  { value: 'minimal' },
  { value: 'low' },
  { value: 'medium' },
  { value: 'high' },
  { value: 'xhigh' },
  { value: 'max' },
];

/** Conservative offline fallback; live `omp models --json` is authoritative. */
export const OMP_FALLBACK_MODELS: ProviderModelsDefinition = {
  OPTIONS: [
    {
      value: 'openai-codex/gpt-5.4',
      label: 'GPT-5.4 (openai-codex)',
      description: 'openai-codex',
    },
  ],
  DEFAULT: 'openai-codex/gpt-5.4',
};

const OMP_MODELS_TIMEOUT_MS = 20 * 1000;

type SpawnFunction = typeof crossSpawn;
type RunCommand = (argv: string[]) => Promise<string | null>;

type OmpJsonModel = {
  provider: string;
  id: string;
  selector: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  thinking: string[];
};

const isNonEmptyString = (value: unknown): value is string => (
  typeof value === 'string' && value.trim().length > 0
);

const isPositiveInteger = (value: unknown): value is number => (
  Number.isInteger(value) && Number(value) > 0
);

const parseJsonModel = (value: unknown): OmpJsonModel | null => {
  if (!value || typeof value !== 'object') return null;
  const model = value as Record<string, unknown>;
  if (
    !isNonEmptyString(model.provider)
    || !isNonEmptyString(model.id)
    || !isNonEmptyString(model.selector)
    || !isNonEmptyString(model.name)
    || !isPositiveInteger(model.contextWindow)
    || !isPositiveInteger(model.maxTokens)
    || typeof model.reasoning !== 'boolean'
    || !Array.isArray(model.thinking)
    || !model.thinking.every(isNonEmptyString)
  ) {
    return null;
  }

  return {
    provider: model.provider.trim(),
    id: model.id.trim(),
    selector: model.selector.trim(),
    name: model.name.trim(),
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    reasoning: model.reasoning,
    thinking: model.thinking.map((level) => level.trim()),
  };
};

/** Parse and strictly validate the v18 `omp models --json` contract. */
export function parseOmpModelsJson(stdout: string): ProviderModelsDefinition | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as { models?: unknown }).models)) {
    return null;
  }

  const rawModels = (parsed as { models: unknown[] }).models;
  if (rawModels.length === 0) return null;
  const models = rawModels.map(parseJsonModel);
  if (models.some((model) => model === null)) return null;

  const options: ProviderModelOption[] = [];
  const seen = new Set<string>();
  for (const model of models as OmpJsonModel[]) {
    if (seen.has(model.selector)) continue;
    seen.add(model.selector);
    const thinking = [...new Set(model.thinking)];
    options.push({
      value: model.selector,
      label: `${model.name} (${model.provider})`,
      description: model.provider,
      resolvedModel: model.id,
      runtimeContextWindow: model.contextWindow,
      runtimeMaxOutputTokens: model.maxTokens,
      effort: model.reasoning && thinking.length > 0
        ? { values: thinking.map((level) => ({ value: level })) }
        : undefined,
    });
  }

  if (options.length === 0) return null;
  const preferredDefault = OMP_FALLBACK_MODELS.DEFAULT;
  return {
    OPTIONS: options,
    DEFAULT: options.some((option) => option.value === preferredDefault)
      ? preferredDefault
      : options[0].value,
  };
}

const parseCount = (value: string | undefined): number | undefined => {
  if (!value) return undefined;
  const normalized = value.trim().replace(/,/g, '');
  const match = /^(\d+(?:\.\d+)?)\s*([km])?$/i.exec(normalized);
  if (!match) return undefined;
  const multiplier = match[2]?.toLowerCase() === 'm'
    ? 1_000_000
    : match[2]?.toLowerCase() === 'k'
      ? 1_000
      : 1;
  const count = Number(match[1]) * multiplier;
  return Number.isInteger(count) && count > 0 ? count : undefined;
};

const splitLegacyRow = (line: string): string[] => {
  if (/[│┃║]/.test(line)) {
    return line.split(/[│┃║]/).map((column) => column.trim()).filter(Boolean);
  }
  return line.trim().split(/\s{2,}/).map((column) => column.trim()).filter(Boolean);
};

/** Robust compatibility parser for pre-JSON OMP box/plain model tables. */
export function parseOmpLegacyModelsTable(stdout: string): ProviderModelsDefinition | null {
  const options: ProviderModelOption[] = [];
  const seen = new Set<string>();

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (
      !line
      || /^(no models|use \/login|warning:)/i.test(line)
      || /^[┌┬┐├┼┤└┴┘─═╭╮╰╯━┃┏┓┗┛┣┫┳┻╋+|\-\s]+$/.test(line)
    ) {
      continue;
    }

    const columns = splitLegacyRow(line);
    if (columns.length < 2) continue;
    const [provider, modelId, context, maxOutput, thinking] = columns;
    if (
      !provider
      || !modelId
      || /^(provider|model)$/i.test(provider)
      || /^(provider|model)$/i.test(modelId)
      || /\s/.test(provider)
      || /[┌┬┐├┼┤└┴┘─═│┃║]/.test(`${provider}${modelId}`)
    ) {
      continue;
    }

    const value = `${provider}/${modelId}`;
    if (seen.has(value)) continue;
    seen.add(value);
    options.push({
      value,
      label: `${modelId} (${provider})`,
      description: provider,
      runtimeContextWindow: parseCount(context),
      runtimeMaxOutputTokens: parseCount(maxOutput),
      effort: /^(yes|true)$/i.test(thinking || '')
        ? { values: LEGACY_THINKING_LEVELS }
        : undefined,
    });
  }

  if (options.length === 0) return null;
  const preferredDefault = OMP_FALLBACK_MODELS.DEFAULT;
  return {
    OPTIONS: options,
    DEFAULT: options.some((option) => option.value === preferredDefault)
      ? preferredDefault
      : options[0].value,
  };
}

/** Execute one catalog command with bounded output and explicit exit handling. */
export const runOmpModelCommand = (
  argv: string[],
  dependencies: { spawn?: SpawnFunction; timeoutMs?: number } = {},
): Promise<string | null> => new Promise((resolve) => {
  const spawn = dependencies.spawn ?? crossSpawn;
  let child: ReturnType<SpawnFunction>;
  try {
    child = spawn('omp', argv, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });
  } catch {
    resolve(null);
    return;
  }

  let stdout = '';
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const finish = (value: string | null) => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    resolve(value);
  };
  timer = setTimeout(() => {
    try {
      child.kill('SIGTERM');
    } catch {
      // Already gone.
    }
    finish(null);
  }, dependencies.timeoutMs ?? OMP_MODELS_TIMEOUT_MS);

  child.stdout?.on('data', (data) => {
    stdout += data.toString();
  });
  child.on('error', () => finish(null));
  child.on('close', (code) => finish(code === 0 ? stdout : null));
});

export class OmpProviderModels implements IProviderModels {
  private readonly runCommand: RunCommand;

  constructor(dependencies: { runCommand?: RunCommand } = {}) {
    this.runCommand = dependencies.runCommand ?? ((argv) => runOmpModelCommand(argv));
  }

  async getSupportedModels(_options?: { bypassCache?: boolean }): Promise<ProviderModelsDefinition> {
    const jsonOutput = await this.runCommand(['models', '--json']);
    if (jsonOutput !== null) {
      const jsonModels = parseOmpModelsJson(jsonOutput);
      if (jsonModels) return jsonModels;
    }

    // Compatibility only for OMP releases predating the JSON catalog contract.
    const legacyOutput = await this.runCommand(['models']);
    if (legacyOutput !== null) {
      const legacyModels = parseOmpLegacyModelsTable(legacyOutput);
      if (legacyModels) return legacyModels;
    }

    return OMP_FALLBACK_MODELS;
  }

  async getCurrentActiveModel(sessionId?: string): Promise<ProviderCurrentActiveModel> {
    void sessionId;
    return buildDefaultProviderCurrentActiveModel(await this.getSupportedModels());
  }

  async changeActiveModel(
    input: ProviderChangeActiveModelInput,
  ): Promise<ProviderSessionActiveModelChange> {
    return writeProviderSessionActiveModelChange('omp', input);
  }
}
