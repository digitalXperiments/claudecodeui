import type { AnyRecord } from '@/shared/types.js';

export type CodexTokenCount = {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
};

export type CodexTokenUsage = {
  /** Current context occupancy from the provider's last request. */
  used: number;
  total: number;
  contextUsed: number;
  contextWindow: number;
  contextFree: number;
  contextPercent: number | null;
  /** Cumulative API usage across the whole session. */
  cumulativeUsed: number;
  billedInputTokens: number;
  billedOutputTokens: number;
  lastTurnInputTokens: number;
  lastTurnOutputTokens: number;
  inputTokens: number;
  outputTokens: number;
  breakdown: {
    input: number;
    output: number;
  };
  model?: string;
  /** Subset of billedInputTokens that was a cache hit. Codex has no separate cache-write concept. */
  cacheReadTokens?: number;
};

const readNumber = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
};

const readField = (record: AnyRecord, camelName: string, snakeName: string): unknown => (
  record[camelName] ?? record[snakeName]
);

/**
 * Normalizes both the app-server camelCase shape and the rollout JSONL
 * snake_case shape into one token-count representation.
 */
export function readCodexTokenCount(value: unknown): CodexTokenCount | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const record = value as AnyRecord;
  const hasTokenFields = [
    'inputTokens',
    'input_tokens',
    'cachedInputTokens',
    'cached_input_tokens',
    'outputTokens',
    'output_tokens',
    'reasoningOutputTokens',
    'reasoning_output_tokens',
    'totalTokens',
    'total_tokens',
  ].some((key) => Object.prototype.hasOwnProperty.call(record, key));

  if (!hasTokenFields) {
    return null;
  }

  const inputTokens = readNumber(readField(record, 'inputTokens', 'input_tokens'));
  const cachedInputTokens = readNumber(readField(record, 'cachedInputTokens', 'cached_input_tokens'));
  const outputTokens = readNumber(readField(record, 'outputTokens', 'output_tokens'));
  const reasoningOutputTokens = readNumber(
    readField(record, 'reasoningOutputTokens', 'reasoning_output_tokens'),
  );
  const reportedTotal = readNumber(readField(record, 'totalTokens', 'total_tokens'));

  return {
    inputTokens,
    cachedInputTokens,
    outputTokens,
    reasoningOutputTokens,
    totalTokens: reportedTotal || inputTokens + outputTokens,
  };
}

const readModelContextWindow = (value: unknown): number => {
  if (!value || typeof value !== 'object') {
    return readNumber(value);
  }

  const record = value as AnyRecord;
  return readNumber(record.modelContextWindow ?? record.model_context_window);
};

/**
 * Builds the normalized usage payload consumed by the chat composer.
 *
 * Codex reports two different metrics: `last` is the context-sized request
 * that was just sent, while `total` is cumulative API usage. They must never
 * be presented as the same number or the session badge grows on every turn.
 */
export function buildCodexTokenUsage(options: {
  total?: unknown;
  last?: unknown;
  modelContextWindow?: unknown;
  model?: unknown;
}): CodexTokenUsage | null {
  const total = readCodexTokenCount(options.total);
  const last = readCodexTokenCount(options.last);
  if (!total && !last) {
    return null;
  }

  const contextWindow = readModelContextWindow(options.modelContextWindow);
  const contextUsed = last?.totalTokens ?? 0;
  const cumulativeUsed = total?.totalTokens ?? 0;
  const contextFree = contextWindow > 0 && last
    ? Math.max(0, contextWindow - contextUsed)
    : 0;
  const contextPercent = contextWindow > 0 && last && contextUsed > 0
    ? Math.min(100, Math.round((contextUsed / contextWindow) * 1000) / 10)
    : null;
  const input = last?.inputTokens ?? total?.inputTokens ?? 0;
  const output = last?.outputTokens ?? total?.outputTokens ?? 0;
  const model = typeof options.model === 'string' && options.model.trim()
    ? options.model.trim()
    : undefined;

  return {
    // If Codex did not provide a last-request record, expose the only metric
    // available as legacy usage while leaving contextUsed at zero so the UI
    // does not claim that cumulative billing is context occupancy.
    used: last ? contextUsed : cumulativeUsed,
    total: contextWindow,
    contextUsed,
    contextWindow,
    contextFree,
    contextPercent,
    cumulativeUsed,
    billedInputTokens: total?.inputTokens ?? 0,
    billedOutputTokens: total?.outputTokens ?? 0,
    lastTurnInputTokens: last?.inputTokens ?? 0,
    lastTurnOutputTokens: last?.outputTokens ?? 0,
    inputTokens: input,
    outputTokens: output,
    breakdown: { input, output },
    ...(model ? { model } : {}),
    cacheReadTokens: total?.cachedInputTokens ?? last?.cachedInputTokens ?? 0,
  };
}
