import type { NormalizedMessage } from '@/shared/types.js';

import type { ProviderLimitSignal } from './continuity.types.js';

const LIMIT_PATTERN = /(?:usage|account|request|token|credit|spend)?\s*(?:rate\s*)?limit(?:ed| reached| exceeded)?|too many requests|quota(?: has been)? (?:reached|exceeded|exhausted)|resource[_ ]exhausted|insufficient[_ ]quota/i;
const HTTP_429_PATTERN = /\b(?:http|status(?: code)?|error|response)\s*[:#-]?\s*429\b|\b429\s+(?:too many requests|rate limit)/i;
const RETRY_DURATION_PATTERN = /(?:try again|retry|resets?|available again)[^\d]{0,24}(\d+(?:\.\d+)?)\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?)/i;
const RESET_AT_PATTERN = /(?:resets?|retry|available again)\s+(?:at|after)\s+([^\n.]{4,100})/i;
const CLAUDE_SENTINEL_PATTERN = /Claude AI usage limit reached\|(\d{10,13})/i;

function toIso(timestampMs: number): string | null {
  const date = new Date(timestampMs);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function parseEpoch(value: string): string | null {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return toIso(parsed < 1e12 ? parsed * 1000 : parsed);
}

function parseStructuredRetryAt(message: NormalizedMessage, nowMs: number): string | null {
  const record = message as Record<string, unknown>;
  for (const key of ['retryAt', 'retry_at', 'resetsAt', 'resets_at', 'resetAt', 'reset_at']) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) {
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed)) return toIso(parsed);
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      return toIso(value < 1e12 ? value * 1000 : value);
    }
  }

  const retryAfter = record.retryAfter ?? record.retry_after;
  if (typeof retryAfter === 'number' && Number.isFinite(retryAfter) && retryAfter >= 0) {
    return toIso(nowMs + retryAfter * 1000);
  }
  return null;
}

function parseTextRetryAt(text: string, nowMs: number): string | null {
  const sentinel = text.match(CLAUDE_SENTINEL_PATTERN);
  if (sentinel) return parseEpoch(sentinel[1]);

  const duration = text.match(RETRY_DURATION_PATTERN);
  if (duration) {
    const amount = Number(duration[1]);
    const unit = duration[2].toLowerCase();
    const multiplier = unit.startsWith('hour') || unit.startsWith('hr')
      ? 3_600_000
      : unit.startsWith('min')
        ? 60_000
        : 1000;
    return toIso(nowMs + amount * multiplier);
  }

  const resetAt = text.match(RESET_AT_PATTERN)?.[1]?.trim();
  if (resetAt) {
    const parsed = Date.parse(resetAt);
    if (Number.isFinite(parsed)) return toIso(parsed);
  }
  return null;
}

/** Provider-neutral hard-limit detector used by every chat runtime. */
export function detectProviderLimit(
  message: NormalizedMessage,
  nowMs = Date.now(),
): ProviderLimitSignal | null {
  const record = message as Record<string, unknown>;
  const text = [message.content, message.text, message.summary, message.reason, record.error]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .join('\n')
    .trim();

  if (!text || (!LIMIT_PATTERN.test(text) && !HTTP_429_PATTERN.test(text) && !CLAUDE_SENTINEL_PATTERN.test(text))) {
    return null;
  }

  const retryAt = parseStructuredRetryAt(message, nowMs) ?? parseTextRetryAt(text, nowMs);
  return {
    reason: text.slice(0, 1000),
    retryAt,
    resetTimeSource: retryAt ? 'message' : 'fallback',
    rawText: text,
  };
}
