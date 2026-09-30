import type { BotChannel } from '@/modules/bots/bots.types.js';

export type FetchLike = (input: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
}>;

export interface OutboundAction {
  key: string;
  label: string;
  style?: 'primary' | 'secondary' | 'destructive';
  /** A signed action link (no public inbound URL is assumed, so buttons are plain URLs). */
  url: string;
}

export interface OutboundMessage {
  botId: string | null;
  botTitle: string;
  title: string;
  body: string;
  urgency: number;
  actions: OutboundAction[];
  href?: string;
  interruptId?: string;
}

export interface AdapterContext {
  fetch: FetchLike;
  /** Resolve a `${secret:NAME}` reference to plaintext. Only called at send time. */
  resolveSecret: (ref: string) => string;
}

export interface SendResult {
  ok: boolean;
  detail?: string;
}

export interface ChannelAdapter {
  kind: string;
  /** Returns an error message for an invalid config, null when valid. */
  validateConfig: (config: Record<string, unknown>) => string | null;
  send: (channel: Pick<BotChannel, 'config' | 'bot_id'>, message: OutboundMessage, ctx: AdapterContext) => Promise<SendResult>;
}

export const SECRET_REF = /^\$\{secret:[A-Za-z0-9_.:-]+\}$/;

export function checkKeys(config: Record<string, unknown>, allowed: readonly string[]): string | null {
  const unknown = Object.keys(config).filter((key) => !allowed.includes(key));
  return unknown.length ? `unknown config key(s): ${unknown.join(', ')}` : null;
}

export function checkSecretRef(config: Record<string, unknown>, key: string, required: boolean): string | null {
  const value = config[key];
  if (value === undefined || value === null || value === '') return required ? `${key} is required` : null;
  if (typeof value !== 'string' || !SECRET_REF.test(value)) {
    return `${key} must be a secret reference like \${secret:NAME}; raw tokens are never stored`;
  }
  return null;
}

export function checkBaseUrl(config: Record<string, unknown>): string | null {
  const value = config.action_base_url;
  if (value === undefined || value === null || value === '') return null;
  try {
    const url = new URL(String(value));
    return url.protocol === 'http:' || url.protocol === 'https:' ? null : 'action_base_url must be http(s)';
  } catch {
    return 'action_base_url must be a valid URL';
  }
}

export const truncate = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
