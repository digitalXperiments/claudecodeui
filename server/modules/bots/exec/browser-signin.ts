/**
 * "Sign in as this bot": the operator logs in to sites by hand on the bot's own persistent browser
 * profile (`<botHome>/browser-profile`), so later runs are already signed in. Also the profile
 * status and the "sign the bot out everywhere" delete.
 *
 * start: opens a cloudcli-browser session on the bot's profile, navigates to the URL and hands the
 * operator the controls (they drive it from the Browser panel). While it is open the kernel defers
 * the bot's wakes (browser-lock.ts: Chromium locks the profile directory).
 * finish: closes the session cleanly so cookies are flushed, then releases the bot to run again.
 */
import fs from 'node:fs';
import path from 'node:path';

import { browserUseService } from '@/modules/browser-use/index.js';
import { missionControlDb } from '@/modules/mission-control/index.js';
import { AppError } from '@/shared/utils.js';

import { BOT_BROWSER_PROFILE_DIRNAME, resolveBotHome } from '../bots-home.js';
import {
  DEFAULT_BROWSER_HOLD_EXTEND_MS,
  DEFAULT_BROWSER_HOLD_MAX_MS,
  DEFAULT_BROWSER_HOLD_TOTAL_MAX_MS,
  beginProvisionalBrowserHold,
  extendBotBrowserHold,
  getBotBrowserExpiry,
  getBotBrowserHold,
  isBotBrowserInUse,
  promoteBrowserHold,
  releaseBotBrowser,
  releaseBotBrowserHold,
  type BrowserHold,
} from '../browser-lock.js';
import { botLeasesDb } from '../kernel/bot-leases.repository.js';

import { activeTeachSession } from './teach.js';

/** The slice of browser-use sign-in needs (a fake in tests). */
export interface SignInBrowser {
  createAgentSession(options: { profileDir?: string | null; recordNetwork?: boolean }): Promise<{ id: string; status: string; message: string | null }>;
  agentNavigate(sessionId: string, url: string): Promise<unknown>;
  takeHumanControl(sessionId: string): Promise<unknown>;
  returnAgentControl(sessionId: string): Promise<unknown>;
  stopSession(sessionId: string): Promise<unknown>;
  listAgentSessions(): Promise<Array<{ id: string; status: string }>>;
  describeAgentSession(sessionId: string): Promise<{ profileDir: string | null; controller: 'agent' | 'human' }>;
}

export interface SignInDeps {
  browser: SignInBrowser;
  /** Longest a sign-in window may stay open before the bot is released. */
  holdMaxMs: number;
  /** What one "I need more time" adds. */
  extendMs: number;
  /** Ceiling for the whole window, extensions included. */
  totalMaxMs: number;
}

const defaultDeps = (): SignInDeps => ({
  browser: browserUseService as unknown as SignInBrowser,
  holdMaxMs: DEFAULT_BROWSER_HOLD_MAX_MS,
  extendMs: DEFAULT_BROWSER_HOLD_EXTEND_MS,
  totalMaxMs: DEFAULT_BROWSER_HOLD_TOTAL_MAX_MS,
});

let deps: SignInDeps | null = null;

/** Tests inject a fake browser; null restores the real one. */
export function setSignInDeps(next: Partial<SignInDeps> | null): void {
  deps = next ? { ...defaultDeps(), ...next } : null;
}

const signInError = (message: string, statusCode: number, code: string): AppError => new AppError(message, { code, statusCode });

function requireBot(botId: string): void {
  if (!missionControlDb.getSection(botId)) throw signInError('Bot not found', 404, 'BOT_NOT_FOUND');
}

function httpUrl(value: unknown): string {
  if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = new URL(value.trim());
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return parsed.toString();
    } catch {
      // fall through
    }
  }
  throw signInError('url must be an http(s) URL', 400, 'SIGNIN_INVALID_URL');
}

/** `<botHome>/browser-profile` without creating the bot home. */
export function botBrowserProfilePath(botId: string): string {
  return path.join(resolveBotHome(botId, { create: false }), BOT_BROWSER_PROFILE_DIRNAME);
}

/** True when the bot holds a live (unexpired) episode lease: an episode may be using its browser. */
function hasActiveEpisode(botId: string): boolean {
  const lease = botLeasesDb.get(botId);
  return Boolean(lease && Date.parse(lease.expires_at) > Date.now());
}

