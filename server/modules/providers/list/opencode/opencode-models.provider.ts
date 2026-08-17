import Database from 'better-sqlite3';
import crossSpawn from 'cross-spawn';

import type { IProviderModels } from '@/shared/interfaces.js';
import type {
  LLMProvider,
  ProviderChangeActiveModelInput,
  ProviderCurrentActiveModel,
  ProviderModelOption,
  ProviderModelsDefinition,
  ProviderSessionActiveModelChange,
} from '@/shared/types.js';
import {
  buildDefaultProviderCurrentActiveModel,
  getOpenCodeDatabasePath,
  readObjectRecord,
  readOptionalString,
  writeProviderSessionActiveModelChange,
} from '@/shared/utils.js';
import { resolveAcpCliCommand } from '@/shared/acp-cli-path.js';

export const OPENCODE_FALLBACK_MODELS: ProviderModelsDefinition = {
  OPTIONS: [
    {
      value: 'anthropic/claude-sonnet-4-5',
      label: 'Claude Sonnet 4.5',
      description: 'anthropic - anthropic/claude-sonnet-4-5',
    },
    {
      value: 'anthropic/claude-opus-4-1',
      label: 'Claude Opus 4.1',
      description: 'anthropic - anthropic/claude-opus-4-1',
    },
    {
      value: 'anthropic/claude-haiku-4-5',
      label: 'Claude Haiku 4.5',
      description: 'anthropic - anthropic/claude-haiku-4-5',
    },
    {
      value: 'openai/gpt-5.1',
      label: 'GPT-5.1',
      description: 'openai - openai/gpt-5.1',
    },
    {
      value: 'openai/gpt-5.1-codex',
      label: 'GPT-5.1 Codex',
      description: 'openai - openai/gpt-5.1-codex',
    },
    {
      value: 'openai/gpt-5.4-mini',
      label: 'GPT-5.4 Mini',
      description: 'openai - openai/gpt-5.4-mini',
    },
  ],
  DEFAULT: 'anthropic/claude-sonnet-4-5',
};

export type OpenCodeProviderModelsOptions = {
  provider?: LLMProvider;
  command?: string;
  databasePath?: string;
  fallbackModels?: ProviderModelsDefinition;
};

const OPEN_CODE_MODELS_TIMEOUT_MS = 20_000;
// The provider is the first path segment; the model id after it is opaque and
// may itself contain slashes (OpenRouter ids such as `openrouter/z-ai/glm-5.2`)
// or punctuation such as `:free`.
const MODEL_ID_LINE = /^[a-z0-9][a-z0-9._-]*\/[^\s/][^\s]*$/i;
// cross-spawn resolves .cmd shims/PATHEXT on Windows and delegates to
// child_process.spawn everywhere else.
const spawnFunction = crossSpawn;
const DATE_TOKEN = /^\d{8}$/;
const SIMPLE_NUMBER_TOKEN = /^\d$/;
const VERSION_TOKEN = /^[a-z]\d+$/i;
const NUMERIC_TOKEN = /^\d+(?:\.\d+)*$/;
const SHORT_ACRONYM_TOKEN = /^[a-z]{2,3}$/;

type OpenCodeVerboseModel = {
  id?: string;
  name?: string;
  providerID?: string;
  status?: string;
  variants?: Record<string, unknown>;
  capabilities?: {
    toolcall?: boolean;
    input?: { text?: boolean };
    output?: { text?: boolean };
  };
};

export const parseOpenCodeModelsStdout = (stdout: string): string[] => {
  const ids: string[] = [];

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('{') || line.startsWith('[')) {
      continue;
    }

    if (MODEL_ID_LINE.test(line)) {
      ids.push(line);
    }
  }

  return [...new Set(ids)];
};

const countJsonBraceDelta = (value: string): number => {
  let delta = 0;
  let inString = false;
  let escaped = false;

  for (const character of value) {
    if (escaped) {
      escaped = false;
      continue;
    }

    if (character === '\\') {
      escaped = inString;
      continue;
    }

    if (character === '"') {
      inString = !inString;
      continue;
    }

    if (inString) {
      continue;
    }

    if (character === '{') {
      delta += 1;
    } else if (character === '}') {
      delta -= 1;
    }
  }

  return delta;
};

