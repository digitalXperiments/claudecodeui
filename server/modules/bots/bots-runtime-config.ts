import { getConnection } from '@/modules/database/index.js';
import { parseJsonObject } from '@/modules/bots/bots.util.js';

export interface BotPhaseRoute {
  provider: string;
  model?: string;
  effort?: string;
}

export interface BotRuntimeConfig {
  identity?: { persona?: string; avatar?: string };
  routing?: { perceive?: BotPhaseRoute; act?: BotPhaseRoute; reflect?: BotPhaseRoute };
  backend?: 'local' | 'docker' | 'ssh';
  backend_config?: Record<string, unknown>;
  /** Route tool calls through the bot tool gateway (default true when the runtime flag is on). */
  gateway?: boolean;
  enforcement?: 'enforced' | 'advisory';
  /** Learning loop settings. Only memory proposals can ever auto-promote. */
  learning?: { auto_promote_memory_min_confidence?: number };
}

const BACKENDS = new Set(['local', 'docker', 'ssh']);
const ENFORCEMENT = new Set(['enforced', 'advisory']);
const PHASES = ['perceive', 'act', 'reflect'] as const;

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeRoute(value: unknown): BotPhaseRoute | undefined {
  if (!isObject(value)) return undefined;
  const provider = asString(value.provider);
  if (!provider) return undefined;
  const route: BotPhaseRoute = { provider };
  const model = asString(value.model);
  const effort = asString(value.effort);
  if (model) route.model = model;
  if (effort) route.effort = effort;
  return route;
}

/** Validate/clean untrusted runtime config: unknown keys and malformed values are dropped. */
export function normalizeBotRuntimeConfig(raw: unknown): BotRuntimeConfig {
  const source = isObject(raw) ? raw : {};
  const config: BotRuntimeConfig = {};
  if (isObject(source.identity)) {
    const identity: NonNullable<BotRuntimeConfig['identity']> = {};
    const persona = typeof source.identity.persona === 'string' ? source.identity.persona : undefined;
    const avatar = asString(source.identity.avatar);
    if (persona !== undefined) identity.persona = persona;
    if (avatar) identity.avatar = avatar;
    config.identity = identity;
  }
  if (isObject(source.routing)) {
    const routing: NonNullable<BotRuntimeConfig['routing']> = {};
    for (const phase of PHASES) {
      const route = normalizeRoute(source.routing[phase]);
      if (route) routing[phase] = route;
    }
    config.routing = routing;
  }
  if (typeof source.backend === 'string' && BACKENDS.has(source.backend)) {
    config.backend = source.backend as BotRuntimeConfig['backend'];
  }
  if (isObject(source.backend_config)) config.backend_config = source.backend_config;
  if (typeof source.gateway === 'boolean') config.gateway = source.gateway;
  if (typeof source.enforcement === 'string' && ENFORCEMENT.has(source.enforcement)) {
    config.enforcement = source.enforcement as BotRuntimeConfig['enforcement'];
  }
  if (isObject(source.learning)) {
    const learning: NonNullable<BotRuntimeConfig['learning']> = {};
    const min = source.learning.auto_promote_memory_min_confidence;
    if (typeof min === 'number' && Number.isFinite(min) && min >= 0 && min <= 1) learning.auto_promote_memory_min_confidence = min;
    config.learning = learning;
  }
  return config;
}

export function readBotRuntimeConfig(botId: string): BotRuntimeConfig | null {
  const row = getConnection().prepare('SELECT runtime_json FROM mc_sections WHERE section_id = ?').get(botId) as
    | { runtime_json: string | null }
    | undefined;
  if (!row) return null;
  return normalizeBotRuntimeConfig(parseJsonObject(row.runtime_json));
}

/**
 * Shallow-merge `patch` over the stored config (top-level keys replace; a key set to
 * `null` is removed). Returns the stored config, or null when the bot does not exist.
 */
export function patchBotRuntimeConfig(
  botId: string,
  patch: { [K in keyof BotRuntimeConfig]?: BotRuntimeConfig[K] | null },
): BotRuntimeConfig | null {
  const current = readBotRuntimeConfig(botId);
  if (!current) return null;
  const merged: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete merged[key];
    else if (value !== undefined) merged[key] = value;
  }
  const next = normalizeBotRuntimeConfig(merged);
  getConnection().prepare('UPDATE mc_sections SET runtime_json = ? WHERE section_id = ?').run(JSON.stringify(next), botId);
  return next;
}
