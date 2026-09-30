/**
 * Bot replies: when an episode was woken by an operator message, the answer goes to the bot thread
 * and back out on the channel the question came from. The kernel envelope's `reply` wins; without
 * one, the episode summary is the reply.
 */

import { onEpisodeFinished } from '@/modules/bots/kernel/kernel.service.js';
import type { BotEpisode } from '@/modules/bots/bots.types.js';
import { botEventsDb } from '@/modules/bots/signals/bot-events.repository.js';
import { botChannelsDb } from '@/modules/bots/channels/bot-channels.repository.js';
import { deliverOnChannel } from '@/modules/bots/channels/notify.service.js';
import { thread } from '@/modules/bots/channels/thread.service.js';

export const REPLY_URGENCY = 0.5;

/** The channel of the operator message that woke this episode, or null when none did. */
export function operatorChannelOf(episode: BotEpisode): string | null {
  for (const eventId of episode.event_ids) {
    const event = botEventsDb.get(eventId);
    if (event?.kind === 'operator_message') {
      return typeof event.payload.channel === 'string' && event.payload.channel ? event.payload.channel : 'inapp';
    }
  }
  return null;
}

export async function deliverEpisodeReply(episode: BotEpisode): Promise<boolean> {
  if (episode.status === 'interrupted') return false;
  const operatorChannel = operatorChannelOf(episode);
  const explicit = typeof episode.outcome.reply === 'string' ? episode.outcome.reply.trim() : '';
  const body = explicit || (operatorChannel ? episode.summary.trim() : '');
  if (!body) return false;

  const channel = operatorChannel ?? 'inapp';
  thread.post(episode.bot_id, { role: 'bot', body, channel, meta: { episode_id: episode.episode_id } });
  if (channel !== 'inapp') {
    const target = botChannelsDb.listEffective(episode.bot_id).find((row) => row.kind === channel && row.enabled);
    if (target) {
      await deliverOnChannel(target, { botId: episode.bot_id, title: 'Reply', body, urgency: REPLY_URGENCY }, 'reply');
    }
  }
  return true;
}

export function startEpisodeReplies(): () => void {
  return onEpisodeFinished((episode) => deliverEpisodeReply(episode).then(() => undefined));
}
