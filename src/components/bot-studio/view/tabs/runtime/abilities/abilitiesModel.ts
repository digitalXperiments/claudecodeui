/**
 * Pure helpers behind the Abilities tab and the wizard's autonomy picker: the plain-language copy for
 * each autonomy level, the lists the server writes, enforcement wording, the typed confirmation for
 * Unrestricted, browser sign-in handling (URL cleanup, 409 wording, where to show the session) and
 * deep-link focus parsing. No React here, so it all runs under `node --test`.
 */

import type {
  BotAbilitiesApp, BotAbilitiesPlain, BotAutonomy, BotBrowserSignIn, BotBrowserStatus, BotBrowserViewHint, BotGateLevel,
} from '../../../../types/botRuntime';

// ---- autonomy ---------------------------------------------------------------------------------

export type AutonomyTone = 'safe' | 'trusted' | 'danger';

export type AutonomyChoice = {
  value: BotAutonomy;
  label: string;
  /** One short line for the card. */
  tagline: string;
  /** The exact meaning, in full sentences. */
  meaning: string;
  tone: AutonomyTone;
};

export const DEFAULT_AUTONOMY: BotAutonomy = 'careful';

export const UNRESTRICTED_CONFIRMATION = 'unrestricted';

export const AUTONOMY_CHOICES: AutonomyChoice[] = [
  {
    value: 'careful',
    label: 'Careful',
    tagline: 'Recommended. Asks before anything risky.',
    meaning: 'Reads, drafts and works in its own folder. Asks you before sending, publishing, deleting, buying or working outside its folder.',
    tone: 'safe',
  },
  {
    value: 'trusted',
    label: 'Trusted',
    tagline: 'Gets things done without waiting for you.',
    meaning: 'Also sends, publishes, deletes and works outside its folder on its own. It still asks right after it has read outside content (emails, web pages), and it never touches your passwords or login files.',
    tone: 'trusted',
  },
  {
    value: 'unrestricted',
    label: 'Unrestricted',
    tagline: 'No gate at all.',
    meaning: 'No gate at all: the AI provider\'s own "bypass" setting applies. Only for bots you fully trust that read nothing from outside.',
    tone: 'danger',
  },
];

export const UNRESTRICTED_WARNING = 'Nothing checks what this bot does. It can send, delete, spend and open any file on this computer without asking. Only choose this for a bot you fully trust that never reads emails, web pages or other outside content, because anything it reads could tell it what to do.';

export function normalizeAutonomy(raw: unknown): BotAutonomy {
  return raw === 'trusted' || raw === 'unrestricted' || raw === 'careful' ? raw : DEFAULT_AUTONOMY;
}

export function autonomyChoice(value: BotAutonomy): AutonomyChoice {
  return AUTONOMY_CHOICES.find((choice) => choice.value === value) ?? AUTONOMY_CHOICES[0];
}

/** Choosing this level needs the word typed out first. */
export const needsTypedConfirmation = (value: BotAutonomy): boolean => value === 'unrestricted';

export const isUnrestrictedConfirmation = (typed: string): boolean => typed.trim().toLowerCase() === UNRESTRICTED_CONFIRMATION;

/** The one-sentence summary shown under the picker in the wizard. */
export function autonomySummary(value: BotAutonomy): string {
  switch (normalizeAutonomy(value)) {
    case 'trusted': return 'This bot can read, draft, send, publish and delete on its own; it will still ask right after it has read outside content such as emails or web pages.';
    case 'unrestricted': return 'Nothing will check this bot. It can do anything the AI provider allows, without asking you.';
    default: return 'This bot can read and draft on its own; it will ask before sending, deleting or buying.';
  }
}

/** A short label for chips and the review step. */
export function autonomyLabel(value: BotAutonomy): string {
  const choice = autonomyChoice(normalizeAutonomy(value));
  return `${choice.label}${choice.value === 'careful' ? ' (asks before risky actions)' : choice.value === 'trusted' ? ' (acts on its own)' : ' (no gate)'}`;
}

// ---- enforcement ------------------------------------------------------------------------------

const providerName = (provider: string): string => (provider ? provider.charAt(0).toUpperCase() + provider.slice(1) : 'This provider');

/** One line, e.g. "Claude is fully controlled by the gate." */
export function enforcementLine(provider: string, level: BotGateLevel | null | undefined): string {
  const name = providerName(provider);
  if (level === 'enforced') return `${name} is fully controlled by the gate.`;
  if (level === 'advisory') return `${name} is only partly controlled by the gate: it can also use its own built-in tools, which the gate cannot see.`;
  if (level === 'off') return 'There is no gate on this bot, so nothing is being checked.';
  return `Checking how firmly the gate controls ${name}…`;
}

