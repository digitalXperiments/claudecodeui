import { getConnection } from '@/modules/database/index.js';

export type BotException = {
  id: string;
  kind: 'failed_tick' | 'failed_item' | 'stale_approval';
  sectionId: string;
  botTitle: string;
  itemId: string | null;
  runId: string | null;
  title: string;
  detail: string;
  at: string;
};

type Row = { section_id: string; bot_title: string; item_id: string | null; run_id: string | null; title: string; detail: string | null; at: string };

/** Open exceptions only: a later successful produce tick clears the failed-tick entry. */
export function listBotExceptions(): BotException[] {
  const db = getConnection();
  const latestRuns = db.prepare(`SELECT s.section_id, s.title AS bot_title, NULL AS item_id,
      r.run_id, 'Tick failed' AS title, COALESCE(r.error_summary, s.last_run_error, 'No error summary recorded') AS detail,
      COALESCE(r.finished_at, r.created_at) AS at
    FROM mc_sections s JOIN agent_runs r ON r.run_id = (
      SELECT run_id FROM agent_runs x WHERE x.source = 'mission_control' AND x.source_ref = s.section_id
        AND COALESCE(json_extract(x.meta_json, '$.phase'), 'produce') = 'produce'
      ORDER BY x.created_at DESC, x.run_id DESC LIMIT 1
    ) WHERE r.status IN ('failed', 'timed_out', 'aborted')`).all() as Row[];
  const sectionErrors = db.prepare(`SELECT section_id, title AS bot_title, last_run_error AS detail,
      COALESCE(last_run_at, updated_at) AS at FROM mc_sections
    WHERE last_run_error IS NOT NULL AND trim(last_run_error) != ''`).all() as Array<{
      section_id: string; bot_title: string; detail: string; at: string;
    }>;
  const itemRows = db.prepare(`SELECT i.section_id, s.title AS bot_title, i.item_id, NULL AS run_id,
      i.title, CASE WHEN i.status = 'failed' THEN COALESCE(i.error, 'Action failed')
        ELSE 'Awaiting review for more than 24 hours' END AS detail, i.updated_at AS at,
      i.status
    FROM mc_items i JOIN mc_sections s ON s.section_id = i.section_id
    WHERE i.status = 'failed' OR (i.status = 'pending' AND i.created_at < datetime('now', '-1 day'))
    ORDER BY i.updated_at DESC LIMIT 200`).all() as Array<Row & { status: string }>;
  return [
    ...latestRuns.map((row) => ({ id: `run:${row.run_id}`, kind: 'failed_tick' as const, sectionId: row.section_id, botTitle: row.bot_title, itemId: null, runId: row.run_id, title: row.title, detail: row.detail ?? '', at: row.at })),
    ...sectionErrors.filter((row) => !latestRuns.some((run) => run.section_id === row.section_id))
      .map((row) => ({ id: `section:${row.section_id}`, kind: 'failed_tick' as const, sectionId: row.section_id, botTitle: row.bot_title, itemId: null, runId: null, title: 'Tick failed before a run was recorded', detail: row.detail, at: row.at })),
    ...itemRows.map((row) => ({ id: `item:${row.item_id}`, kind: row.status === 'failed' ? 'failed_item' as const : 'stale_approval' as const, sectionId: row.section_id, botTitle: row.bot_title, itemId: row.item_id, runId: null, title: row.title, detail: row.detail ?? '', at: row.at })),
  ].sort((a, b) => b.at.localeCompare(a.at));
}
