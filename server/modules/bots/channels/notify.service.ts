/**
 * `notifyOperator`: the one door for proactive messages. Resolves the bot's channels (its own,
 * else global defaults), applies the interruption policy per channel, logs every attempt to
 * `bot_outbound_log`, and always records an in-app notification.
 */

import { missionControlDb } from '@/modules/mission-control/index.js';
import type { BotChannel } from '@/modules/bots/bots.types.js';
import { getChannelAdapter } from '@/modules/bots/channels/adapters/index.js';
import { recordInAppNotification } from '@/modules/bots/channels/adapters/inapp.js';
import type { OutboundAction, OutboundMessage } from '@/modules/bots/channels/adapters/types.js';
import { botChannelsDb } from '@/modules/bots/channels/bot-channels.repository.js';
import { botOutboundLogDb } from '@/modules/bots/channels/bot-outbound-log.repository.js';
import { getAdapterContext, type ChannelPolicy } from '@/modules/bots/channels/channels.service.js';
import { buildActionUrl, createActionToken } from '@/modules/bots/channels/signed-links.js';

/** Quiet hours are lifted for messages at or above this urgency. */
export const QUIET_HOURS_BYPASS_URGENCY = 0.9;

export interface NotifyActionInput {
  id: string;
  label: string;
  style?: 'primary' | 'secondary' | 'destructive';
}

export interface NotifyOperatorInput {
  botId: string | null;
  title: string;
  body: string;
  /** 0 (low) to 1 (urgent). */
  urgency: number;
  actions?: NotifyActionInput[];
  interruptId?: string;
  href?: string;
  /** A scheduled digest (the morning brief): bypasses `digest` and `min_urgency`. */
  scheduled?: boolean;
  /**
   * The operator must see this (an approval, a reminder, an expiry): every enabled channel is tried
   * whatever its quiet hours, digest, minimum urgency or daily cap say.
   */
  critical?: boolean;
}

export interface NotifyResult {
  delivered: string[];
  suppressed: string[];
  failed: string[];
  /** Why each failed channel failed (the adapter's detail), in the order they were tried. */
  failures: Array<{ kind: string; detail: string }>;
}

// ---- policy -----------------------------------------------------------------