/**
 * The raw provider permission mode only matters when nothing else is in charge: Unrestricted (the
 * provider's own setting is the only control) or a provider the gate can only advise. `level` is null
 * while still unknown.
 */
export function showProviderPermissionMode(autonomy: BotAutonomy, level: BotGateLevel | null | undefined): boolean {
  if (autonomy === 'unrestricted') return true;
  return level === 'advisory' || level === 'off';
}

export const PERMISSION_MODE_PLAIN: Record<string, string> = {
  default: 'The provider asks before acting where it can. A bot has nobody to answer, so anything it would ask about simply does not happen.',
  acceptEdits: 'File edits go ahead without asking; other actions are held back.',
  bypassPermissions: 'The provider skips its own questions, so the bot can do everything it is able to.',
  plan: 'Read-only: the bot plans but changes nothing.',
};

export function permissionModeWords(mode: string | null | undefined): string {
  return (mode && PERMISSION_MODE_PLAIN[mode]) || `Set to ${mode || 'default'}.`;
}

/** Why the permission mode is on screen (or null when it should stay hidden). */
export function permissionModeReason(autonomy: BotAutonomy, level: BotGateLevel | null | undefined, provider: string): string | null {
  if (autonomy === 'unrestricted') return 'You chose Unrestricted, so there is no gate. This setting is now the only thing that decides what the provider will do on its own.';
  if (level === 'advisory') return `${providerName(provider)} can use tools the gate cannot see, so this setting acts as a second line of defence.`;
  if (level === 'off') return 'There is no gate, so this setting is the only control.';
  return null;
}

// ---- plain lists ------------------------------------------------------------------------------

export type PlainSection = { key: keyof BotAbilitiesPlain; title: string; tone: 'ok' | 'ask' | 'never'; empty: string; items: string[] };

const cleanList = (value: unknown): string[] => (Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0).map((entry) => entry.trim()) : []);

export function normalizePlain(raw: unknown): BotAbilitiesPlain {
  const record = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return { canDoAlone: cleanList(record.canDoAlone), asksFirst: cleanList(record.asksFirst), neverDoes: cleanList(record.neverDoes) };
}

/** The three lists, always in the same order, each with a friendly empty state. */
export function plainSections(raw: unknown): PlainSection[] {
  const plain = normalizePlain(raw);
  return [
    { key: 'canDoAlone', title: 'Can do alone', tone: 'ok', empty: 'Nothing yet.', items: plain.canDoAlone },
    { key: 'asksFirst', title: 'Asks you first', tone: 'ask', empty: 'Nothing: it will not stop to ask.', items: plain.asksFirst },
    { key: 'neverDoes', title: 'Never does', tone: 'never', empty: 'Nothing is blocked outright.', items: plain.neverDoes },
  ];
}

// ---- apps -------------------------------------------------------------------------------------

export const prettyServerName = (server: string): string => {
  const base = server.trim().replace(/^claude\.ai\s+/i, '').replace(/^mcp__/i, '').replace(/__\*?$/, '').replace(/__.*$/, '');
  const words = base.replace(/[-_]+/g, ' ').trim();
  if (!words) return server;
  return words === words.toLowerCase() ? words.replace(/\b\w/g, (c) => c.toUpperCase()) : words;
};

/** "5 allowed · 2 ask first · 1 blocked", skipping zero counts. */
export function toolCountsLabel(counts: BotAbilitiesApp['tools_policy_counts'] | null | undefined): string {
  const parts: string[] = [];
  if (counts?.allow) parts.push(`${counts.allow} allowed`);
  if (counts?.ask) parts.push(`${counts.ask} ask first`);
  if (counts?.deny) parts.push(`${counts.deny} blocked`);
  return parts.length ? parts.join(' · ') : 'Using the default rules (risky tools ask first)';
}

export function appsHeadline(count: number): string {
  if (count === 0) return 'No apps yet. This bot cannot use any outside app.';
  return `${count} app${count === 1 ? '' : 's'} attached. The bot can use only these.`;
}

/** Merge each phase's saved tool policy for the servers still attached, keeping other servers' entries. */
export function mergeToolPolicy(
  saved: Record<string, Record<string, 'allow' | 'ask' | 'deny'>> | undefined,
  draft: Record<string, Record<string, 'allow' | 'ask' | 'deny'>>,
  servers: string[],
): Record<string, Record<string, 'allow' | 'ask' | 'deny'>> {
  const keep = new Set(servers);
  const next: Record<string, Record<string, 'allow' | 'ask' | 'deny'>> = {};
  for (const [server, tools] of Object.entries(saved ?? {})) if (keep.has(server)) next[server] = tools;
  for (const server of servers) if (draft[server]) next[server] = draft[server];
  return next;
}

