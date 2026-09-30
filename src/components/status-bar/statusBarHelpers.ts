import type { ContextPressureTelemetry, HeartbeatPhase } from './types';

export function formatCurrency(amount: number): string {
  if (!Number.isFinite(amount) || amount <= 0) return '$0.00';
  if (amount < 0.01) return '<$0.01';
  if (amount >= 1000) return `$${(amount / 1000).toFixed(1)}k`;
  if (amount >= 100) return `$${amount.toFixed(1)}`;
  return `$${amount.toFixed(2)}`;
}

export function formatVelocity(usdPerMin: number): string {
  if (!Number.isFinite(usdPerMin) || usdPerMin <= 0) return '$0.00';
  if (usdPerMin < 0.01) return '<$0.01';
  if (usdPerMin >= 10) return `$${usdPerMin.toFixed(0)}`;
  return `$${usdPerMin.toFixed(2)}`;
}

export function formatTokenCount(count: number): string {
  if (!Number.isFinite(count) || count <= 0) return '0';
  if (count >= 1_000_000_000) return `${(count / 1_000_000_000).toFixed(1)}B`;
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 10_000) return `${Math.round(count / 1000)}k`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`;
  return String(count);
}

export function computeContextPressure(budget: Record<string, unknown> | null | undefined): ContextPressureTelemetry {
  if (!budget || typeof budget !== 'object') {
    return { usedTokens: 0, contextWindow: 0, percent: null };
  }

  const breakdown = budget.breakdown && typeof budget.breakdown === 'object'
    ? (budget.breakdown as Record<string, unknown>)
    : null;

  const readNum = (v: unknown): number => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  };

  const rawModel = typeof budget.model === 'string' ? budget.model.trim() : undefined;
  const inputTokens = readNum(budget.billedInputTokens ?? budget.inputTokens ?? breakdown?.input);
  const outputTokens = readNum(budget.billedOutputTokens ?? budget.outputTokens ?? breakdown?.output);
  const contextUsed = readNum(budget.contextUsed);
  let contextWindow = readNum(budget.contextWindow ?? budget.total);
  const cumulativeUsed = readNum(budget.cumulativeUsed) || (inputTokens + outputTokens);

  const hasContextFill = contextUsed > 0;
  const usedTokens = hasContextFill ? contextUsed : readNum(budget.used) || cumulativeUsed;

  // Infer window if model is known and window is 0
  if (contextWindow <= 0 && rawModel) {
    const lower = rawModel.toLowerCase();
    if (lower.includes('pro')) {
      contextWindow = 2_000_000;
    } else if (lower.includes('flash') || lower.includes('gemini')) {
      contextWindow = 1_000_000;
    } else if (lower.includes('codex') || lower.includes('gpt-4o')) {
      contextWindow = 128_000;
    } else if (lower.includes('claude')) {
      contextWindow = 200_000;
    }
  }

  let percent: number | null = null;
  if (typeof budget.contextPercent === 'number' && Number.isFinite(budget.contextPercent)) {
    percent = Math.max(0, Math.min(100, Math.round(budget.contextPercent)));
  } else if (contextWindow > 0 && usedTokens > 0) {
    percent = Math.min(100, Math.round((usedTokens / contextWindow) * 100));
  }

  return {
    usedTokens,
    contextWindow,
    percent,
    inputTokens: inputTokens > 0 ? inputTokens : undefined,
    outputTokens: outputTokens > 0 ? outputTokens : undefined,
    model: rawModel,
  };
}

export function evaluateStallState({
  isProcessing,
  elapsedSeconds,
  idleSeconds,
  thresholdSeconds = 18,
  currentPhase = 'idle',
}: {
  isProcessing: boolean;
  elapsedSeconds: number;
  idleSeconds: number;
  thresholdSeconds?: number;
  currentPhase?: HeartbeatPhase;
}): { isStalled: boolean; phase: HeartbeatPhase } {
  if (!isProcessing) {
    return { isStalled: false, phase: 'idle' };
  }

  const isStalled = idleSeconds >= thresholdSeconds;
  return {
    isStalled,
    phase: isStalled ? 'stalled' : (currentPhase === 'idle' ? 'thinking' : currentPhase),
  };
}
