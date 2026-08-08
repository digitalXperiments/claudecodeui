import { getConnection } from '@/modules/database/index.js';
import { newInterruptId } from '@/shared/ids.js';
import type {
  CreateInterruptInput,
  Interrupt,
  InterruptAction,
  InterruptListFilter,
  InterruptStatus,
} from '@/modules/interrupt-queue/interrupts.types.js';

type InterruptRow = Omit<Interrupt, 'actions' | 'meta'> & { actions_json: string; meta_json: string };

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
  const { actions_json, meta_json, ...rest } = row;
  return { ...rest, actions: parseActions(actions_json), meta: parseObject(meta_json) };
}

function nowIso(): string {
  return new Date().toISOString();
}

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

function findDedupeKey(dedupeKey: string): string | null {
  const db = getConnection();
  const rows = db
    .prepare(`SELECT interrupt_id, meta_json FROM interrupts WHERE status IN ('open', 'snoozed')`)
    .all() as Array<{ interrupt_id: string; meta_json: string | null }>;
  for (const row of rows) {
    if (parseObject(row.meta_json).dedupeKey === dedupeKey) return row.interrupt_id;
  }
  return null;
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
    const rows = projectId
      ? db
          .prepare(`SELECT * FROM interrupts WHERE project_id = ? AND status IN ('open', 'snoozed') AND (snooze_until IS NULL OR snooze_until <= CURRENT_TIMESTAMP)`)
          .all(projectId)
      : db
          .prepare(`SELECT * FROM interrupts WHERE status IN ('open', 'snoozed') AND (snooze_until IS NULL OR snooze_until <= CURRENT_TIMESTAMP)`)
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
    const dedupeKey = input.dedupeKey;
    const existingId = dedupeKey ? findDedupeKey(dedupeKey) : null;
    const id = existingId ?? newInterruptId();
    const meta = { ...(input.meta ?? {}), ...(dedupeKey ? { dedupeKey } : {}) };
    const now = nowIso();
    const actions = input.actions ?? [];
    if (existingId) {
      db.prepare(
        `UPDATE interrupts SET project_id = ?, kind = ?, severity = ?, title = ?, body = ?, run_id = ?, task_id = ?, workspace_id = ?, href = ?, actions_json = ?, priority = ?, status = 'open', snooze_until = NULL, resolved_at = NULL, resolved_by = NULL, resolution = NULL, updated_at = ?, meta_json = ? WHERE interrupt_id = ?`,
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
        now,
        JSON.stringify(meta),
        id,
      );
    } else {
      db.prepare(
        `INSERT INTO interrupts (interrupt_id, project_id, kind, severity, title, body, run_id, task_id, workspace_id, href, actions_json, status, priority, created_at, updated_at, meta_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?)`,
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
        now,
        now,
        JSON.stringify(meta),
      );
    }
    return this.get(id)!;
  },

  resolve(interruptId: string, status: Extract<InterruptStatus, 'resolved' | 'dismissed'>, actor: string | null, resolution: string): Interrupt | null {
    const db = getConnection();
    db.prepare(`UPDATE interrupts SET status = ?, resolved_at = ?, resolved_by = ?, resolution = ?, updated_at = ? WHERE interrupt_id = ?`).run(status, nowIso(), actor, resolution, nowIso(), interruptId);
    return this.get(interruptId);
  },

  snooze(interruptId: string, until: string, actor: string | null): Interrupt | null {
    const db = getConnection();
    db.prepare(`UPDATE interrupts SET status = 'snoozed', snooze_until = ?, resolved_by = ?, updated_at = ? WHERE interrupt_id = ?`).run(until, actor, nowIso(), interruptId);
    return this.get(interruptId);
  },
};