const isOpenCodeVerboseModel = (value: unknown): value is OpenCodeVerboseModel => {
  const record = readObjectRecord(value);
  return Boolean(record && readOptionalString(record.id));
};

export const parseOpenCodeVerboseModelsStdout = (stdout: string): OpenCodeVerboseModel[] => {
  const models: OpenCodeVerboseModel[] = [];
  let buffer: string[] = [];
  let depth = 0;

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (buffer.length === 0) {
      if (line === '{') {
        buffer = [rawLine];
        depth = 1;
      }
      continue;
    }

    buffer.push(rawLine);
    depth += countJsonBraceDelta(rawLine);

    if (depth !== 0) {
      continue;
    }

    try {
      const parsed = JSON.parse(buffer.join('\n'));
      if (isOpenCodeVerboseModel(parsed)) {
        models.push(parsed);
      }
    } catch {
      // Ignore malformed verbose blocks and fall back to the plain id parser.
    }

    buffer = [];
  }

  return models;
};

const formatDateToken = (token: string): string => (
  `${token.slice(0, 4)}-${token.slice(4, 6)}-${token.slice(6, 8)}`
);

const formatModelToken = (token: string, nextToken?: string): string => {
  const lower = token.toLowerCase();

  if (VERSION_TOKEN.test(token)) {
    return token.toUpperCase();
  }

  if (SHORT_ACRONYM_TOKEN.test(lower) && nextToken && NUMERIC_TOKEN.test(nextToken)) {
    return token.toUpperCase();
  }

  return lower.charAt(0).toUpperCase() + lower.slice(1);
};

const formatOpenCodeModelSlug = (slug: string): string => {
  const labelParts: string[] = [];
  const dateParts: string[] = [];
  const tokens = slug.split('-').filter(Boolean);

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const nextToken = tokens[index + 1];

    if (DATE_TOKEN.test(token)) {
      dateParts.push(formatDateToken(token));
      continue;
    }

    if (SIMPLE_NUMBER_TOKEN.test(token) && nextToken && SIMPLE_NUMBER_TOKEN.test(nextToken)) {
      labelParts.push(`${token}.${nextToken}`);
      index += 1;
      continue;
    }

    labelParts.push(formatModelToken(token, nextToken));
  }

  const label = (labelParts.join(' ').trim() || slug).replace(/^GPT\s+/, 'GPT-');
  if (dateParts.length === 0) {
    return label;
  }

  return `${label} (${dateParts.join(', ')})`;
};

const readOpenCodeModelParts = (id: string): { upstreamProvider: string; slug: string } => {
  const separatorIndex = id.indexOf('/');
  if (separatorIndex < 0) {
    return {
      upstreamProvider: '',
      slug: id,
    };
  }

  return {
    upstreamProvider: id.slice(0, separatorIndex),
    slug: id.slice(separatorIndex + 1),
  };
};

const isSupportedOpenCodeModelId = (id: string): boolean => (
  readOpenCodeModelParts(id).upstreamProvider.toLowerCase() !== 'google'
);

/** Models shown as coding agents must be able to take text, return text, and use tools. */
const isAgentCompatibleOpenCodeModel = (model: OpenCodeVerboseModel): boolean => {
  if (model.status && model.status !== 'active') {
    return false;
  }

  const capabilities = model.capabilities;
  return capabilities?.input?.text !== false
    && capabilities?.output?.text !== false
    && capabilities?.toolcall !== false;
};

const readOpenCodeVerboseModelId = (model: OpenCodeVerboseModel): string | null => {
  const id = readOptionalString(model.id);
  if (!id) {
    return null;
  }

  const upstreamProvider = readOptionalString(model.providerID);
  if (!upstreamProvider || id.startsWith(`${upstreamProvider}/`)) {
    return id;
  }

  // `id` is provider-local even when it contains a slash. For example,
  // OpenRouter reports `{ providerID: "openrouter", id: "z-ai/glm-5.2" }`.
  // Returning the local id by itself silently selects a different provider (or
  // collides with its native entry) when ACP applies the model option.
  return `${upstreamProvider}/${id}`;
};

