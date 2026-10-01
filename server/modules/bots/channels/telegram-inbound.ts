/**
 * Telegram inbound: an optional long-poll `getUpdates` loop per channel (config.inbound = true).
 * Text from the configured chat becomes an operator message in the bot's thread (and an
 * `operator_message` event); everything from any other chat is ignored. The update offset is
 * persisted in the channel config (`inbound_offset`) so a restart never replays old messages.
 *
 * Approval buttons are `callback_data` buttons (`a:<shortid>`, see callback-ids.ts). A
 * `callback_query` from the configured chat resolves the interrupt it stands for (actor
 * 'telegram'), answers the tap and rewrites the message to "Approved / Denied" without buttons;
 * a callback from any other chat is ignored.
 */

import { interruptsService } from '@/modules/interrupt-queue/index.js';
import { missionControlDb } from '@/modules/mission-control/index.js';
import { resolveCallbackData } from '@/modules/bots/channels/callback-ids.js';
import { botChannelsDb } from '@/modules/bots/channels/bot-channels.repository.js';
import { telegramCall } from '@/modules/bots/channels/adapters/telegram.js';
import { channelsService, getAdapterContext } from '@/modules/bots/channels/channels.service.js';
import { thread } from '@/modules/bots/channels/thread.service.js';

const BOT_COMMAND = /^\/bot(?:@\w+)?\s+(?:"([^"]+)"|(\S+))\s+([\s\S]+)$/;
const DEFAULT_POLL_TIMEOUT_S = 25;
const RETRY_DELAY_MS = 5_000;
const SYNC_INTERVAL_MS = 30_000;

const slug = (text: string): string => text.trim().toLowerCase().replace(/[\s_]+/g, '-');

/** A bot by exact title, slug or id; null when absent or ambiguous. */
export function resolveBotByName(name: string): string | null {
  const wanted = slug(name);
  const matches = missionControlDb
    .listSections()
    .filter((section) => section.section_id === name.trim() || slug(section.title) === wanted);
  return matches.length === 1 ? matches[0].section_id : null;
}

export interface InboundRoute {
  botId: string | null;
  text: string;
  hint?: string;
}

/** Decide which bot a Telegram text is for. */
export function routeTelegramText(text: string, boundBotId: string | null): InboundRoute {
  const command = BOT_COMMAND.exec(text.trim());
  if (command) {
    const botId = resolveBotByName(command[1] ?? command[2]);
    if (botId && (!boundBotId || boundBotId === botId)) return { botId, text: command[3].trim() };
    if (!boundBotId) return { botId: null, text: '', hint: `No bot named "${command[1] ?? command[2]}".` };
  }
  if (boundBotId) return { botId: boundBotId, text: text.trim() };
  return { botId: null, text: '', hint: 'Address a bot with: /bot <name> <message> (use dashes for spaces, e.g. /bot pr-shepherd status?).' };
}

interface TelegramUpdate {
  update_id?: number;
  message?: { text?: string; chat?: { id?: number | string } };
  callback_query?: {
    id?: string;
    data?: string;
    message?: { message_id?: number; text?: string; chat?: { id?: number | string } };
  };
}

const RESULT_LINES: Record<string, string> = {
  approve_once: 'Approved \u2713',
  always_allow: 'Always allowed \u2713',
  deny: 'Denied \u2717',
};

/**
 * One tapped approval button. Only the configured chat may press them. Never throws: a failed
 * Telegram call must not stop the poll loop or hold back the offset.
 */
export async function handleTelegramCallback(
  channel: { config: Record<string, unknown> },
  query: NonNullable<TelegramUpdate['callback_query']>,
): Promise<'applied' | 'stale' | 'ignored'> {
  const ctx = getAdapterContext();
  const tokenRef = String(channel.config.token_ref);
  const chatId = String(channel.config.chat_id).trim();
  const message = query.message;
  if (!query.id || message?.chat?.id === undefined || String(message.chat.id) !== chatId) return 'ignored';
  const mapped = resolveCallbackData(query.data);
  if (!mapped && !(typeof query.data === 'string' && query.data.startsWith('a:'))) return 'ignored';

  const answer = (text: string): Promise<unknown> =>
    telegramCall(ctx, tokenRef, 'answerCallbackQuery', { callback_query_id: query.id, text: text.slice(0, 190) }).catch(() => undefined);
  const rewrite = (line: string): Promise<unknown> =>
    typeof message.message_id === 'number'
      ? telegramCall(ctx, tokenRef, 'editMessageText', {
          chat_id: message.chat!.id,
          message_id: message.message_id,
          text: `${typeof message.text === 'string' ? message.text.slice(0, 3800) : ''}\n\n${line}`.trim(),
          disable_web_page_preview: true,
          reply_markup: { inline_keyboard: [] },
        }).catch(() => undefined)
      : Promise.resolve();

  if (!mapped) {
    await answer('This request has expired.');
    await rewrite('Expired');
    return 'stale';
  }
  const interrupt = interruptsService.get(mapped.interruptId);
  if (!interrupt || (interrupt.status !== 'open' && interrupt.status !== 'snoozed')) {
    await answer('Already answered or expired.');
    await rewrite('Already answered');
    return 'stale';
  }
  const action = interrupt.actions.find((candidate) => candidate.id === mapped.actionKey);
  try {
    interruptsService.act(mapped.interruptId, { key: mapped.actionKey, actor: 'telegram' });
  } catch (error) {
    await answer(error instanceof Error ? error.message : 'Could not apply that.');
    return 'stale';
  }
  const result = RESULT_LINES[mapped.actionKey] ?? `${action?.label ?? mapped.actionKey} \u2713`;
  await answer(result);
  await rewrite(result);
  return 'applied';
}

