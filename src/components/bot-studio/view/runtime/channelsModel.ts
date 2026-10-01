/**
 * Pure helpers for the Channels view: kind metadata, policy drafts + validation, config drafts
 * per kind, and one-line policy summaries. Mirrors the server validation in
 * server/modules/bots/channels/channels.service.ts and adapters/*.ts so the UI can explain a
 * problem before the request is sent (the server remains the authority).
 */

import type { BotChannel, BotChannelPolicy, BotPublicBaseUrlSource } from '../../types/botRuntime';

export type ChannelKind = 'inapp' | 'webpush' | 'slack' | 'telegram' | 'email';

export type ChannelKindMeta = {
  kind: ChannelKind;
  label: string;
  description: string;
  /** Always on and not configurable (inapp). */
  alwaysOn?: boolean;
  /** The server rejects creating this kind (email is deferred). */
  deferred?: boolean;
};

/** Verbatim from server/modules/bots/channels/adapters/email.ts (EMAIL_DEFERRED_MESSAGE). */
export const EMAIL_DEFERRED_MESSAGE = "email channel not available yet — route email through the bot's own mail MCP tools";

export const CHANNEL_KIND_META: ChannelKindMeta[] = [
  { kind: 'inapp', label: 'In-app', description: 'The notifications inbox inside CloudCLI. Always on, nothing to configure.', alwaysOn: true },
  { kind: 'webpush', label: 'Web push', description: 'Browser push notifications. Uses the push subscriptions your browsers already registered (enable them in Settings → Notifications); no extra configuration.' },
  { kind: 'slack', label: 'Slack', description: 'Posts to a channel with a bot token, or to an incoming webhook. Action buttons are signed links.' },
  { kind: 'telegram', label: 'Telegram', description: 'Sends to one chat through a bot. Optionally polls for your replies.' },
  { kind: 'email', label: 'Email', description: EMAIL_DEFERRED_MESSAGE, deferred: true },
];

export function channelMeta(kind: string): ChannelKindMeta {
  return CHANNEL_KIND_META.find((entry) => entry.kind === kind)
    ?? { kind: kind as ChannelKind, label: kind, description: 'Unknown channel kind.' };
}

/** Kinds that can still be added to a scope (one row per kind per scope; in-app is implicit and deferred kinds are excluded). */
export function addableKinds(existing: Array<Pick<BotChannel, 'kind'>>): ChannelKindMeta[] {
  const have = new Set(existing.map((channel) => channel.kind));
  return CHANNEL_KIND_META.filter((entry) => !entry.deferred && !entry.alwaysOn && !have.has(entry.kind));
}

// ---- secret references ---------------------------------------------------------------------------

export const SECRET_REF = /^\$\{secret:[A-Za-z0-9_.:-]+\}$/;
const BARE_SECRET_NAME = /^[A-Za-z0-9_.:-]+$/;

/** Accepts `${secret:NAME}` or a bare NAME (wrapped). Returns '' for blank, null when invalid. */
export function normalizeSecretRef(input: string): string | null {
  const value = input.trim();
  if (!value) return '';
  if (SECRET_REF.test(value)) return value;
  if (BARE_SECRET_NAME.test(value)) return `\${secret:${value}}`;
  return null;
}

// ---- policy --------------------------------------------------------------------------------------

export type ChannelPolicyValue = BotChannelPolicy & { brief_at?: string; brief_tz?: string };

const HH_MM = /^([01]\d|2[0-3]):[0-5]\d$/;

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function isValidTime(value: string): boolean {
  return HH_MM.test(value);
}

/** Returns an error string, or null when the quiet-hours window is acceptable. */
export function validateQuietHours(start: string, end: string, tz: string): string | null {
  if (!isValidTime(start) || !isValidTime(end)) return 'Quiet hours need a start and an end time (HH:MM).';
  if (start === end) return 'Quiet hours start and end must differ.';
  if (tz.trim() && !isValidTimeZone(tz.trim())) return `"${tz.trim()}" is not a valid IANA time zone (for example Asia/Dubai).`;
  return null;
}

