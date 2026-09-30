import { getConnection } from '@/modules/database/index.js';
import { newBotThreadMessageId } from '@/shared/ids.js';
import { nowIso, parseJsonObject } from '@/modules/bots/bots.util.js';
import type { BotThreadMessage, BotThreadRole } from '@/modules/bots/bots.types.js';

type MessageRow = {
  message_id: string;
  bot_id: string;
  role: string;
  body: string;
  channel: string;
  meta_json: string;
  created_at: string;
};

function mapMessage(row: MessageRow): BotThreadMessage {
  return {
    message_id: row.message_id,
    bot_id: row.bot_id,
    role: row.role as BotThreadRole,
    body: row.body,
    channel: row.channel,
    meta: parseJsonObject(row.meta_json),
    created_at: row.created_at,
  };
}

export interface PostBotThreadMessageInput {
  role: BotThreadRole;
  body: string;
  channel?: string;
  meta?: Record<string, unknown>;
}

export const botThreadDb = {
  get(messageId: string): BotThreadMessage | null {
    const row = getConnection().prepare('SELECT * FROM bot_thread_messages WHERE message_id = ?').get(messageId) as
      | MessageRow
      | undefined;
    return row ? mapMessage(row) : null;
  },

  post(botId: string, input: PostBotThreadMessageInput): BotThreadMessage {
    const id = newBotThreadMessageId();
    getConnection()
      .prepare(
        'INSERT INTO bot_thread_messages (message_id, bot_id, role, body, channel, meta_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(id, botId, input.role, input.body, input.channel ?? 'inapp', JSON.stringify(input.meta ?? {}), nowIso());
    return botThreadDb.get(id)!;
  },

  /** Messages oldest-first; `before` is an ISO cursor for paging back through history. */
  list(botId: string, options: { limit?: number; before?: string } = {}): BotThreadMessage[] {
    const db = getConnection();
    const limit = Math.max(1, options.limit ?? 100);
    const rows = (options.before
      ? db
          .prepare('SELECT * FROM bot_thread_messages WHERE bot_id = ? AND created_at < ? ORDER BY created_at DESC, message_id DESC LIMIT ?')
          .all(botId, options.before, limit)
      : db
          .prepare('SELECT * FROM bot_thread_messages WHERE bot_id = ? ORDER BY created_at DESC, message_id DESC LIMIT ?')
          .all(botId, limit)) as MessageRow[];
    return rows.reverse().map(mapMessage);
  },

  deleteForBot(botId: string): number {
    return getConnection().prepare('DELETE FROM bot_thread_messages WHERE bot_id = ?').run(botId).changes;
  },
};