/** One getUpdates round. Returns how many operator messages were accepted. */
export async function pollTelegramOnce(channelId: string, options: { signal?: AbortSignal } = {}): Promise<number> {
  const channel = botChannelsDb.get(channelId);
  if (!channel || !channel.enabled || channel.kind !== 'telegram' || channel.config.inbound !== true) return 0;
  const ctx = getAdapterContext();
  const tokenRef = String(channel.config.token_ref);
  const chatId = String(channel.config.chat_id).trim();
  const offset = typeof channel.config.inbound_offset === 'number' ? channel.config.inbound_offset : 0;
  const timeout = Number.isFinite(Number(channel.config.poll_timeout_s)) ? Number(channel.config.poll_timeout_s) : DEFAULT_POLL_TIMEOUT_S;

  const response = await telegramCall(ctx, tokenRef, 'getUpdates', { offset, timeout, allowed_updates: ['message', 'callback_query'] }, options.signal);
  if (!response.ok) throw new Error(`telegram getUpdates failed: ${response.description ?? `http ${response.status}`}`);
  const updates = (Array.isArray(response.result) ? response.result : []) as TelegramUpdate[];

  let accepted = 0;
  for (const update of updates) {
    if (typeof update.update_id !== 'number') continue;
    if (update.callback_query) {
      try {
        await handleTelegramCallback(channel, update.callback_query);
      } catch (error) {
        console.warn('[BotChannels] telegram callback failed', error instanceof Error ? error.message : error);
      }
      channelsService.setConfigValue(channelId, 'inbound_offset', update.update_id + 1);
      continue;
    }
    const message = update.message;
    const text = typeof message?.text === 'string' ? message.text.trim() : '';
    // Only the configured chat may speak to the bot; every other chat is dropped silently.
    if (text && message?.chat?.id !== undefined && String(message.chat.id) === chatId) {
      const route = routeTelegramText(text, channel.bot_id);
      if (route.botId && route.text) {
        try {
          thread.postOperatorMessage(route.botId, route.text, 'telegram', { telegram_update_id: update.update_id });
          accepted += 1;
        } catch (error) {
          console.warn('[BotChannels] telegram inbound failed', error instanceof Error ? error.message : error);
        }
      } else if (route.hint) {
        await telegramCall(ctx, tokenRef, 'sendMessage', { chat_id: channel.config.chat_id, text: route.hint }).catch(() => undefined);
      }
    }
    channelsService.setConfigValue(channelId, 'inbound_offset', update.update_id + 1);
  }
  return accepted;
}

// ---- loop management -----------------------------------------------------------

const loops = new Map<string, AbortController>();
let syncTimer: ReturnType<typeof setInterval> | null = null;

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
    signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

async function runLoop(channelId: string, controller: AbortController): Promise<void> {
  const { signal } = controller;
  while (!signal.aborted) {
    const channel = botChannelsDb.get(channelId);
    if (!channel || !channel.enabled || channel.config.inbound !== true) break;
    try {
      await pollTelegramOnce(channelId, { signal });
      // A zero timeout would spin; pace it.
      if (Number(channel.config.poll_timeout_s) === 0) await abortableSleep(2_000, signal);
    } catch (error) {
      if (signal.aborted) break;
      console.warn('[BotChannels] telegram poll error', error instanceof Error ? error.message : error);
      await abortableSleep(RETRY_DELAY_MS, signal);
    }
  }
  if (loops.get(channelId) === controller) loops.delete(channelId);
}

/** Start a loop for every enabled inbound channel that lacks one. */
export function syncTelegramPolling(): void {
  const wanted = [...botChannelsDb.list(null), ...missionControlDb.listSections().flatMap((section) => botChannelsDb.list(section.section_id))]
    .filter((channel) => channel.kind === 'telegram' && channel.enabled && channel.config.inbound === true);
  const wantedIds = new Set(wanted.map((channel) => channel.channel_id));
  for (const [id, controller] of loops) {
    if (!wantedIds.has(id)) {
      controller.abort();
      loops.delete(id);
    }
  }
  for (const channel of wanted) {
    if (loops.has(channel.channel_id)) continue;
    const controller = new AbortController();
    loops.set(channel.channel_id, controller);
    void runLoop(channel.channel_id, controller);
  }
}

export function startTelegramPolling(): void {
  syncTelegramPolling();
  syncTimer ??= setInterval(syncTelegramPolling, SYNC_INTERVAL_MS);
  syncTimer.unref?.();
}

export function stopTelegramPolling(): void {
  if (syncTimer) clearInterval(syncTimer);
  syncTimer = null;
  for (const controller of loops.values()) controller.abort();
  loops.clear();
}
