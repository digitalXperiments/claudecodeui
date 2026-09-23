/**
 * Transcript replay for Antigravity sessions.
 *
 * Antigravity persists every conversation under its private GEMINI_HOME as
 * `antigravity-acp/conversations/<sessionId>.db`, but the rows are opaque
 * protobuf blobs — there is nothing a SQLite reader can normalize the way the
 * OpenCode reader does. The agent does, however, advertise
 * `agentCapabilities.loadSession`, and ACP `session/load` replays the whole
 * conversation as ordinary `session/update` notifications before it returns.
 * Replaying through the same normalizer the live stream uses is therefore the
 * only reader that stays correct across Antigravity releases.
 *
 * Replay means spawning an ACP child (~500MB, several seconds), so results are
 * memoized against the conversation database's fingerprint (`.db` + `-wal`
 * mtime/size) and served stale-while-revalidate:
 *
 *   - fingerprint matches the cache  -> served from memory (`fresh`)
 *   - cache exists but is outdated   -> the cached replay is returned at once
 *                                       (`stale`) and one background refresh
 *                                       is queued (deduped, throttled)
 *   - nothing cached                 -> the caller blocks on a replay
 *
 * Background refreshes run one at a time, never while a live CloudCLI turn is
 * writing the session (see `setAntigravityHistoryBusyCheck`), and are also
 * triggered ahead of time — by the sessions watcher, after a chat run
 * completes, and for the most recent sessions shortly after boot — so the
 * cache is usually warm before the user opens a session.
 */

import fs from 'node:fs';
import path from 'node:path';

import { spawnAntigravityAcpChild, ANTIGRAVITY_SETUP_TIMEOUT_MS } from './antigravity-acp.js';
import {
  antigravityConversationsDir,
  listAntigravityConversations,
  readAntigravityConversationCwd,
} from './antigravity-conversation-store.js';
import { resolveAntigravityBinary } from './antigravity-runtime.js';

/** One replayed `session/update` payload, in the same shape the live stream sees. */
export type AntigravityHistoryUpdate = Record<string, unknown>;

/** `session/load` replays the full transcript, so it needs a wider bound than setup calls. */
const LOAD_TIMEOUT_MS = Math.max(ANTIGRAVITY_SETUP_TIMEOUT_MS, 120_000);

/**
 * Draining notifications after `session/load` resolves.
 *
 * The agent emits the replay before the response in practice, but the reply is
 * written to the same stdout stream from a different goroutine, so a trailing
 * chunk can land just after it. Rather than a fixed sleep, the drain ends once
 * no update has arrived for `DRAIN_IDLE_MS` (measured from the later of the
 * load response and the last update), and never runs past `DRAIN_MAX_MS`.
 */
const DRAIN_IDLE_MS = 150;
const DRAIN_MAX_MS = 1_500;

/** Minimum gap between two background refreshes of the same session. */
const REFRESH_THROTTLE_MS = 5_000;
/** Default trailing debounce for watcher-driven refreshes. */
const DEFAULT_REFRESH_DELAY_MS = 3_000;
/** How many recent sessions to prewarm after boot, and how long to wait first. */
const BOOT_PREWARM_COUNT = 3;
const BOOT_PREWARM_DELAY_MS = 20_000;

export { antigravityConversationsDir as antigravityConversationsDirectory } from './antigravity-conversation-store.js';

export function antigravityConversationDbPath(
  providerSessionId: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(antigravityConversationsDir(env), `${providerSessionId}.db`);
}

/**
 * `null` when the conversation was never written (or was pruned).
 *
 * Antigravity keeps conversations in SQLite WAL mode. During an active turn the
 * main database can remain unchanged while every new message is appended to
 * `<session>.db-wal`; only a later checkpoint advances the `.db` fingerprint.
 * Include the WAL identity so fresh messages invalidate the replay cache as
 * soon as they are persisted.
 */
export function antigravityConversationFingerprint(
  providerSessionId: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  try {
    const dbPath = antigravityConversationDbPath(providerSessionId, env);
    const stats = fs.statSync(dbPath);
    let wal = 'missing';
    try {
      const walStats = fs.statSync(`${dbPath}-wal`);
      wal = `${walStats.mtimeMs}:${walStats.size}`;
    } catch {
      // A missing WAL is normal after a checkpoint or a clean close.
    }
    return `${stats.mtimeMs}:${stats.size}|${wal}`;
  } catch {
    return null;
  }
}

type CacheEntry = { fingerprint: string; updates: AntigravityHistoryUpdate[] };

