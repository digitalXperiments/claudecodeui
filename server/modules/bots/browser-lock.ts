/**
 * In-memory registry of bots whose browser profile is held by the operator ("sign in as this bot",
 * teach mode on the bot profile). Chromium locks a profile directory, so while a hold exists the
 * bot must not run an episode that would open its browser; the kernel defers the wake
 * (`browser_in_use`) and retries after release.
 *
 * A hold goes through two states. `starting` is a provisional hold placed synchronously BEFORE the
 * episode lease is checked and before the browser is opened, so a wake that races the sign-in sees
 * one side or the other (see `beginProvisionalBrowserHold`). `open` is the live session.
 *
 * Dependency-free on purpose: the kernel and the exec routes both import it.
 */

/** A forgotten sign-in window must not block the bot forever. */
export const DEFAULT_BROWSER_HOLD_MAX_MS = 30 * 60_000;
/** One "I need more time" click. */
export const DEFAULT_BROWSER_HOLD_EXTEND_MS = 30 * 60_000;
/** A sign-in window never stays open longer than this in total, however often it is extended. */
export const DEFAULT_BROWSER_HOLD_TOTAL_MAX_MS = 2 * 60 * 60_000;
/** A provisional (`starting`) hold that never got promoted lapses after this long. */
const PROVISIONAL_TTL_MS = 2 * 60_000;

export type BrowserHoldKind = 'sign_in' | 'teach';
export type BrowserHoldState = 'starting' | 'open';

export interface BrowserHold {
  botId: string;
  sessionId: string;
  startedAt: string;
  /** Epoch ms after which the hold lapses. */
  expiresAt: number;
  /** Epoch ms ceiling for extensions (defaults to `expiresAt`: not extendable). */
  maxExpiresAt?: number;
  /** Default `sign_in`. */
  kind?: BrowserHoldKind;
  /** Default `open`. */
  state?: BrowserHoldState;
  /** Asked before the hold is honoured; false drops it (the session was closed behind our back). */
  isAlive?: () => Promise<boolean>;
  /** Called once when the hold lapses by timeout, to close the session (cleanly, so cookies flush). */
  onExpire?: () => Promise<void>;
}

const holds = new Map<string, BrowserHold>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const expired = new Map<string, { sessionId: string; expiredAt: string; kind: BrowserHoldKind }>();
const listeners = new Set<(botId: string) => void>();

const kindOf = (hold: BrowserHold): BrowserHoldKind => hold.kind ?? 'sign_in';
const stateOf = (hold: BrowserHold): BrowserHoldState => hold.state ?? 'open';

function clearTimer(botId: string): void {
  const timer = timers.get(botId);
  if (timer) clearTimeout(timer);
  timers.delete(botId);
}

/** Closes the session when the hold lapses even if nobody asks about the bot. */
function armTimer(hold: BrowserHold): void {
  clearTimer(hold.botId);
  const timer = setTimeout(() => {
    timers.delete(hold.botId);
    void expireHold(hold);
  }, Math.max(0, hold.expiresAt - Date.now()) + 5);
  timer.unref?.();
  timers.set(hold.botId, timer);
}

/** Drop `hold` if it has lapsed and close its session. Safe to call twice. */
async function expireHold(hold: BrowserHold): Promise<boolean> {
  if (holds.get(hold.botId) !== hold) return false;
  if (Date.now() < hold.expiresAt) {
    armTimer(hold);
    return false;
  }
  holds.delete(hold.botId);
  clearTimer(hold.botId);
  if (stateOf(hold) === 'open' && hold.sessionId) {
    expired.set(hold.botId, { sessionId: hold.sessionId, expiredAt: new Date().toISOString(), kind: kindOf(hold) });
  }
  await hold.onExpire?.().catch(() => undefined);
  return true;
}

export function holdBotBrowser(hold: BrowserHold): void {
  holds.set(hold.botId, hold);
  if (stateOf(hold) === 'open') expired.delete(hold.botId);
  armTimer(hold);
}

export function getBotBrowserHold(botId: string): BrowserHold | null {
  return holds.get(botId) ?? null;
}

/** Synchronous: is any hold (provisional or open) registered? Does not expire or probe anything. */
export function isBotBrowserHeld(botId: string): boolean {
  return holds.has(botId);
}

/** The last sign-in window that was closed for running out of time, until a new one opens. */
export function getBotBrowserExpiry(botId: string): { sessionId: string; expiredAt: string; kind: BrowserHoldKind } | null {
  return expired.get(botId) ?? null;
}

