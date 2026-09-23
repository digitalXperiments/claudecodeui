/**
 * Pure guards for the per-session processing map (`useSessionProtection`).
 * Kept free of React so the stale-ack rules can be unit tested directly.
 */

/**
 * How long after a local `chat.send` a `chat_subscribed` ack may NOT demote
 * the session's chat entry (to idle or to Shell). The server reserves the
 * session synchronously on send, but a subscribe ack can still describe the
 * pre-send state (it was generated before the send reached the server, or by
 * an older server build). A few seconds covers the Agent CLI hand-off; the
 * terminal `complete` / `protocol_error` frames always clear the entry.
 */
export const LOCAL_SEND_ACK_GUARD_MS = 5_000;

export type GuardedSessionActivity = {
  source: 'chat' | 'shell';
  startedAt: number;
  /** Client clock of the most recent local `chat.send` for this entry. */
  localSendAt?: number;
};

export type IdleRequestOptions = {
  /** Ignore the idle when the entry started at/after this client timestamp. */
  ifStartedBefore?: number;
  /**
   * The idle comes from a `chat_subscribed` ack (advisory, can be stale) as
   * opposed to a terminal frame (`complete`, abort, protocol error).
   */
  fromSubscribeAck?: boolean;
};

export function hasRecentLocalSend(
  activity: GuardedSessionActivity | undefined,
  now: number,
): boolean {
  return Boolean(
    activity
    && activity.source === 'chat'
    && typeof activity.localSendAt === 'number'
    && now - activity.localSendAt >= 0
    && now - activity.localSendAt < LOCAL_SEND_ACK_GUARD_MS,
  );
}

/** True when an idle request must leave `existing` in place. */
export function shouldIgnoreIdle(
  existing: GuardedSessionActivity,
  opts: IdleRequestOptions | undefined,
  now: number,
): boolean {
  // A request that started after the subscribe was sent is newer than the
  // state the ack describes.
  if (opts?.ifStartedBefore !== undefined && existing.startedAt >= opts.ifStartedBefore) {
    return true;
  }
  return Boolean(opts?.fromSubscribeAck) && hasRecentLocalSend(existing, now);
}

/**
 * True when a Shell-activity ack must not take over a chat entry: the local
 * send is handing the session from Agent CLI to Chat, so "Shell active"
 * describes the moment before the hand-off.
 */
export function shouldIgnoreShellTakeover(
  existing: GuardedSessionActivity | undefined,
  incomingSource: 'chat' | 'shell' | undefined,
  now: number,
): boolean {
  return incomingSource === 'shell' && hasRecentLocalSend(existing, now);
}
