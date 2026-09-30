/**
 * Pure route parsing for Bot Studio (`/bots/...`). Kept out of BotStudioView so it can be unit
 * tested. The runtime pages (`brief`, `channels`, `teams`) always parse; the view decides whether
 * to render them or the "enable Bot runtime v2" card based on the `bots.runtimeV2` flag.
 */

export type BotStudioViewKey =
  | 'dashboard'
  | 'inbox'
  | 'board'
  | 'bots'
  | 'templates'
  | 'activity'
  | 'exceptions'
  | 'import'
  | 'brief'
  | 'channels'
  | 'teams';

export type BotStudioRoute = {
  page: BotStudioViewKey | 'new';
  botId?: string;
  /** Raw tab id from the URL; BotDetailView maps legacy ids to the consolidated tabs. */
  tab?: string;
};

/** Pages that only exist while the Bot Runtime v2 flag is on. */
export const RUNTIME_PAGES = ['brief', 'channels', 'teams'] as const;
export type RuntimePage = (typeof RUNTIME_PAGES)[number];

export function isRuntimePage(page: string | undefined): page is RuntimePage {
  return RUNTIME_PAGES.some((entry) => entry === page);
}

const SIMPLE_PAGES: ReadonlyArray<BotStudioViewKey> = [
  'templates', 'board', 'activity', 'exceptions', 'import', 'inbox', 'brief', 'channels', 'teams',
];

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function parseRoute(pathname: string): BotStudioRoute {
  const parts = pathname.split('/').filter(Boolean);
  const tail = parts[0] === 'bots' ? parts.slice(1) : [];
  if (tail[0] === 'new') return { page: 'new' };
  if (tail[0] === 'b' && tail[1]) return { page: 'bots', botId: safeDecode(tail[1]), tab: tail[2] || 'overview' };
  const simple = SIMPLE_PAGES.find((page) => page === tail[0]);
  if (simple) return { page: simple };
  return { page: 'dashboard' };
}

/** The URL for a top-level view (used by the roster navigation). */
export function viewPath(view: BotStudioViewKey): string {
  return view === 'dashboard' ? '/bots' : `/bots/${view}`;
}

/** Deep link to a bot's detail tab. */
export function botTabPath(botId: string, tab = 'overview'): string {
  return `/bots/b/${encodeURIComponent(botId)}/${tab}`;
}
