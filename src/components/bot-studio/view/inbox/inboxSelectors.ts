import type { McItem } from '../../../mission-control/api/missionControlApi';
import type { Bot } from '../../types';

export type InboxFilter = 'needs_attention' | 'pending' | 'in_progress' | 'in_qa' | 'resolved' | 'failed' | 'all';

export const INBOX_FILTERS: InboxFilter[] = ['needs_attention', 'pending', 'in_progress', 'in_qa', 'resolved', 'failed', 'all'];

export const INBOX_FILTER_LABELS: Record<InboxFilter, string> = {
  needs_attention: 'Needs attention', pending: 'Pending', in_progress: 'In progress', in_qa: 'In QA', resolved: 'Resolved', failed: 'Failed', all: 'All',
};

export type InboxCounts = Record<InboxFilter, number>;

export type InboxKeyboardState = {
  selectedItemId: string | null;
  checkedIds: string[];
};

export type InboxKeyboardAction =
  | { type: 'move'; itemIds: string[]; direction: 1 | -1 }
  | { type: 'toggle'; itemId: string }
  | { type: 'clear' };

export function inboxFilterMatches(item: McItem, filter: InboxFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'needs_attention') return item.status === 'pending' || item.status === 'failed' || item.status === 'awaiting_work' || item.status === 'in_qa';
  if (filter === 'in_progress') return item.status === 'resolving' || item.status === 'working';
  if (filter === 'resolved') return item.status === 'resolved' || item.status === 'dismissed';
  return item.status === filter;
}

export function getInboxCounts(items: McItem[]): InboxCounts {
  return Object.fromEntries(INBOX_FILTERS.map((filter) => [filter, items.filter((item) => inboxFilterMatches(item, filter)).length])) as InboxCounts;
}

export function inboxSearchText(item: McItem, bot?: Bot): string {
  return [item.title, item.summary, bot?.title, bot?.purpose].filter(Boolean).join(' ').toLowerCase();
}

export function filterInboxItems(items: McItem[], bots: Bot[], filter: InboxFilter, botId: string, search: string): McItem[] {
  const needle = search.trim().toLowerCase();
  return items.filter((item) => {
    const bot = bots.find((candidate) => candidate.section_id === item.section_id);
    return inboxFilterMatches(item, filter)
      && (botId === 'all' || item.section_id === botId)
      && (!needle || inboxSearchText(item, bot).includes(needle));
  });
}

function needsDecision(item: McItem): boolean {
  if (item.status === 'awaiting_work' || item.status === 'in_qa') return true;
  if (item.status === 'failed' && item.work_ready_at) return true;
  return (item.status === 'pending' || item.status === 'failed') && item.actions.some((action) => action.kind === 'approve');
}

function timestamp(item: McItem): number {
  const value = Date.parse(item.created_at || item.updated_at || '');
  return Number.isFinite(value) ? value : 0;
}

/** Keep actionable work at the top while preserving newest-first order in each group. */
export function sortInboxItems(items: McItem[]): McItem[] {
  return [...items].sort((left, right) => {
    const decisionDelta = Number(needsDecision(right)) - Number(needsDecision(left));
    return decisionDelta || timestamp(right) - timestamp(left);
  });
}

export function inboxKeyboardReducer(state: InboxKeyboardState, action: InboxKeyboardAction): InboxKeyboardState {
  if (action.type === 'clear') return { ...state, checkedIds: [] };
  if (action.type === 'toggle') {
    return {
      ...state,
      checkedIds: state.checkedIds.includes(action.itemId)
        ? state.checkedIds.filter((id) => id !== action.itemId)
        : [...state.checkedIds, action.itemId],
    };
  }
  if (!action.itemIds.length) return state;
  const selectedIndex = action.itemIds.indexOf(state.selectedItemId ?? '');
  const index = selectedIndex < 0 ? (action.direction > 0 ? -1 : action.itemIds.length) : selectedIndex;
  const nextIndex = Math.max(0, Math.min(action.itemIds.length - 1, index + action.direction));
  return { ...state, selectedItemId: action.itemIds[nextIndex] };
}