/**
 * Outcome of a history read.
 *
 * - `fresh`   — replay matches what is on disk.
 * - `stale`   — the last good replay; the store has changed since and a
 *               background refresh has been queued (or is waiting for a live
 *               turn to finish).
 * - `missing` — the conversation database does not exist (yet): a brand-new
 *               session whose first turn has not been persisted.
 * - `failed`  — the replay threw or timed out; nothing usable is cached.
 * - `no-cwd`  — neither the `.meta` sidecar nor the caller knows the cwd, so
 *               `session/load` cannot be addressed. Not retryable.
 */
export type AntigravityHistoryStatus = 'fresh' | 'stale' | 'missing' | 'failed' | 'no-cwd';

export type AntigravityHistoryRead = {
  updates: AntigravityHistoryUpdate[];
  status: AntigravityHistoryStatus;
};

const cache = new Map<string, CacheEntry>();
/** Single-flight: two tabs opening the same session must not spawn two agents. */
const inFlight = new Map<string, Promise<AntigravityHistoryUpdate[]>>();
/** Last cwd a caller supplied per session, so background refreshes can fall back to it. */
const knownCwds = new Map<string, string>();

type RefreshRequest = { fallbackCwd: string; env: NodeJS.ProcessEnv };
const refreshTimers = new Map<string, NodeJS.Timeout>();
const lastRefreshStartedAt = new Map<string, number>();
const refreshQueue: string[] = [];
const refreshRequests = new Map<string, RefreshRequest>();
let refreshWorkerRunning = false;

let busyCheck: (providerSessionId: string) => boolean = () => false;

/**
 * Register the predicate that says whether a live CloudCLI turn is currently
 * writing a session. The chat runtime (`server/opencode-cli.js`) owns that
 * state; background refreshes skip busy sessions, and the runtime triggers a
 * refresh itself when the turn completes.
 */
export function setAntigravityHistoryBusyCheck(check: ((providerSessionId: string) => boolean) | null): void {
  busyCheck = check ?? (() => false);
}

const isBusy = (providerSessionId: string): boolean => {
  try {
    return busyCheck(providerSessionId);
  } catch {
    return false;
  }
};

/**
 * Called when a background replay lands a transcript that differs from the one
 * previously served. Clients that were handed the stale cache
 * (`historyRefreshing`) otherwise never learn the fresh replay is ready. The
 * default announces the session through the shared `session_upserted`
 * broadcast, which makes a client viewing it re-read the latest page. Loaded
 * lazily so the history reader stays importable without the websocket stack.
 */
