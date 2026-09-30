import type { BotThreadMessage } from '../../../../types/botRuntime';

/** A thread message the operator just sent and the server has not acknowledged yet. */
export type OptimisticMessage = BotThreadMessage & { optimistic: true; failed?: boolean };
export type ThreadEntry = BotThreadMessage | OptimisticMessage;

export const isOptimistic = (entry: ThreadEntry): entry is OptimisticMessage => 'optimistic' in entry && entry.optimistic === true;

export const THREAD_PAGE_SIZE = 100;
const OPTIMISTIC_PREFIX = 'optimistic-';

export function makeOptimisticMessage(botId: string, body: string, now: number = Date.now(), nonce: string = String(now)): OptimisticMessage {
  return {
    message_id: `${OPTIMISTIC_PREFIX}${nonce}`,
    bot_id: botId,
    role: 'operator',
    body,
    channel: 'inapp',
    meta: {},
    created_at: new Date(now).toISOString(),
    optimistic: true,
  };
}

/**
 * Enter sends, Shift+Enter inserts a newline. An IME composition (`isComposing`) must never send,
 * and an empty/whitespace draft never sends.
 */
export function shouldSendOnKey(event: { key: string; shiftKey: boolean; isComposing?: boolean }, draft: string): boolean {
  return event.key === 'Enter' && !event.shiftKey && !event.isComposing && draft.trim().length > 0;
}

/**
 * Append still-pending optimistic messages after the confirmed thread, dropping any whose real
 * counterpart has already arrived over the websocket (same operator body at/after the send time,
 * tolerating a little clock skew between client and server).
 */
export function mergeOptimistic(messages: BotThreadMessage[], pending: OptimisticMessage[], skewMs = 10_000): ThreadEntry[] {
  const used = new Set<string>();
  const remaining = [...pending]
    .sort((a, b) => a.created_at.localeCompare(b.created_at))
    .filter((optimistic) => {
      const sentAt = Date.parse(optimistic.created_at);
      // Each confirmed message can satisfy only one optimistic one (the operator may send the same text twice).
      const match = messages.find((message) => message.role === 'operator'
        && !used.has(message.message_id)
        && message.body === optimistic.body
        && Date.parse(message.created_at) >= sentAt - skewMs);
      if (match) used.add(match.message_id);
      return !match;
    });
  return [...messages, ...remaining];
}

/** Cursor for "load older": the oldest confirmed message's created_at. */
export function oldestCursor(messages: BotThreadMessage[]): string | null {
  return messages.length > 0 ? messages[0].created_at : null;
}

export type ThreadDayGroup = { key: string; label: string; entries: ThreadEntry[] };

function dayKey(time: number): string {
  const date = new Date(time);
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}

/** Group a chronological thread into day sections labelled Today / Yesterday / a date. */
export function groupThreadByDay(entries: ThreadEntry[], now: number = Date.now()): ThreadDayGroup[] {
  const todayKey = dayKey(now);
  const yesterdayKey = dayKey(now - 24 * 60 * 60 * 1000);
  const groups: ThreadDayGroup[] = [];
  for (const entry of entries) {
    const time = Date.parse(entry.created_at);
    const key = Number.isFinite(time) ? dayKey(time) : 'unknown';
    const last = groups[groups.length - 1];
    if (last && last.key === key) {
      last.entries.push(entry);
      continue;
    }
    const label = key === todayKey ? 'Today'
      : key === yesterdayKey ? 'Yesterday'
        : Number.isFinite(time) ? new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' }).format(new Date(time))
          : 'Earlier';
    groups.push({ key, label, entries: [entry] });
  }
  return groups;
}

export type ThreadAlignment = 'right' | 'left' | 'center';

export const threadAlignment = (role: string): ThreadAlignment => (role === 'operator' ? 'right' : role === 'bot' ? 'left' : 'center');
