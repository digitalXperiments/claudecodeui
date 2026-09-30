import { getConnection } from '@/modules/database/index.js';
import { newBotEventId } from '@/shared/ids.js';
import { nowIso, parseJsonObject } from '@/modules/bots/bots.util.js';
import type {
  BotEvent,
  BotEventStatus,
  BotTrust,
  IngestEventInput,
} from '@/modules/bots/bots.types.js';

type EventRow = {
  event_id: string;
  bot_id: string;
  trigger_id: string | null;
  source: string;
  kind: string;
  dedupe_key: string | null;
  trust: string;
  payload_json: string;
  status: string;
  episode_id: string | null;
  received_at: string;
  claimed_at: string | null;
};

function mapEvent(row: EventRow): BotEvent {
  return {
    event_id: row.event_id,
    bot_id: row.bot_id,
    trigger_id: row.trigger_id,
    source: row.source,
    kind: row.kind,
    dedupe_key: row.dedupe_key,
    trust: row.trust as BotTrust,
    payload: parseJsonObject(row.payload_json),
    status: row.status as BotEventStatus,
    episode_id: row.episode_id,
    received_at: row.received_at,
    claimed_at: row.claimed_at,
  };
}

const placeholders = (count: number): string => new Array(count).fill('?').join(',');

export const botEventsDb = {
  get(eventId: string): BotEvent | null {
    const row = getConnection()
      .prepare('SELECT * FROM bot_events WHERE event_id = ?')
      .get(eventId) as EventRow | undefined;
    return row ? mapEvent(row) : null;
  },

  findByDedupeKey(botId: string, dedupeKey: string): BotEvent | null {
    const row = getConnection()
      .prepare('SELECT * FROM bot_events WHERE bot_id = ? AND dedupe_key = ?')
      .get(botId, dedupeKey) as EventRow | undefined;
    return row ? mapEvent(row) : null;
  },

  /** Insert a queued event. A repeated (bot_id, dedupe_key) returns the existing row with duplicate=true. */
  insert(input: IngestEventInput): { event: BotEvent; duplicate: boolean } {
    const db = getConnection();
    const eventId = newBotEventId();
    const result = db
      .prepare(
        `INSERT INTO bot_events (event_id, bot_id, trigger_id, source, kind, dedupe_key, trust, payload_json, status, received_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?)
         ON CONFLICT DO NOTHING`,
      )
      .run(
        eventId,
        input.botId,
        input.triggerId ?? null,
        input.source,
        input.kind,
        input.dedupeKey ?? null,
        input.trust,
        JSON.stringify(input.payload ?? {}),
        nowIso(),
      );
    if (result.changes === 0) {
      const existing = input.dedupeKey ? botEventsDb.findByDedupeKey(input.botId, input.dedupeKey) : null;
      if (existing) return { event: existing, duplicate: true };
      throw new Error('bot event insert was ignored without a matching dedupe_key');
    }
    return { event: botEventsDb.get(eventId)!, duplicate: false };
  },

  /**
   * Atomically claim up to `max` queued events (oldest first) for a bot.
   * With `coalesceMs`, only events received within that window of the oldest
   * queued event are taken, so bursts coalesce into one batch.
   */
  claimBatch(botId: string, options: { max: number; coalesceMs?: number }): BotEvent[] {
    const db = getConnection();
    const claim = db.transaction((): BotEvent[] => {
      const queued = db
        .prepare(
          `SELECT * FROM bot_events WHERE bot_id = ? AND status = 'queued'
           ORDER BY received_at ASC, event_id ASC LIMIT ?`,
        )
        .all(botId, Math.max(1, options.max)) as EventRow[];
      if (queued.length === 0) return [];
      let selected = queued;
      if (options.coalesceMs && options.coalesceMs > 0) {
        const first = Date.parse(queued[0].received_at);
        selected = queued.filter((row) => Date.parse(row.received_at) - first <= options.coalesceMs!);
      }
      const ts = nowIso();
      const ids = selected.map((row) => row.event_id);
      db.prepare(
        `UPDATE bot_events SET status = 'claimed', claimed_at = ? WHERE status = 'queued' AND event_id IN (${placeholders(ids.length)})`,
      ).run(ts, ...ids);
      return selected.map((row) => mapEvent({ ...row, status: 'claimed', claimed_at: ts }));
    });
    return claim.immediate();
  },

  markConsumed(eventIds: string[], episodeId: string | null): number {
    if (eventIds.length === 0) return 0;
    return getConnection()
      .prepare(
        `UPDATE bot_events SET status = 'consumed', episode_id = ? WHERE event_id IN (${placeholders(eventIds.length)})`,
      )
      .run(episodeId, ...eventIds).changes;
  },

  markDropped(eventIds: string[], reason?: string): number {
    if (eventIds.length === 0) return 0;
    const db = getConnection();
    const drop = db.transaction((): number => {
      let changes = 0;
      for (const id of eventIds) {
        const row = db.prepare('SELECT payload_json FROM bot_events WHERE event_id = ?').get(id) as
          | { payload_json: string }
          | undefined;
        if (!row) continue;
        const payload = parseJsonObject(row.payload_json);
        if (reason) payload._drop_reason = reason;
        changes += db
          .prepare("UPDATE bot_events SET status = 'dropped', payload_json = ? WHERE event_id = ?")
          .run(JSON.stringify(payload), id).changes;
      }
      return changes;
    });
    return drop();
  },

  /** Return claimed events to the queue (used when an episode is interrupted). */
  releaseClaimed(botId: string): number {
    return getConnection()
      .prepare("UPDATE bot_events SET status = 'queued', claimed_at = NULL WHERE bot_id = ? AND status = 'claimed'")
      .run(botId).changes;
  },

  /** Tag claimed events with the episode that is working on them (used to re-queue after a crash). */
  attachToEpisode(eventIds: string[], episodeId: string): number {
    if (eventIds.length === 0) return 0;
    return getConnection()
      .prepare(`UPDATE bot_events SET episode_id = ? WHERE status = 'claimed' AND event_id IN (${placeholders(eventIds.length)})`)
      .run(episodeId, ...eventIds).changes;
  },

  /** Restart recovery: every claimed event goes back to the queue. Returns the affected bot ids. */
  releaseAllClaimed(): string[] {
    const db = getConnection();
    const release = db.transaction((): string[] => {
      const rows = db.prepare("SELECT DISTINCT bot_id FROM bot_events WHERE status = 'claimed'").all() as { bot_id: string }[];
      db.prepare("UPDATE bot_events SET status = 'queued', claimed_at = NULL, episode_id = NULL WHERE status = 'claimed'").run();
      return rows.map((row) => row.bot_id);
    });
    return release();
  },

  listBotsWithQueued(): string[] {
    const rows = getConnection()
      .prepare("SELECT DISTINCT bot_id FROM bot_events WHERE status = 'queued'")
      .all() as { bot_id: string }[];
    return rows.map((row) => row.bot_id);
  },

  listForEpisode(episodeId: string): BotEvent[] {
    const rows = getConnection()
      .prepare('SELECT * FROM bot_events WHERE episode_id = ? ORDER BY received_at ASC, event_id ASC')
      .all(episodeId) as EventRow[];
    return rows.map(mapEvent);
  },

  countQueued(botId: string): number {
    const row = getConnection()
      .prepare("SELECT COUNT(*) AS n FROM bot_events WHERE bot_id = ? AND status = 'queued'")
      .get(botId) as { n: number };
    return row.n;
  },

  listRecent(botId: string, limit = 50): BotEvent[] {
    const rows = getConnection()
      .prepare('SELECT * FROM bot_events WHERE bot_id = ? ORDER BY received_at DESC, event_id DESC LIMIT ?')
      .all(botId, Math.max(1, limit)) as EventRow[];
    return rows.map(mapEvent);
  },
};