export type PolicyDraft = {
  quietEnabled: boolean;
  quietStart: string;
  quietEnd: string;
  quietTz: string;
  /** Text so the field can be empty (= no limit). */
  maxPings: string;
  /** 0-1. */
  minUrgency: number;
  digest: boolean;
  briefAt: string;
  briefTz: string;
};

export const EMPTY_POLICY_DRAFT: PolicyDraft = {
  quietEnabled: false,
  quietStart: '22:00',
  quietEnd: '07:00',
  quietTz: '',
  maxPings: '',
  minUrgency: 0,
  digest: false,
  briefAt: '',
  briefTz: '',
};

export function policyToDraft(policy: ChannelPolicyValue | null | undefined): PolicyDraft {
  const p = policy ?? {};
  return {
    quietEnabled: Boolean(p.quiet_hours),
    quietStart: p.quiet_hours?.start ?? EMPTY_POLICY_DRAFT.quietStart,
    quietEnd: p.quiet_hours?.end ?? EMPTY_POLICY_DRAFT.quietEnd,
    quietTz: p.quiet_hours?.tz ?? '',
    maxPings: typeof p.max_pings_per_day === 'number' ? String(p.max_pings_per_day) : '',
    minUrgency: typeof p.min_urgency === 'number' ? p.min_urgency : 0,
    digest: p.digest === true,
    briefAt: p.brief_at ?? '',
    briefTz: p.brief_tz ?? '',
  };
}

/**
 * Draft -> policy to send. The server replaces the whole policy on update, so anything left at its
 * "off" value is omitted. `brief_at`/`brief_tz` are only emitted for global channels.
 */
export function draftToPolicy(draft: PolicyDraft, options: { global: boolean }): { policy: ChannelPolicyValue; errors: string[] } {
  const errors: string[] = [];
  const policy: ChannelPolicyValue = {};
  if (draft.quietEnabled) {
    const error = validateQuietHours(draft.quietStart, draft.quietEnd, draft.quietTz);
    if (error) errors.push(error);
    else policy.quiet_hours = { start: draft.quietStart, end: draft.quietEnd, ...(draft.quietTz.trim() ? { tz: draft.quietTz.trim() } : {}) };
  }
  const max = draft.maxPings.trim();
  if (max) {
    const n = Number(max);
    if (!Number.isInteger(n) || n < 0) errors.push('Max pings per day must be a whole number, 0 or more.');
    else policy.max_pings_per_day = n;
  }
  if (!Number.isFinite(draft.minUrgency) || draft.minUrgency < 0 || draft.minUrgency > 1) errors.push('Minimum urgency must be between 0 and 1.');
  else if (draft.minUrgency > 0) policy.min_urgency = Math.round(draft.minUrgency * 100) / 100;
  if (draft.digest) policy.digest = true;
  if (options.global) {
    const briefAt = draft.briefAt.trim();
    if (briefAt) {
      if (!isValidTime(briefAt)) errors.push('Brief time must be HH:MM (24-hour).');
      else policy.brief_at = briefAt;
    }
    const briefTz = draft.briefTz.trim();
    if (briefTz) {
      if (!isValidTimeZone(briefTz)) errors.push(`"${briefTz}" is not a valid IANA time zone for the brief.`);
      else policy.brief_tz = briefTz;
    }
  }
  return { policy, errors };
}

export function urgencyLabel(value: number): string {
  if (value <= 0) return 'Everything';
  if (value < 0.34) return 'Low and above';
  if (value < 0.67) return 'Medium and above';
  if (value < 0.9) return 'High and above';
  return 'Urgent only';
}

/** Short human phrases, one per active rule. Empty policy -> a single "no limits" phrase. */
export function policyParts(policy: ChannelPolicyValue | null | undefined): string[] {
  const p = policy ?? {};
  const parts: string[] = [];
  if (p.quiet_hours) parts.push(`Quiet ${p.quiet_hours.start}–${p.quiet_hours.end}${p.quiet_hours.tz ? ` (${p.quiet_hours.tz})` : ''}`);
  if (typeof p.max_pings_per_day === 'number') parts.push(p.max_pings_per_day === 0 ? 'No pings' : `Max ${p.max_pings_per_day} pings/day`);
  if (typeof p.min_urgency === 'number' && p.min_urgency > 0) parts.push(`Urgency ≥ ${Math.round(p.min_urgency * 100)}%`);
  if (p.digest) parts.push('Digest only');
  if (p.brief_at) parts.push(`Brief at ${p.brief_at}${p.brief_tz ? ` (${p.brief_tz})` : ''}`);
  return parts.length ? parts : ['No limits'];
}

