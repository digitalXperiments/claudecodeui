import type { McItem } from '../../../mission-control/api/missionControlApi';
import type { Bot } from '../../types';

export type InboxFilter = 'pending' | 'resolving' | 'resolved' | 'failed' | 'all';

export type InboxCounts = Record<InboxFilter, number>;

export type InboxKeyboardState = {
  selectedItemId: string | null;
  checkedIds: string[];
};

export type InboxKeyboardAction =
  | { type: 'move'; itemIds: string[]; direction: 1 | -1 }
  | { type: 'toggle'; itemId: string }
  | { type: 'clear' };

export function getInboxCounts(items: McItem[]): InboxCounts {
  return {
    pending: items.filter((item) => item.status === 'pending').length,
    resolving: items.filter((item) => item.status === 'resolving').length,
    resolved: items.filter((item) => item.status === 'resolved' || item.status === 'dismissed').length,
    failed: items.filter((item) => item.status === 'failed').length,
    all: items.length,
  };
}

export function inboxFilterMatches(item: McItem, filter: InboxFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'resolved') return item.status === 'resolved' || item.status === 'dismissed';
  return item.status === filter;
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
  return item.status === 'pending' && item.actions.some((action) => action.kind === 'approve');
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
