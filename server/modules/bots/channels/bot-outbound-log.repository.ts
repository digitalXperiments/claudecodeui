import { getConnection } from '@/modules/database/index.js';
import { nowIso } from '@/modules/bots/bots.util.js';
import type { BotOutboundLogEntry } from '@/modules/bots/bots.types.js';

type OutboundRow = {
  bot_id: string | null;
  channel_kind: string;
  urgency: number;
  delivered: number;
  reason: string | null;
  created_at: string;
};

function mapEntry(row: OutboundRow): BotOutboundLogEntry {
  return { ...row, delivered: row.delivered === 1 };
}

export const botOutboundLogDb = {
  record(entry: {
    botId: string | null;
    channelKind: string;
    urgency: number;
    delivered: boolean;
    reason?: string | null;
  }): BotOutboundLogEntry {
    const createdAt = nowIso();
    getConnection()
      .prepare('INSERT INTO bot_outbound_log (bot_id, channel_kind, urgency, delivered, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(entry.botId, entry.channelKind, entry.urgency, entry.delivered ? 1 : 0, entry.reason ?? null, createdAt);
    return {
      bot_id: entry.botId,
      channel_kind: entry.channelKind,
      urgency: entry.urgency,
      delivered: entry.delivered,
      reason: entry.reason ?? null,
      created_at: createdAt,
    };
  },

  /** Delivered pings on a channel kind since `sinceIso` (for max_pings_per_day). */
  countDeliveredSince(botId: string | null, channelKind: string, sinceIso: string): number {
    const db = getConnection();
    const row = (botId === null
      ? db
          .prepare('SELECT COUNT(*) AS n FROM bot_outbound_log WHERE bot_id IS NULL AND channel_kind = ? AND delivered = 1 AND created_at >= ?')
          .get(channelKind, sinceIso)
      : db
          .prepare('SELECT COUNT(*) AS n FROM bot_outbound_log WHERE bot_id = ? AND channel_kind = ? AND delivered = 1 AND created_at >= ?')
          .get(botId, channelKind, sinceIso)) as { n: number };
    return row.n;
  },

  listRecent(botId: string | null, limit = 100): BotOutboundLogEntry[] {
    const db = getConnection();
    const rows = (botId === null
      ? db.prepare('SELECT * FROM bot_outbound_log ORDER BY created_at DESC LIMIT ?').all(Math.max(1, limit))
      : db.prepare('SELECT * FROM bot_outbound_log WHERE bot_id = ? ORDER BY created_at DESC LIMIT ?').all(botId, Math.max(1, limit))) as OutboundRow[];
    return rows.map(mapEntry);
  },

  deleteForBot(botId: string): number {
    return getConnection().prepare('DELETE FROM bot_outbound_log WHERE bot_id = ?').run(botId).changes;
  },
};
