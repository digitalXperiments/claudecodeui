import type { ChannelAdapter } from '@/modules/bots/channels/adapters/types.js';
import { emailAdapter } from '@/modules/bots/channels/adapters/email.js';
import { inappAdapter } from '@/modules/bots/channels/adapters/inapp.js';
import { slackAdapter } from '@/modules/bots/channels/adapters/slack.js';
import { telegramAdapter } from '@/modules/bots/channels/adapters/telegram.js';
import { webpushAdapter } from '@/modules/bots/channels/adapters/webpush.js';

export const CHANNEL_KINDS = ['inapp', 'webpush', 'slack', 'telegram', 'email'] as const;
export type ChannelKind = (typeof CHANNEL_KINDS)[number];

const adapters: Record<ChannelKind, ChannelAdapter> = {
  inapp: inappAdapter,
  webpush: webpushAdapter,
  slack: slackAdapter,
  telegram: telegramAdapter,
  email: emailAdapter,
};

export const getChannelAdapter = (kind: string): ChannelAdapter | null =>
  (adapters as Record<string, ChannelAdapter | undefined>)[kind] ?? null;

export { recordInAppNotification } from '@/modules/bots/channels/adapters/inapp.js';
export { setWebPushSender } from '@/modules/bots/channels/adapters/webpush.js';
export { buildSlackPayload } from '@/modules/bots/channels/adapters/slack.js';
export { buildTelegramPayload } from '@/modules/bots/channels/adapters/telegram.js';
export type { AdapterContext, ChannelAdapter, FetchLike, OutboundAction, OutboundMessage } from '@/modules/bots/channels/adapters/types.js';