export const policySummary = (policy: ChannelPolicyValue | null | undefined): string => policyParts(policy).join(' · ');

// ---- config drafts -------------------------------------------------------------------------------

export type SlackMode = 'bot' | 'webhook';

export type ConfigDraft = {
  slackMode: SlackMode;
  /** Slack bot token ref, or Telegram bot token ref. */
  tokenRef: string;
  channelId: string;
  webhookUrlRef: string;
  chatId: string;
  inbound: boolean;
  actionBaseUrl: string;
};

export const EMPTY_CONFIG_DRAFT: ConfigDraft = {
  slackMode: 'bot',
  tokenRef: '',
  channelId: '',
  webhookUrlRef: '',
  chatId: '',
  inbound: false,
  actionBaseUrl: '',
};

const str = (value: unknown): string => (typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '');

export function configToDraft(kind: string, config: Record<string, unknown> | null | undefined): ConfigDraft {
  const c = config ?? {};
  return {
    slackMode: kind === 'slack' && c.webhook_url_ref ? 'webhook' : 'bot',
    tokenRef: str(c.token_ref),
    channelId: str(c.channel_id),
    webhookUrlRef: str(c.webhook_url_ref),
    chatId: str(c.chat_id),
    inbound: c.inbound === true,
    actionBaseUrl: str(c.action_base_url),
  };
}

/** Keys the server writes or the UI does not expose; copied through on edit so an edit cannot drop them. */
const PRESERVED_KEYS = ['poll_timeout_s', 'inbound_offset'] as const;

function checkBaseUrl(value: string): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? null : 'Public base URL must start with http:// or https://.';
  } catch {
    return 'Public base URL must be a valid URL.';
  }
}

export function draftToConfig(
  kind: string,
  draft: ConfigDraft,
  existing?: Record<string, unknown> | null,
): { config: Record<string, unknown>; errors: string[] } {
  const errors: string[] = [];
  const config: Record<string, unknown> = {};
  const secret = (input: string, label: string, required: boolean): string => {
    const ref = normalizeSecretRef(input);
    if (ref === null) {
      errors.push(`${label} must be a secret reference like \${secret:NAME} (pick one from your vault; raw tokens are never stored).`);
      return '';
    }
    if (!ref && required) errors.push(`${label} is required.`);
    return ref ?? '';
  };
  if (kind === 'slack') {
    if (draft.slackMode === 'webhook') {
      const ref = secret(draft.webhookUrlRef, 'Webhook secret', true);
      if (ref) config.webhook_url_ref = ref;
    } else {
      const ref = secret(draft.tokenRef, 'Bot token secret', true);
      if (ref) config.token_ref = ref;
      if (!draft.channelId.trim()) errors.push('Slack channel id is required (for example C0123456789).');
      else config.channel_id = draft.channelId.trim();
    }
  } else if (kind === 'telegram') {
    const ref = secret(draft.tokenRef, 'Bot token secret', true);
    if (ref) config.token_ref = ref;
    const chat = draft.chatId.trim();
    if (!/^-?\d+$|^@\w+$/.test(chat)) errors.push('Chat id must be a numeric Telegram chat id.');
    else if (draft.inbound && chat.startsWith('@')) errors.push('Inbound replies need a numeric chat id.');
    else config.chat_id = chat;
    if (draft.inbound) config.inbound = true;
  } else if (kind === 'email') {
    errors.push(EMAIL_DEFERRED_MESSAGE);
  }
  if (kind === 'slack' || kind === 'telegram') {
    const base = draft.actionBaseUrl.trim();
    const baseError = checkBaseUrl(base);
    if (baseError) errors.push(baseError);
    else if (base) config.action_base_url = base;
    for (const key of PRESERVED_KEYS) {
      if (kind === 'telegram' && existing && existing[key] !== undefined) config[key] = existing[key];
    }
  }
  return { config, errors };
}

// ---- grouping + outbound log ---------------------------------------------------------------------

