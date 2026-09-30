/** One conversation thread per bot, mirrored across channels. */

import { missionControlDb } from '@/modules/mission-control/index.js';
import { broadcastSystemEvent } from '@/modules/websocket/index.js';
import { AppError } from '@/shared/utils.js';
import type { BotThreadMessage, BotThreadRole } from '@/modules/bots/bots.types.js';
import { botThreadDb } from '@/modules/bots/channels/bot-thread.repository.js';
import { botSignals } from '@/modules/bots/signals/signals.service.js';

export const MAX_THREAD_MESSAGE_CHARS = 4_000;

export interface ThreadPostInput {
  role: BotThreadRole;
  body: string;
  channel?: string;
  meta?: Record<string, unknown>;
}

function cleanBody(body: unknown): string {
  const text = typeof body === 'string' ? body.trim() : '';
  if (!text) throw new AppError('body is required', { code: 'BOT_THREAD_INVALID', statusCode: 400 });
  return text.slice(0, MAX_THREAD_MESSAGE_CHARS);
}

export const thread = {
  /** Persist a message and tell connected clients. */
  post(botId: string, input: ThreadPostInput): BotThreadMessage {
    const message = botThreadDb.post(botId, {
      role: input.role,
      body: cleanBody(input.body),
      channel: input.channel ?? 'inapp',
      meta: input.meta,
    });
    broadcastSystemEvent({ kind: 'bot_thread_message', bot_id: botId, message });
    return message;
  },

  /**
   * The operator speaks: store the message, then ingest an `operator_message` event (trust
   * `operator`) so the kernel wakes through the normal notify path.
   */
  postOperatorMessage(botId: string, body: unknown, channel = 'inapp', meta: Record<string, unknown> = {}): BotThreadMessage {
    if (!missionControlDb.getSection(botId)) {
      throw new AppError(`Bot not found: ${botId}`, { code: 'BOT_NOT_FOUND', statusCode: 404 });
    }
    const message = thread.post(botId, { role: 'operator', body: cleanBody(body), channel, meta });
    botSignals.ingest({
      botId,
      source: `thread:${channel}`,
      kind: 'operator_message',
      dedupeKey: `thread:${message.message_id}`,
      trust: 'operator',
      payload: { text: message.body, channel, message_id: message.message_id },
    });
    return message;
  },

  list: (botId: string, options: { limit?: number; before?: string } = {}): BotThreadMessage[] => botThreadDb.list(botId, options),
};