type HistoryRefreshedListener = (providerSessionId: string) => void;
const defaultRefreshedListener: HistoryRefreshedListener = (providerSessionId) => {
  void import('@/modules/websocket/index.js')
    .then(({ broadcastSessionUpserted }) => broadcastSessionUpserted(providerSessionId, 'antigravity'))
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[AntigravityProvider] Could not announce refreshed history for ${providerSessionId}:`, message);
    });
};
let refreshedListener: HistoryRefreshedListener = defaultRefreshedListener;

/** Override (tests) or restore (`null`) the refreshed-history notification. */
export function setAntigravityHistoryRefreshedListener(listener: HistoryRefreshedListener | null): void {
  refreshedListener = listener ?? defaultRefreshedListener;
}

function sameUpdates(left: AntigravityHistoryUpdate[], right: AntigravityHistoryUpdate[]): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

/** Exported for tests and for the reload path after a session finishes a turn. */
export function clearAntigravityHistoryCache(providerSessionId?: string): void {
  if (providerSessionId) {
    cache.delete(providerSessionId);
    lastRefreshStartedAt.delete(providerSessionId);
    return;
  }
  cache.clear();
  lastRefreshStartedAt.clear();
  knownCwds.clear();
  for (const timer of refreshTimers.values()) clearTimeout(timer);
  refreshTimers.clear();
  refreshQueue.length = 0;
  refreshRequests.clear();
}

/** The cwd `session/load` must be addressed with: `.meta` first, then the caller's. */
export function resolveAntigravityReplayCwd(
  providerSessionId: string,
  fallbackCwd: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return readAntigravityConversationCwd(providerSessionId, env) ?? fallbackCwd ?? '';
}

async function replaySession(
  providerSessionId: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<AntigravityHistoryUpdate[]> {
  const session = spawnAntigravityAcpChild(env);
  const updates: AntigravityHistoryUpdate[] = [];
  let lastUpdateAt = 0;

  session.rpc.onMessage((message: Record<string, unknown>) => {
    if (message?.method !== 'session/update') return;
    const params = message.params as Record<string, unknown> | undefined;
    // One child can host several sessions; only the loaded one is history.
    if (typeof params?.sessionId === 'string' && params.sessionId !== providerSessionId) return;
    const update = params?.update;
    if (update && typeof update === 'object') {
      updates.push(update as AntigravityHistoryUpdate);
      lastUpdateAt = Date.now();
    }
  });

  try {
    await session.rpc.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
      clientInfo: { name: 'cloudcli', version: '1.0.0' },
    }, ANTIGRAVITY_SETUP_TIMEOUT_MS);

    await session.rpc.request('session/load', {
      sessionId: providerSessionId,
      cwd,
      mcpServers: [],
    }, LOAD_TIMEOUT_MS);

    const loadedAt = Date.now();
    await new Promise<void>((resolve) => {
      const tick = () => {
        const now = Date.now();
        const quietSince = Math.max(loadedAt, lastUpdateAt);
        if (now - quietSince >= DRAIN_IDLE_MS || now - loadedAt >= DRAIN_MAX_MS) {
          resolve();
          return;
        }
        const wait = Math.min(DRAIN_IDLE_MS - (now - quietSince), DRAIN_MAX_MS - (now - loadedAt));
        const timer = setTimeout(tick, Math.max(1, wait));
        timer.unref?.();
      };
      tick();
    });
    return updates;
  } finally {
    session.dispose();
  }
}

/**
 * Single-flight replay that caches its result. Rejects on failure so callers
 * can tell a failed replay from an empty conversation.
 */
function loadAndCache(
  providerSessionId: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<AntigravityHistoryUpdate[]> {
  const pending = inFlight.get(providerSessionId);
  if (pending) return pending;

  const load = replaySession(providerSessionId, cwd, env)
    .then((updates) => {
      // Re-stat rather than trusting the pre-read fingerprint: a turn that
      // landed mid-replay must not be cached under the stale signature.
      const after = antigravityConversationFingerprint(providerSessionId, env);
      if (after) cache.set(providerSessionId, { fingerprint: after, updates });
      return updates;
    })
    .finally(() => {
      inFlight.delete(providerSessionId);
    });

  inFlight.set(providerSessionId, load);
  return load;
}

async function runRefreshWorker(): Promise<void> {
  if (refreshWorkerRunning) return;
  refreshWorkerRunning = true;
  try {
    while (refreshQueue.length > 0) {
      const providerSessionId = refreshQueue.shift() as string;
      const request = refreshRequests.get(providerSessionId);
      refreshRequests.delete(providerSessionId);
      if (!request) continue;

      const { env } = request;
      const fingerprint = antigravityConversationFingerprint(providerSessionId, env);
      // Pruned, already fresh, or a live turn is still writing it (the runtime
      // schedules another refresh when that turn completes).
      if (!fingerprint) continue;
      if (cache.get(providerSessionId)?.fingerprint === fingerprint) continue;
      if (isBusy(providerSessionId)) continue;

      const cwd = resolveAntigravityReplayCwd(
        providerSessionId,
        request.fallbackCwd || knownCwds.get(providerSessionId) || '',
        env,
      );
      if (!cwd) continue;
      // Background work must never spam errors on hosts without the agent.
      if (!resolveAntigravityBinary(env).ok) continue;

      lastRefreshStartedAt.set(providerSessionId, Date.now());
      const previous = cache.get(providerSessionId)?.updates;
      try {
        const updates = await loadAndCache(providerSessionId, cwd, env);
        // Only a session some reader was served a stale copy of can have a
        // client waiting on it; unchanged replays (checkpoint-only fingerprint
        // moves) stay silent.
        if (previous && !sameUpdates(previous, updates)) {
          try {
            refreshedListener(providerSessionId);
          } catch {
            // Notification is best-effort.
          }
        }
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[AntigravityProvider] Background history refresh failed for ${providerSessionId}:`, message);
      }
    }
  } finally {
    refreshWorkerRunning = false;
  }
}

function enqueueRefresh(providerSessionId: string, request: RefreshRequest): void {
  refreshRequests.set(providerSessionId, request);
  if (!refreshQueue.includes(providerSessionId)) refreshQueue.push(providerSessionId);
  void runRefreshWorker();
}

/**
 * Queue a background replay so the next open is served from a warm cache.
 *
 * Calls are debounced per session (trailing `delayMs`), throttled to one start
 * per `REFRESH_THROTTLE_MS`, deduplicated against an in-flight replay, and run
 * one at a time. Safe to call as often as a watcher fires.
 */