/** Another browser session (a run, a teach session) already holds this profile directory. */
async function profileHeldBySession(profileDir: string, ignoreSessionId?: string): Promise<boolean> {
  const { browser } = deps ?? defaultDeps();
  let sessions: Array<{ id: string; status: string }> = [];
  try {
    sessions = await browser.listAgentSessions();
  } catch {
    return false; // Browser agent tools disabled: no sessions can hold it.
  }
  for (const session of sessions) {
    if (session.status !== 'ready' || session.id === ignoreSessionId) continue;
    try {
      const info = await browser.describeAgentSession(session.id);
      if (info.profileDir && path.resolve(info.profileDir) === path.resolve(profileDir)) return true;
    } catch {
      // A session we cannot describe is not provably ours; skip it.
    }
  }
  return false;
}

export type BrowserBusyReason = 'sign_in' | 'starting' | 'teach' | 'episode' | 'session';

/** The registered hold (if any, after dropping lapsed or dead ones) as a busy reason. */
async function holdBusyReason(botId: string): Promise<BrowserBusyReason | null> {
  if (!(await isBotBrowserInUse(botId))) return null;
  const hold = getBotBrowserHold(botId);
  if (!hold) return null;
  if (hold.state === 'starting') return 'starting';
  return hold.kind === 'teach' ? 'teach' : 'sign_in';
}

/** Busy reasons that do not involve the hold registry (used while we hold the profile ourselves). */
async function nonHoldBusyReason(botId: string): Promise<BrowserBusyReason | null> {
  if (activeTeachSession(botId)) return 'teach';
  if (hasActiveEpisode(botId)) return 'episode';
  if (await profileHeldBySession(botBrowserProfilePath(botId))) return 'session';
  return null;
}

/** Why the bot's browser profile cannot be used or deleted right now, or null. */
export async function botBrowserBusyReason(botId: string): Promise<BrowserBusyReason | null> {
  return (await holdBusyReason(botId)) ?? (await nonHoldBusyReason(botId));
}

const BUSY_MESSAGES: Record<BrowserBusyReason, string> = {
  sign_in: 'A sign-in window is already open for this bot. Finish it first.',
  starting: 'A sign-in window is opening for this bot. Give it a moment, then finish it.',
  teach: 'A teach session is using this bot\'s browser. Stop it first.',
  episode: 'The bot is running right now. Wait for it to finish, then sign in.',
  session: "Another browser session is using this bot's profile. Close it first.",
};

export interface SignInViewHint {
  /** The Browser panel is the main-content tab with this id. */
  kind: 'browser_panel';
  tab: 'browser';
  session_id: string;
  /** The panel lists sessions from here and shows the new one. */
  sessions_endpoint: string;
  /** The operator drives the page through this (click/type/key/scroll/navigate). */
  control_endpoint: string;
  note: string;
}

export interface SignInStartResult {
  sessionId: string;
  startedAt: string;
  url: string;
  expiresAt: string;
  viewHint: SignInViewHint;
}

export function activeSignIn(botId: string): { sessionId: string; startedAt: string; expiresAt: string } | null {
  const hold = getBotBrowserHold(botId);
  return hold && hold.state !== 'starting' && hold.kind !== 'teach' ? { sessionId: hold.sessionId, startedAt: hold.startedAt, expiresAt: new Date(hold.expiresAt).toISOString() } : null;
}

const starting = new Set<string>();

export async function startSignIn(botId: string, input: { url?: unknown } = {}): Promise<SignInStartResult> {
  requireBot(botId);
  const url = httpUrl(input.url);
  // Two clicks at once must not both open the profile (the busy check below awaits).
  if (starting.has(botId)) throw signInError(BUSY_MESSAGES.sign_in, 409, 'SIGNIN_BROWSER_BUSY');
  starting.add(botId);
  try {
    return await openSignIn(botId, url);
  } finally {
    starting.delete(botId);
  }
}

/** Close the sign-in browser the clean way: hand control back, then stop it so cookies flush to disk. */
async function closeSignInSession(browser: SignInBrowser, sessionId: string): Promise<void> {
  await browser.returnAgentControl(sessionId).catch(() => undefined);
  await browser.stopSession(sessionId);
}