/** Drop the hold and tell listeners (the kernel re-wakes the bot). Returns false when there was none. */
export function releaseBotBrowser(botId: string): boolean {
  const had = holds.delete(botId);
  clearTimer(botId);
  if (had) {
    for (const listener of [...listeners]) {
      try {
        listener(botId);
      } catch (error) {
        console.warn('[bots] browser release listener failed', error instanceof Error ? error.message : String(error));
      }
    }
  }
  return had;
}

/** Release `hold` only if it is still the registered one (a later hold is left alone). */
export function releaseBotBrowserHold(hold: BrowserHold): boolean {
  return holds.get(hold.botId) === hold ? releaseBotBrowser(hold.botId) : false;
}

export type ProvisionalHoldResult =
  | { ok: true; hold: BrowserHold }
  | { ok: false; reason: 'held' | 'episode' };

/**
 * Place a `starting` hold, THEN check the episode lease, all in one synchronous block.
 *
 * The kernel does the mirror image (acquire the lease, then look for a hold, also synchronously).
 * Whichever side goes first, the other sees it, so a sign-in and an episode can never both believe
 * they own the profile. `leaseActive` must be a synchronous read.
 */
export function beginProvisionalBrowserHold(options: {
  botId: string;
  kind: BrowserHoldKind;
  leaseActive: () => boolean;
}): ProvisionalHoldResult {
  const { botId, kind } = options;
  if (holds.has(botId)) return { ok: false, reason: 'held' };
  const hold: BrowserHold = {
    botId,
    sessionId: '',
    startedAt: new Date().toISOString(),
    expiresAt: Date.now() + PROVISIONAL_TTL_MS,
    kind,
    state: 'starting',
  };
  holdBotBrowser(hold);
  let leased = false;
  try {
    leased = options.leaseActive();
  } catch {
    leased = true; // cannot tell: assume an episode may be running
  }
  if (leased) {
    holds.delete(botId);
    clearTimer(botId);
    return { ok: false, reason: 'episode' };
  }
  return { ok: true, hold };
}

/** Swap a still-registered provisional hold for the live one. False when it was dropped meanwhile. */
export function promoteBrowserHold(provisional: BrowserHold, open: BrowserHold): boolean {
  if (holds.get(provisional.botId) !== provisional) return false;
  holdBotBrowser({ ...open, state: 'open' });
  return true;
}

export type ExtendResult =
  | { ok: true; expiresAt: number; atLimit: boolean }
  | { ok: false; reason: 'not_active' | 'limit' };

/** Push the hold's expiry out by `extendMs`, never past its `maxExpiresAt`. */
export function extendBotBrowserHold(botId: string, sessionId: string, extendMs: number): ExtendResult {
  const hold = holds.get(botId);
  if (!hold || stateOf(hold) !== 'open' || hold.sessionId !== sessionId || Date.now() >= hold.expiresAt) {
    return { ok: false, reason: 'not_active' };
  }
  const ceiling = Math.max(hold.maxExpiresAt ?? hold.expiresAt, hold.expiresAt);
  if (hold.expiresAt >= ceiling) return { ok: false, reason: 'limit' };
  hold.expiresAt = Math.min(hold.expiresAt + extendMs, ceiling);
  armTimer(hold);
  return { ok: true, expiresAt: hold.expiresAt, atLimit: hold.expiresAt >= ceiling };
}

/** True while a hold is registered. Lapsed or dead holds are dropped (and closed) on the way. */
export async function isBotBrowserInUse(botId: string): Promise<boolean> {
  const hold = holds.get(botId);
  if (!hold) return false;
  if (Date.now() >= hold.expiresAt) {
    await expireHold(hold);
    return holds.has(botId);
  }
  if (hold.isAlive) {
    let alive = true;
    try {
      alive = await hold.isAlive();
    } catch {
      alive = true; // cannot tell: keep the hold, a stuck profile is worse than a short delay
    }
    if (!alive && holds.get(botId) === hold) {
      holds.delete(botId);
      clearTimer(botId);
      return false;
    }
  }
  return holds.has(botId);
}

/** Listener called after a hold is released (not on expiry). Returns the unsubscribe function. */
export function onBotBrowserReleased(listener: (botId: string) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function resetBrowserLocksForTests(): void {
  holds.clear();
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
  expired.clear();
  listeners.clear();
}
