import type { BotRun } from '../../api/botStudioApi';

export type ActivityFilter = 'all' | 'failed' | 'completed' | 'noop';

export type ActivityRow = { botId: string; run: BotRun };

export function filterActivityRows(rows: ActivityRow[], filter: ActivityFilter): ActivityRow[] {
  if (filter === 'all') return rows;
  return rows.filter(({ run }) => {
    const status = run.status.toLowerCase();
    const kind = (run.kind ?? '').toLowerCase();
    if (filter === 'failed') return status === 'failed' || Boolean(run.error_summary);
    if (filter === 'completed') return ['completed', 'resolved', 'graded', 'success', 'succeeded'].includes(status) || ['graded', 'completed'].includes(kind);
    return ['noop', 'no-op', 'skipped'].includes(status) || ['noop', 'no-op', 'skipped'].includes(kind);
  });
}

export function sortActivityRows(rows: ActivityRow[]): ActivityRow[] {
  return [...rows].sort((a, b) => String(b.run.started_at ?? '').localeCompare(String(a.run.started_at ?? '')));
}

export function pageActivityRows(rows: ActivityRow[], page: number, pageSize: number): ActivityRow[] {
  return rows.slice(0, Math.max(0, page) * Math.max(1, pageSize));
}
