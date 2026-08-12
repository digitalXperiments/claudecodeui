/**
 * Run spine maintenance (PRD §6.5 / §6.8):
 *  - stuck detector: running with no recent events → run_stuck interrupt
 *  - retention: purge old events and terminal runs
 */

import { Cron } from 'croner';

import { getConnection } from '@/modules/database/index.js';
import { interruptsService } from '@/modules/interrupt-queue/index.js';
import { scheduleHistoricalTokenBackfill } from '@/modules/runs/runs-token-backfill.js';
import { TERMINAL_RUN_STATUSES } from '@/shared/run-events.js';

/** Minutes without a durable event while status is in-flight before flagging stuck. */
const STUCK_MINUTES = Number(process.env.CLOUDCLI_RUN_STUCK_MINUTES || 15);
/** Keep full events this many days (PRD default 14). */
const EVENT_RETENTION_DAYS = Number(process.env.CLOUDCLI_RUN_EVENT_RETENTION_DAYS || 14);
/** Keep run rows this many days (PRD default 90). */
const RUN_RETENTION_DAYS = Number(process.env.CLOUDCLI_RUN_RETENTION_DAYS || 90);

let stuckJob: Cron | null = null;
let retentionJob: Cron | null = null;

function minutesAgoIso(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

/**
 * Find in-flight runs whose last event (or started_at) is older than the stuck
 * threshold and open a deduped `run_stuck` interrupt.
 */
export function detectStuckRuns(): number {
  const db = getConnection();
  const cutoff = minutesAgoIso(STUCK_MINUTES);
  const rows = db
    .prepare(
      `SELECT r.run_id, r.project_id, r.title, r.status, r.app_session_id, r.source,
              COALESCE(
                (SELECT MAX(e.ts) FROM agent_run_events e WHERE e.run_id = r.run_id),
                r.started_at,
                r.created_at
              ) AS last_activity
       FROM agent_runs r
       WHERE r.status IN ('queued', 'starting', 'running', 'waiting_permission', 'waiting_approval')
         AND COALESCE(
               (SELECT MAX(e.ts) FROM agent_run_events e WHERE e.run_id = r.run_id),
               r.started_at,
               r.created_at
             ) < ?`,
    )
    .all(cutoff) as Array<{
    run_id: string;
    project_id: string | null;
    title: string | null;
    status: string;
    app_session_id: string | null;
    source: string;
    last_activity: string;
  }>;

  let flagged = 0;
  for (const row of rows) {
    try {
      interruptsService.create({
        projectId: row.project_id,
        kind: 'run_stuck',
        severity: 'warning',
        title: `Run stuck: ${row.title || row.run_id}`,
        body: `No activity since ${row.last_activity} (status: ${row.status}).`,
        runId: row.run_id,
        href: row.app_session_id
          ? `/chat?sessionId=${encodeURIComponent(row.app_session_id)}`
          : null,
        actions: [
          { id: 'abort_run', label: 'Abort', style: 'destructive' },
          { id: 'dismiss', label: 'Dismiss', style: 'secondary' },
        ],
        meta: { source: row.source, lastActivity: row.last_activity },
        dedupeKey: `run_stuck:${row.run_id}`,
      });
      flagged += 1;
    } catch {
      // best-effort
    }
  }
  return flagged;
}

/**
 * Compact retention: drop old events first, then terminal runs past the
 * retention window (events cascade via FK).
 */
export function applyRunRetention(): { eventsDeleted: number; runsDeleted: number } {
  const db = getConnection();
  const eventCutoff = daysAgoIso(EVENT_RETENTION_DAYS);
  const runCutoff = daysAgoIso(RUN_RETENTION_DAYS);

  const events = db
    .prepare(`DELETE FROM agent_run_events WHERE ts < ?`)
    .run(eventCutoff);

  const terminal = [...TERMINAL_RUN_STATUSES];
  const placeholders = terminal.map(() => '?').join(', ');
  const runs = db
    .prepare(
      `DELETE FROM agent_runs
       WHERE status IN (${placeholders})
         -- Historical token-backfill rows (source = 'history', see
         -- runs-token-backfill.ts) are stamped with the *session's* original
         -- created_at/finished_at, which is routinely older than the
         -- retention window by design (that's the whole point of "historical").
         -- Retention would delete them here, then the very next backfill pass
         -- would recreate them (the session still lacks a token-covered run)
         -- — a nightly delete/recreate loop with real WS broadcast noise.
         -- These rows carry no operational data to retire, so exclude them.
         AND source != 'history'
         AND COALESCE(finished_at, updated_at, created_at) < ?`,
    )
    .run(...terminal, runCutoff);

  // Soft-clean resolved interrupts older than run retention.
  db.prepare(
    `DELETE FROM interrupts
     WHERE status IN ('resolved', 'dismissed')
       AND COALESCE(resolved_at, updated_at, created_at) < ?`,
  ).run(runCutoff);

  return {
    eventsDeleted: Number(events.changes ?? 0),
    runsDeleted: Number(runs.changes ?? 0),
  };
}

export function startRunMaintenance(): () => void {
  stopRunMaintenance();
  // Every 5 minutes for stuck; nightly retention.
  stuckJob = new Cron('*/5 * * * *', { timezone: 'UTC' }, () => {
    try {
      const n = detectStuckRuns();
      if (n > 0) {
        console.log(`[Runs] flagged ${n} stuck run(s)`);
      }
    } catch (error) {
      console.error('[Runs] stuck detector failed', error);
    }
  });
  retentionJob = new Cron('17 3 * * *', { timezone: 'UTC' }, () => {
    try {
      const result = applyRunRetention();
      console.log('[Runs] retention cleanup', result);
    } catch (error) {
      console.error('[Runs] retention failed', error);
    }
    // Sessions discovered after boot (provider sync) may still lack token_*;
    // re-run the idempotent backfill alongside nightly retention. Safe to run
    // right after retention now that retention excludes source='history' rows.
    void scheduleHistoricalTokenBackfill();
  });

  // One-shot (coalesced) durable fill of agent_runs.token_* from provider disk
  // for sessions that predate live token_budget persistence. Fire-and-forget so
  // boot is not blocked on filesystem scans.
  void scheduleHistoricalTokenBackfill();

  return stopRunMaintenance;
}

export function stopRunMaintenance(): void {
  stuckJob?.stop();
  retentionJob?.stop();
  stuckJob = null;
  retentionJob = null;
}
