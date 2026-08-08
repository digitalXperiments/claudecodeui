/**
 * Best-effort WebSocket fan-out for system-level events (PRD §4.6).
 *
 * Mirrors `broadcastNotificationCreated` in auth-health: every open chat
 * WebSocket receives a JSON frame. Failures never throw — realtime is optional.
 */

import type { SystemWsEvent } from '@/shared/run-events.js';
import {
  connectedClients,
  WS_OPEN_STATE,
} from '@/modules/websocket/services/websocket-state.service.js';

export function broadcastSystemEvent(event: SystemWsEvent): void {
  try {
    const frame = JSON.stringify({
      ...event,
      timestamp: new Date().toISOString(),
    });
    connectedClients.forEach((client) => {
      if (client.readyState === WS_OPEN_STATE) {
        try {
          client.send(frame);
        } catch {
          // Drop closed/broken sockets lazily; prune happens on next send elsewhere.
        }
      }
    });
  } catch {
    // Best-effort only.
  }
}
