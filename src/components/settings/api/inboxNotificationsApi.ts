import { authenticatedFetch } from '../../../utils/api';

export type InboxNotification = {
  notification_id: string;
  kind: string;
  severity: string;
  title: string;
  body: string;
  source: string;
  href: string | null;
  meta: Record<string, unknown>;
  read_at: string | null;
  dismissed_at: string | null;
  created_at: string;
};

const BASE = '/api/notifications/inbox';

async function parse<T>(response: Response): Promise<T> {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(
      typeof (payload as { error?: string })?.error === 'string'
        ? (payload as { error: string }).error
        : `Request failed (${response.status})`,
    );
  }
  return payload as T;
}

export const inboxNotificationsApi = {
  async list(): Promise<{ notifications: InboxNotification[]; unreadCount: number }> {
    const res = await authenticatedFetch(BASE);
    const data = await parse<{ notifications?: InboxNotification[]; unreadCount?: number }>(res);
    return {
      notifications: Array.isArray(data.notifications) ? data.notifications : [],
      unreadCount: typeof data.unreadCount === 'number' ? data.unreadCount : 0,
    };
  },

  async create(input: {
    kind?: string;
    severity?: string;
    title: string;
    body?: string;
    source?: string;
    href?: string | null;
    meta?: Record<string, unknown>;
    dedupeKey?: string;
  }): Promise<InboxNotification> {
    const res = await authenticatedFetch(BASE, {
      method: 'POST',
      body: JSON.stringify(input),
    });
    const data = await parse<{ notification: InboxNotification }>(res);
    return data.notification;
  },

  async markRead(id: string): Promise<void> {
    const res = await authenticatedFetch(`${BASE}/${encodeURIComponent(id)}/read`, { method: 'POST' });
    await parse(res);
  },

  async dismiss(id: string): Promise<void> {
    const res = await authenticatedFetch(`${BASE}/${encodeURIComponent(id)}/dismiss`, {
      method: 'POST',
    });
    await parse(res);
  },

  async markAllRead(): Promise<void> {
    const res = await authenticatedFetch(`${BASE}/read-all`, { method: 'POST' });
    await parse(res);
  },

  async dismissAll(): Promise<void> {
    const res = await authenticatedFetch(`${BASE}/dismiss-all`, { method: 'POST' });
    await parse(res);
  },
};
