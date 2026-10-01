/**
 * Telegram: sendMessage with an inline keyboard. Telegram rejects the whole message when a URL
 * button points at localhost ("Bad Request: inline keyboard button URL ... localhost"), so the
 * buttons depend on what can actually work:
 *  - inbound polling is on, or the action base URL is not public https: `callback_data` buttons
 *    (`a:<shortid>`), answered by the poller in telegram-inbound.ts;
 *  - a public https base URL and no polling: URL buttons (the signed links);
 *  - otherwise the message goes out WITHOUT buttons plus a line "Open CloudCLI to approve".
 * A failed send with buttons is retried once without them, so a message is never dropped.
 */

import { interruptsService } from '@/modules/interrupt-queue/index.js';
import { createCallbackData, DEFAULT_CALLBACK_TTL_MS } from '@/modules/bots/channels/callback-ids.js';
import {
  checkBaseUrl,
  checkKeys,
  checkSecretRef,
  isPublicHttpsUrl,
  OPEN_CLOUDCLI_LINE,
  truncate,
  type AdapterContext,
  type ChannelAdapter,
  type OutboundMessage,
  type SendResult,
} from '@/modules/bots/channels/adapters/types.js';

export const TELEGRAM_CONFIG_KEYS = ['token_ref', 'chat_id', 'inbound', 'poll_timeout_s', 'inbound_offset', 'action_base_url'] as const;

export type TelegramButtonMode = 'callback' | 'url' | 'none';

/** Which kind of approval buttons this message can carry on this channel. */
export function telegramButtonMode(config: Record<string, unknown>, message: OutboundMessage): TelegramButtonMode {
  if (message.actions.length === 0) return 'none';
  if (config.inbound === true && message.interruptId) return 'callback';
  if (message.actions.every((action) => isPublicHttpsUrl(action.url))) return 'url';
  return 'none';
}

function callbackTtlMs(interruptId: string | undefined): number {
  try {
    const expires = interruptId ? interruptsService.get(interruptId)?.expires_at : null;
    const left = expires ? Date.parse(expires) - Date.now() : NaN;
    // Outlive the approval a little so a late tap still gets an answer ("expired") rather than silence.
    if (Number.isFinite(left) && left > 0) return left + 5 * 60_000;
  } catch {
    // Fall through to the default.
  }
  return DEFAULT_CALLBACK_TTL_MS;
}

export function buildTelegramPayload(
  chatId: string | number,
  message: OutboundMessage,
  mode: TelegramButtonMode = message.actions.every((action) => isPublicHttpsUrl(action.url)) ? 'url' : 'none',
): Record<string, unknown> {
  const buttonless = message.actions.length > 0 && mode === 'none';
  const text = `${message.title}\n${message.botTitle}\n\n${truncate(message.body, 3500)}${buttonless ? `\n\n${OPEN_CLOUDCLI_LINE}` : ''}`;
  const payload: Record<string, unknown> = { chat_id: chatId, text, disable_web_page_preview: true };
  if (mode === 'url') {
    payload.reply_markup = { inline_keyboard: message.actions.slice(0, 6).map((action) => [{ text: truncate(action.label, 60), url: action.url }]) };
  } else if (mode === 'callback' && message.interruptId) {
    const interruptId = message.interruptId;
    const ttlMs = callbackTtlMs(interruptId);
    payload.reply_markup = {
      inline_keyboard: message.actions.slice(0, 6).map((action) => [
        { text: truncate(action.label, 60), callback_data: createCallbackData(interruptId, action.key, { ttlMs }) },
      ]),
    };
  }
  return payload;
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
  const tokenRef = String(config.token_ref);
  const chatId = config.chat_id as string | number;
  const mode = telegramButtonMode(config, message);
  const attempt = async (buttons: TelegramButtonMode): Promise<{ ok: boolean; detail?: string }> => {
    try {
      const result = await telegramCall(ctx, tokenRef, 'sendMessage', buildTelegramPayload(chatId, message, buttons));
      return result.ok ? { ok: true } : { ok: false, detail: `telegram error: ${result.description ?? `http ${result.status}`}` };
    } catch (error) {
      return { ok: false, detail: `telegram error: ${error instanceof Error ? error.message : String(error)}` };
    }
  };
  const first = await attempt(mode);
  if (first.ok || mode === 'none') return first;
  // Any failure with buttons: say the same thing once more without them, never drop the message.
  const retry = await attempt('none');
  return retry.ok ? { ok: true, detail: `sent without buttons after: ${first.detail}` } : { ok: false, detail: `${first.detail}; retry without buttons: ${retry.detail}` };
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
