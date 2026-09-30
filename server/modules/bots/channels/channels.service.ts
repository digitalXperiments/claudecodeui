/**
 * Channel CRUD with per-kind config validation. Secrets are only ever `${secret:NAME}` references,
 * resolved at send time; a raw token in a config is rejected, never stored.
 */

import { missionControlDb } from '@/modules/mission-control/index.js';
import { secretsService } from '@/modules/secrets/index.js';
import { AppError } from '@/shared/utils.js';
import type { BotChannel, BotChannelPolicy } from '@/modules/bots/bots.types.js';
import { CHANNEL_KINDS, getChannelAdapter } from '@/modules/bots/channels/adapters/index.js';
import type { AdapterContext, FetchLike } from '@/modules/bots/channels/adapters/types.js';
import { botChannelsDb } from '@/modules/bots/channels/bot-channels.repository.js';

export type ChannelPolicy = BotChannelPolicy & { brief_at?: string; brief_tz?: string };

const HH_MM = /^([01]\d|2[0-3]):[0-5]\d$/;
const POLICY_KEYS = ['quiet_hours', 'max_pings_per_day', 'min_urgency', 'digest', 'brief_at', 'brief_tz'];

const invalid = (message: string): AppError => new AppError(message, { code: 'BOT_CHANNEL_INVALID', statusCode: 400 });

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function validatePolicy(policy: unknown): ChannelPolicy {
  if (policy === undefined || policy === null) return {};
  if (typeof policy !== 'object' || Array.isArray(policy)) throw invalid('policy must be an object');
  const p = policy as Record<string, unknown>;
  const unknown = Object.keys(p).filter((key) => !POLICY_KEYS.includes(key));
  if (unknown.length) throw invalid(`unknown policy key(s): ${unknown.join(', ')}`);
  const out: ChannelPolicy = {};
  if (p.quiet_hours !== undefined) {
    const q = p.quiet_hours as Record<string, unknown> | null;
    if (!q || typeof q !== 'object' || typeof q.start !== 'string' || typeof q.end !== 'string' || !HH_MM.test(q.start) || !HH_MM.test(q.end)) {
      throw invalid('quiet_hours needs start and end as HH:MM');
    }
    if (q.tz !== undefined && (typeof q.tz !== 'string' || !isValidTimeZone(q.tz))) throw invalid('quiet_hours.tz is not a valid IANA time zone');
    out.quiet_hours = { start: q.start, end: q.end, ...(q.tz ? { tz: String(q.tz) } : {}) };
  }
  if (p.max_pings_per_day !== undefined) {
    const n = Number(p.max_pings_per_day);
    if (!Number.isInteger(n) || n < 0) throw invalid('max_pings_per_day must be a non-negative integer');
    out.max_pings_per_day = n;
  }
  if (p.min_urgency !== undefined) {
    const n = Number(p.min_urgency);
    if (!Number.isFinite(n) || n < 0 || n > 1) throw invalid('min_urgency must be between 0 and 1');
    out.min_urgency = n;
  }
  if (p.digest !== undefined) {
    if (typeof p.digest !== 'boolean') throw invalid('digest must be a boolean');
    out.digest = p.digest;
  }
  if (p.brief_at !== undefined) {
    if (typeof p.brief_at !== 'string' || !HH_MM.test(p.brief_at)) throw invalid('brief_at must be HH:MM');
    out.brief_at = p.brief_at;
  }
  if (p.brief_tz !== undefined) {
    if (typeof p.brief_tz !== 'string' || !isValidTimeZone(p.brief_tz)) throw invalid('brief_tz is not a valid IANA time zone');
    out.brief_tz = p.brief_tz;
  }
  return out;
}

// ---- adapter context (injectable fetch) ---------------------------------------

let fetchImpl: FetchLike | null = null;

/** Tests inject a fake fetch; null restores the global fetch. */
export function setChannelsFetch(fn: FetchLike | null): void {
  fetchImpl = fn;
}

export function getAdapterContext(): AdapterContext {
  return {
    fetch: fetchImpl ?? ((input, init) => fetch(input, init as RequestInit) as ReturnType<FetchLike>),
    resolveSecret: (ref) => secretsService.resolve(ref),
  };
}

// ---- service -----------------------------------------------------------------

type ChangeListener = () => void;
const changeListeners = new Set<ChangeListener>();

/** Called after any create/update/delete (the brief scheduler re-reads its policy). */
export function onChannelsChanged(listener: ChangeListener): () => void {
  changeListeners.add(listener);
  return () => changeListeners.delete(listener);
}

function emitChanged(): void {
  for (const listener of [...changeListeners]) {
    try {
      listener();
    } catch (error) {
      console.warn('[BotChannels] change listener failed', error instanceof Error ? error.message : error);
    }
  }
}

function validateConfig(kind: string, config: unknown): Record<string, unknown> {
  if (!(CHANNEL_KINDS as readonly string[]).includes(kind)) {
    throw invalid(`Unknown channel kind "${kind}". Use one of: ${CHANNEL_KINDS.join(', ')}`);
  }
  if (config !== undefined && (config === null || typeof config !== 'object' || Array.isArray(config))) {
    throw invalid('config must be an object');
  }
  const value = (config ?? {}) as Record<string, unknown>;
  const error = getChannelAdapter(kind)!.validateConfig(value);
  if (error) throw invalid(error);
  return value;
}

function requireBot(botId: string): void {
  if (!missionControlDb.getSection(botId)) {
    throw new AppError(`Bot not found: ${botId}`, { code: 'BOT_NOT_FOUND', statusCode: 404 });
  }
}

export interface CreateChannelInput {
  botId?: string | null;
  kind: string;
  config?: unknown;
  policy?: unknown;
  enabled?: boolean;
}

export const channelsService = {
  get: (channelId: string): BotChannel | null => botChannelsDb.get(channelId),

  /** `botId: null` lists the global defaults; a bot id lists only that bot's overrides. */
  list: (botId: string | null): BotChannel[] => botChannelsDb.list(botId),

  listEffective: (botId: string): BotChannel[] => botChannelsDb.listEffective(botId),

  create(input: CreateChannelInput): BotChannel {
    const botId = input.botId ?? null;
    if (botId) requireBot(botId);
    const config = validateConfig(input.kind, input.config);
    const policy = validatePolicy(input.policy);
    const channel = botChannelsDb.upsert({ botId, kind: input.kind, config, policy, enabled: input.enabled });
    emitChanged();
    return channel;
  },

  update(channelId: string, patch: { config?: unknown; policy?: unknown; enabled?: boolean }): BotChannel {
    const existing = botChannelsDb.get(channelId);
    if (!existing) throw new AppError(`Channel not found: ${channelId}`, { code: 'BOT_CHANNEL_NOT_FOUND', statusCode: 404 });
    const config = patch.config !== undefined ? validateConfig(existing.kind, patch.config) : existing.config;
    const policy = patch.policy !== undefined ? validatePolicy(patch.policy) : existing.policy;
    const channel = botChannelsDb.upsert({ channelId, kind: existing.kind, config, policy, enabled: patch.enabled });
    emitChanged();
    return channel;
  },

  /** Internal: persist a cursor (e.g. the Telegram offset) without re-validating or notifying. */
  setConfigValue(channelId: string, key: string, value: unknown): void {
    const existing = botChannelsDb.get(channelId);
    if (!existing) return;
    botChannelsDb.upsert({ channelId, kind: existing.kind, config: { ...existing.config, [key]: value } });
  },

  remove(channelId: string): boolean {
    const removed = botChannelsDb.delete(channelId);
    if (removed) emitChanged();
    return removed;
  },
};
