/**
 * Live `kind: 'error'` rows emitted by provider runs, keyed by app session id.
 *
 * Provider transcripts often never record a failed turn's error (Codex writes
 * only the user prompt and an empty `task_complete` when the model is
 * rejected), so these rows are persisted here and merged back into history.
 */

import { getConnection } from '@/modules/database/connection.js';

export type SessionRunErrorRow = {
  message_id: string;
  session_id: string;
  provider: string;
  content: string;
  timestamp: string;
};

export const sessionRunErrorsDb = {
  record(row: SessionRunErrorRow): void {
    const db = getConnection();
    db.prepare(`
      INSERT OR IGNORE INTO session_run_errors (message_id, session_id, provider, content, timestamp)
      VALUES (?, ?, ?, ?, ?)
    `).run(row.message_id, row.session_id, row.provider, row.content, row.timestamp);
  },

  listBySession(sessionId: string): SessionRunErrorRow[] {
    const db = getConnection();
    return db.prepare(`
      SELECT message_id, session_id, provider, content, timestamp
      FROM session_run_errors
      WHERE session_id = ?
      ORDER BY timestamp ASC
    `).all(sessionId) as SessionRunErrorRow[];
  },

  deleteBySession(sessionId: string): void {
    const db = getConnection();
    db.prepare('DELETE FROM session_run_errors WHERE session_id = ?').run(sessionId);
  },
};
