import { getConnection } from '@/modules/database/index.js';
import { newInterruptId } from '@/shared/ids.js';
import type {
  CreateInterruptInput,
  Interrupt,
  InterruptAction,
  InterruptListFilter,
  InterruptStatus,
} from '@/modules/interrupt-queue/interrupts.types.js';

type InterruptRow = Omit<Interrupt, 'actions' | 'meta'> & {
  actions_json: string;
  meta_json: string;
  dedupe_key: string | null;
};

const PRIORITIES: Record<string, number> = {
  permission_pending: 10,
  approval_pending: 15,
  auth_unhealthy: 20,
  secret_missing: 20,
  run_stuck: 25,
  run_failed: 30,
  ci_failed: 35,
  mcp_unhealthy: 40,
  workspace_conflict: 45,
  task_overdue: 50,
  task_blocked: 55,
};

function parseObject(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function parseActions(raw: string | null | undefined): InterruptAction[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((item) => item && typeof item.id === 'string') : [];
  } catch {
    return [];
  }
}

function mapRow(row: InterruptRow): Interrupt {
  const { actions_json, meta_json, dedupe_key: _dedupeKey, ...rest } = row;
  return { ...rest, actions: parseActions(actions_json), meta: parseObject(meta_json) };
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * SQL predicate excluding open/snoozed rows whose approval window elapsed.
 * `datetime()` normalizes both ISO-8601 strings (what the service writes) and
 * SQLite CURRENT_TIMESTAMP values so mixed formats compare correctly.
 */
const NOT_EXPIRED_SQL = `(expires_at IS NULL OR datetime(expires_at) > datetime('now'))`;

function linkedMissionControlItemId(row: InterruptRow): string | null {
  if (row.kind !== 'approval_pending') {
    return null;
  }

  const meta = parseObject(row.meta_json);
  const itemId = meta.itemId ?? meta.item_id;
  return typeof itemId === 'string' && itemId.trim() ? itemId.trim() : null;
}

function isActionableMissionControlApproval(row: InterruptRow, db: ReturnType<typeof getConnection>): boolean {
  const itemId = linkedMissionControlItemId(row);
  if (!itemId) {
    // Keep legacy/manual approval interrupts visible when they do not carry a
    // Mission Control item reference that can be checked.
    return true;
  }

  const item = db
    .prepare(`SELECT status FROM mc_items WHERE item_id = ?`)
    .get(itemId) as { status?: string } | undefined;
  return item?.status === 'pending' || item?.status === 'failed';
}

function filterStaleMissionControlApprovals(
  rows: InterruptRow[],
  db: ReturnType<typeof getConnection>,
): InterruptRow[] {
  return rows.filter((row) => (
    !['open', 'snoozed'].includes(row.status)
    || isActionableMissionControlApproval(row, db)
  ));
}

function findDedupeKey(
  db: ReturnType<typeof getConnection>,
  dedupeKey: string,
): string | null {
  const row = db
    .prepare(
      `SELECT interrupt_id FROM interrupts
       WHERE dedupe_key = ? AND status IN ('open', 'snoozed')
       LIMIT 1`,
    )
    .get(dedupeKey) as { interrupt_id: string } | undefined;
  return row?.interrupt_id ?? null;
}

export const interruptsDb = {
  list(filter: InterruptListFilter = {}): Interrupt[] {
    const db = getConnection();
    const where: string[] = [];
    const params: unknown[] = [];
    const statuses = filter.status
      ? Array.isArray(filter.status)
        ? filter.status
        : [filter.status]
      : ['open', 'snoozed'];

    if (statuses.length) {
      where.push(`status IN (${statuses.map(() => '?').join(', ')})`);
      params.push(...statuses);
    }
    if (filter.projectId) {
      where.push('project_id = ?');
      params.push(filter.projectId);
    }
    // Snoozed items re-enter the queue automatically once their UTC deadline passes.
    if (!filter.status || statuses.includes('open')) {
      where.push(`(snooze_until IS NULL OR snooze_until <= CURRENT_TIMESTAMP)`);
    }
    // Rows past their approval window leave "Needs you" immediately, even
    // before the periodic sweep flips their status to 'expired'. Only active
    // rows are constrained so a mixed filter can still return 'expired' rows.
    if (statuses.includes('open') || statuses.includes('snoozed')) {
      where.push(`(status NOT IN ('open', 'snoozed') OR ${NOT_EXPIRED_SQL})`);
    }

    const limit = Math.min(Math.max(Math.trunc(filter.limit ?? 50), 1), 200);
    const rows = db
      .prepare(
        `SELECT * FROM interrupts${where.length ? ` WHERE ${where.join(' AND ')}` : ''}
         ORDER BY priority ASC, created_at DESC`,
      )
      .all(...params) as InterruptRow[];
    return filterStaleMissionControlApprovals(rows, db).slice(0, limit).map(mapRow);
  },

  countOpen(projectId?: string): number {
    const db = getConnection();
    const activeSql = `status IN ('open', 'snoozed') AND (snooze_until IS NULL OR snooze_until <= CURRENT_TIMESTAMP) AND ${NOT_EXPIRED_SQL}`;
    const rows = projectId
      ? db
          .prepare(`SELECT * FROM interrupts WHERE project_id = ? AND ${activeSql}`)
          .all(projectId)
      : db
          .prepare(`SELECT * FROM interrupts WHERE ${activeSql}`)
          .all();
    return filterStaleMissionControlApprovals(rows as InterruptRow[], db).length;
  },

  /**
   * Unread items among the active "Needs you" queue. Read state only affects
   * the badge — items stay actionable until resolved/expired.
   */
  countUnread(projectId?: string): number {
    const db = getConnection();
    const activeSql = `status IN ('open', 'snoozed') AND (snooze_until IS NULL OR snooze_until <= CURRENT_TIMESTAMP) AND ${NOT_EXPIRED_SQL} AND read_at IS NULL`;
    const rows = projectId
      ? db
          .prepare(`SELECT * FROM interrupts WHERE project_id = ? AND ${activeSql}`)
          .all(projectId)
      : db
          .prepare(`SELECT * FROM interrupts WHERE ${activeSql}`)
          .all();
    return filterStaleMissionControlApprovals(rows as InterruptRow[], db).length;
  },

  get(interruptId: string): Interrupt | null {
    const row = getConnection().prepare(`SELECT * FROM interrupts WHERE interrupt_id = ?`).get(interruptId) as InterruptRow | undefined;
    return row ? mapRow(row) : null;
  },

  listByMeta(
    key: string,
    value: string,
    statuses: InterruptStatus[] = ['open', 'snoozed'],
  ): Interrupt[] {
    if (!key.trim() || !value.trim() || statuses.length === 0) {
      return [];
    }

    const db = getConnection();
    const placeholders = statuses.map(() => '?').join(', ');
    const rows = db
      .prepare(`SELECT * FROM interrupts WHERE status IN (${placeholders})`)
      .all(...statuses) as InterruptRow[];

    return rows
      .filter((row) => parseObject(row.meta_json)[key] === value)
      .map(mapRow);
  },

  create(input: CreateInterruptInput): Interrupt {
    const db = getConnection();
    const dedupeKey = input.dedupeKey?.trim() || null;
    const write = db.transaction((): string => {
      const existingId = dedupeKey ? findDedupeKey(db, dedupeKey) : null;
      const id = existingId ?? newInterruptId();
      const meta = { ...(input.meta ?? {}), ...(dedupeKey ? { dedupeKey } : {}) };
      const now = nowIso();
      const actions = input.actions ?? [];
      if (existingId) {
        // Dedupe refresh is new information: reset the read marker and extend
        // the approval window alongside the rest of the payload.
        db.prepare(
          `UPDATE interrupts SET project_id = ?, kind = ?, severity = ?, title = ?, body = ?, run_id = ?, task_id = ?, workspace_id = ?, href = ?, actions_json = ?, priority = ?, dedupe_key = ?, status = 'open', snooze_until = NULL, resolved_at = NULL, resolved_by = NULL, resolution = NULL, expires_at = ?, read_at = NULL, updated_at = ?, meta_json = ? WHERE interrupt_id = ? AND status IN ('open', 'snoozed')`,
        ).run(
          input.projectId ?? null,
          input.kind,
          input.severity ?? 'warning',
          input.title.trim(),
          input.body ?? '',
          input.runId ?? null,
          input.taskId ?? null,
          input.workspaceId ?? null,
          input.href ?? null,
          JSON.stringify(actions),
          input.priority ?? PRIORITIES[input.kind] ?? 50,
          dedupeKey,
          input.expiresAt ?? null,
          now,
          JSON.stringify(meta),
          id,
        );
      } else {
        db.prepare(
          `INSERT INTO interrupts (interrupt_id, project_id, kind, severity, title, body, run_id, task_id, workspace_id, href, actions_json, status, priority, dedupe_key, expires_at, created_at, updated_at, meta_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?)`,
        ).run(
          id,
          input.projectId ?? null,
          input.kind,
          input.severity ?? 'warning',
          input.title.trim(),
          input.body ?? '',
          input.runId ?? null,
          input.taskId ?? null,
          input.workspaceId ?? null,
          input.href ?? null,
          JSON.stringify(actions),
          input.priority ?? PRIORITIES[input.kind] ?? 50,
          dedupeKey,
          input.expiresAt ?? null,
          now,
          now,
          JSON.stringify(meta),
        );
      }
      return id;
    });
    const id = write.immediate();
    return this.get(id)!;
  },

  resolve(interruptId: string, status: Extract<InterruptStatus, 'resolved' | 'dismissed'>, actor: string | null, resolution: string): Interrupt | null {
    const db = getConnection();
    const now = nowIso();
    db.prepare(
      `UPDATE interrupts SET status = ?, resolved_at = ?, resolved_by = ?, resolution = ?, updated_at = ?
       WHERE interrupt_id = ? AND status IN ('open', 'snoozed')`,
    ).run(status, now, actor, resolution, now, interruptId);
    return this.get(interruptId);
  },

  snooze(interruptId: string, until: string, actor: string | null): Interrupt | null {
    const db = getConnection();
    db.prepare(`UPDATE interrupts SET status = 'snoozed', snooze_until = ?, resolved_by = ?, updated_at = ? WHERE interrupt_id = ?`).run(until, actor, nowIso(), interruptId);
    return this.get(interruptId);
  },

  /** Transition an active interrupt to 'expired' (approval window elapsed). */
  expire(interruptId: string, resolution = 'expired'): Interrupt | null {
    const db = getConnection();
    const now = nowIso();
    db.prepare(
      `UPDATE interrupts SET status = 'expired', resolved_at = ?, resolved_by = 'system', resolution = ?, updated_at = ?
       WHERE interrupt_id = ? AND status IN ('open', 'snoozed')`,
    ).run(now, resolution, now, interruptId);
    return this.get(interruptId);
  },

  /** Batch viewport mark-as-read. Only first reads are recorded. */
  markRead(interruptIds: string[]): number {
    const ids = interruptIds.filter((id) => typeof id === 'string' && id.trim());
    if (ids.length === 0) return 0;
    const db = getConnection();
    const placeholders = ids.map(() => '?').join(', ');
    const result = db
      .prepare(
        `UPDATE interrupts SET read_at = ?, updated_at = ?
         WHERE interrupt_id IN (${placeholders}) AND read_at IS NULL`,
      )
      .run(nowIso(), nowIso(), ...ids);
    return Number(result.changes ?? 0);
  },

  /** Active interrupts attached to a run, optionally narrowed by kind. */
  listActiveByRunId(runId: string, kinds?: string[]): Interrupt[] {
    if (!runId.trim()) return [];
    const db = getConnection();
    const params: unknown[] = [runId];
    let kindSql = '';
    if (kinds && kinds.length > 0) {
      kindSql = ` AND kind IN (${kinds.map(() => '?').join(', ')})`;
      params.push(...kinds);
    }
    const rows = db
      .prepare(`SELECT * FROM interrupts WHERE run_id = ? AND status IN ('open', 'snoozed')${kindSql}`)
      .all(...params) as InterruptRow[];
    return rows.map(mapRow);
  },

  /**
   * Every active interrupt joined with its run's current status so the sweep
   * can reconcile the queue against reality in a single query.
   */
  listActiveForSweep(): Array<{
    interrupt: Interrupt;
    runExists: boolean;
    runStatus: string | null;
    expired: boolean;
  }> {
    const db = getConnection();
    const rows = db
      .prepare(
        `SELECT i.*,
                r.run_id AS sweep_run_id,
                r.status AS sweep_run_status,
                (i.expires_at IS NOT NULL AND datetime(i.expires_at) <= datetime('now')) AS sweep_expired
         FROM interrupts i
         LEFT JOIN agent_runs r ON r.run_id = i.run_id
         WHERE i.status IN ('open', 'snoozed')`,
      )
      .all() as Array<InterruptRow & {
      sweep_run_id: string | null;
      sweep_run_status: string | null;
      sweep_expired: number;
    }>;
    return rows.map((row) => {
      const { sweep_run_id, sweep_run_status, sweep_expired, ...rest } = row;
      return {
        interrupt: mapRow(rest as InterruptRow),
        runExists: sweep_run_id != null,
        runStatus: sweep_run_status,
        expired: sweep_expired === 1,
      };
    });
  },

  /** Cross-module existence probe used by the ci_failed sweep rule. */
  swarmExists(swarmId: string): boolean {
    if (!swarmId.trim()) return false;
    const db = getConnection();
    try {
      const row = db.prepare(`SELECT 1 AS present FROM swarm_runs WHERE swarm_id = ?`).get(swarmId) as
        | { present: number }
        | undefined;
      return Boolean(row);
    } catch {
      // swarm tables are optional in some deployments; treat as still present
      // so informational pointers are never resolved on a transient error.
      return true;
    }
  },
};
