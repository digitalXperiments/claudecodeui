import { useEffect, useMemo, useState } from 'react';
import { Check, CheckSquare, X } from 'lucide-react';
import type { McAction, McItem } from '../../mission-control/api/missionControlApi';
import type { Bot } from '../types';
import SegmentedControl from '../ui/SegmentedControl';
import InboxItemCard from './InboxItemCard';
import { Button } from '../../../shared/view/ui';

type Filter = 'pending' | 'resolving' | 'resolved' | 'failed' | 'all';

export default function InboxView({ items, bots, search, selectedItemId, onSelectItem, onAction, onPreview, onRetry, onWork, onGenerateAssets }: {
  items: McItem[];
  bots: Bot[];
  search: string;
  selectedItemId: string | null;
  onSelectItem: (item: McItem) => void;
  onAction: (item: McItem, action: McAction, body?: Record<string, unknown>) => void;
  onPreview: (item: McItem, action?: McAction) => void;
  onRetry: (item: McItem) => void;
  onWork: (item: McItem) => void;
  onGenerateAssets: (item: McItem, force: boolean) => Promise<{ generated: number; skipped: number; failed: number; messages: string[] }>;
}) {
  const [filter, setFilter] = useState<Filter>('pending');
  const [botFilter, setBotFilter] = useState('all');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const counts = useMemo(() => ({ pending: items.filter((item) => item.status === 'pending').length, resolving: items.filter((item) => item.status === 'resolving').length, resolved: items.filter((item) => item.status === 'resolved' || item.status === 'dismissed').length, failed: items.filter((item) => item.status === 'failed').length, all: items.length }), [items]);
  const visible = items.filter((item) => (filter === 'all' || (filter === 'resolved' ? item.status === 'resolved' || item.status === 'dismissed' : item.status === filter)) && (botFilter === 'all' || item.section_id === botFilter) && `${item.title} ${item.summary}`.toLowerCase().includes(search.toLowerCase()));

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT') return;
      if (!visible.length) return;
      const currentIndex = Math.max(0, visible.findIndex((item) => item.item_id === selectedItemId));
      if (event.key.toLowerCase() === 'j' || event.key === 'ArrowDown') { event.preventDefault(); onSelectItem(visible[Math.min(currentIndex + 1, visible.length - 1)]); }
      if (event.key.toLowerCase() === 'k' || event.key === 'ArrowUp') { event.preventDefault(); onSelectItem(visible[Math.max(currentIndex - 1, 0)]); }
      if (event.key === ' ') { event.preventDefault(); const item = visible[currentIndex]; setSelectedIds((current) => current.includes(item.item_id) ? current.filter((id) => id !== item.item_id) : [...current, item.item_id]); }
      if (event.key.toLowerCase() === 'a') { const item = visible[currentIndex]; const action = item.actions.find((entry) => entry.kind === 'approve'); if (action) onAction(item, action); }
      if (event.key.toLowerCase() === 'd') { const item = visible[currentIndex]; const action = item.actions.find((entry) => entry.kind === 'dismiss' || /dismiss/i.test(entry.label)); if (action) onAction(item, action); }
      if (event.key.toLowerCase() === 'r') { const item = visible[currentIndex]; const action = item.actions.find((entry) => !['approve', 'dismiss'].includes(entry.kind) && !entry.terminal); if (action) onAction(item, action); }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onAction, onSelectItem, selectedItemId, visible]);

  const batch = (kind: 'approve' | 'dismiss') => { selectedIds.forEach((id) => { const item = items.find((entry) => entry.item_id === id); const action = item?.actions.find((entry) => entry.kind === kind); if (item && action) onAction(item, action); }); setSelectedIds([]); };
  return <section className="flex min-h-0 flex-1 flex-col"><div className="flex flex-wrap items-center gap-2 border-b border-border/70 bg-background px-4 py-3 sm:px-5"><SegmentedControl value={filter} onChange={setFilter} label="Inbox status" options={(['pending', 'resolving', 'resolved', 'failed', 'all'] as Filter[]).map((value) => ({ value, label: value[0].toUpperCase() + value.slice(1), count: counts[value] }))} /><select value={botFilter} onChange={(event) => setBotFilter(event.target.value)} aria-label="Filter inbox by bot" className="h-9 rounded-lg border border-border bg-background px-2.5 text-xs outline-none focus:border-primary"><option value="all">All bots</option>{bots.map((bot) => <option key={bot.section_id} value={bot.section_id}>{bot.title}</option>)}</select>{selectedIds.length ? <div className="ml-auto flex items-center gap-1.5"><span className="text-[10px] text-muted-foreground">{selectedIds.length} selected</span><Button size="sm" onClick={() => batch('approve')}><Check className="h-3 w-3" />Approve all</Button><Button size="sm" variant="ghost" onClick={() => batch('dismiss')}><X className="h-3 w-3" />Dismiss all</Button></div> : <span className="ml-auto hidden items-center gap-1 text-[10px] text-muted-foreground sm:flex"><CheckSquare className="h-3 w-3" />J/K navigate · A approve · D dismiss · Space select</span>}</div><div className="min-h-0 flex-1 overflow-y-auto p-3 sm:p-5">{visible.length ? <div className="mx-auto max-w-4xl space-y-3">{visible.map((item) => <InboxItemCard key={item.item_id} item={item} bot={bots.find((bot) => bot.section_id === item.section_id)} selected={selectedItemId === item.item_id} checked={selectedIds.includes(item.item_id)} onSelect={() => onSelectItem(item)} onCheck={(checked) => setSelectedIds((current) => checked ? [...current, item.item_id] : current.filter((id) => id !== item.item_id))} onAction={onAction} onPreview={onPreview} onRetry={onRetry} onWork={onWork} onGenerateAssets={(force) => onGenerateAssets(item, force)} />)}</div> : <div className="mx-auto flex max-w-md flex-col items-center justify-center py-20 text-center"><div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/10 text-primary"><Check className="h-5 w-5" /></div><h2 className="mt-4 text-sm font-semibold">Inbox is clear</h2><p className="mt-1 text-xs leading-5 text-muted-foreground">No {filter === 'all' ? '' : filter} items match the current filters.</p></div>}</div></section>;
}
