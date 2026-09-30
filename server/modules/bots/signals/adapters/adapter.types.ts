import type { IngestEventInput } from '@/modules/bots/bots.types.js';

export type WatchEventDraft = Omit<IngestEventInput, 'botId'>;

export interface WatchPollResult {
  events: WatchEventDraft[];
  cursor: Record<string, unknown>;
}

export interface WatchAdapter {
  /** Returns an error message when the adapter-specific config is invalid, else null. */
  validate?(config: Record<string, unknown>): string | null;
  poll(config: Record<string, unknown>, cursor: Record<string, unknown>): Promise<WatchPollResult>;
}

export type WatchExec = (file: string, args: string[]) => Promise<{ stdout: string }>;
export type WatchFetch = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

/** Maximum events a single poll may emit (protects the bot from a first-sync flood). */
export const MAX_EVENTS_PER_POLL = 50;
export const FETCH_TIMEOUT_MS = 20_000;

export function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Fetch with an abort timeout; rejects on non-2xx so callers record last_error. */
export async function fetchText(
  fetchImpl: WatchFetch,
  url: string,
  headers?: Record<string, string>,
  timeoutMs = FETCH_TIMEOUT_MS,
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { headers, signal: controller.signal });
    if (!response.ok) throw new Error(`GET ${safeUrl(url)} failed with HTTP ${response.status}`);
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

/** Strips credentials and query strings so errors never leak tokens. */
export function safeUrl(raw: string): string {
  try {
    const url = new URL(raw);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return '<invalid url>';
  }
}

export function validateHttpUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return 'url is required';
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'url must be http(s)';
    return null;
  } catch {
    return 'url is not a valid URL';
  }
}
