/**
 * Best-effort WebSocket fan-out for system-level events (PRD §4.6).
 *
 * Mirrors `broadcastNotificationCreated` in auth-health: every open chat
 * WebSocket receives a JSON frame. Failures never throw — realtime is optional.
 *
 * Exception: `run_event` frames (one per persisted run event — i.e. per
 * streamed provider event) are only sent to sockets that opted in via
 * `runs.subscribe` (a specific run id, or `*` for all runs). No bundled
 * client consumes them, and fanning every token of every run out to every
 * tab was pure serialization + socket overhead on the streaming hot path.
 */

import type { SystemWsEvent } from '@/shared/run-events.js';
import type { RealtimeClientConnection } from '@/shared/types.js';
import {
  connectedClients,
  WS_OPEN_STATE,
} from '@/modules/websocket/services/websocket-state.service.js';

export const ALL_RUNS_SUBSCRIPTION = '*';

/** Run ids (or `*`) each socket subscribed to; entries die with the socket. */
const runEventSubscriptions = new WeakMap<RealtimeClientConnection, Set<string>>();
let runEventSubscriberCount = 0;

export function subscribeRunEvents(connection: RealtimeClientConnection, runId: string): void {
  if (!runId) return;
  let subscriptions = runEventSubscriptions.get(connection);
  if (!subscriptions) {
    subscriptions = new Set();
    runEventSubscriptions.set(connection, subscriptions);
    runEventSubscriberCount += 1;
  }
  subscriptions.add(runId);
}

/** Drops one run subscription, or all of the socket's subscriptions when `runId` is omitted. */
export function unsubscribeRunEvents(connection: RealtimeClientConnection, runId?: string): void {
  const subscriptions = runEventSubscriptions.get(connection);
  if (!subscriptions) return;
  if (runId) {
    subscriptions.delete(runId);
  } else {
    subscriptions.clear();
  }
  if (subscriptions.size === 0) {
    runEventSubscriptions.delete(connection);
    runEventSubscriberCount = Math.max(0, runEventSubscriberCount - 1);
  }
}

function isSubscribedToRun(connection: RealtimeClientConnection, runId: string): boolean {
  const subscriptions = runEventSubscriptions.get(connection);
  return Boolean(subscriptions && (subscriptions.has(runId) || subscriptions.has(ALL_RUNS_SUBSCRIPTION)));
}

export function broadcastSystemEvent(event: SystemWsEvent): void {
  try {
    const runScope = event.kind === 'run_event' ? event.run_id : null;
    if (runScope !== null && runEventSubscriberCount === 0) {
      // Nobody is listening: skip even the JSON.stringify.
      return;
    }

    let frame: string | null = null;
    connectedClients.forEach((client) => {
      if (client.readyState !== WS_OPEN_STATE) return;
      if (runScope !== null && !isSubscribedToRun(client, runScope)) return;
      frame ??= JSON.stringify({
        ...event,
        timestamp: new Date().toISOString(),
      });
      try {
        client.send(frame);
      } catch {
        // Drop closed/broken sockets lazily; prune happens on next send elsewhere.
      }
    });
  } catch {
    // Best-effort only.
  }
}
