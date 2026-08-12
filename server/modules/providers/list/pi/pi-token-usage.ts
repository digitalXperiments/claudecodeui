import fsSync from 'node:fs';

import type { AnyRecord } from '@/shared/types.js';

export type PiSessionTokenUsage = {
  used: number;
  total: number;
  contextUsed: number;
  contextWindow: number;
  contextFree: number;
  contextPercent: number | null;
  cumulativeUsed: number;
  billedInputTokens: number;
  billedOutputTokens: number;
  lastTurnInputTokens: number;
  lastTurnOutputTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  breakdown: { input: number; output: number };
  model: string | null;
  provider: 'pi';
};

const readNumber = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
};

function readUsage(value: unknown): {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
} | null {
  const usage = value && typeof value === 'object' ? value as AnyRecord : null;
  if (!usage) return null;

  const input = readNumber(usage.input ?? usage.inputTokens ?? usage.input_tokens);
  const output = readNumber(usage.output ?? usage.outputTokens ?? usage.output_tokens);
  const cacheRead = readNumber(usage.cacheRead ?? usage.cacheReadTokens ?? usage.cache_read);
  const cacheWrite = readNumber(usage.cacheWrite ?? usage.cacheWriteTokens ?? usage.cache_write);
  const reportedTotal = readNumber(usage.totalTokens ?? usage.total_tokens);
  if (input === 0 && output === 0 && cacheRead === 0 && cacheWrite === 0 && reportedTotal === 0) {
    return null;
  }

  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    total: reportedTotal || input + output + cacheRead + cacheWrite,
  };
}

function resolveContextWindow(contextUsed: number): number {
  const configured = readNumber(process.env.PI_CONTEXT_WINDOW || process.env.CONTEXT_WINDOW);
  if (configured > 0) return configured;
  // Pi's default model catalog is currently 200k-context. This is only a
  // fallback for historical files; live get_session_stats provides the exact
  // window when the session process is still active.
  return contextUsed > 200_000 ? 1_000_000 : 200_000;
}

export function buildPiTokenUsageFromStats(stats: unknown): PiSessionTokenUsage | null {
  const record = stats && typeof stats === 'object' ? stats as AnyRecord : null;
  const tokens = record?.tokens && typeof record.tokens === 'object'
    ? record.tokens as AnyRecord
    : null;
  if (!tokens) return null;

  const context = record?.contextUsage && typeof record.contextUsage === 'object'
    ? record.contextUsage as AnyRecord
    : null;
  const input = readNumber(tokens.input);
  const output = readNumber(tokens.output);
  const cacheRead = readNumber(tokens.cacheRead);
  const cacheWrite = readNumber(tokens.cacheWrite);
  const cumulativeUsed = readNumber(tokens.total) || input + output + cacheRead + cacheWrite;
  const contextUsed = readNumber(context?.tokens) || input + cacheRead + cacheWrite;
  const contextWindow = readNumber(context?.contextWindow) || resolveContextWindow(contextUsed);

  return {
    used: contextUsed || cumulativeUsed,
    total: contextWindow,
    contextUsed,
    contextWindow,
    contextFree: Math.max(0, contextWindow - contextUsed),
    contextPercent: contextUsed > 0 && contextWindow > 0
      ? Math.min(100, Math.round((contextUsed / contextWindow) * 1000) / 10)
      : null,
    cumulativeUsed,
    billedInputTokens: input + cacheRead + cacheWrite,
    billedOutputTokens: output,
    lastTurnInputTokens: input,
    lastTurnOutputTokens: output,
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    breakdown: { input: contextUsed || input, output },
    model: typeof record?.model === 'string' ? record.model : null,
    provider: 'pi',
  };
}

export function readPiSessionTokenUsage(jsonlPath: string): PiSessionTokenUsage {
  let fileContent = '';
  try {
    fileContent = fsSync.readFileSync(jsonlPath, 'utf8');
  } catch {
    // Missing or unreadable sessions return a zero-shaped response.
  }

  let inputSum = 0;
  let outputSum = 0;
  let cacheReadSum = 0;
  let cacheWriteSum = 0;
  let latestInput = 0;
  let latestOutput = 0;
  let latestCacheRead = 0;
  let latestCacheWrite = 0;
  let model: string | null = null;

  for (const line of fileContent.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let entry: AnyRecord;
    try {
      entry = JSON.parse(line) as AnyRecord;
    } catch {
      continue;
    }

    const message = entry.message && typeof entry.message === 'object'
      ? entry.message as AnyRecord
      : null;
    const usages: unknown[] = [];
    if (message?.usage) usages.push(message.usage);
    if (entry.usage) usages.push(entry.usage);

    for (const rawUsage of usages) {
      const usage = readUsage(rawUsage);
      if (!usage) continue;
      inputSum += usage.input;
      outputSum += usage.output;
      cacheReadSum += usage.cacheRead;
      cacheWriteSum += usage.cacheWrite;

      if (message?.role === 'assistant') {
        latestInput = usage.input;
        latestOutput = usage.output;
        latestCacheRead = usage.cacheRead;
        latestCacheWrite = usage.cacheWrite;
        if (typeof message.model === 'string' && message.model.trim()) {
          model = message.model.trim();
        }
      }
    }
  }

  const contextUsed = latestInput + latestCacheRead + latestCacheWrite;
  const contextWindow = resolveContextWindow(contextUsed);
  const cumulativeUsed = inputSum + outputSum + cacheReadSum + cacheWriteSum;

  return {
    used: contextUsed || cumulativeUsed,
    total: contextWindow,
    contextUsed,
    contextWindow,
    contextFree: Math.max(0, contextWindow - contextUsed),
    contextPercent: contextUsed > 0
      ? Math.min(100, Math.round((contextUsed / contextWindow) * 1000) / 10)
      : null,
    cumulativeUsed,
    billedInputTokens: inputSum + cacheReadSum + cacheWriteSum,
    billedOutputTokens: outputSum,
    lastTurnInputTokens: latestInput,
    lastTurnOutputTokens: latestOutput,
    inputTokens: inputSum,
    outputTokens: outputSum,
    cacheReadTokens: latestCacheRead,
    cacheWriteTokens: latestCacheWrite,
    breakdown: { input: contextUsed || inputSum, output: latestOutput },
    model,
    provider: 'pi',
  };
}
