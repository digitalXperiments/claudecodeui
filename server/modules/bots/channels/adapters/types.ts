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
  /** A signed action link. Only a public https base URL makes it a usable button; see `isPublicHttpsUrl`. */
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

/** Appended to a message that went out without approval buttons. */
export const OPEN_CLOUDCLI_LINE = 'Open CloudCLI to approve';

const PRIVATE_HOST = /^(?:localhost|.*\.localhost|.*\.local|.*\.internal|.*\.lan|0\.0\.0\.0|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+|169\.254\.\d+\.\d+|\[?(?:::1?|fe80:[^\]]*|f[cd][0-9a-f]{2}:[^\]]*)\]?)$/i;

/** True for an https URL a phone can reach: not localhost, loopback, a private range or a `.local` name. */
export function isPublicHttpsUrl(value: unknown): boolean {
  try {
    const url = new URL(String(value));
    if (url.protocol !== 'https:') return false;
    const host = url.hostname.toLowerCase();
    if (!host || PRIVATE_HOST.test(host)) return false;
    // A bare single-label host (`cloudcli`) only resolves on a LAN.
    return host.includes('.') || host.includes(':');
  } catch {
    return false;
  }
}

/** True for a URL that points at this machine or a private network (any scheme). */
export function isLocalUrl(value: unknown): boolean {
  try {
    const host = new URL(String(value)).hostname.toLowerCase();
    return !host || PRIVATE_HOST.test(host) || !(host.includes('.') || host.includes(':'));
  } catch {
    return true;
  }
}

export const truncate = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
