/**
 * Turns the wizard's channel choices into the bot-scoped channel rows to create. Channels resolve
 * per kind: a bot's own row of a kind replaces the global row of that kind. So
 *   - a bot-specific Slack/Telegram channel is a new row,
 *   - "do not use this global channel" is a bot-scoped copy of it, disabled,
 *   - quiet hours on a global channel the bot keeps is a bot-scoped copy with the window added.
 * Copies carry secret REFERENCES only (the vault never leaves the server).
 */

import type { BotChannel, BotChannelInput, BotChannelPolicy } from '../types/botRuntime';
import {
  EMPTY_POLICY_DRAFT, channelMeta, draftToConfig, draftToPolicy,
} from '../view/runtime/channelsModel';

import type { OwnChannelKind, RuntimeDraft } from './runtimeDraft';

export type ChannelOp = { kind: string; label: string; why: string; quiet: boolean; input: Omit<BotChannelInput, 'botId'> };

export type ChannelPlan = { ops: ChannelOp[]; errors: string[] };

/**
 * Keys copied from a global channel that must NOT follow into a bot-scoped copy: the Telegram inbound
 * poller state (a second poller on the same token would fight the first and double-handle replies)
 * and the global-only morning-brief schedule.
 */
const COPY_DROP_CONFIG = ['inbound', 'inbound_offset', 'poll_timeout_s'];
const COPY_DROP_POLICY = ['brief_at', 'brief_tz'];

function copyConfig(config: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(config).filter(([key]) => !COPY_DROP_CONFIG.includes(key)));
}

function copyPolicy(policy: BotChannelPolicy): BotChannelPolicy {
  return Object.fromEntries(Object.entries(policy).filter(([key]) => !COPY_DROP_POLICY.includes(key))) as BotChannelPolicy;
}

/** The quiet-hours policy the user chose (empty when off), validated like the Channels page does. */
export function quietPolicy(quiet: RuntimeDraft['channels']['quiet']): { policy: BotChannelPolicy; errors: string[] } {
  if (!quiet.enabled) return { policy: {}, errors: [] };
  const built = draftToPolicy({ ...EMPTY_POLICY_DRAFT, quietEnabled: true, quietStart: quiet.start, quietEnd: quiet.end, quietTz: quiet.tz }, { global: false });
  return { policy: built.policy, errors: built.errors };
}

const OWN_KINDS: OwnChannelKind[] = ['slack', 'telegram'];

export function planChannels(channels: RuntimeDraft['channels'], globals: BotChannel[]): ChannelPlan {
  const ops: ChannelOp[] = [];
  const errors: string[] = [];
  const quiet = quietPolicy(channels.quiet);
  errors.push(...quiet.errors);
  const usable = globals.filter((channel) => channel.bot_id === null && channel.kind !== 'inapp');
  const handled = new Set<string>();

  for (const kind of OWN_KINDS) {
    const own = channels.own[kind];
    if (!own?.enabled) continue;
    const built = draftToConfig(kind, own.config);
    if (built.errors.length) {
      errors.push(...built.errors.map((message) => `${channelMeta(kind).label}: ${message}`));
      continue;
    }
    handled.add(kind);
    const overridesGlobal = usable.some((channel) => channel.kind === kind);
    ops.push({
      kind,
      label: `${channelMeta(kind).label} channel for this bot`,
      why: overridesGlobal ? `Replaces the shared ${channelMeta(kind).label} channel for this bot.` : 'A channel only this bot uses.',
      quiet: Boolean(quiet.policy.quiet_hours),
      input: { kind, config: built.config, policy: quiet.policy, enabled: true },
    });
  }

  for (const channel of usable) {
    if (handled.has(channel.kind)) continue;
    const label = channelMeta(channel.kind).label;
    if (channels.skipGlobal.includes(channel.channel_id)) {
      handled.add(channel.kind);
      ops.push({
        kind: channel.kind,
        label: `Do not use ${label} for this bot`,
        why: 'Saved as a bot-specific copy of the shared channel, switched off.',
        quiet: false,
        input: { kind: channel.kind, config: copyConfig(channel.config), policy: {}, enabled: false },
      });
      continue;
    }
    if (channels.quiet.enabled && channel.enabled) {
      handled.add(channel.kind);
      ops.push({
        kind: channel.kind,
        label: `${label} with quiet hours`,
        why: 'Saved as a bot-specific copy of the shared channel with your quiet hours added; later edits to the shared channel will not reach this copy.',
        quiet: true,
        input: { kind: channel.kind, config: copyConfig(channel.config), policy: { ...copyPolicy(channel.policy), ...quiet.policy }, enabled: true },
      });
    }
  }
  return { ops, errors };
}

/** What the bot will use, in words: for the Review step and the Reach me summary. */
export function describeChannelChoices(channels: RuntimeDraft['channels'], globals: BotChannel[]): string[] {
  const lines = ['In-app notifications (always on)'];
  const plan = planChannels(channels, globals);
  const overridden = new Set(plan.ops.map((op) => op.kind));
  for (const channel of globals.filter((entry) => entry.bot_id === null && entry.kind !== 'inapp')) {
    if (overridden.has(channel.kind)) continue;
    if (channel.enabled) lines.push(`${channelMeta(channel.kind).label} (shared channel)`);
  }
  for (const op of plan.ops) {
    if (op.input.enabled === false) lines.push(`${channelMeta(op.kind).label}: off for this bot`);
    else lines.push(`${op.label}${op.quiet ? ` · quiet ${channels.quiet.start}–${channels.quiet.end}` : ''}`);
  }
  return lines;
}
