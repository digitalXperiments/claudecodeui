import { getConnection } from '@/modules/database/index.js';
import type { BotLease } from '@/modules/bots/bots.types.js';

function isoPlus(ms: number, from = Date.now()): string {
  return new Date(from + ms).toISOString();
}

export const botLeasesDb = {
  get(botId: string): BotLease | null {
    return (
      (getConnection().prepare('SELECT * FROM bot_leases WHERE bot_id = ?').get(botId) as BotLease | undefined) ??
      null
    );
  },

  /**
   * Atomic acquire: inserts a lease, or takes over one whose expires_at is in
   * the past. Returns the lease only when this holder now owns it.
   */
  acquire(botId: string, holder: string, ttlMs: number, episodeId: string | null = null): BotLease | null {
    const now = Date.now();
    const nowStr = new Date(now).toISOString();
    const result = getConnection()
      .prepare(
        `INSERT INTO bot_leases (bot_id, holder, episode_id, acquired_at, expires_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(bot_id) DO UPDATE SET
           holder = excluded.holder, episode_id = excluded.episode_id,
           acquired_at = excluded.acquired_at, expires_at = excluded.expires_at
         WHERE bot_leases.expires_at < ?`,
      )
      .run(botId, holder, episodeId, nowStr, isoPlus(ttlMs, now), nowStr);
    return result.changes > 0 ? botLeasesDb.get(botId) : null;
  },

  /** Extend the lease; only succeeds for the current holder while unexpired-or-not-yet-taken. */
  renew(botId: string, holder: string, ttlMs: number, episodeId?: string | null): boolean {
    const db = getConnection();
    if (episodeId === undefined) {
      return (
        db
          .prepare('UPDATE bot_leases SET expires_at = ? WHERE bot_id = ? AND holder = ?')
          .run(isoPlus(ttlMs), botId, holder).changes > 0
      );
    }
    return (
      db
        .prepare('UPDATE bot_leases SET expires_at = ?, episode_id = ? WHERE bot_id = ? AND holder = ?')
        .run(isoPlus(ttlMs), episodeId, botId, holder).changes > 0
    );
  },

  /** Release only by the holder. */
  release(botId: string, holder: string): boolean {
    return getConnection().prepare('DELETE FROM bot_leases WHERE bot_id = ? AND holder = ?').run(botId, holder).changes > 0;
  },

  /** Delete every lease past expiry; returns the expired rows (for episode recovery). */
  expireStale(now: Date = new Date()): BotLease[] {
    const db = getConnection();
    const nowStr = now.toISOString();
    const expire = db.transaction((): BotLease[] => {
      const rows = db.prepare('SELECT * FROM bot_leases WHERE expires_at < ?').all(nowStr) as BotLease[];
      if (rows.length > 0) db.prepare('DELETE FROM bot_leases WHERE expires_at < ?').run(nowStr);
      return rows;
    });
    return expire();
  },

  list(): BotLease[] {
    return getConnection().prepare('SELECT * FROM bot_leases ORDER BY bot_id').all() as BotLease[];
  },
};
