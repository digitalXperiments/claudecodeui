/**
 * In-app system notification inbox (sidebar Notifications bar).
 */

import { randomUUID } from 'node:crypto';

import { getConnection } from '@/modules/database/connection.js';

export type SystemNotificationKind =
  | 'permission_pending'
  | 'run_failed'
  | 'action_required'
  | 'info'
  | 'run_stuck';

export type SystemNotificationSeverity = 'info' | 'warning' | 'error';

export type SystemNotificationRow = {
  notification_id: string;
  kind: string;
  severity: string;
  title: string;
  body: string;
  source: string;
  href: string | null;
  meta_json: string;
  read_at: string | null;
  dismissed_at: string | null;
  created_at: string;
};

export type SystemNotification = Omit<SystemNotificationRow, 'meta_json'> & {
  meta: Record<string, unknown>;
};

export type CreateSystemNotificationInput = {
  kind: SystemNotificationKind | string;
  severity?: SystemNotificationSeverity | string;
  title: string;
  body?: string;
  source?: string;
  href?: string | null;
  meta?: Record<string, unknown>;
  /** When set, replaces an existing undismissed notification with the same dedupe key in meta. */
  dedupeKey?: string;
};

function parseMeta(metaJson: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(metaJson);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function mapRow(row: SystemNotificationRow): SystemNotification {
  const { meta_json, ...rest } = row;
  return { ...rest, meta: parseMeta(meta_json) };
}

export const systemNotificationsDb = {
  list(options?: { includeDismissed?: boolean; limit?: number }): SystemNotification[] {
    const db = getConnection();
    const limit = Math.min(Math.max(options?.limit ?? 50, 1), 200);
    const includeDismissed = options?.includeDismissed === true;
    const rows = includeDismissed
      ? (db
          .prepare(
            `SELECT * FROM system_notifications ORDER BY created_at DESC LIMIT ?`,
          )
          .all(limit) as SystemNotificationRow[])
      : (db
          .prepare(
            `SELECT * FROM system_notifications
             WHERE dismissed_at IS NULL
             ORDER BY created_at DESC LIMIT ?`,
          )
          .all(limit) as SystemNotificationRow[]);
    return rows.map(mapRow);
  },

  unreadCount(): number {
    const db = getConnection();
    const row = db
      .prepare(
        `SELECT COUNT(*) AS count FROM system_notifications
         WHERE dismissed_at IS NULL AND read_at IS NULL`,
      )
      .get() as { count: number };
    return row?.count ?? 0;
  },

  get(notificationId: string): SystemNotification | null {
    const db = getConnection();
    const row = db
      .prepare(`SELECT * FROM system_notifications WHERE notification_id = ?`)
      .get(notificationId) as SystemNotificationRow | undefined;
    return row ? mapRow(row) : null;
  },

  create(input: CreateSystemNotificationInput): SystemNotification {
    const db = getConnection();
    const meta = { ...(input.meta ?? {}) };
    if (input.dedupeKey) {
      meta.dedupeKey = input.dedupeKey;
      // Upsert-by-dedupe: dismiss older matching open items and insert fresh.
      const existing = db
        .prepare(
          `SELECT notification_id, meta_json FROM system_notifications
           WHERE dismissed_at IS NULL`,
        )
        .all() as { notification_id: string; meta_json: string }[];
      for (const row of existing) {
        const rowMeta = parseMeta(row.meta_json);
        if (rowMeta.dedupeKey === input.dedupeKey) {
          db.prepare(
            `UPDATE system_notifications SET dismissed_at = CURRENT_TIMESTAMP WHERE notification_id = ?`,
          ).run(row.notification_id);
        }
      }
    }

    const id = randomUUID();
    db.prepare(
      `INSERT INTO system_notifications (
         notification_id, kind, severity, title, body, source, href, meta_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.kind,
      input.severity ?? 'info',
      input.title.trim(),
      input.body ?? '',
      input.source ?? 'system',
      input.href ?? null,
      JSON.stringify(meta),
    );
    return systemNotificationsDb.get(id)!;
  },

  markRead(notificationId: string): SystemNotification | null {
    const db = getConnection();
    db.prepare(
      `UPDATE system_notifications SET read_at = COALESCE(read_at, CURRENT_TIMESTAMP)
       WHERE notification_id = ?`,
    ).run(notificationId);
    return systemNotificationsDb.get(notificationId);
  },

  markAllRead(): number {
    const db = getConnection();
    const result = db
      .prepare(
        `UPDATE system_notifications SET read_at = CURRENT_TIMESTAMP
         WHERE dismissed_at IS NULL AND read_at IS NULL`,
      )
      .run();
    return result.changes;
  },

  dismiss(notificationId: string): boolean {
    const db = getConnection();
    const result = db
      .prepare(
        `UPDATE system_notifications SET dismissed_at = CURRENT_TIMESTAMP,
           read_at = COALESCE(read_at, CURRENT_TIMESTAMP)
         WHERE notification_id = ?`,
      )
      .run(notificationId);
    return result.changes > 0;
  },

  dismissAll(): number {
    const db = getConnection();
    const result = db
      .prepare(
        `UPDATE system_notifications SET dismissed_at = CURRENT_TIMESTAMP,
           read_at = COALESCE(read_at, CURRENT_TIMESTAMP)
         WHERE dismissed_at IS NULL`,
      )
      .run();
    return result.changes;
  },
};
