/** In-app: the system notifications inbox plus a WebSocket nudge. Always available. */

import { systemNotificationsDb } from '@/modules/database/index.js';
import { broadcastSystemEvent } from '@/modules/websocket/index.js';
import { checkKeys, type ChannelAdapter, type OutboundMessage } from '@/modules/bots/channels/adapters/types.js';

export function recordInAppNotification(message: OutboundMessage): void {
  systemNotificationsDb.create({
    kind: message.interruptId ? 'action_required' : 'bot_notice',
    severity: message.urgency >= 0.8 ? 'warning' : 'info',
    title: message.title,
    body: message.body,
    source: 'bot',
    href: message.href ?? (message.botId ? `/bots/b/${encodeURIComponent(message.botId)}/overview` : '/bots'),
    meta: { botId: message.botId, urgency: message.urgency, interruptId: message.interruptId ?? null },
    dedupeKey: message.interruptId ? `bot-interrupt-${message.interruptId}` : undefined,
  });
  broadcastSystemEvent({ kind: 'notification_created' });
}

export const inappAdapter: ChannelAdapter = {
  kind: 'inapp',
  validateConfig: (config) => checkKeys(config, []),
  async send(_channel, message) {
    recordInAppNotification(message);
    return { ok: true };
  },
};