async function openSignIn(botId: string, url: string): Promise<SignInStartResult> {
  const { browser, holdMaxMs, totalMaxMs } = deps ?? defaultDeps();
  const busyError = (reason: BrowserBusyReason): AppError =>
    signInError(BUSY_MESSAGES[reason], 409, reason === 'episode' ? 'SIGNIN_BOT_RUNNING' : 'SIGNIN_BROWSER_BUSY');

  const existing = await holdBusyReason(botId);
  if (existing) throw busyError(existing);

  // Hold the profile FIRST (synchronously, together with the lease check), so a wake that races
  // this sign-in either sees the hold and defers, or already holds the lease and we refuse.
  const provisional = beginProvisionalBrowserHold({ botId, kind: 'sign_in', leaseActive: () => hasActiveEpisode(botId) });
  if (!provisional.ok) throw busyError(provisional.reason === 'episode' ? 'episode' : 'sign_in');
  const placeholder = provisional.hold;
  let promoted = false;
  let sessionId: string | null = null;
  try {
    const busy = await nonHoldBusyReason(botId);
    if (busy) throw busyError(busy);

    const profileDir = path.join(resolveBotHome(botId), BOT_BROWSER_PROFILE_DIRNAME);
    let session: Awaited<ReturnType<SignInBrowser['createAgentSession']>>;
    try {
      session = await browser.createAgentSession({ profileDir, recordNetwork: false });
    } catch (error) {
      // A profile locked by a Chromium we do not track is the usual cause.
      throw signInError(`Could not open the browser: ${error instanceof Error ? error.message : String(error)}`, 409, 'SIGNIN_BROWSER_UNAVAILABLE');
    }
    if (session.status !== 'ready') {
      throw signInError(session.message || 'The browser runtime is not ready.', 503, 'SIGNIN_BROWSER_UNAVAILABLE');
    }
    sessionId = session.id;
    // The lease can only have appeared if our hold was dropped; verify it once more before going live.
    if (hasActiveEpisode(botId)) throw busyError('episode');
    const startedAt = new Date().toISOString();
    const startedMs = Date.now();
    const liveSessionId = session.id;
    const open: BrowserHold = {
      botId,
      sessionId: liveSessionId,
      startedAt,
      expiresAt: startedMs + holdMaxMs,
      maxExpiresAt: Math.max(startedMs + totalMaxMs, startedMs + holdMaxMs),
      kind: 'sign_in',
      isAlive: async () => {
        const sessions = await browser.listAgentSessions();
        return sessions.some((entry) => entry.id === liveSessionId && entry.status === 'ready');
      },
      // Same path as Finish: control back to the agent, then a clean close so cookies are written.
      onExpire: () => closeSignInSession(browser, liveSessionId),
    };
    if (!promoteBrowserHold(placeholder, open)) throw busyError('sign_in');
    promoted = true;
    try {
      await browser.agentNavigate(liveSessionId, url);
      await browser.takeHumanControl(liveSessionId);
    } catch (error) {
      throw signInError(`Could not open ${url}: ${error instanceof Error ? error.message : String(error)}`, 500, 'SIGNIN_START_FAILED');
    }
    return {
      sessionId: liveSessionId,
      startedAt,
      url,
      expiresAt: new Date(open.expiresAt).toISOString(),
      viewHint: {
        kind: 'browser_panel',
        tab: 'browser',
        session_id: liveSessionId,
        sessions_endpoint: '/api/browser-use/sessions',
        control_endpoint: `/api/browser-use/sessions/${liveSessionId}/control`,
        note: 'Open the Browser panel and sign in. Click Finish when you are done so the login is saved; the bot waits until then.',
      },
    };
  } catch (error) {
    if (promoted) releaseBotBrowser(botId);
    else releaseBotBrowserHold(placeholder);
    if (sessionId) await browser.stopSession(sessionId).catch(() => undefined);
    throw error;
  }
}

/** "I need more time": push the sign-in window out (30 minutes at a time, 2 hours in total). */
export async function extendSignIn(botId: string, sessionId: string): Promise<{ extended: true; expiresAt: string; atLimit: boolean }> {
  requireBot(botId);
  const { extendMs } = deps ?? defaultDeps();
  const hold = getBotBrowserHold(botId);
  if (!hold || hold.state === 'starting' || hold.kind === 'teach' || hold.sessionId !== sessionId) {
    throw signInError('No sign-in session is open for this bot', 404, 'SIGNIN_NOT_ACTIVE');
  }
  const result = extendBotBrowserHold(botId, sessionId, extendMs);
  if (!result.ok) {
    if (result.reason === 'limit') {
      throw signInError('This sign-in window is already at its 2 hour limit. Finish, then start again if you need more.', 409, 'SIGNIN_EXTEND_LIMIT');
    }
    throw signInError('No sign-in session is open for this bot', 404, 'SIGNIN_NOT_ACTIVE');
  }
  return { extended: true, expiresAt: new Date(result.expiresAt).toISOString(), atLimit: result.atLimit };
}

