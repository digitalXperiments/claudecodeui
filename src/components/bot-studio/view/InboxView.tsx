import { useEffect, useMemo, useReducer, useState } from 'react';
import { Check, CheckSquare, Search, X } from 'lucide-react';

import SegmentedControl from '../ui/SegmentedControl';
import { actionIsSendLike } from '../types';
import { Button } from '../../../shared/view/ui';

import InboxItemCard from './InboxItemCard';
import type { InboxViewProps } from './contracts';
import {
  filterInboxItems,
  getInboxCounts,
  inboxKeyboardReducer,
  sortInboxItems,
  type InboxFilter,
} from './inbox/inboxSelectors';

export default function InboxView({
  items,
  bots,
  search,
  selectedItemId,
  onSelectItem,
  onAction,
  onPreview,
  onRetry,
  onWork,
  onGenerateAssets,
  keyboard,
}: InboxViewProps) {
  const [filter, setFilter] = useState<InboxFilter>('pending');
  const [botFilter, setBotFilter] = useState('all');
  const [selection, dispatchSelection] = useReducer(inboxKeyboardReducer, {
    selectedItemId,
    checkedIds: [],
  });
  const counts = useMemo(() => getInboxCounts(items), [items]);
  const visible = useMemo(
    () => sortInboxItems(filterInboxItems(items, bots, filter, botFilter, search)),
    [botFilter, bots, filter, items, search],
  );
  const activeItemId = selectedItemId ?? selection.selectedItemId;

  useEffect(() => {
    if (selectedItemId) dispatchSelection({ type: 'move', itemIds: [selectedItemId], direction: 1 });
  }, [selectedItemId]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA' || target?.tagName === 'SELECT' || target?.isContentEditable) return;
      const key = event.key.toLowerCase();

      if (key === 'escape') {
        if (selection.checkedIds.length) {
          event.preventDefault();
          dispatchSelection({ type: 'clear' });
        }
        return;
      }
      if (!visible.length) return;
      const currentIndex = visible.findIndex((item) => item.item_id === activeItemId);
      const current = visible[currentIndex >= 0 ? currentIndex : 0];
      if (key === 'j' || event.key === 'ArrowDown' || key === 'k' || event.key === 'ArrowUp') {
        event.preventDefault();
        const direction = key === 'j' || event.key === 'ArrowDown' ? 1 : -1;
        const index = currentIndex < 0 ? (direction > 0 ? -1 : visible.length) : currentIndex;
        const nextIndex = Math.max(0, Math.min(visible.length - 1, index + direction));
        const next = visible[nextIndex];
        dispatchSelection({ type: 'move', itemIds: visible.map((item) => item.item_id), direction });
        onSelectItem(next);
        return;
      }
      if (key === 'enter') {
        event.preventDefault();
        onSelectItem(current);
        return;
      }
      if (key === ' ') {
        event.preventDefault();
        dispatchSelection({ type: 'toggle', itemId: current.item_id });
        return;
      }
      if (key === 'a') {
        const action = current.actions.find((entry) => entry.kind === 'approve');
        const currentBot = bots.find((bot) => bot.section_id === current.section_id);
        if (current.status === 'pending' && action && !(currentBot?.autonomy === 'propose' && actionIsSendLike(action))) onAction(current, action);
        return;
      }
      if (key === 'd') {
        const action = current.actions.find((entry) => entry.kind === 'dismiss' || /dismiss/i.test(entry.label));
        if (current.status === 'pending' && action) onAction(current, action);
        return;
      }
      if (key === 'r') {
        const action = current.actions.find((entry) => !['approve', 'dismiss'].includes(entry.kind) && !entry.terminal);
        const currentBot = bots.find((bot) => bot.section_id === current.section_id);
        if (current.status === 'pending' && action && !(currentBot?.autonomy === 'propose' && actionIsSendLike(action))) onAction(current, action);
      }
    };
    if (keyboard) return keyboard.register(handleKeyDown);
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [activeItemId, bots, keyboard, onAction, onSelectItem, selection.checkedIds.length, visible]);

  const batch = (kind: 'approve' | 'dismiss') => {
    selection.checkedIds.forEach((id) => {
      const item = items.find((entry) => entry.item_id === id);
      const action = item?.actions.find((entry) => entry.kind === kind || (kind === 'dismiss' && /dismiss/i.test(entry.label)));
      if (item && action) onAction(item, action);
    });
    dispatchSelection({ type: 'clear' });
  };

  return (
    <section className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-border/70 bg-background px-4 py-3 sm:px-5">
        <SegmentedControl
          value={filter}
          onChange={setFilter}
          label="Inbox status"
          options={(['pending', 'resolving', 'resolved', 'failed', 'all'] as InboxFilter[]).map((value) => ({
            value,
            label: value[0].toUpperCase() + value.slice(1),
            count: counts[value],
          }))}
        />
        <label className="relative flex h-9 min-w-36 items-center">
          <Search className="pointer-events-none absolute left-2.5 h-3.5 w-3.5 text-muted-foreground" />
          <select value={botFilter} onChange={(event) => setBotFilter(event.target.value)} aria-label="Filter inbox by bot" className="h-9 w-full rounded-lg border border-border bg-background pl-8 pr-2.5 text-xs outline-none focus:border-primary focus:ring-2 focus:ring-primary/10">
            <option value="all">All bots</option>
            {bots.map((bot) => <option key={bot.section_id} value={bot.section_id}>{bot.title}</option>)}
          </select>
        </label>
        {selection.checkedIds.length ? (
          <div className="ml-auto flex items-center gap-1.5" role="toolbar" aria-label="Inbox batch actions">
            <span className="text-[10px] text-muted-foreground">{selection.checkedIds.length} selected</span>
            <Button size="sm" onClick={() => batch('approve')}><Check className="h-3 w-3" />Approve all</Button>
            <Button size="sm" variant="ghost" onClick={() => batch('dismiss')}><X className="h-3 w-3" />Dismiss all</Button>
          </div>
        ) : (
          <span className="ml-auto hidden items-center gap-1 text-[10px] text-muted-foreground sm:flex"><CheckSquare className="h-3 w-3" />J/K navigate · Enter open · A approve · D dismiss · Space select</span>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3 sm:p-5">
        {visible.length ? (
          <div className="mx-auto max-w-4xl space-y-3" role="list" aria-label="Inbox items">
            {visible.map((item) => (
              <InboxItemCard
                key={item.item_id}
                item={item}
                bot={bots.find((bot) => bot.section_id === item.section_id)}
                selected={activeItemId === item.item_id}
                checked={selection.checkedIds.includes(item.item_id)}
                onSelect={() => onSelectItem(item)}
                onCheck={(checked) => {
                  if (checked !== selection.checkedIds.includes(item.item_id)) dispatchSelection({ type: 'toggle', itemId: item.item_id });
                }}
                onAction={onAction}
                onPreview={onPreview}
                onRetry={onRetry}
                onWork={onWork}
                onGenerateAssets={(force) => onGenerateAssets(item, force)}
              />
            ))}
          </div>
        ) : (
          <div className="mx-auto flex max-w-md flex-col items-center justify-center py-20 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/10 text-primary"><Check className="h-5 w-5" /></div>
            <h2 className="mt-4 text-sm font-semibold">{search.trim() ? 'No matching inbox items' : 'Inbox is clear'}</h2>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">{search.trim() ? `Nothing matches “${search.trim()}”.` : `No ${filter === 'all' ? '' : filter} items match the current filters.`}</p>
          </div>
        )}
      </div>
    </section>
  );
}
