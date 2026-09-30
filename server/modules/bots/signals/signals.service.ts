/**
 * L1 Signals: the bot event bus. Every reason a bot might wake becomes a
 * normalized `bot_events` row; ingest dedupes, broadcasts, and asks the
 * (injected) wake handler to run the bot after a per-bot debounce so bursts of
 * events coalesce into a single wake-up.
 */

import { missionControlDb } from '@/modules/mission-control/index.js';
import { broadcastSystemEvent } from '@/modules/websocket/index.js';
import type { BotEvent, IngestEventInput } from '@/modules/bots/bots.types.js';
import { botEventsDb } from '@/modules/bots/signals/bot-events.repository.js';
import { botTriggersDb } from '@/modules/bots/signals/bot-triggers.repository.js';

export const DEFAULT_COALESCE_MS = 5_000;
export const MAX_COALESCE_MS = 600_000;
/** Operator-authored events (chat, manual wake) should not sit behind a long debounce. */
const OPERATOR_MAX_DELAY_MS = 1_000;

export function clampCoalesceMs(value: unknown, fallback = DEFAULT_COALESCE_MS): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(MAX_COALESCE_MS, Math.max(0, Math.round(n)));
}

type WakeHandler = (botId: string) => void;

interface PendingWake {
  timer: ReturnType<typeof setTimeout>;
  firstAt: number;
}

let wakeHandler: WakeHandler | null = null;
const pending = new Map<string, PendingWake>();

function fireWake(botId: string): void {
  pending.delete(botId);
  if (!wakeHandler) return;
  try {
    wakeHandler(botId);
  } catch (error) {
    console.error('[BotSignals] wake handler failed', { botId, error: error instanceof Error ? error.message : String(error) });
  }
}

/** Debounce: each new event restarts the window, bounded so a steady stream still wakes the bot. */
function scheduleWake(botId: string, delayMs: number): void {
  const now = Date.now();
  const existing = pending.get(botId);
  const firstAt = existing?.firstAt ?? now;
  if (existing) clearTimeout(existing.timer);
  const maxWait = Math.min(MAX_COALESCE_MS, Math.max(delayMs * 6, delayMs));
  const delay = Math.max(0, Math.min(delayMs, firstAt + maxWait - now));
  const timer = setTimeout(() => fireWake(botId), delay);
  timer.unref?.();
  pending.set(botId, { timer, firstAt });
}

function wakeDelayFor(input: IngestEventInput): number {
  let delay = DEFAULT_COALESCE_MS;
  if (input.triggerId) {
    const trigger = botTriggersDb.get(input.triggerId);
    if (trigger) delay = clampCoalesceMs(trigger.config.coalesce_ms, DEFAULT_COALESCE_MS);
  }
  if (input.trust === 'operator') delay = Math.min(delay, OPERATOR_MAX_DELAY_MS);
  return delay;
}

export const botSignals = {
  /** The kernel registers its `notify` here. Pass null to detach. */
  setWakeHandler(handler: WakeHandler | null): void {
    wakeHandler = handler;
  },

  /**
   * Insert a queued event (deduping on `dedupeKey`), broadcast it, and request a
   * debounced wake. Events for disabled bots are recorded as dropped.
   */
  ingest(input: IngestEventInput): { event: BotEvent; duplicate: boolean } {
    const bot = missionControlDb.getSection(input.botId);
    if (!bot) throw new Error(`Unknown bot: ${input.botId}`);
    const inserted = botEventsDb.insert(input);
    if (inserted.duplicate) return inserted;
    if (input.triggerId) {
      botTriggersDb.update(input.triggerId, { lastFiredAt: inserted.event.received_at });
    }
    if (!bot.enabled) {
      botEventsDb.markDropped([inserted.event.event_id], 'bot_disabled');
      return { event: botEventsDb.get(inserted.event.event_id) ?? inserted.event, duplicate: false };
    }
    broadcastSystemEvent({
      kind: 'bot_event_received',
      bot_id: input.botId,
      event_id: inserted.event.event_id,
      event_kind: input.kind,
    });
    scheduleWake(input.botId, wakeDelayFor(input));
    return inserted;
  },

  claimBatch(botId: string, options: { max: number; coalesceMs?: number }): BotEvent[] {
    return botEventsDb.claimBatch(botId, options);
  },

  markConsumed(eventIds: string[], episodeId: string | null): number {
    return botEventsDb.markConsumed(eventIds, episodeId);
  },

  markDropped(eventIds: string[], reason?: string): number {
    return botEventsDb.markDropped(eventIds, reason);
  },

  listRecent(botId: string, limit = 50): BotEvent[] {
    return botEventsDb.listRecent(botId, limit);
  },

  /** Run every pending debounced wake immediately (tests and shutdown). */
  flushWakes(): void {
    for (const [botId, entry] of [...pending.entries()]) {
      clearTimeout(entry.timer);
      fireWake(botId);
    }
  },

  /** Drop pending wake timers without invoking the handler. */
  cancelWakes(): void {
    for (const entry of pending.values()) clearTimeout(entry.timer);
    pending.clear();
  },

  hasPendingWake(botId: string): boolean {
    return pending.has(botId);
  },
};