function localParts(date: Date, tz?: string): { minutes: number; secondsIntoDay: number } {
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch {
    formatter = new Intl.DateTimeFormat('en-US', { hourCycle: 'h23', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }
  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  const hour = Number(parts.hour) % 24;
  const minute = Number(parts.minute);
  return { minutes: hour * 60 + minute, secondsIntoDay: hour * 3600 + minute * 60 + Number(parts.second) };
}

const toMinutes = (hhmm: string): number => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

export function inQuietHours(quiet: NonNullable<ChannelPolicy['quiet_hours']>, now: Date): boolean {
  const start = toMinutes(quiet.start);
  const end = toMinutes(quiet.end);
  if (start === end) return false;
  const { minutes } = localParts(now, quiet.tz);
  return start < end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
}

/** Start of the current day in `tz` (server-local when omitted), as an ISO timestamp. */
export function startOfLocalDayIso(now: Date, tz?: string): string {
  return new Date(now.getTime() - localParts(now, tz).secondsIntoDay * 1000).toISOString();
}

/** Why this message must not go out on this channel right now, or null to send. */
export function evaluatePolicy(
  policy: ChannelPolicy,
  ctx: { botId: string | null; kind: string; urgency: number; scheduled?: boolean; now: Date },
): string | null {
  if (policy.quiet_hours && ctx.urgency < QUIET_HOURS_BYPASS_URGENCY && inQuietHours(policy.quiet_hours, ctx.now)) {
    return 'quiet_hours';
  }
  if (typeof policy.min_urgency === 'number' && !ctx.scheduled && ctx.urgency < policy.min_urgency) return 'min_urgency';
  if (policy.digest === true && !ctx.scheduled) return 'digest';
  if (typeof policy.max_pings_per_day === 'number') {
    const since = startOfLocalDayIso(ctx.now, policy.quiet_hours?.tz);
    if (botOutboundLogDb.countDeliveredSince(ctx.botId, ctx.kind, since) >= policy.max_pings_per_day) return 'max_pings_per_day';
  }
  return null;
}

// ---- message building ----------------------------------------------------------

function buildActions(input: NotifyOperatorInput, baseUrl: unknown): OutboundAction[] {
  if (!input.interruptId || !input.actions) return [];
  const interruptId = input.interruptId;
  return input.actions
    .filter((action) => action.id && action.id !== 'open_href')
    .map((action) => ({
      key: action.id,
      label: action.label,
      style: action.style,
      url: buildActionUrl(createActionToken(interruptId, action.id), baseUrl),
    }));
}

function botTitleOf(botId: string | null): string {
  if (!botId) return 'CloudCLI bots';
  return missionControlDb.getSection(botId)?.title?.trim() || 'Bot';
}

function buildMessage(input: NotifyOperatorInput, baseUrl: unknown): OutboundMessage {
  return {
    botId: input.botId,
    botTitle: botTitleOf(input.botId),
    title: input.title,
    body: input.body,
    urgency: input.urgency,
    actions: buildActions(input, baseUrl),
    href: input.href,
    interruptId: input.interruptId,
  };
}

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Deliver one message on one channel row and log it; never throws. */
export async function deliverOnChannel(
  channel: Pick<BotChannel, 'kind' | 'config' | 'bot_id'>,
  input: NotifyOperatorInput,
  reason: string | null = null,
): Promise<{ ok: boolean; detail?: string }> {
  const adapter = getChannelAdapter(channel.kind);
  const urgency = input.urgency;
  try {
    if (!adapter) throw new Error(`no adapter for ${channel.kind}`);
    const result = await adapter.send(channel, buildMessage(input, channel.config.action_base_url), getAdapterContext());
    botOutboundLogDb.record({
      botId: input.botId,
      channelKind: channel.kind,
      urgency,
      delivered: result.ok,
      reason: result.ok ? reason : (result.detail ?? 'send_failed'),
    });
    return result;
  } catch (error) {
    const detail = `error: ${errorText(error)}`.slice(0, 200);
    botOutboundLogDb.record({ botId: input.botId, channelKind: channel.kind, urgency, delivered: false, reason: detail });
    return { ok: false, detail };
  }
}

export async function notifyOperator(input: NotifyOperatorInput, options: { now?: Date } = {}): Promise<NotifyResult> {
  const now = options.now ?? new Date();
  const normalized: NotifyOperatorInput = {
    ...input,
    urgency: Number.isFinite(input.urgency) ? Math.min(1, Math.max(0, input.urgency)) : 0.5,
  };
  const result: NotifyResult = { delivered: [], suppressed: [], failed: [], failures: [] };

  // In-app always records, whatever the policy says.
  try {
    recordInAppNotification(buildMessage(normalized, undefined));
    botOutboundLogDb.record({ botId: normalized.botId, channelKind: 'inapp', urgency: normalized.urgency, delivered: true });
    result.delivered.push('inapp');
  } catch (error) {
    botOutboundLogDb.record({ botId: normalized.botId, channelKind: 'inapp', urgency: normalized.urgency, delivered: false, reason: `error: ${errorText(error)}`.slice(0, 200) });
    result.failed.push('inapp');
    result.failures.push({ kind: 'inapp', detail: errorText(error) });
  }

  const channels = (normalized.botId ? botChannelsDb.listEffective(normalized.botId) : botChannelsDb.list(null))
    .filter((channel) => channel.enabled && channel.kind !== 'inapp');
  for (const channel of channels) {
    const reason = normalized.critical ? null : evaluatePolicy(channel.policy as ChannelPolicy, {
      botId: normalized.botId,
      kind: channel.kind,
      urgency: normalized.urgency,
      scheduled: normalized.scheduled,
      now,
    });
    if (reason) {
      // The title rides along in the reason so the morning brief can list what was held back.
      botOutboundLogDb.record({
        botId: normalized.botId,
        channelKind: channel.kind,
        urgency: normalized.urgency,
        delivered: false,
        reason: `${reason}: ${normalized.title}`.slice(0, 200),
      });
      result.suppressed.push(channel.kind);
      continue;
    }
    const sent = await deliverOnChannel(channel, normalized);
    (sent.ok ? result.delivered : result.failed).push(channel.kind);
    if (!sent.ok) result.failures.push({ kind: channel.kind, detail: sent.detail ?? 'send failed' });
  }
  return result;
}
