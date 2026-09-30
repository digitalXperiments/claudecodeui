import { getConnection } from '@/modules/database/index.js';
import { nowIso } from '@/modules/bots/bots.util.js';
import type { BotOperatorProfileEntry } from '@/modules/bots/bots.types.js';

export const botOperatorProfileDb = {
  get(key: string): BotOperatorProfileEntry | null {
    return (
      (getConnection().prepare('SELECT * FROM bot_operator_profile WHERE key = ?').get(key) as
        | BotOperatorProfileEntry
        | undefined) ?? null
    );
  },

  list(): BotOperatorProfileEntry[] {
    return getConnection().prepare('SELECT * FROM bot_operator_profile ORDER BY key ASC').all() as BotOperatorProfileEntry[];
  },

  set(key: string, value: string, source = 'manual'): BotOperatorProfileEntry {
    getConnection()
      .prepare(
        `INSERT INTO bot_operator_profile (key, value, source, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, source = excluded.source, updated_at = excluded.updated_at`,
      )
      .run(key, value, source, nowIso());
    return botOperatorProfileDb.get(key)!;
  },

  delete(key: string): boolean {
    return getConnection().prepare('DELETE FROM bot_operator_profile WHERE key = ?').run(key).changes > 0;
  },
};
