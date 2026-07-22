/**
 * Claude token usage: latest-turn context occupancy vs session spend.
 *
 * Claude Code JSONL stores per-assistant-message `message.usage`. The *latest*
 * assistant usage (input + cache) is the live context fill. Summing every
 * assistant usage is cumulative session spend (can dwarf the window).
 */

import fsSync from 'node:fs';

export type ClaudeSessionTokenUsage = {
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
  cumulativeUsed: number;
  billedInputTokens: number;
  billedOutputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  cacheTokens: number;
  model: string | null;
  provider: 'claude';
  breakdown: { input: number; output: number };
};

function readNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Best-effort context window from model id / env / observed fill. */
export function resolveClaudeContextWindow(
  model: string | null | undefined,
  contextUsedHint?: number,
): number {
  const fromEnv = parseInt(process.env.CONTEXT_WINDOW || '', 10);
  if (Number.isFinite(fromEnv) && fromEnv > 0) {
    return fromEnv;
  }
  const id = (model || '').toLowerCase();
  // Explicit long-context variants.
  if (id.includes('[1m]') || id.includes('1m') || id.includes('fable')) {
    return 1_000_000;
  }
  // Current Claude Code defaults are 200k; promote to 1M when the live fill
  // already exceeds the standard window (long-context sessions).
  if (typeof contextUsedHint === 'number' && contextUsedHint > 200_000) {
    return 1_000_000;
  }
  return 200_000;
}

function parseAssistantUsage(usage: Record<string, unknown>): {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
} {
  const directInput = readNumber(usage.input_tokens ?? usage.inputTokens);
  const cacheRead = readNumber(
    usage.cache_read_input_tokens ?? usage.cacheReadInputTokens ?? usage.cacheReadTokens,
  );
  const cacheCreation = readNumber(
    usage.cache_creation_input_tokens ??
      usage.cacheCreationInputTokens ??
      usage.cacheCreationTokens,
  );
  const output = readNumber(usage.output_tokens ?? usage.outputTokens);
  return {
    input: directInput + cacheRead + cacheCreation,
    output,
    cacheRead,
    cacheCreation,
  };
}

export function readClaudeSessionTokenUsage(jsonlPath: string): ClaudeSessionTokenUsage {
  let latestInput = 0;
  let latestOutput = 0;
  let latestCacheRead = 0;
  let latestCacheCreation = 0;
  let model: string | null = null;
  let inputSum = 0;
  let outputSum = 0;

  let fileContent = '';
  try {
    fileContent = fsSync.readFileSync(jsonlPath, 'utf8');
  } catch {
    // missing file
  }

  for (const line of fileContent.trim().split('\n')) {
    if (!line) continue;
    try {
      const entry = JSON.parse(line) as {
        type?: string;
        message?: { usage?: Record<string, unknown>; model?: string };
      };
      if (entry.type !== 'assistant' || !entry.message?.usage) {
        continue;
      }
      const parsed = parseAssistantUsage(entry.message.usage);
      inputSum += parsed.input;
      outputSum += parsed.output;
      latestInput = parsed.input;
      latestOutput = parsed.output;
      latestCacheRead = parsed.cacheRead;
      latestCacheCreation = parsed.cacheCreation;
      if (typeof entry.message.model === 'string' && entry.message.model.trim()) {
        model = entry.message.model.trim();
      }
    } catch {
      // skip
    }
  }

  const contextUsed = latestInput > 0 ? latestInput : 0;
  const contextWindow = resolveClaudeContextWindow(model, contextUsed);
  const cumulativeUsed = inputSum + outputSum;
  const used = contextUsed > 0 ? contextUsed : cumulativeUsed;
  const cacheTokens = latestCacheRead + latestCacheCreation;
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
    lastTurnInputTokens: latestInput,
    lastTurnOutputTokens: latestOutput,
    // Session spend I/O (sum of turns) — billed totals, not context fill.
    inputTokens: inputSum,
    outputTokens: outputSum,
    billedInputTokens: inputSum,
    billedOutputTokens: outputSum,
    cumulativeUsed,
    cacheReadTokens: latestCacheRead,
    cacheCreationTokens: latestCacheCreation,
    cacheTokens,
    model,
    provider: 'claude',
    breakdown: {
      input: contextUsed > 0 ? contextUsed : inputSum,
      output: latestOutput,
    },
  };
}

/** Build a live token_budget payload from a single SDK/assistant usage object. */
export function buildClaudeTokenBudgetFromUsage(
  usage: Record<string, unknown>,
  model?: string | null,
): ClaudeSessionTokenUsage {
  const parsed = parseAssistantUsage(usage);
  const contextUsed = parsed.input;
  const contextWindow = resolveClaudeContextWindow(model, contextUsed);
  const cacheTokens = parsed.cacheRead + parsed.cacheCreation;
  const contextFree =
    contextWindow > 0 ? Math.max(0, contextWindow - contextUsed) : 0;
  const contextPercent =
    contextWindow > 0 && contextUsed > 0
      ? Math.min(100, Math.round((contextUsed / contextWindow) * 1000) / 10)
      : null;

  return {
    used: contextUsed,
    total: contextWindow,
    contextUsed,
    contextWindow,
    contextFree,
    contextPercent,
    lastTurnInputTokens: parsed.input,
    lastTurnOutputTokens: parsed.output,
    // Live stream only has the current turn — spend fields match that turn.
    inputTokens: parsed.input,
    outputTokens: parsed.output,
    billedInputTokens: parsed.input,
    billedOutputTokens: parsed.output,
    cumulativeUsed: parsed.input + parsed.output,
    cacheReadTokens: parsed.cacheRead,
    cacheCreationTokens: parsed.cacheCreation,
    cacheTokens,
    model: model ?? null,
    provider: 'claude',
    breakdown: {
      input: parsed.input,
      output: parsed.output,
    },
  };
}
