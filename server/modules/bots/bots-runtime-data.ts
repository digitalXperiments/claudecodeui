import { getConnection } from '@/modules/database/index.js';

/**
 * Remove every piece of bot runtime data that does NOT cascade from
 * mc_sections: FTS5 rows (virtual tables have no FKs) and tables keyed by bot_id
 * without a foreign key (leases, scoped rules, gate decisions, channels,
 * outbound log, team membership). FK tables cascade when the section row is
 * deleted (PRAGMA foreign_keys is ON via INIT_SCHEMA_SQL), but call this too so
 * nothing is orphaned. Safe to call before or after the section is deleted.
 */
export function deleteBotRuntimeData(botId: string): void {
  const db = getConnection();
  db.transaction(() => {
    db.prepare('DELETE FROM bot_episodes_fts WHERE bot_id = ?').run(botId);
    db.prepare('DELETE FROM bot_leases WHERE bot_id = ?').run(botId);
    db.prepare("DELETE FROM bot_rules WHERE scope = 'bot' AND bot_id = ?").run(botId);
    db.prepare('DELETE FROM bot_gate_decisions WHERE bot_id = ?').run(botId);
    db.prepare('DELETE FROM bot_channels WHERE bot_id = ?').run(botId);
    db.prepare('DELETE FROM bot_outbound_log WHERE bot_id = ?').run(botId);
    db.prepare('DELETE FROM bot_team_members WHERE bot_id = ?').run(botId);
    db.prepare('UPDATE bot_teams SET coordinator_bot_id = NULL WHERE coordinator_bot_id = ?').run(botId);
    // FK-cascaded tables, deleted explicitly so the helper also works with foreign_keys off.
    for (const table of [
      'bot_triggers', 'bot_events', 'bot_goals', 'bot_commitments', 'bot_episodes', 'bot_budgets',
      'bot_learning_proposals', 'bot_skills', 'bot_thread_messages', 'bot_spaces',
    ]) {
      db.prepare(`DELETE FROM ${table} WHERE bot_id = ?`).run(botId);
    }
  })();
}
