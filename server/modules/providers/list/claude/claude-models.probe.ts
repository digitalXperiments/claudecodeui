import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { query } from '@anthropic-ai/claude-agent-sdk';

import { resolveClaudeCodeExecutablePath } from '@/shared/claude-cli-path.js';
import type { ProviderModelOption, ProviderModelsDefinition } from '@/shared/types.js';

/**
 * Model entry as reported by the installed Claude Code CLI over the SDK control
 * channel. `resolvedModel` is newer than the SDK type definitions, so it is
 * declared here instead of relying on `ModelInfo`.
 */
export type ClaudeCliModelInfo = {
  value?: string;
  resolvedModel?: string;
  displayName?: string;
  description?: string;
  supportsEffort?: boolean;
  supportedEffortLevels?: string[];
};

const PROBE_TIMEOUT_MS = 20_000;
const PREFERRED_DEFAULT_EFFORT = 'high';

/**
 * Prompt stream that never yields a message.
 *
 * `supportedModels()` only needs the control-channel initialize handshake, so
 * withholding the first user message keeps the CLI from starting a turn — which
 * is what would otherwise create a stray session JSONL next to real sessions.
 */
const createIdlePrompt = async function* (): AsyncGenerator<never> {
  await new Promise<never>(() => {});
};

/**
 * Asks the installed Claude Code CLI which models it currently supports.
 *
 * The CLI is the only accurate source: model aliases (`opus`, `sonnet`) are
 * remapped to new generations by CLI releases, so any list hardcoded in
 * CloudCLI goes stale silently. Runs in a throwaway cwd so the probe cannot
 * touch the caller's project state.
 */
export const probeClaudeCliModels = async (): Promise<ClaudeCliModelInfo[]> => {
  const probeCwd = await mkdtemp(path.join(os.tmpdir(), 'cloudcli-claude-models-'));

  let queryInstance: ReturnType<typeof query> | null = null;
  let timeoutHandle: NodeJS.Timeout | null = null;

  try {
    queryInstance = query({
      prompt: createIdlePrompt(),
      options: {
        cwd: probeCwd,
        env: { ...process.env },
        pathToClaudeCodeExecutable: resolveClaudeCodeExecutablePath(process.env.CLAUDE_CLI_PATH),
      },
    });

    const activeQuery = queryInstance;
    const models = await Promise.race([
      activeQuery.supportedModels() as Promise<ClaudeCliModelInfo[]>,
      new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(
          () => reject(new Error(`Claude CLI model probe timed out after ${PROBE_TIMEOUT_MS}ms`)),
          PROBE_TIMEOUT_MS,
        );
      }),
    ]);

    return Array.isArray(models) ? models : [];
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }

    try {
      await queryInstance?.close?.();
    } catch {
      // The probe subprocess is disposable; a failed close must not surface.
    }

    await rm(probeCwd, { recursive: true, force: true }).catch(() => {});
  }
};

const normalizeEffortLevels = (levels: string[] | undefined): string[] => {
  if (!Array.isArray(levels)) {
    return [];
  }

  const seen = new Set<string>();
  for (const level of levels) {
    const normalized = typeof level === 'string' ? level.trim() : '';
    if (normalized) {
      seen.add(normalized);
    }
  }

  return [...seen];
};

const buildEffort = (info: ClaudeCliModelInfo): ProviderModelOption['effort'] => {
  const values = normalizeEffortLevels(info.supportedEffortLevels);
  if (info.supportsEffort === false || values.length === 0) {
    return undefined;
  }

  return {
    default: values.includes(PREFERRED_DEFAULT_EFFORT)
      ? PREFERRED_DEFAULT_EFFORT
      : values[values.length - 1],
    values: values.map((value) => ({ value })),
  };
};

export const toClaudeProviderModelOption = (
  info: ClaudeCliModelInfo,
): ProviderModelOption | null => {
  const value = typeof info.value === 'string' ? info.value.trim() : '';
  if (!value) {
    return null;
  }

  const resolvedModel = typeof info.resolvedModel === 'string' ? info.resolvedModel.trim() : '';
  const label = typeof info.displayName === 'string' && info.displayName.trim()
    ? info.displayName.trim()
    : value;
  const description = typeof info.description === 'string' && info.description.trim()
    ? info.description.trim()
    : undefined;
  const effort = buildEffort(info);

  return {
    value,
    label,
    ...(description ? { description } : {}),
    // Sessions report the concrete model id (`claude-opus-5[1m]`) while the
    // catalog is keyed by alias (`opus[1m]`). Keeping the resolved id lets the
    // UI match a running session back to its catalog entry.
    ...(resolvedModel && resolvedModel !== value ? { resolvedModel } : {}),
    ...(effort ? { effort } : {}),
  };
};

/**
 * Converts the CLI-reported model list into the provider catalog shape.
 *
 * Returns `null` when the CLI reported nothing usable so callers can fall back
 * to the static catalog instead of showing an empty model picker.
 */
export const buildClaudeModelsDefinition = (
  models: ClaudeCliModelInfo[],
  fallbackDefault: string,
): ProviderModelsDefinition | null => {
  const options: ProviderModelOption[] = [];
  const seenValues = new Set<string>();

  for (const info of models) {
    const option = toClaudeProviderModelOption(info);
    if (!option || seenValues.has(option.value)) {
      continue;
    }

    seenValues.add(option.value);
    options.push(option);
  }

  if (options.length === 0) {
    return null;
  }

  return {
    OPTIONS: options,
    DEFAULT: seenValues.has(fallbackDefault) ? fallbackDefault : options[0].value,
  };
};
