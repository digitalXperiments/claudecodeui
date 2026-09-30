import { getConnection } from '@/modules/database/index.js';
import { newBotTriggerId } from '@/shared/ids.js';
import { nowIso, parseJsonObject, toFlag } from '@/modules/bots/bots.util.js';
import type { BotTrigger } from '@/modules/bots/bots.types.js';

type TriggerRow = {
  trigger_id: string;
  bot_id: string;
  kind: string;
  config_json: string;
  enabled: number;
  cursor_json: string;
  last_fired_at: string | null;
  created_at: string;
  updated_at: string;
};

function mapTrigger(row: TriggerRow): BotTrigger {
  return {
    trigger_id: row.trigger_id,
    bot_id: row.bot_id,
    kind: row.kind,
    config: parseJsonObject(row.config_json),
    enabled: row.enabled === 1,
    cursor: parseJsonObject(row.cursor_json),
    last_fired_at: row.last_fired_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export interface CreateBotTriggerInput {
  botId: string;
  kind: string;
  config?: Record<string, unknown>;
  enabled?: boolean;
}

export interface UpdateBotTriggerInput {
  kind?: string;
  config?: Record<string, unknown>;
  enabled?: boolean;
  cursor?: Record<string, unknown>;
  lastFiredAt?: string | null;
}

export const botTriggersDb = {
  get(triggerId: string): BotTrigger | null {
    const row = getConnection()
      .prepare('SELECT * FROM bot_triggers WHERE trigger_id = ?')
      .get(triggerId) as TriggerRow | undefined;
    return row ? mapTrigger(row) : null;
  },

  list(botId?: string): BotTrigger[] {
    const db = getConnection();
    const rows = (botId
      ? db.prepare('SELECT * FROM bot_triggers WHERE bot_id = ? ORDER BY created_at ASC').all(botId)
      : db.prepare('SELECT * FROM bot_triggers ORDER BY created_at ASC').all()) as TriggerRow[];
    return rows.map(mapTrigger);
  },

  listEnabled(): BotTrigger[] {
    const rows = getConnection()
      .prepare('SELECT * FROM bot_triggers WHERE enabled = 1 ORDER BY created_at ASC')
      .all() as TriggerRow[];
    return rows.map(mapTrigger);
  },

  create(input: CreateBotTriggerInput): BotTrigger {
    const id = newBotTriggerId();
    const ts = nowIso();
    getConnection()
      .prepare(
        `INSERT INTO bot_triggers (trigger_id, bot_id, kind, config_json, enabled, cursor_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, '{}', ?, ?)`,
      )
      .run(id, input.botId, input.kind, JSON.stringify(input.config ?? {}), toFlag(input.enabled, true), ts, ts);
    return botTriggersDb.get(id)!;
  },

  update(triggerId: string, patch: UpdateBotTriggerInput): BotTrigger | null {
    const current = botTriggersDb.get(triggerId);
    if (!current) return null;
    getConnection()
      .prepare(
        `UPDATE bot_triggers SET kind = ?, config_json = ?, enabled = ?, cursor_json = ?, last_fired_at = ?, updated_at = ?
         WHERE trigger_id = ?`,
      )
      .run(
        patch.kind ?? current.kind,
        JSON.stringify(patch.config ?? current.config),
        toFlag(patch.enabled, current.enabled),
        JSON.stringify(patch.cursor ?? current.cursor),
        patch.lastFiredAt === undefined ? current.last_fired_at : patch.lastFiredAt,
        nowIso(),
        triggerId,
      );
    return botTriggersDb.get(triggerId);
  },

  delete(triggerId: string): boolean {
    return getConnection().prepare('DELETE FROM bot_triggers WHERE trigger_id = ?').run(triggerId).changes > 0;
  },
};
