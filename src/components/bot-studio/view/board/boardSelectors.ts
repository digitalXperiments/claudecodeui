import type { McAction, McItem } from '../../../mission-control/api/missionControlApi';
import { routeWorkProject, type Bot } from '../../types';

export type BoardColumn = 'approval' | 'ready' | 'in_progress' | 'in_qa' | 'done' | 'blocked';

export const BOARD_COLUMNS: Array<{ key: BoardColumn; label: string; empty: string }> = [
  { key: 'approval', label: 'Awaiting approval', empty: 'Nothing waiting for approval.' },
  { key: 'ready', label: 'Ready for work', empty: 'No items waiting for Start work.' },
  { key: 'in_progress', label: 'In progress', empty: 'No resolve or work sessions running.' },
  { key: 'in_qa', label: 'In QA', empty: 'No finished work to review.' },
  { key: 'done', label: 'Done', empty: 'Nothing done yet.' },
  { key: 'blocked', label: 'Blocked', empty: 'No failures.' },
];

/** Done shows only the most recent items; the rest are summarized as "+N older". */
export const BOARD_DONE_LIMIT = 20;

/** Toolbar filter: bots with a work profile, every bot, or a single bot id. */
export const BOARD_FILTER_WORK = '__work';
export const BOARD_FILTER_ALL = '__all';

export type BoardDrop = 'approve' | 'start_work' | 'accept' | 'send_back';

export type Board = { columns: Record<BoardColumn, McItem[]>; olderDone: number };

type BoardBot = Pick<Bot, 'section_id' | 'work_profile'> & { actions?: McAction[]; title?: string };

export function approveActionFor(item: Pick<McItem, 'actions'>): McAction | undefined {
  return item.actions.find((action) => action.kind === 'approve');
}

export function dismissActionFor(item: Pick<McItem, 'actions'>): McAction | undefined {
  return item.actions.find((action) => action.kind === 'dismiss');
}

/** Column for an item, or null when the board does not show it (dismissed, expired, unactionable pending). */
export function boardColumnFor(item: Pick<McItem, 'status' | 'actions'>, bot?: BoardBot): BoardColumn | null {
  switch (item.status) {
    case 'pending': {
      const actions = item.actions.length ? item.actions : bot?.actions ?? [];
      return actions.some((action) => action.kind !== 'work') ? 'approval' : null;
    }
    case 'awaiting_work': return 'ready';
    case 'resolving':
    case 'working': return 'in_progress';
    case 'in_qa': return 'in_qa';
    case 'resolved': return 'done';
    case 'failed': return 'blocked';
    default: return null;
  }
}

export function defaultBoardBotFilter(bots: Array<Pick<Bot, 'work_profile'>>): string {
  return bots.some((bot) => bot.work_profile) ? BOARD_FILTER_WORK : BOARD_FILTER_ALL;
}

export function boardFilterMatches(item: Pick<McItem, 'section_id'>, bot: BoardBot | undefined, filter: string): boolean {
  if (filter === BOARD_FILTER_ALL) return true;
  if (filter === BOARD_FILTER_WORK) return Boolean(bot?.work_profile);
  return item.section_id === filter;
}

function updatedAt(item: Pick<McItem, 'updated_at' | 'created_at'>): number {
  const value = Date.parse(item.updated_at || item.created_at || '');
  return Number.isFinite(value) ? value : 0;
}

/** Group items into columns, newest first, capping Done at BOARD_DONE_LIMIT. */
export function buildBoard(items: McItem[], bots: BoardBot[], filter: string, search = ''): Board {
  const needle = search.trim().toLowerCase();
  const columns: Record<BoardColumn, McItem[]> = { approval: [], ready: [], in_progress: [], in_qa: [], done: [], blocked: [] };
  for (const item of items) {
    const bot = bots.find((entry) => entry.section_id === item.section_id);
    if (!boardFilterMatches(item, bot, filter)) continue;
    if (needle && !`${item.title} ${item.summary} ${bot?.title ?? ''}`.toLowerCase().includes(needle)) continue;
    const column = boardColumnFor(item, bot);
    if (column) columns[column].push(item);
  }
  for (const key of Object.keys(columns) as BoardColumn[]) columns[key].sort((left, right) => updatedAt(right) - updatedAt(left));
  const olderDone = Math.max(0, columns.done.length - BOARD_DONE_LIMIT);
  columns.done = columns.done.slice(0, BOARD_DONE_LIMIT);
  return { columns, olderDone };
}

/**
 * The action a drag from `from` to `to` performs, or null when the drop is not
 * allowed. Each drop mirrors a card button, so buttons stay the keyboard path.
 */
export function boardDropFor(from: BoardColumn, to: BoardColumn, item: Pick<McItem, 'actions' | 'body'>, bot?: BoardBot): BoardDrop | null {
  if (from === 'approval' && (to === 'ready' || to === 'in_progress')) return approveActionFor(item) ? 'approve' : null;
  if (from === 'ready' && to === 'in_progress') return routeWorkProject(item, bot?.work_profile) ? 'start_work' : null;
  if (from === 'in_qa' && to === 'done') return 'accept';
  if (from === 'in_qa' && to === 'in_progress') return 'send_back';
  return null;
}
