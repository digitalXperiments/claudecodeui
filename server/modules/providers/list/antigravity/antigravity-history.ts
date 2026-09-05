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
 * memoized against the conversation database's mtime+size: a session that has
 * not run since the last read is served from memory, and one that has is
 * re-read exactly once.
 */

import fs from 'node:fs';
import path from 'node:path';

import { spawnAntigravityAcpChild, ANTIGRAVITY_SETUP_TIMEOUT_MS } from './antigravity-acp.js';
import { antigravityConversationsDir } from './antigravity-conversation-store.js';

/** One replayed `session/update` payload, in the same shape the live stream sees. */
export type AntigravityHistoryUpdate = Record<string, unknown>;

/** `session/load` replays the full transcript, so it needs a wider bound than setup calls. */
const LOAD_TIMEOUT_MS = Math.max(ANTIGRAVITY_SETUP_TIMEOUT_MS, 120_000);

/**
 * How long to keep draining notifications after `session/load` resolves.
 *
 * The agent emits the replay before the response in practice, but the reply is
 * written to the same stdout stream from a different goroutine, so a short
 * grace period keeps a trailing chunk from being cut off.
 */
const DRAIN_AFTER_LOAD_MS = 250;

export { antigravityConversationsDir as antigravityConversationsDirectory } from './antigravity-conversation-store.js';

export function antigravityConversationDbPath(
  providerSessionId: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(antigravityConversationsDir(env), `${providerSessionId}.db`);
}

/** `null` when the conversation was never written (or was pruned). */
function conversationFingerprint(providerSessionId: string, env: NodeJS.ProcessEnv): string | null {
  try {
    const stats = fs.statSync(antigravityConversationDbPath(providerSessionId, env));
    return `${stats.mtimeMs}:${stats.size}`;
  } catch {
    return null;
  }
}

type CacheEntry = { fingerprint: string; updates: AntigravityHistoryUpdate[] };

const cache = new Map<string, CacheEntry>();
/** Single-flight: two tabs opening the same session must not spawn two agents. */
const inFlight = new Map<string, Promise<AntigravityHistoryUpdate[]>>();

/** Exported for tests and for the reload path after a session finishes a turn. */
export function clearAntigravityHistoryCache(providerSessionId?: string): void {
  if (providerSessionId) {
    cache.delete(providerSessionId);
    return;
  }
  cache.clear();
}

async function replaySession(
  providerSessionId: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<AntigravityHistoryUpdate[]> {
  const session = spawnAntigravityAcpChild(env);
  const updates: AntigravityHistoryUpdate[] = [];

  session.rpc.onMessage((message: Record<string, unknown>) => {
    if (message?.method !== 'session/update') return;
    const params = message.params as Record<string, unknown> | undefined;
    // One child can host several sessions; only the loaded one is history.
    if (typeof params?.sessionId === 'string' && params.sessionId !== providerSessionId) return;
    const update = params?.update;
    if (update && typeof update === 'object') updates.push(update as AntigravityHistoryUpdate);
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

    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, DRAIN_AFTER_LOAD_MS);
      timer.unref?.();
    });
    return updates;
  } finally {
    session.dispose();
  }
}

/**
 * Replay a stored Antigravity conversation as `session/update` payloads.
 *
 * Returns an empty list — rather than throwing — when the conversation is not
 * on disk, when the agent is not installed, or when the replay fails: an
 * unreadable transcript must render as an empty session, not a failed request.
 */
export async function readAntigravityHistoryUpdates(
  providerSessionId: string,
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<AntigravityHistoryUpdate[]> {
  if (!providerSessionId) return [];

  const fingerprint = conversationFingerprint(providerSessionId, env);
  if (!fingerprint) return [];

  const cached = cache.get(providerSessionId);
  if (cached && cached.fingerprint === fingerprint) return cached.updates;

  const pending = inFlight.get(providerSessionId);
  if (pending) return pending;

  const load = replaySession(providerSessionId, cwd, env)
    .then((updates) => {
      // Re-stat rather than trusting the pre-read fingerprint: a turn that
      // landed mid-replay must not be cached under the stale signature.
      const after = conversationFingerprint(providerSessionId, env);
      if (after) cache.set(providerSessionId, { fingerprint: after, updates });
      return updates;
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[AntigravityProvider] Failed to replay session ${providerSessionId}:`, message);
      return [] as AntigravityHistoryUpdate[];
    })
    .finally(() => {
      inFlight.delete(providerSessionId);
    });

  inFlight.set(providerSessionId, load);
  return load;
}
