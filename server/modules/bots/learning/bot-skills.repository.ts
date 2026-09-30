import { getConnection } from '@/modules/database/index.js';
import { newBotSkillLinkId } from '@/shared/ids.js';
import { nowIso, toFlag } from '@/modules/bots/bots.util.js';
import type { BotSkill } from '@/modules/bots/bots.types.js';

type SkillRow = {
  link_id: string;
  bot_id: string;
  name: string;
  path: string;
  origin: string;
  version: number;
  enabled: number;
  created_at: string;
  updated_at: string;
};

function mapSkill(row: SkillRow): BotSkill {
  return { ...row, enabled: row.enabled === 1 };
}

export interface UpsertBotSkillInput {
  botId: string;
  name: string;
  path: string;
  origin?: string;
  enabled?: boolean;
}

export const botSkillsDb = {
  get(linkId: string): BotSkill | null {
    const row = getConnection().prepare('SELECT * FROM bot_skills WHERE link_id = ?').get(linkId) as
      | SkillRow
      | undefined;
    return row ? mapSkill(row) : null;
  },

  getByName(botId: string, name: string): BotSkill | null {
    const row = getConnection().prepare('SELECT * FROM bot_skills WHERE bot_id = ? AND name = ?').get(botId, name) as
      | SkillRow
      | undefined;
    return row ? mapSkill(row) : null;
  },

  list(botId: string): BotSkill[] {
    const rows = getConnection()
      .prepare('SELECT * FROM bot_skills WHERE bot_id = ? ORDER BY name ASC')
      .all(botId) as SkillRow[];
    return rows.map(mapSkill);
  },

  /** Create a skill link, or bump the version and update path/origin of the existing (bot_id, name) link. */
  upsert(input: UpsertBotSkillInput): BotSkill {
    const existing = botSkillsDb.getByName(input.botId, input.name);
    const ts = nowIso();
    if (existing) {
      getConnection()
        .prepare('UPDATE bot_skills SET path = ?, origin = ?, version = version + 1, enabled = ?, updated_at = ? WHERE link_id = ?')
        .run(input.path, input.origin ?? existing.origin, toFlag(input.enabled, existing.enabled), ts, existing.link_id);
      return botSkillsDb.get(existing.link_id)!;
    }
    const id = newBotSkillLinkId();
    getConnection()
      .prepare(
        `INSERT INTO bot_skills (link_id, bot_id, name, path, origin, version, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)`,
      )
      .run(id, input.botId, input.name, input.path, input.origin ?? 'manual', toFlag(input.enabled, true), ts, ts);
    return botSkillsDb.get(id)!;
  },

  setEnabled(linkId: string, enabled: boolean): BotSkill | null {
    const result = getConnection()
      .prepare('UPDATE bot_skills SET enabled = ?, updated_at = ? WHERE link_id = ?')
      .run(enabled ? 1 : 0, nowIso(), linkId);
    return result.changes > 0 ? botSkillsDb.get(linkId) : null;
  },

  delete(linkId: string): boolean {
    return getConnection().prepare('DELETE FROM bot_skills WHERE link_id = ?').run(linkId).changes > 0;
  },
};
