import { readFile } from 'node:fs/promises';

import { sessionsDb } from '@/modules/database/index.js';
import {
  buildClaudeModelsDefinition,
  probeClaudeCliModels,
} from '@/modules/providers/list/claude/claude-models.probe.js';
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

const FULL_EFFORT = {
  default: 'high',
  values: [
    { value: 'low' },
    { value: 'medium' },
    { value: 'high' },
    { value: 'xhigh' },
    { value: 'max' },
  ],
} as const;

/**
 * Last-resort catalog used only when the installed Claude CLI cannot be probed.
 *
 * Descriptions here are deliberately generation-agnostic: model aliases are
 * remapped to newer generations by CLI releases, so naming a version in this
 * file guarantees it will eventually lie to the user. The live probe in
 * `claude-models.probe.ts` is the source of truth for versioned labels.
 */
export const CLAUDE_FALLBACK_MODELS: ProviderModelsDefinition = {
  OPTIONS: [
    {
      value: 'default',
      label: 'Default (recommended)',
      description: 'Use the Claude Code default model',
      effort: { ...FULL_EFFORT, values: [...FULL_EFFORT.values] },
    },
    {
      value: 'fable',
      label: 'Fable',
      description: 'Most capable for your hardest and longest-running tasks',
      effort: { ...FULL_EFFORT, values: [...FULL_EFFORT.values] },
    },
    {
      value: 'sonnet',
      label: 'Sonnet',
      description: 'Efficient for routine tasks',
      effort: { ...FULL_EFFORT, values: [...FULL_EFFORT.values] },
    },
    {
      value: 'sonnet[1m]',
      label: 'Sonnet (1M context)',
      description: 'Sonnet for long sessions',
      effort: { ...FULL_EFFORT, values: [...FULL_EFFORT.values] },
    },
    {
      value: 'opus',
      label: 'Opus',
      description: 'Best for everyday, complex tasks',
      effort: { ...FULL_EFFORT, values: [...FULL_EFFORT.values] },
    },
    {
      value: 'opus[1m]',
      label: 'Opus (1M context)',
      description: 'Opus with 1M context · Best for everyday, complex tasks',
      effort: { ...FULL_EFFORT, values: [...FULL_EFFORT.values] },
    },
    {
      value: 'haiku',
      label: 'Haiku',
      description: 'Fastest for quick answers',
    },
  ],
  DEFAULT: 'default',
};

/**
 * Resolves one model identifier against a catalog.
 *
 * Sessions and settings can carry either the CLI alias (`opus[1m]`) or the
 * concrete model id the CLI resolved it to (`claude-opus-5[1m]`), so both are
 * accepted.
 */
export const findClaudeModelOptionIn = (
  definition: ProviderModelsDefinition,
  model: string | undefined | null,
): ProviderModelOption | null => {
  const normalizedModel = typeof model === 'string' ? model.trim() : '';
  if (!normalizedModel) {
    return null;
  }

  return definition.OPTIONS.find((option) => option.value === normalizedModel)
    ?? definition.OPTIONS.find((option) => option.resolvedModel === normalizedModel)
    ?? null;
};

export const findClaudeModelOption = (model: string | undefined | null): ProviderModelOption | null =>
  findClaudeModelOptionIn(CLAUDE_FALLBACK_MODELS, model);

/**
 * Every CLI alias a run's `model` column can carry at request time
 * ('default', 'sonnet', 'opus[1m]', ...) — each one gets remapped by the CLI
 * to a concrete generation ('claude-sonnet-5', 'claude-opus-5[1m]', ...),
 * which is what every token_budget event actually reports. Used to decide
 * when a run's stored model is a request-time alias worth superseding with
 * the resolved id, rather than a value to leave alone (see
 * runs.service.ts recordProviderUsage and completed-run reconciliation
 * resolveUnresolvedModels) — without this, Stats fragments one real model
 * into an alias bucket and a resolved-id bucket.
 */
export const CLAUDE_MODEL_ALIASES: readonly string[] = CLAUDE_FALLBACK_MODELS.OPTIONS.map(
  (option) => option.value,
);
type ClaudeInitEvent = {
  sessionId?: string;
  session_id?: string;
  type?: string;
  subtype?: string;
  model?: string;
  message?: {
    content?: unknown;
    model?: string;
  };
};

const ANSI_PATTERN = new RegExp(
  '[\\u001B\\u009B][[\\]()#;?]*(?:'
  + '(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]'
  + '|(?:[\\dA-PR-TZcf-ntqry=><~]))',
  'g',
);

const extractClaudeEventModel = (event: ClaudeInitEvent, sessionId: string): string | null => {
  const eventSessionId = event.sessionId ?? event.session_id;
  if (eventSessionId && eventSessionId !== sessionId) {
    return null;
  }

  const contentModel = extractClaudeModelFromMessageContent(event.message?.content);
  if (contentModel) {
    return contentModel;
  }

  const directModel = event.model?.trim();
  if (directModel) {
    return directModel;
  }

  const messageModel = event.message?.model?.trim();
  return messageModel || null;
};