const labelForOpenCodeModelId = (
  id: string,
  fallbackModels: ProviderModelsDefinition = OPENCODE_FALLBACK_MODELS,
): string => {
  const fallbackLabel = fallbackModels.OPTIONS.find((option) => option.value === id)?.label;
  if (fallbackLabel) {
    return fallbackLabel;
  }

  const { slug } = readOpenCodeModelParts(id);
  return formatOpenCodeModelSlug(slug);
};

const descriptionForOpenCodeModelId = (id: string): string => {
  const { upstreamProvider } = readOpenCodeModelParts(id);
  return upstreamProvider ? `${upstreamProvider} - ${id}` : id;
};

const readOpenCodeVariantEffort = (key: string, value: unknown): string | null => {
  const variant = readObjectRecord(value);
  return readOptionalString(variant?.reasoningEffort)
    ?? readOptionalString(variant?.effort)
    ?? key;
};

const readOpenCodeEffortValues = (
  variants: OpenCodeVerboseModel['variants'],
): NonNullable<ProviderModelOption['effort']>['values'] => {
  const effortValues: NonNullable<ProviderModelOption['effort']>['values'] = [];
  const seenValues = new Set<string>();

  for (const [key, value] of Object.entries(variants ?? {})) {
    const effort = readOpenCodeVariantEffort(key, value);
    if (!effort || seenValues.has(effort)) {
      continue;
    }

    seenValues.add(effort);
    effortValues.push({ value: effort });
  }

  return effortValues;
};

const mapOpenCodeVerboseModel = (
  model: OpenCodeVerboseModel,
  fallbackModels: ProviderModelsDefinition,
): ProviderModelOption | null => {
  const value = readOpenCodeVerboseModelId(model);
  if (!value || !isSupportedOpenCodeModelId(value) || !isAgentCompatibleOpenCodeModel(model)) {
    return null;
  }

  const effortValues = readOpenCodeEffortValues(model.variants);

  return {
    value,
    label: readOptionalString(model.name) ?? labelForOpenCodeModelId(value, fallbackModels),
    description: descriptionForOpenCodeModelId(value),
    effort: effortValues.length > 0
      ? {
          values: effortValues,
        }
      : undefined,
  };
};

export const buildOpenCodeDefinitionFromIds = (
  ids: string[],
  fallbackModels: ProviderModelsDefinition = OPENCODE_FALLBACK_MODELS,
): ProviderModelsDefinition => {
  const options: ProviderModelOption[] = ids
    .filter(isSupportedOpenCodeModelId)
    .map((value) => ({
      value,
      label: labelForOpenCodeModelId(value, fallbackModels),
      description: descriptionForOpenCodeModelId(value),
    }));

  const defaultValue = options.find((option) => option.value === fallbackModels.DEFAULT)?.value
    ?? options[0]?.value
    ?? fallbackModels.DEFAULT;

  return {
    OPTIONS: options,
    DEFAULT: defaultValue,
  };
};

export const buildOpenCodeDefinitionFromVerboseModels = (
  models: OpenCodeVerboseModel[],
  fallbackModels: ProviderModelsDefinition = OPENCODE_FALLBACK_MODELS,
): ProviderModelsDefinition => {
  const options: ProviderModelOption[] = [];
  const seenValues = new Set<string>();

  for (const model of models) {
    const mappedModel = mapOpenCodeVerboseModel(model, fallbackModels);
    if (!mappedModel || seenValues.has(mappedModel.value)) {
      continue;
    }

    seenValues.add(mappedModel.value);
    options.push(mappedModel);
  }

  if (options.length === 0) {
    return fallbackModels;
  }

  const defaultValue = options.find((option) => option.value === fallbackModels.DEFAULT)?.value
    ?? options[0]?.value
    ?? fallbackModels.DEFAULT;

  return {
    OPTIONS: options,
    DEFAULT: defaultValue,
  };
};

const parseOpenCodeSessionModelValue = (rawModel: unknown): string | null => {
  if (typeof rawModel === 'string') {
    const trimmed = rawModel.trim();
    if (!trimmed) {
      return null;
    }

    try {
      return parseOpenCodeSessionModelValue(JSON.parse(trimmed));
    } catch {
      return trimmed;
    }
  }

  const record = readObjectRecord(rawModel);
  if (!record) {
    return null;
  }

  return readOptionalString(record.id)
    ?? readOptionalString(record.model)
    ?? readOptionalString(record.name)
    ?? readOptionalString(record.value)
    ?? null;
};

