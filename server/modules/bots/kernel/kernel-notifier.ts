/**
 * Where the kernel sends an episode's `notify` request. The channels wave replaces the default
 * (an in-app system notification) with `setKernelNotifier`.
 */

import { systemNotificationsDb } from '@/modules/database/index.js';
import { broadcastSystemEvent } from '@/modules/websocket/index.js';

export interface KernelNotification {
  botId: string;
  episodeId: string;
  title: string;
  body: string;
  /** 0 (low) to 1 (urgent). */
  urgency: number;
}

export type KernelNotifier = (notification: KernelNotification) => void | Promise<void>;

const defaultNotifier: KernelNotifier = (notification) => {
  systemNotificationsDb.create({
    kind: 'bot_notice',
    severity: notification.urgency >= 0.8 ? 'warning' : 'info',
    title: notification.title,
    body: notification.body,
    source: 'bot',
    href: `/bots/b/${encodeURIComponent(notification.botId)}/overview`,
    meta: { botId: notification.botId, episodeId: notification.episodeId, urgency: notification.urgency },
    dedupeKey: `bot-notice-${notification.episodeId}`,
  });
  broadcastSystemEvent({ kind: 'notification_created' });
};

let notifier: KernelNotifier = defaultNotifier;

/** Replace the notifier; pass null to restore the in-app default. */
export function setKernelNotifier(fn: KernelNotifier | null): void {
  notifier = fn ?? defaultNotifier;
}

export async function dispatchKernelNotification(notification: KernelNotification): Promise<void> {
  await notifier(notification);
}