const stripAnsi = (value: string): string => value.replace(ANSI_PATTERN, '');

const extractTaggedContent = (content: string, tagName: string): string | null => {
  const escapedTagName = tagName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`<${escapedTagName}>([\\s\\S]*?)<\\/${escapedTagName}>`).exec(content);
  return match ? match[1] : null;
};

const extractClaudeModelFromTextContent = (content: string): string | null => {
  const localCommandStdout = extractTaggedContent(content, 'local-command-stdout');
  if (localCommandStdout !== null) {
    const cleanedStdout = stripAnsi(localCommandStdout).replace(/\s+/g, ' ').trim();
    const changedModel = /(?:set|changed|switched)\s+model\s+to\s+(.+?)\.?$/i.exec(cleanedStdout);
    if (changedModel?.[1]?.trim()) {
      return changedModel[1].trim();
    }
  }

  const modelTag = extractTaggedContent(content, 'model')?.trim();
  return modelTag || null;
};

const extractClaudeModelFromMessageContent = (content: unknown): string | null => {
  if (typeof content === 'string') {
    return extractClaudeModelFromTextContent(content);
  }

  if (!Array.isArray(content)) {
    return null;
  }

  for (const part of content) {
    if (!part || typeof part !== 'object' || !('text' in part) || typeof part.text !== 'string') {
      continue;
    }

    const model = extractClaudeModelFromTextContent(part.text);
    if (model) {
      return model;
    }
  }

  return null;
};

const readClaudeSessionModelFromJsonl = async (
  sessionId: string,
  jsonlPath: string,
): Promise<ProviderCurrentActiveModel | null> => {
  const content = await readFile(jsonlPath, 'utf8');
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const event = JSON.parse(lines[index]) as ClaudeInitEvent;
      const model = extractClaudeEventModel(event, sessionId);
      if (model) {
        return { model };
      }
    } catch {
      // Skip malformed JSONL lines that can happen during concurrent writes.
    }
  }

  return null;
};

/**
 * Short-lived memo around the CLI probe.
 *
 * The probe spawns a CLI subprocess (~0.4s), and `getSupportedModels()` runs on
 * every chat turn to resolve effort levels, so an unmemoized probe would spawn
 * one process per message. The window stays small so a CLI upgrade shows up in
 * the picker almost immediately.
 */
const PROBE_MEMO_TTL_MS = 60_000;

let memoizedModels: { models: ProviderModelsDefinition; expiresAt: number } | null = null;
let inFlightProbe: Promise<ProviderModelsDefinition> | null = null;

export const clearClaudeModelsProbeCache = (): void => {
  memoizedModels = null;
  inFlightProbe = null;
};

const loadClaudeModels = async (): Promise<ProviderModelsDefinition> => {
  try {
    const probed = await probeClaudeCliModels();
    const definition = buildClaudeModelsDefinition(probed, CLAUDE_FALLBACK_MODELS.DEFAULT);
    if (definition) {
      return definition;
    }

    console.warn('Claude CLI reported no usable models; using the built-in catalog.');
  } catch (error) {
    console.warn(
      'Unable to read models from the Claude CLI; using the built-in catalog:',
      error instanceof Error ? error.message : error,
    );
  }

  return CLAUDE_FALLBACK_MODELS;
};

export class ClaudeProviderModels implements IProviderModels {
  /**
   * Reads the model catalog from the installed Claude CLI.
   *
   * Anything hardcoded here drifts the moment a CLI release remaps an alias to
   * a new model generation, which is why the CLI is asked directly and the
   * static catalog is only a fallback.
   */
  async getSupportedModels(): Promise<ProviderModelsDefinition> {
    if (memoizedModels && memoizedModels.expiresAt > Date.now()) {
      return memoizedModels.models;
    }

    if (inFlightProbe) {
      return inFlightProbe;
    }

    inFlightProbe = loadClaudeModels()
      .then((models) => {
        memoizedModels = { models, expiresAt: Date.now() + PROBE_MEMO_TTL_MS };
        return models;
      })
      .finally(() => {
        inFlightProbe = null;
      });

    return inFlightProbe;
  }

  async getCurrentActiveModel(sessionId?: string): Promise<ProviderCurrentActiveModel> {
    if (!sessionId?.trim()) {
      return buildDefaultProviderCurrentActiveModel(await this.getSupportedModels());
    }

    try {
      const jsonlPath = sessionsDb.getSessionById(sessionId)?.jsonl_path;
      const activeModel = jsonlPath
        ? await readClaudeSessionModelFromJsonl(sessionId, jsonlPath)
        : null;
      if (activeModel?.model) {
        return activeModel;
      }
    } catch {
      // Fall through to the provider default when the session-backed lookup fails.
    }

    return buildDefaultProviderCurrentActiveModel(await this.getSupportedModels());
  }

  async changeActiveModel(
    input: ProviderChangeActiveModelInput,
  ): Promise<ProviderSessionActiveModelChange> {
    return writeProviderSessionActiveModelChange('claude', input);
  }
}
