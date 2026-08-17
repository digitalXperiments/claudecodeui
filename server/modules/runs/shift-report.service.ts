/**
 * Overnight shift report — one Needs you card at 9am local.
 *
 * Summarizes what finished (PRs), what is waiting, what burned money, and
 * what died in a restart. Not a new inbox.
 */

import { getConnection } from '@/modules/database/index.js';
import { interruptsService } from '@/modules/interrupt-queue/index.js';
import { ORPHAN_ERROR_SUMMARY } from '@/modules/runs/runs.types.js';

const SHIFT_HOURS = 12;

function hoursAgoIso(hours: number): string {
  return new Date(Date.now() - hours * 3600_000).toISOString();
}

export type ShiftReport = {
  windowHours: number;
  prs: Array<{ swarmId: string; goal: string; prUrl: string }>;
  waiting: number;
  spendUsd: number;
  restartDeaths: number;
  failedRuns: number;
};

export function collectShiftReport(windowHours = SHIFT_HOURS): ShiftReport {
  const db = getConnection();
  const since = hoursAgoIso(windowHours);

  const prs = db.prepare(
    `SELECT swarm_id, goal, pr_url
     FROM swarm_runs
     WHERE pr_url IS NOT NULL AND trim(pr_url) <> ''
       AND COALESCE(updated_at, created_at) >= ?`,
  ).all(since) as Array<{ swarm_id: string; goal: string; pr_url: string }>;

  const waiting = db.prepare(
    `SELECT COUNT(*) AS n FROM interrupts WHERE status = 'open' AND kind != 'shift_report'`,
  ).get() as { n: number };

  const spend = db.prepare(
    `SELECT COALESCE(SUM(cost_usd_estimate), 0) AS cost
     FROM agent_runs
     WHERE source != 'history'
       AND COALESCE(finished_at, updated_at, created_at) >= ?`,
  ).get(since) as { cost: number };

  const deaths = db.prepare(
    `SELECT COUNT(*) AS n
     FROM agent_runs
     WHERE error_summary = ?
       AND COALESCE(finished_at, updated_at, created_at) >= ?`,
  ).get(ORPHAN_ERROR_SUMMARY, since) as { n: number };

  const failed = db.prepare(
    `SELECT COUNT(*) AS n
     FROM agent_runs
     WHERE status IN ('failed', 'aborted', 'timed_out')
       AND source != 'history'
       AND COALESCE(finished_at, updated_at, created_at) >= ?`,
  ).get(since) as { n: number };

  return {
    windowHours,
    prs: prs.map((row) => ({ swarmId: row.swarm_id, goal: row.goal, prUrl: row.pr_url })),
    waiting: Number(waiting?.n ?? 0),
    spendUsd: Number(spend?.cost ?? 0),
    restartDeaths: Number(deaths?.n ?? 0),
    failedRuns: Number(failed?.n ?? 0),
  };
}

export function formatShiftReport(report: ShiftReport): { title: string; body: string } {
  const prLines = report.prs.length
    ? report.prs.map((row) => `- ${row.prUrl} — ${row.goal.slice(0, 80)}`).join('\n')
    : '- No PRs opened in this window.';
  const title = `Shift report · ${report.prs.length} PR${report.prs.length === 1 ? '' : 's'} · $${report.spendUsd.toFixed(2)}`;
  const body = [
    `Last ${report.windowHours} hours.`,
    '',
    '## Finished with PRs',
    prLines,
    '',
    '## Waiting on you',
    `${report.waiting} open Needs you item${report.waiting === 1 ? '' : 's'}.`,
    '',
    '## Spend',
    `$${report.spendUsd.toFixed(2)} across live runs.`,
    '',
    '## Deaths',
    `${report.restartDeaths} orphaned by server restart, ${report.failedRuns} failed/aborted/timed out.`,
  ].join('\n');
  return { title, body };
}

export function publishShiftReport(now = new Date()): ShiftReport | null {
  // 09:00–09:19 local. Dedupe key is the calendar day, so a late tick is fine.
  if (now.getHours() !== 9 || now.getMinutes() >= 20) {
    return null;
  }
  const report = collectShiftReport();
  const { title, body } = formatShiftReport(report);
  const dayKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  interruptsService.create({
    kind: 'shift_report',
    severity: 'info',
    title,
    body,
    actions: [{ id: 'dismiss', label: 'Got it', style: 'primary' }],
    priority: 40,
    dedupeKey: `shift_report:${dayKey}`,
    meta: report as unknown as Record<string, unknown>,
  });
  return report;
}
