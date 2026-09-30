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
  /** Present on real fetch responses; lets the reader stop at the size cap. */
  body?: { getReader(): { read(): Promise<{ done: boolean; value?: Uint8Array }>; cancel(reason?: unknown): Promise<void> } } | null;
  headers?: { get(name: string): string | null };
}>;

/** Maximum events a single poll may emit (protects the bot from a first-sync flood). */
export const MAX_EVENTS_PER_POLL = 50;
export const FETCH_TIMEOUT_MS = 20_000;
/** Largest response body a watch adapter will read (a hostile or broken feed cannot exhaust memory). */
export const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

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
    return await readBounded(response, url);
  } finally {
    clearTimeout(timer);
  }
}

async function readBounded(response: Awaited<ReturnType<WatchFetch>>, url: string): Promise<string> {
  const tooLarge = () => new Error(`GET ${safeUrl(url)} response exceeds ${MAX_RESPONSE_BYTES} bytes`);
  const declared = Number(response.headers?.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) throw tooLarge();
  const reader = response.body?.getReader();
  if (!reader) {
    const text = await response.text();
    if (text.length > MAX_RESPONSE_BYTES) throw tooLarge();
    return text;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw tooLarge();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
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
