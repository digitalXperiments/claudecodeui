import { useCallback, useEffect, useState } from 'react';
import { Bell, CheckCheck, Loader2, X } from 'lucide-react';

import { Button } from '../../../../shared/view/ui';
import { cn } from '../../../../lib/utils';
import {
  inboxNotificationsApi,
  type InboxNotification,
} from '../../../settings/api/inboxNotificationsApi';

type NotificationsPanelProps = {
  open: boolean;
  onClose: () => void;
  onUnreadChange?: (count: number) => void;
};

function severityClass(severity: string): string {
  if (severity === 'error') return 'border-l-red-500';
  if (severity === 'warning') return 'border-l-amber-500';
  return 'border-l-blue-500';
}

function timeAgo(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const seconds = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

export default function NotificationsPanel({
  open,
  onClose,
  onUnreadChange,
}: NotificationsPanelProps) {
  const [items, setItems] = useState<InboxNotification[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { notifications, unreadCount } = await inboxNotificationsApi.list();
      setItems(notifications);
      onUnreadChange?.(unreadCount);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load notifications');
    } finally {
      setLoading(false);
    }
  }, [onUnreadChange]);

  useEffect(() => {
    if (open) {
      void refresh();
    }
  }, [open, refresh]);

  // Poll unread count lightly when closed so the badge stays fresh.
  useEffect(() => {
    if (open) return undefined;
    let cancelled = false;
    const tick = async () => {
      try {
        const { unreadCount } = await inboxNotificationsApi.list();
        if (!cancelled) onUnreadChange?.(unreadCount);
      } catch {
        // ignore background poll errors
      }
    };
    void tick();
    const id = window.setInterval(tick, 30000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [open, onUnreadChange]);

  if (!open) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-[10000] flex justify-end bg-background/40 backdrop-blur-[1px] md:bg-transparent md:backdrop-blur-none">
      <button
        type="button"
        className="absolute inset-0 cursor-default"
        aria-label="Close notifications"
        onClick={onClose}
      />
      <div className="relative z-10 flex h-full w-full max-w-md flex-col border-l border-border bg-background shadow-2xl">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div className="flex items-center gap-2">
            <Bell className="h-4 w-4 text-foreground" />
            <h2 className="text-sm font-semibold text-foreground">Notifications</h2>
          </div>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              className="h-8 px-2 text-xs"
              onClick={() => void inboxNotificationsApi.markAllRead().then(refresh)}
              title="Mark all read"
            >
              <CheckCheck className="h-3.5 w-3.5" />
            </Button>
            <Button variant="ghost" size="sm" className="h-8 w-8 p-0" onClick={onClose}>
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {loading && items.length === 0 ? (
            <div className="flex items-center justify-center gap-2 p-6 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading…
            </div>
          ) : error ? (
            <p className="p-4 text-sm text-destructive">{error}</p>
          ) : items.length === 0 ? (
            <p className="p-6 text-center text-sm text-muted-foreground">
              You’re all caught up. Failed runs and permission waits will show up here.
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {items.map((item) => {
                const unread = !item.read_at;
                return (
                  <li
                    key={item.notification_id}
                    className={cn(
                      'border-l-2 px-4 py-3',
                      severityClass(item.severity),
                      unread ? 'bg-accent/30' : 'bg-background',
                    )}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className={cn('text-sm', unread ? 'font-semibold' : 'font-medium')}>
                          {item.title}
                        </p>
                        {item.body ? (
                          <p className="mt-0.5 text-xs text-muted-foreground">{item.body}</p>
                        ) : null}
                        <p className="mt-1 text-[10px] uppercase tracking-wide text-muted-foreground/70">
                          {item.source} · {item.kind} · {timeAgo(item.created_at)}
                        </p>
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 shrink-0 px-2 text-xs"
                        onClick={() =>
                          void inboxNotificationsApi.dismiss(item.notification_id).then(refresh)
                        }
                      >
                        Dismiss
                      </Button>
                    </div>
                    {unread ? (
                      <button
                        type="button"
                        className="mt-1 text-[11px] text-primary hover:underline"
                        onClick={() =>
                          void inboxNotificationsApi.markRead(item.notification_id).then(refresh)
                        }
                      >
                        Mark read
                      </button>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {items.length > 0 ? (
          <div className="border-t border-border p-3">
            <Button
              variant="outline"
              size="sm"
              className="w-full"
              onClick={() => void inboxNotificationsApi.dismissAll().then(refresh)}
            >
              Dismiss all
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