/** Global channels first, then each bot's own, bots alphabetical. */
export function groupChannels(
  channels: BotChannel[],
  titleOf: (botId: string) => string,
): Array<{ botId: string | null; title: string; channels: BotChannel[] }> {
  const global = channels.filter((channel) => channel.bot_id === null);
  const byBot = new Map<string, BotChannel[]>();
  for (const channel of channels) {
    if (channel.bot_id === null) continue;
    byBot.set(channel.bot_id, [...(byBot.get(channel.bot_id) ?? []), channel]);
  }
  const groups: Array<{ botId: string | null; title: string; channels: BotChannel[] }> = [{ botId: null, title: 'Global (all bots)', channels: global }];
  const bots = [...byBot.entries()].map(([botId, list]) => ({ botId, title: titleOf(botId), channels: list }));
  bots.sort((a, b) => a.title.localeCompare(b.title));
  return [...groups, ...bots];
}

/** What an outbound log row means, in plain words. Held-back reasons look like `<policy>: <title>`. */
export function outboundReasonLabel(delivered: boolean, reason: string | null): string {
  if (delivered) return reason === 'test' ? 'Test message' : 'Delivered';
  if (!reason) return 'Not delivered';
  const index = reason.indexOf(':');
  const head = (index >= 0 ? reason.slice(0, index) : reason).trim();
  const title = index >= 0 ? reason.slice(index + 1).trim() : '';
  const suffix = title ? `: ${title}` : '';
  switch (head) {
    case 'quiet_hours': return `Held back (quiet hours)${suffix}`;
    case 'digest': return `Held back (digest)${suffix}`;
    case 'min_urgency': return `Below minimum urgency${suffix}`;
    case 'max_pings_per_day': return `Daily ping limit reached${suffix}`;
    default: return reason;
  }
}

// ---- public base URL -----------------------------------------------------------------------------

/**
 * GET /runtime/host reports only whether an app-wide URL (the `bots.public_base_url` setting or
 * CLOUDCLI_PUBLIC_URL) is configured, not which source won. A per-channel `action_base_url`
 * overrides both and is not visible there.
 */
export function publicUrlStatus(host: { publicUrlConfigured?: unknown } | null | undefined): { label: string; tone: 'success' | 'warning' | 'default'; detail: string } {
  if (!host || typeof host.publicUrlConfigured !== 'boolean') {
    return { label: 'Unknown', tone: 'default', detail: 'The server did not report whether a public URL is configured.' };
  }
  return host.publicUrlConfigured
    ? { label: 'App-wide URL configured', tone: 'success', detail: 'Action links use it unless a channel sets its own base URL.' }
    : { label: 'No app-wide URL', tone: 'warning', detail: 'Action links fall back to http://localhost, which only works from this machine, unless a channel sets its own base URL.' };
}

const PUBLIC_BASE_URL_SOURCES: Record<BotPublicBaseUrlSource, string> = {
  override: 'set on this channel',
  app_config: 'set in app settings',
  env: 'from the CLOUDCLI_PUBLIC_URL environment variable',
  default: 'default, this machine only',
};

export const LOCAL_PUBLIC_URL_WARNING = 'Approval links point to localhost, so they will not open from your phone. Telegram and Slack will send approvals without link buttons. Set a public https URL (bots.public_base_url).';

/**
 * The line (and, for a localhost URL, the warning) shown for `public_base_url` in the channels response.
 * Returns null when an older server did not send it or sent something unusable, so the UI renders nothing.
 */
export function describePublicBaseUrl(info: unknown): { line: string; warning: string | null } | null {
  if (!info || typeof info !== 'object') return null;
  const { value, source, is_local: isLocal } = info as Record<string, unknown>;
  if (typeof value !== 'string' || !value.trim()) return null;
  const where = typeof source === 'string' && Object.prototype.hasOwnProperty.call(PUBLIC_BASE_URL_SOURCES, source)
    ? PUBLIC_BASE_URL_SOURCES[source as BotPublicBaseUrlSource]
    : null;
  return {
    line: `Approval links use ${value.trim()}${where ? ` (${where})` : ''}`,
    warning: isLocal === true ? LOCAL_PUBLIC_URL_WARNING : null,
  };
}
