/** Web push via the existing notification orchestrator and the push_subscriptions table. */

import { pushSubscriptionsDb, userDb } from '@/modules/database/index.js';
import { notifyDigest } from '@/modules/notifications/index.js';
import { checkKeys, truncate, type ChannelAdapter } from '@/modules/bots/channels/adapters/types.js';

export type WebPushSender = (input: { userId: number; title: string; body: string; data: Record<string, unknown> }) => void;

const defaultSender: WebPushSender = ({ userId, title, body, data }) => {
  notifyDigest({ userId, title, body, channels: ['webPush'], data });
};

let sender: WebPushSender = defaultSender;

/** Tests inject a fake sender; null restores the orchestrator. */
export function setWebPushSender(fn: WebPushSender | null): void {
  sender = fn ?? defaultSender;
}

export const webpushAdapter: ChannelAdapter = {
  kind: 'webpush',
  validateConfig: (config) => checkKeys(config, []),
  async send(_channel, message) {
    const user = userDb.getFirstUser();
    if (!user) return { ok: false, detail: 'no_user' };
    if (pushSubscriptionsDb.getPushSubscriptions(user.id).length === 0) return { ok: false, detail: 'no_subscriptions' };
    sender({
      userId: user.id,
      title: truncate(message.title, 120),
      body: truncate(message.body, 300),
      data: { tag: `bot:${message.botId ?? 'brief'}`, botId: message.botId, url: message.href ?? '/bots' },
    });
    return { ok: true };
  },
};
