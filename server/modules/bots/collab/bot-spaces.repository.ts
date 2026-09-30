import { getConnection } from '@/modules/database/index.js';
import { newBotSpaceId } from '@/shared/ids.js';
import { nowIso } from '@/modules/bots/bots.util.js';
import type { BotSpace } from '@/modules/bots/bots.types.js';

const SELECT = 'SELECT space_id, bot_id, title, path, kind, created_at, updated_at FROM bot_spaces';

export const botSpacesDb = {
  get(spaceId: string): BotSpace | null {
    return (getConnection().prepare(`${SELECT} WHERE space_id = ?`).get(spaceId) as BotSpace | undefined) ?? null;
  },

  list(botId: string): BotSpace[] {
    return getConnection().prepare(`${SELECT} WHERE bot_id = ? ORDER BY updated_at DESC`).all(botId) as BotSpace[];
  },

  create(input: { botId: string; title: string; path: string; kind?: string }): BotSpace {
    const id = newBotSpaceId();
    const ts = nowIso();
    getConnection()
      .prepare('INSERT INTO bot_spaces (space_id, bot_id, title, path, kind, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, input.botId, input.title, input.path, input.kind ?? 'markdown', ts, ts);
    return botSpacesDb.get(id)!;
  },

  update(spaceId: string, patch: { title?: string; path?: string; kind?: string }): BotSpace | null {
    const current = botSpacesDb.get(spaceId);
    if (!current) return null;
    getConnection()
      .prepare('UPDATE bot_spaces SET title = ?, path = ?, kind = ?, updated_at = ? WHERE space_id = ?')
      .run(patch.title ?? current.title, patch.path ?? current.path, patch.kind ?? current.kind, nowIso(), spaceId);
    return botSpacesDb.get(spaceId);
  },

  /** Bump updated_at without changing metadata (after the space file was written). */
  touch(spaceId: string): void {
    getConnection().prepare('UPDATE bot_spaces SET updated_at = ? WHERE space_id = ?').run(nowIso(), spaceId);
  },

  delete(spaceId: string): boolean {
    return getConnection().prepare('DELETE FROM bot_spaces WHERE space_id = ?').run(spaceId).changes > 0;
  },
};
