/** Telegram: sendMessage with inline keyboard URL buttons (signed links). Inbound lives in telegram-inbound.ts. */

import {
  checkBaseUrl,
  checkKeys,
  checkSecretRef,
  truncate,
  type AdapterContext,
  type ChannelAdapter,
  type OutboundMessage,
  type SendResult,
} from '@/modules/bots/channels/adapters/types.js';

export const TELEGRAM_CONFIG_KEYS = ['token_ref', 'chat_id', 'inbound', 'poll_timeout_s', 'inbound_offset', 'action_base_url'] as const;

export function buildTelegramPayload(chatId: string | number, message: OutboundMessage): Record<string, unknown> {
  const text = `${message.title}\n${message.botTitle}\n\n${truncate(message.body, 3500)}`;
  return {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
    ...(message.actions.length > 0
      ? { reply_markup: { inline_keyboard: message.actions.slice(0, 6).map((action) => [{ text: truncate(action.label, 60), url: action.url }]) } }
      : {}),
  };
}

export async function telegramCall(
  ctx: AdapterContext,
  tokenRef: string,
  method: string,
  payload: unknown,
  signal?: AbortSignal,
): Promise<{ ok: boolean; result?: unknown; description?: string; status: number }> {
  const token = ctx.resolveSecret(tokenRef);
  const response = await ctx.fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal,
  });
  const body = (await response.json().catch(() => ({}))) as { ok?: boolean; result?: unknown; description?: string };
  return { ok: response.ok && body.ok === true, result: body.result, description: body.description, status: response.status };
}

export async function sendTelegramText(
  config: Record<string, unknown>,
  message: OutboundMessage,
  ctx: AdapterContext,
): Promise<SendResult> {
  const result = await telegramCall(ctx, String(config.token_ref), 'sendMessage', buildTelegramPayload(config.chat_id as string | number, message));
  return result.ok ? { ok: true } : { ok: false, detail: `telegram error: ${result.description ?? `http ${result.status}`}` };
}

export const telegramAdapter: ChannelAdapter = {
  kind: 'telegram',
  validateConfig(config) {
    const error =
      checkKeys(config, TELEGRAM_CONFIG_KEYS)
      ?? checkSecretRef(config, 'token_ref', true)
      ?? checkBaseUrl(config);
    if (error) return error;
    const chat = config.chat_id;
    if (!(typeof chat === 'number' || (typeof chat === 'string' && /^-?\d+$|^@\w+$/.test(chat.trim())))) {
      return 'chat_id must be a numeric Telegram chat id';
    }
    if (config.inbound !== undefined && typeof config.inbound !== 'boolean') return 'inbound must be a boolean';
    if (config.inbound === true && typeof chat === 'string' && chat.startsWith('@')) return 'inbound requires a numeric chat_id';
    if (config.poll_timeout_s !== undefined) {
      const seconds = Number(config.poll_timeout_s);
      if (!Number.isFinite(seconds) || seconds < 0 || seconds > 50) return 'poll_timeout_s must be between 0 and 50';
    }
    return null;
  },
  send: (channel, message, ctx) => sendTelegramText(channel.config, message, ctx),
};