// ---- spaces / skills copy ---------------------------------------------------------------------

export function countLabel(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

// ---- browser ----------------------------------------------------------------------------------

export function formatBytes(bytes: number | null | undefined): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value >= 10 ? Math.round(value) : Math.round(value * 10) / 10} ${units[unit]}`;
}

/** What the profile looks like to a non-technical reader. */
export function browserStatusLine(browser: BotBrowserStatus | null | undefined, now: number = Date.now()): string {
  if (!browser || !browser.profile_exists) return 'This bot has no browser logins yet.';
  const parts = ['This bot has its own browser with saved logins'];
  const sites = browser.signed_in_sites?.filter(Boolean) ?? [];
  if (sites.length) parts.push(`signed in to ${sites.slice(0, 4).join(', ')}${sites.length > 4 ? ` and ${sites.length - 4} more` : ''}`);
  const size = formatBytes(browser.size_bytes);
  if (size) parts.push(size);
  if (browser.last_used_at) {
    const time = Date.parse(browser.last_used_at);
    if (Number.isFinite(time)) {
      const minutes = Math.max(0, Math.round((now - time) / 60_000));
      parts.push(minutes < 1 ? 'used just now' : minutes < 60 ? `used ${minutes} min ago` : minutes < 1440 ? `used ${Math.round(minutes / 60)} h ago` : `used ${Math.round(minutes / 1440)} d ago`);
    }
  }
  return `${parts.join(' · ')}.`;
}

/** Accepts "example.com" and full URLs; only http(s) is allowed. Returns the cleaned URL or a problem. */
export function normalizeSignInUrl(raw: string): { url: string } | { error: string } {
  const text = raw.trim();
  if (!text) return { error: 'Enter the address of the site to sign in to, for example https://mail.google.com.' };
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`;
  let parsed: URL;
  try { parsed = new URL(withScheme); } catch { return { error: 'That does not look like a web address.' }; }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return { error: 'Only web addresses (http or https) can be opened.' };
  if (!parsed.hostname.includes('.') && parsed.hostname !== 'localhost') return { error: 'That does not look like a web address.' };
  return { url: parsed.toString() };
}

/** 409 means the bot (or its browser) is busy: say so in plain words instead of a status code. */
export function browserErrorMessage(error: unknown, action: 'sign-in' | 'finish' | 'sign-out' | 'extend'): string {
  const status = (error as { status?: unknown } | null)?.status;
  if (action === 'extend') {
    if (status === 409) return 'This sign-in window is already at its 2 hour limit. Press "I\'m done signing in" to save your logins, then start again if you need more time.';
    if (status === 404) return SIGN_IN_EXPIRED_MESSAGE;
  }
  if (status === 409) {
    return action === 'finish'
      ? 'That sign-in session is no longer open. Start again from "Sign in as this bot".'
      : 'This bot is running right now, or its browser is in use. Wait for it to finish (or pause it), then try again.';
  }
  const message = error instanceof Error && error.message ? error.message : '';
  if (message) return message;
  return action === 'sign-in' ? 'Could not open the sign-in browser.' : action === 'finish' ? 'Could not finish signing in.' : action === 'extend' ? 'Could not add more time.' : 'Could not sign the bot out.';
}

// ---- where to show the sign-in session --------------------------------------------------------

export type ViewTarget =
  | { kind: 'embed'; sessionId: string }
  | { kind: 'route'; path: string }
  | { kind: 'event'; name: string; detail: unknown }
  | { kind: 'instructions'; text: string };

const SAFE_ROUTE = /^\/(?!\/)[^\s\\]*$/;
const SAFE_EVENT = /^[a-z][\w:.-]{0,63}$/i;

export const UNKNOWN_VIEW_INSTRUCTIONS = (botTitle: string): string => `Open the Browser panel; the session named ${botTitle || 'this bot'} is yours to drive. Sign in there, then come back and press "I'm done signing in".`;

/**
 * Turn the server's `viewHint` into something the UI can follow. A client route (a path starting with a
 * single "/") or a named event is followed; anything else, including malformed or external values,
 * becomes instructions so the user is never left with a dead button.
 */
