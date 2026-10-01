/**
 * Short ids for Telegram inline `callback_data` buttons.
 *
 * Telegram limits callback_data to 64 bytes and rejects URL buttons that point at localhost, so a
 * button carries `a:<shortid>` and the server maps it back to { interruptId, actionKey }. The map
 * lives in app_config (`bots.telegram_callbacks`) so a pending approval still works after a server
 * restart; entries expire with the approval (or after a day) and are pruned on every write.
 */

import { randomBytes } from 'node:crypto';

import { appConfigDb } from '@/modules/database/index.js';

export const CALLBACK_IDS_CONFIG = 'bots.telegram_callbacks';
export const CALLBACK_PREFIX = 'a:';
export const DEFAULT_CALLBACK_TTL_MS = 24 * 60 * 60 * 1000;
/** Most entries kept at once; the oldest go first. */
const MAX_ENTRIES = 400;

interface Entry {
  i: string;
  a: string;
  /** Expiry, epoch milliseconds. */
  e: number;
}

type Store = Record<string, Entry>;

function load(): Store {
  try {
    const raw = appConfigDb.get(CALLBACK_IDS_CONFIG);
    const parsed = raw ? (JSON.parse(raw) as unknown) : {};
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Store) : {};
  } catch {
    return {};
  }
}

function save(store: Store, now: number): void {
  const live = Object.entries(store).filter(([, entry]) => entry && typeof entry.e === 'number' && entry.e > now);
  live.sort((a, b) => a[1].e - b[1].e);
  appConfigDb.set(CALLBACK_IDS_CONFIG, JSON.stringify(Object.fromEntries(live.slice(-MAX_ENTRIES))));
}

/** A new callback_data (`a:<shortid>`, well under 64 bytes) for one action on one interrupt. */
export function createCallbackData(interruptId: string, actionKey: string, options: { ttlMs?: number; now?: number } = {}): string {
  const now = options.now ?? Date.now();
  const store = load();
  let id = randomBytes(6).toString('base64url');
  while (store[id]) id = randomBytes(6).toString('base64url');
  store[id] = { i: interruptId, a: actionKey, e: now + (options.ttlMs ?? DEFAULT_CALLBACK_TTL_MS) };
  save(store, now);
  return `${CALLBACK_PREFIX}${id}`;
}

/** The interrupt action a callback_data stands for, or null when it is malformed, unknown or expired. */
export function resolveCallbackData(data: unknown, now = Date.now()): { interruptId: string; actionKey: string } | null {
  if (typeof data !== 'string' || !data.startsWith(CALLBACK_PREFIX) || data.length > 64) return null;
  const entry = load()[data.slice(CALLBACK_PREFIX.length)];
  if (!entry || typeof entry.i !== 'string' || typeof entry.a !== 'string' || typeof entry.e !== 'number' || entry.e <= now) return null;
  return { interruptId: entry.i, actionKey: entry.a };
}