const runOpenCodeModelsCommand = (command: string): Promise<string> => new Promise((resolve, reject) => {
  // Resolve through PATH plus the installer's `~/.<name>/bin` location: a
  // GUI-launched server never sources the shell profile that puts it on PATH.
  const openCodeProcess = spawnFunction(resolveAcpCliCommand(command), ['models', '--verbose'], {
    cwd: process.cwd(),
    env: { ...process.env },
  });

  let stdout = '';
  let stderr = '';
  let settled = false;

  const timer = setTimeout(() => {
    openCodeProcess.kill('SIGTERM');
    if (!settled) {
      settled = true;
      reject(new Error(`${command} models timed out`));
    }
  }, OPEN_CODE_MODELS_TIMEOUT_MS);

  const finish = (error: Error | null, output: string) => {
    if (settled) {
      return;
    }

    settled = true;
    clearTimeout(timer);

    if (error) {
      reject(error);
      return;
    }

    resolve(output);
  };

  openCodeProcess.stdout?.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
  });

  openCodeProcess.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  openCodeProcess.on('error', (error) => {
    finish(error instanceof Error ? error : new Error(String(error)), '');
  });

  openCodeProcess.on('close', (code) => {
    if (code !== 0) {
      finish(new Error(stderr.trim() || `${command} models exited with code ${code}`), '');
      return;
    }

    finish(null, stdout);
  });
});

export class OpenCodeProviderModels implements IProviderModels {
  private readonly provider: LLMProvider;
  private readonly command: string;
  private readonly databasePath: string;
  private readonly fallbackModels: ProviderModelsDefinition;

  constructor(options: OpenCodeProviderModelsOptions = {}) {
    this.provider = options.provider ?? 'opencode';
    this.command = options.command ?? 'opencode';
    this.databasePath = options.databasePath ?? getOpenCodeDatabasePath();
    this.fallbackModels = options.fallbackModels ?? OPENCODE_FALLBACK_MODELS;
  }

  async getSupportedModels(): Promise<ProviderModelsDefinition> {
    try {
      const stdout = await runOpenCodeModelsCommand(this.command);
      const verboseModels = parseOpenCodeVerboseModelsStdout(stdout);
      if (verboseModels.length > 0) {
        return buildOpenCodeDefinitionFromVerboseModels(verboseModels, this.fallbackModels);
      }

      const ids = parseOpenCodeModelsStdout(stdout);
      if (ids.length === 0) {
        return this.fallbackModels;
      }

      return buildOpenCodeDefinitionFromIds(ids, this.fallbackModels);
    } catch {
      return this.fallbackModels;
    }
  }

  async getCurrentActiveModel(sessionId?: string): Promise<ProviderCurrentActiveModel> {
    if (!sessionId?.trim()) {
      return buildDefaultProviderCurrentActiveModel(await this.getSupportedModels());
    }

    try {
      const dbPath = this.databasePath;
      const db = new Database(dbPath, { readonly: true, fileMustExist: true });

      try {
        const row = db.prepare(`
          SELECT
            s.id AS sessionId,
            s.model AS model,
            s.agent AS agent,
            s.directory AS directory,
            s.time_updated AS timeUpdated,
            s.time_created AS timeCreated
          FROM session s
          WHERE s.id = ?
          ORDER BY COALESCE(s.time_updated, s.time_created, 0) DESC
          LIMIT 1
        `).get(sessionId) as {
          sessionId?: string;
          model?: unknown;
          agent?: string | null;
          directory?: string | null;
          timeUpdated?: number | null;
          timeCreated?: number | null;
        } | undefined;

        const model = parseOpenCodeSessionModelValue(row?.model);
        if (model) {
          return {
            model,
          };
        }
      } finally {
        db.close();
      }
    } catch {
      // Fall through to the provider default when OpenCode session lookup fails.
    }

    return buildDefaultProviderCurrentActiveModel(await this.getSupportedModels());
  }

  async changeActiveModel(
    input: ProviderChangeActiveModelInput,
  ): Promise<ProviderSessionActiveModelChange> {
    return writeProviderSessionActiveModelChange(this.provider, input);
  }
}