export function resolveViewHint(hint: BotBrowserViewHint | null | undefined, botTitle: string): ViewTarget {
  const fallback: ViewTarget = { kind: 'instructions', text: UNKNOWN_VIEW_INSTRUCTIONS(botTitle) };
  if (typeof hint === 'string') {
    const text = hint.trim();
    if (SAFE_ROUTE.test(text)) return { kind: 'route', path: text };
    return text && !/^[a-z][a-z0-9+.-]*:/i.test(text) && text.includes(' ') ? { kind: 'instructions', text } : fallback;
  }
  if (!hint || typeof hint !== 'object') return fallback;
  // The server's sign-in hint names a browser-use session: show it right here, inline.
  const record = hint as Record<string, unknown>;
  if (record.kind === 'browser_panel' && typeof record.session_id === 'string' && /^[\w-]{1,128}$/.test(record.session_id)) {
    return { kind: 'embed', sessionId: record.session_id };
  }
  const route = typeof hint.route === 'string' ? hint.route : typeof hint.path === 'string' ? hint.path : '';
  if (route && SAFE_ROUTE.test(route.trim())) return { kind: 'route', path: route.trim() };
  if (typeof hint.event === 'string' && SAFE_EVENT.test(hint.event)) return { kind: 'event', name: hint.event, detail: hint.detail };
  const text = typeof hint.instructions === 'string' ? hint.instructions : typeof hint.message === 'string' ? hint.message : '';
  return text.trim() ? { kind: 'instructions', text: text.trim() } : fallback;
}

/** A session the sign-in flow keeps so "I'm done signing in" survives leaving the tab. */
export type PendingSignIn = { sessionId: string; url: string; target: ViewTarget; /** ISO time the server closes the window. */ expiresAt?: string | null };

export function pendingSignIn(result: BotBrowserSignIn, url: string, botTitle: string): PendingSignIn {
  return { sessionId: result.sessionId, url, target: resolveViewHint(result.viewHint, botTitle), expiresAt: result.expiresAt ?? null };
}

/** Shown once the server has closed a sign-in window that ran out of time. */
export const SIGN_IN_EXPIRED_MESSAGE = 'The sign-in browser was closed after 30 minutes \u2014 sign in again.';
/** Below this much time left the card warns and offers "I need more time". */
export const SIGN_IN_WARN_MS = 5 * 60_000;

export type SignInCountdown = { remainingMs: number; label: string; low: boolean; expired: boolean };

/** "27:05 left" style countdown for the open sign-in window; null when the server gave no expiry. */
export function signInCountdown(expiresAt: string | null | undefined, now: number = Date.now()): SignInCountdown | null {
  if (!expiresAt) return null;
  const end = Date.parse(expiresAt);
  if (!Number.isFinite(end)) return null;
  const remainingMs = Math.max(0, end - now);
  const totalSeconds = Math.ceil(remainingMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return {
    remainingMs,
    label: remainingMs <= 0 ? 'Time is up' : `${minutes}:${String(seconds).padStart(2, '0')} left`,
    low: remainingMs > 0 && remainingMs < SIGN_IN_WARN_MS,
    expired: remainingMs <= 0,
  };
}

// ---- deep links -------------------------------------------------------------------------------

export type AbilitiesSection = 'autonomy' | 'apps' | 'skills' | 'spaces' | 'accounts';

export const ABILITIES_SECTIONS: Array<{ id: AbilitiesSection; label: string }> = [
  { id: 'autonomy', label: 'How much it can do alone' },
  { id: 'apps', label: 'Apps' },
  { id: 'skills', label: 'Skills' },
  { id: 'spaces', label: 'Spaces' },
  { id: 'accounts', label: 'Accounts & logins' },
];

/** `skills` or `skill:<name>` (open that skill) from a tab focus; anything else is ignored. */
export function parseAbilitiesFocus(focus: string | null | undefined): { section: AbilitiesSection | null; skill: string | null } {
  if (!focus) return { section: null, skill: null };
  if (focus.startsWith('skill:')) { const skill = focus.slice('skill:'.length); return { section: 'skills', skill: skill || null }; }
  const section = ABILITIES_SECTIONS.find((entry) => entry.id === focus)?.id ?? null;
  return { section, skill: null };
}

// ---- header summary ---------------------------------------------------------------------------

/** The short "at a glance" chips above the sections. Counts prefer live data over the first load. */
export function abilitiesChips(input: {
  autonomy: BotAutonomy;
  apps: number;
  skills: number;
  spaces: number;
  logins: number;
  browserProfile: boolean;
}): string[] {
  return [
    `Autonomy: ${autonomyChoice(input.autonomy).label}`,
    countLabel(input.apps, 'app'),
    countLabel(input.skills, 'skill'),
    countLabel(input.spaces, 'space'),
    input.logins || input.browserProfile
      ? `${countLabel(input.logins, 'saved key')}${input.browserProfile ? ' · browser logins' : ''}`
      : 'No logins yet',
  ];
}