export async function finishSignIn(botId: string, sessionId: string): Promise<{ finished: true; warning?: string }> {
  requireBot(botId);
  const hold = getBotBrowserHold(botId);
  if (!hold || hold.state === 'starting' || hold.kind === 'teach' || hold.sessionId !== sessionId) {
    throw signInError('No sign-in session is open for this bot', 404, 'SIGNIN_NOT_ACTIVE');
  }
  const { browser } = deps ?? defaultDeps();
  let warning: string | undefined;
  try {
    // Closing the context is what flushes cookies to disk.
    await closeSignInSession(browser, sessionId);
  } catch (error) {
    warning = `The browser did not close cleanly: ${error instanceof Error ? error.message : String(error)}`;
  }
  releaseBotBrowser(botId);
  return warning ? { finished: true, warning } : { finished: true };
}

// ---- profile status and "sign out everywhere" -------------------------------------------------

const MAX_WALK_ENTRIES = 50_000;

export interface BrowserProfileStatus {
  profile_exists: boolean;
  size_bytes: number;
  /** Newest file modification time inside the profile (the profile's contents are never read). */
  last_used_at: string | null;
  in_use: boolean;
  in_use_by: BrowserBusyReason | null;
  sign_in: { session_id: string; started_at: string; expires_at: string } | null;
  /** The last sign-in window that was closed because it ran out of time (until a new one opens). */
  sign_in_expired: { session_id: string; expired_at: string } | null;
}

function walkProfile(root: string): { size: number; newest: number } {
  let size = 0;
  let newest = 0;
  let seen = 0;
  const stack = [root];
  while (stack.length > 0 && seen < MAX_WALK_ENTRIES) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      seen += 1;
      const full = path.join(dir, entry.name);
      try {
        const stat = fs.lstatSync(full); // never follow links out of the profile
        if (stat.isSymbolicLink()) continue;
        if (stat.isDirectory()) stack.push(full);
        else {
          size += stat.size;
          newest = Math.max(newest, stat.mtimeMs);
        }
      } catch {
        // vanished mid-walk (Chromium churns files)
      }
    }
  }
  return { size, newest };
}

export async function browserProfileStatus(botId: string): Promise<BrowserProfileStatus> {
  requireBot(botId);
  const profile = botBrowserProfilePath(botId);
  const busy = await botBrowserBusyReason(botId);
  const signIn = activeSignIn(botId);
  const expiry = getBotBrowserExpiry(botId);
  const base = {
    in_use: busy !== null,
    in_use_by: busy,
    sign_in: signIn ? { session_id: signIn.sessionId, started_at: signIn.startedAt, expires_at: signIn.expiresAt } : null,
    sign_in_expired: expiry && expiry.kind === 'sign_in' && !signIn ? { session_id: expiry.sessionId, expired_at: expiry.expiredAt } : null,
  };
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(profile);
  } catch {
    return { profile_exists: false, size_bytes: 0, last_used_at: null, ...base };
  }
  if (!stat.isDirectory()) return { profile_exists: false, size_bytes: 0, last_used_at: null, ...base };
  const { size, newest } = walkProfile(profile);
  return {
    profile_exists: true,
    size_bytes: size,
    last_used_at: new Date(newest || stat.mtimeMs).toISOString(),
    ...base,
  };
}

/** Resolve the profile directory and prove it is a real directory inside the bot home. Throws otherwise. */
export function safeProfileDirForDelete(botId: string): string | null {
  const home = resolveBotHome(botId, { create: false });
  const profile = path.join(home, BOT_BROWSER_PROFILE_DIRNAME);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(profile);
  } catch {
    return null;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw signInError('The browser profile is not a plain folder inside the bot home; refusing to delete it.', 400, 'BROWSER_PROFILE_UNSAFE');
  }
  const realHome = fs.realpathSync(home);
  const realProfile = fs.realpathSync(profile);
  const rel = path.relative(realHome, realProfile);
  if (rel !== BOT_BROWSER_PROFILE_DIRNAME) {
    throw signInError('The browser profile resolves outside the bot home; refusing to delete it.', 400, 'BROWSER_PROFILE_UNSAFE');
  }
  return profile;
}

/** "Sign the bot out everywhere": delete the profile. Refused while the browser is in use. */
export async function deleteBrowserProfile(botId: string): Promise<{ deleted: boolean }> {
  requireBot(botId);
  const busy = await botBrowserBusyReason(botId);
  if (busy) throw signInError(`${BUSY_MESSAGES[busy]} Nothing was deleted.`, 409, 'BROWSER_PROFILE_IN_USE');
  const profile = safeProfileDirForDelete(botId);
  if (!profile) return { deleted: false };
  fs.rmSync(profile, { recursive: true, force: true });
  return { deleted: true };
}
