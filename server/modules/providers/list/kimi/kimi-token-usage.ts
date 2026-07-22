/**
 * Kimi token usage: context occupancy (last turn input) vs session spend (sum of turns).
 *
 * Usage is persisted as `usage.record` lines in
 * `~/.kimi-code/sessions/<wd>/<sessionId>/agents/main/wire.jsonl` with
 * `usageScope: "turn"`. Summing every line inflates the badge the same way Grok
 * did; the latest turn's input total is the live context fill.
 */

import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import TOML from '@iarna/toml';

import { readObjectRecord, readOptionalString } from '@/shared/utils.js';

const KIMI_SESSIONS_ROOT = path.join(os.homedir(), '.kimi-code', 'sessions');
const KIMI_CONFIG_PATH = path.join(os.homedir(), '.kimi-code', 'config.toml');

export type KimiSessionTokenUsage = {
  used: number;
  total: number;
  contextUsed: number;
  contextWindow: number;
  contextFree: number;
  contextPercent: number | null;
  lastTurnInputTokens: number;
  lastTurnOutputTokens: number;
  inputTokens: number;
  outputTokens: number;
  billedInputTokens: number;
  billedOutputTokens: number;
  cumulativeUsed: number;
  model: string | null;
  provider: 'kimi';
  breakdown: { input: number; output: number };
};

function readUsageNumbers(usage: Record<string, unknown>): { input: number; output: number } {
  const input =
    Number(usage.inputOther || 0) +
    Number(usage.inputCacheRead || 0) +
    Number(usage.inputCacheCreation || 0);
  const output = Number(usage.output || 0);
  return {
    input: Number.isFinite(input) ? input : 0,
    output: Number.isFinite(output) ? output : 0,
  };
}

/** Resolve session dir by scanning workdir folders for the provider-native id. */
export function findKimiSessionDir(providerSessionId: string): string | null {
  if (!providerSessionId) {
    return null;
  }
  const candidates = [
    providerSessionId,
    providerSessionId.startsWith('session_') ? providerSessionId : `session_${providerSessionId}`,
  ];
  try {
    const workDirs = fsSync.readdirSync(KIMI_SESSIONS_ROOT);
    for (const workDir of workDirs) {
      for (const id of candidates) {
        const candidate = path.join(KIMI_SESSIONS_ROOT, workDir, id);
        if (fsSync.existsSync(candidate)) {
          return candidate;
        }
      }
    }
  } catch {
    return null;
  }
  return null;
}

function readKimiModelContextWindow(modelId: string | null): number {
  if (!modelId) {
    return 200_000;
  }
  try {
    const content = fsSync.readFileSync(KIMI_CONFIG_PATH, 'utf8');
    const parsed = TOML.parse(content) as Record<string, unknown>;
    const models = readObjectRecord(parsed.models);
    if (models) {
      const info = readObjectRecord(models[modelId]);
      if (info && typeof info.max_context_size === 'number' && info.max_context_size > 0) {
        return info.max_context_size;
      }
      // Some configs store bare model id without provider prefix.
      const short = modelId.includes('/') ? modelId.split('/').pop()! : modelId;
      for (const [id, raw] of Object.entries(models)) {
        if (id === modelId || id.endsWith(`/${short}`) || id === short) {
          const entry = readObjectRecord(raw);
          if (entry && typeof entry.max_context_size === 'number' && entry.max_context_size > 0) {
            return entry.max_context_size;
          }
        }
      }
    }
  } catch {
    // ignore
  }
  return 200_000;
}

export function readKimiSessionTokenUsage(sessionDir: string): KimiSessionTokenUsage {
  const wirePath = path.join(sessionDir, 'agents', 'main', 'wire.jsonl');
  let inputSum = 0;
  let outputSum = 0;
  let lastInput = 0;
  let lastOutput = 0;
  let model: string | null = null;

  try {
    const wireContent = fsSync.readFileSync(wirePath, 'utf8');
    for (const line of wireContent.trim().split('\n')) {
      if (!line) continue;
      try {
        const entry = JSON.parse(line) as Record<string, unknown>;
        if (entry?.type !== 'usage.record' || !entry.usage || typeof entry.usage !== 'object') {
          continue;
        }
        const { input, output } = readUsageNumbers(entry.usage as Record<string, unknown>);
        inputSum += input;
        outputSum += output;
        lastInput = input;
        lastOutput = output;
        const entryModel = readOptionalString(entry.model);
        if (entryModel) {
          model = entryModel;
        }
      } catch {
        // skip bad lines
      }
    }
  } catch {
    // missing wire
  }

  const contextWindow = readKimiModelContextWindow(model);
  const contextUsed = lastInput > 0 ? lastInput : 0;
  const cumulativeUsed = inputSum + outputSum;
  const used = contextUsed > 0 ? contextUsed : cumulativeUsed;
  const contextFree =
    contextWindow > 0 ? Math.max(0, contextWindow - contextUsed) : 0;
  const contextPercent =
    contextWindow > 0 && contextUsed > 0
      ? Math.min(100, Math.round((contextUsed / contextWindow) * 1000) / 10)
      : null;

  return {
    used,
    total: contextWindow,
    contextUsed,
    contextWindow,
    contextFree,
    contextPercent,
    lastTurnInputTokens: lastInput,
    lastTurnOutputTokens: lastOutput,
    inputTokens: inputSum,
    outputTokens: outputSum,
    billedInputTokens: inputSum,
    billedOutputTokens: outputSum,
    cumulativeUsed,
    model,
    provider: 'kimi',
    breakdown: {
      input: contextUsed > 0 ? contextUsed : inputSum,
      output: lastOutput,
    },
  };
}
