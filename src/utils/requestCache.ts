import { authenticatedFetch } from './api';

/**
 * Tiny in-flight + short-TTL request cache.
 *
 * Opening a session used to fire the same GET from two or three components at
 * once (session meta, token usage, live usage, TaskMaster info, provider
 * models…). Callers that share a key now share one request: a call while the
 * request is in flight joins it, and a call within `ttlMs` of it settling gets
 * the settled value. Failures are never cached, so the next call retries.
 *
 * Values are parsed results, never `Response` objects (a body can only be read
 * once, so a shared Response would break every caller but the first).
 */

type Entry = {
  promise: Promise<unknown>;
  settledAt: number | null;
  ttlMs: number;
};

const DEFAULT_TTL_MS = 3_000;
const entries = new Map<string, Entry>();

export type SharedRequestOptions = {
  /** How long a settled value stays reusable. 0 = dedupe in-flight only. */
  ttlMs?: number;
  /** Skip any cached value and replace it with a fresh request. */
  force?: boolean;
};

type InternalOptions<T> = SharedRequestOptions & {
  /** Resolved values failing this check are handed out once, then dropped. */
  shouldCache?: (value: T) => boolean;
};

export function sharedRequest<T>(
  key: string,
  fetcher: () => Promise<T>,
  { ttlMs = DEFAULT_TTL_MS, force = false, shouldCache }: InternalOptions<T> = {},
): Promise<T> {
  const existing = entries.get(key);
  if (existing && !force) {
    const fresh = existing.settledAt === null || Date.now() - existing.settledAt < existing.ttlMs;
    if (fresh) return existing.promise as Promise<T>;
  }

  const entry: Entry = { promise: Promise.resolve(), settledAt: null, ttlMs };
  entry.promise = fetcher().then(
    (value) => {
      if (entries.get(key) === entry) {
        if (shouldCache && !shouldCache(value)) entries.delete(key);
        else entry.settledAt = Date.now();
      }
      return value;
    },
    (error: unknown) => {
      if (entries.get(key) === entry) entries.delete(key);
      throw error;
    },
  );
  entries.set(key, entry);
  return entry.promise as Promise<T>;
}

/** Drop one key, or every key starting with `prefix` when it ends in `*`. */
export function invalidateSharedRequest(keyOrPrefix: string): void {
  if (keyOrPrefix.endsWith('*')) {
    const prefix = keyOrPrefix.slice(0, -1);
    for (const key of [...entries.keys()]) {
      if (key.startsWith(prefix)) entries.delete(key);
    }
    return;
  }
  entries.delete(keyOrPrefix);
}

/** Test helper. */
export function clearSharedRequests(): void {
  entries.clear();
}

export type SharedJsonResult<T> = {
  ok: boolean;
  status: number;
  data: T | null;
};

/**
 * Shared authenticated GET that resolves to `{ ok, status, data }` with the
 * body parsed as JSON (null when the body is empty or not JSON). Non-2xx
 * responses are not cached, matching `sharedRequest`'s never-cache-failures
 * rule, but still resolve so callers keep their existing `!ok` handling.
 */
export function sharedJsonGet<T = unknown>(
  url: string,
  options: SharedRequestOptions & { key?: string } = {},
): Promise<SharedJsonResult<T>> {
  const { key = `GET ${url}`, ...requestOptions } = options;
  return sharedRequest<SharedJsonResult<T>>(key, async () => {
    const response = await authenticatedFetch(url);
    let data: T | null = null;
    try {
      data = (await response.json()) as T;
    } catch {
      data = null;
    }
    return { ok: response.ok, status: response.status, data };
  }, { ...requestOptions, shouldCache: (result) => result.ok });
}
