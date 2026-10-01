/**
 * Signed action links: a capability URL that resolves one action on one interrupt.
 *
 * token = base64url(JSON{ i: interruptId, a: actionKey, e: expiresAtMs }) "." base64url(HMAC-SHA256)
 *
 * The HMAC key is random, generated once and kept in app_config ('bots.action_link_key'). Links are
 * single-use in effect: acting resolves the interrupt, and verification rejects any token whose
 * interrupt is no longer pending.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { appConfigDb } from '@/modules/database/index.js';
import { interruptsService, type Interrupt } from '@/modules/interrupt-queue/index.js';
import { isLocalUrl } from '@/modules/bots/channels/adapters/types.js';

export const ACTION_LINK_KEY_CONFIG = 'bots.action_link_key';
export const PUBLIC_BASE_URL_CONFIG = 'bots.public_base_url';
export const DEFAULT_ACTION_LINK_TTL_MS = 24 * 60 * 60 * 1000;
export const ACTION_LINK_PATH = '/api/bot-actions';

export interface ActionLinkPayload {
  interruptId: string;
  actionKey: string;
  /** Expiry, epoch milliseconds. */
  exp: number;
}

export type ActionLinkVerdict =
  | { ok: true; payload: ActionLinkPayload; interrupt: Interrupt }
  | { ok: false; reason: 'malformed' | 'bad_signature' | 'expired' | 'used' | 'unknown_action' | 'missing' };

const b64 = (buffer: Buffer): string => buffer.toString('base64url');

function linkKey(): Buffer {
  const existing = appConfigDb.get(ACTION_LINK_KEY_CONFIG);
  if (existing) return Buffer.from(existing, 'hex');
  const generated = randomBytes(32).toString('hex');
  appConfigDb.set(ACTION_LINK_KEY_CONFIG, generated);
  // Another process may have won the race: prefer whatever is persisted.
  return Buffer.from(appConfigDb.get(ACTION_LINK_KEY_CONFIG) ?? generated, 'hex');
}

const sign = (body: string): Buffer => createHmac('sha256', linkKey()).update(body).digest();

export function createActionToken(
  interruptId: string,
  actionKey: string,
  options: { ttlMs?: number; now?: number } = {},
): string {
  const payload = { i: interruptId, a: actionKey, e: (options.now ?? Date.now()) + (options.ttlMs ?? DEFAULT_ACTION_LINK_TTL_MS) };
  const body = b64(Buffer.from(JSON.stringify(payload), 'utf8'));
  return `${body}.${b64(sign(body))}`;
}

/** Signature and expiry only; does not look at the interrupt. */
export function decodeActionToken(
  token: string,
  now = Date.now(),
): { ok: true; payload: ActionLinkPayload } | { ok: false; reason: 'malformed' | 'bad_signature' | 'expired' } {
  const parts = typeof token === 'string' ? token.split('.') : [];
  if (parts.length !== 2 || !parts[0] || !parts[1] || token.length > 2_000) return { ok: false, reason: 'malformed' };
  const [body, signature] = parts;
  const supplied = Buffer.from(signature, 'base64url');
  const expected = sign(body);
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return { ok: false, reason: 'bad_signature' };
  let parsed: { i?: unknown; a?: unknown; e?: unknown };
  try {
    parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (typeof parsed.i !== 'string' || typeof parsed.a !== 'string' || typeof parsed.e !== 'number') {
    return { ok: false, reason: 'malformed' };
  }
  if (parsed.e <= now) return { ok: false, reason: 'expired' };
  return { ok: true, payload: { interruptId: parsed.i, actionKey: parsed.a, exp: parsed.e } };
}

/** Full check: signature, expiry, interrupt still pending, and the action is one the interrupt offers. */
export function verifyActionToken(token: string, now = Date.now()): ActionLinkVerdict {
  const decoded = decodeActionToken(token, now);
  if (!decoded.ok) return decoded;
  const interrupt = interruptsService.get(decoded.payload.interruptId);
  if (!interrupt) return { ok: false, reason: 'missing' };
  if (interrupt.status !== 'open' && interrupt.status !== 'snoozed') return { ok: false, reason: 'used' };
  if (interrupt.expires_at && Date.parse(interrupt.expires_at) <= now) return { ok: false, reason: 'expired' };
  if (!interrupt.actions.some((action) => action.id === decoded.payload.actionKey)) {
    return { ok: false, reason: 'unknown_action' };
  }
  return { ok: true, payload: decoded.payload, interrupt };
}

/** Public base URL for links: explicit override, app config, env, else the local server. */
export function resolveActionBaseUrl(override?: unknown): string {
  const candidate =
    (typeof override === 'string' && override.trim())
    || appConfigDb.get(PUBLIC_BASE_URL_CONFIG)
    || process.env.CLOUDCLI_PUBLIC_URL
    || `http://localhost:${process.env.SERVER_PORT || process.env.PORT || 3001}`;
  return String(candidate).replace(/\/+$/, '');
}

export type PublicBaseUrlSource = 'override' | 'app_config' | 'env' | 'default';

export interface PublicBaseUrlInfo {
  value: string;
  /** Where the value came from: a channel override, app_config 'bots.public_base_url', CLOUDCLI_PUBLIC_URL, or the local default. */
  source: PublicBaseUrlSource;
  /** Localhost or a private address: approval links will not open from a phone. */
  is_local: boolean;
}

/** The base URL approval links use, where it came from, and whether it is only reachable on this machine. */
export function describeActionBaseUrl(override?: unknown): PublicBaseUrlInfo {
  const fromOverride = typeof override === 'string' && override.trim() ? override.trim() : '';
  const fromConfig = appConfigDb.get(PUBLIC_BASE_URL_CONFIG)?.trim() ?? '';
  const fromEnv = process.env.CLOUDCLI_PUBLIC_URL?.trim() ?? '';
  const source: PublicBaseUrlSource = fromOverride ? 'override' : fromConfig ? 'app_config' : fromEnv ? 'env' : 'default';
  const value = resolveActionBaseUrl(override);
  return { value, source, is_local: isLocalUrl(value) };
}

export function buildActionUrl(token: string, baseUrl?: unknown): string {
  return `${resolveActionBaseUrl(baseUrl)}${ACTION_LINK_PATH}/${token}`;
}

export const signedActionLinks = {
  create(interruptId: string, actionKey: string, ttlMs?: number, baseUrl?: unknown): string {
    return buildActionUrl(createActionToken(interruptId, actionKey, { ttlMs }), baseUrl);
  },
  verify: verifyActionToken,
};