export function scheduleAntigravityHistoryRefresh(
  providerSessionId: string,
  options: { fallbackCwd?: string; env?: NodeJS.ProcessEnv; delayMs?: number } = {},
): void {
  if (!providerSessionId) return;
  const env = options.env ?? process.env;
  const fallbackCwd = options.fallbackCwd ?? '';
  if (fallbackCwd) knownCwds.set(providerSessionId, fallbackCwd);

  const sinceLast = Date.now() - (lastRefreshStartedAt.get(providerSessionId) ?? 0);
  const throttleWait = Math.max(0, REFRESH_THROTTLE_MS - sinceLast);
  const delay = Math.max(options.delayMs ?? DEFAULT_REFRESH_DELAY_MS, throttleWait);

  const existing = refreshTimers.get(providerSessionId);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    refreshTimers.delete(providerSessionId);
    if (inFlight.has(providerSessionId)) {
      // A replay is already running; re-check once it settles so a change that
      // landed mid-replay is still picked up.
      inFlight.get(providerSessionId)?.catch(() => undefined).finally(() => {
        scheduleAntigravityHistoryRefresh(providerSessionId, { fallbackCwd, env, delayMs: 0 });
      });
      return;
    }
    enqueueRefresh(providerSessionId, { fallbackCwd, env });
  }, delay);
  timer.unref?.();
  refreshTimers.set(providerSessionId, timer);
}

/**
 * Warm the cache for the most recently updated conversations, one replay at a
 * time, shortly after boot. No-op when the agent is not installed, and can be
 * disabled with `CLOUDCLI_ANTIGRAVITY_HISTORY_PREWARM=0`.
 */
export function prewarmRecentAntigravityHistory(
  options: { env?: NodeJS.ProcessEnv; count?: number; delayMs?: number } = {},
): void {
  const env = options.env ?? process.env;
  if (env.CLOUDCLI_ANTIGRAVITY_HISTORY_PREWARM === '0') return;
  const timer = setTimeout(() => {
    try {
      if (!resolveAntigravityBinary(env).ok) return;
      const recent = listAntigravityConversations(env)
        .filter((conversation) => Boolean(conversation.cwd))
        .slice(0, options.count ?? BOOT_PREWARM_COUNT);
      for (const conversation of recent) {
        enqueueRefresh(conversation.sessionId, { fallbackCwd: conversation.cwd ?? '', env });
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn('[AntigravityProvider] History prewarm skipped:', message);
    }
  }, options.delayMs ?? BOOT_PREWARM_DELAY_MS);
  timer.unref?.();
}

/**
 * Replay a stored Antigravity conversation as `session/update` payloads,
 * reporting whether the result is authoritative.
 *
 * Never throws. Only blocks on a replay when nothing is cached; an outdated
 * cache is returned immediately while a background refresh catches up.
 */
export async function readAntigravityHistory(
  providerSessionId: string,
  fallbackCwd: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<AntigravityHistoryRead> {
  if (!providerSessionId) return { updates: [], status: 'missing' };
  if (fallbackCwd) knownCwds.set(providerSessionId, fallbackCwd);

  const fingerprint = antigravityConversationFingerprint(providerSessionId, env);
  if (!fingerprint) return { updates: [], status: 'missing' };

  const cached = cache.get(providerSessionId);
  if (cached && cached.fingerprint === fingerprint) return { updates: cached.updates, status: 'fresh' };
  if (cached) {
    scheduleAntigravityHistoryRefresh(providerSessionId, { fallbackCwd, env, delayMs: 0 });
    return { updates: cached.updates, status: 'stale' };
  }

  const cwd = resolveAntigravityReplayCwd(providerSessionId, fallbackCwd, env);
  if (!cwd) return { updates: [], status: 'no-cwd' };

  try {
    const updates = await loadAndCache(providerSessionId, cwd, env);
    return { updates, status: 'fresh' };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[AntigravityProvider] Failed to replay session ${providerSessionId}:`, message);
    return { updates: [], status: 'failed' };
  }
}

/**
 * Back-compat wrapper returning only the updates (empty on any failure).
 * Prefer `readAntigravityHistory`, which distinguishes failure from empty.
 */
export async function readAntigravityHistoryUpdates(
  providerSessionId: string,
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<AntigravityHistoryUpdate[]> {
  return (await readAntigravityHistory(providerSessionId, cwd, env)).updates;
}
