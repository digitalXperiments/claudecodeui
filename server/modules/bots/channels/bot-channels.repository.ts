import { getConnection } from '@/modules/database/index.js';
import { newBotChannelId } from '@/shared/ids.js';
import { nowIso, parseJsonObject, toFlag } from '@/modules/bots/bots.util.js';
import type { BotChannel, BotChannelPolicy } from '@/modules/bots/bots.types.js';

type ChannelRow = {
  channel_id: string;
  bot_id: string | null;
  kind: string;
  config_json: string;
  policy_json: string;
  enabled: number;
  created_at: string;
  updated_at: string;
};

function mapChannel(row: ChannelRow): BotChannel {
  return {
    channel_id: row.channel_id,
    bot_id: row.bot_id,
    kind: row.kind,
    config: parseJsonObject(row.config_json),
    policy: parseJsonObject(row.policy_json) as BotChannelPolicy,
    enabled: row.enabled === 1,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export interface UpsertBotChannelInput {
  channelId?: string;
  botId?: string | null;
  kind: string;
  config?: Record<string, unknown>;
  policy?: BotChannelPolicy;
  enabled?: boolean;
}

export const botChannelsDb = {
  get(channelId: string): BotChannel | null {
    const row = getConnection().prepare('SELECT * FROM bot_channels WHERE channel_id = ?').get(channelId) as
      | ChannelRow
      | undefined;
    return row ? mapChannel(row) : null;
  },

  /** Channels for a bot, or the global defaults when botId is null. */
  list(botId: string | null): BotChannel[] {
    const db = getConnection();
    const rows = (botId === null
      ? db.prepare('SELECT * FROM bot_channels WHERE bot_id IS NULL ORDER BY created_at ASC').all()
      : db.prepare('SELECT * FROM bot_channels WHERE bot_id = ? ORDER BY created_at ASC').all(botId)) as ChannelRow[];
    return rows.map(mapChannel);
  },

  /** A bot's effective channels: its own, falling back to global defaults for kinds it doesn't override. */
  listEffective(botId: string): BotChannel[] {
    const own = botChannelsDb.list(botId);
    const ownKinds = new Set(own.map((channel) => channel.kind));
    return [...own, ...botChannelsDb.list(null).filter((channel) => !ownKinds.has(channel.kind))];
  },

  upsert(input: UpsertBotChannelInput): BotChannel {
    const ts = nowIso();
    const existing = input.channelId ? botChannelsDb.get(input.channelId) : null;
    if (existing) {
      getConnection()
        .prepare('UPDATE bot_channels SET kind = ?, config_json = ?, policy_json = ?, enabled = ?, updated_at = ? WHERE channel_id = ?')
        .run(
          input.kind,
          JSON.stringify(input.config ?? existing.config),
          JSON.stringify(input.policy ?? existing.policy),
          toFlag(input.enabled, existing.enabled),
          ts,
          existing.channel_id,
        );
      return botChannelsDb.get(existing.channel_id)!;
    }
    const id = input.channelId ?? newBotChannelId();
    getConnection()
      .prepare(
        `INSERT INTO bot_channels (channel_id, bot_id, kind, config_json, policy_json, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.botId ?? null,
        input.kind,
        JSON.stringify(input.config ?? {}),
        JSON.stringify(input.policy ?? {}),
        toFlag(input.enabled, true),
        ts,
        ts,
      );
    return botChannelsDb.get(id)!;
  },

  delete(channelId: string): boolean {
    return getConnection().prepare('DELETE FROM bot_channels WHERE channel_id = ?').run(channelId).changes > 0;
  },
};
