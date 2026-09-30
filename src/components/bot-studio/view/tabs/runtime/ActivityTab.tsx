import { Activity, AlertTriangle, Loader2, Search, X, Zap } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import { Button } from '../../../../../shared/view/ui';
import type { McSection } from '../../../../mission-control/api/missionControlApi';
import { botRuntimeApi } from '../../../api/botRuntimeApi';
import { useBotRuntime, useBotRuntimeStatus } from '../../../hooks/useBotRuntime';
import type { BotEpisodeSearchHit } from '../../../types/botRuntime';
import InlineToast from '../../../ui/InlineToast';
import SegmentedControl from '../../../ui/SegmentedControl';
import Skeleton from '../../../ui/Skeleton';

import EpisodeDetailPanel from './parts/EpisodeDetailPanel';
import EpisodeRow from './parts/EpisodeRow';
import { countEpisodesByStatus, EPISODE_STATUS_FILTERS, filterEpisodes, truncateText, type EpisodeStatusFilter } from './parts/episodes';
import { describeRuntimeStatus } from './parts/runtimeStatus';
import { useNow } from './parts/useNow';

const SEARCH_DEBOUNCE_MS = 300;
const EPISODE_SECTIONS = ['episodes' as const];

const STATUS_DOT: Record<string, string> = {
  running: 'bg-primary animate-pulse',
  queued: 'bg-amber-500',
  idle: 'bg-emerald-500',
  disabled: 'bg-muted-foreground/50',
  unknown: 'bg-muted-foreground/30',
};

export function ActivityTab({ botId }: { botId: string; section: McSection }) {
  const runtime = useBotRuntime(botId, { sections: EPISODE_SECTIONS });
  const { status, refresh: refreshStatus } = useBotRuntimeStatus();
  const [filter, setFilter] = useState<EpisodeStatusFilter>('all');
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<BotEpisodeSearchHit[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [waking, setWaking] = useState(false);
  const [wakeOpen, setWakeOpen] = useState(false);
  const [wakeNote, setWakeNote] = useState('');
  const [toast, setToast] = useState<{ message: string; tone: 'success' | 'error' } | null>(null);

  const episodes = runtime.episodes;
  const hasRunning = episodes.some((episode) => episode.status === 'running');
  const now = useNow(hasRunning || Boolean(status?.running.includes(botId)));

  // Reset per-bot UI state when switching bots.
  useEffect(() => {
    setSelectedId(null);
    setQuery('');
    setHits(null);
    setFilter('all');
  }, [botId]);

  // Debounced episode search (server-side relevance ranking).
  useEffect(() => {
    const text = query.trim();
    if (!text) {
      setHits(null);
      setSearching(false);
      setSearchError(null);
      return undefined;
    }
    let cancelled = false;
    setSearching(true);
    const timer = setTimeout(() => {
      botRuntimeApi.episodes.search(botId, text, 25).then(
        (result) => { if (!cancelled) { setHits(result); setSearchError(null); setSearching(false); } },
        (caught) => { if (!cancelled) { setSearchError(caught instanceof Error ? caught.message : 'Search failed.'); setHits(null); setSearching(false); } },
      );
    }, SEARCH_DEBOUNCE_MS);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [botId, query]);

  const counts = useMemo(() => countEpisodesByStatus(episodes), [episodes]);
  const visible = useMemo(() => filterEpisodes(episodes, filter, hits), [episodes, filter, hits]);
  const selected = useMemo(() => episodes.find((episode) => episode.episode_id === selectedId) ?? null, [episodes, selectedId]);
  const runtimeStatus = describeRuntimeStatus(status, botId);
  const listState = runtime.sectionState.episodes.state;
  const listError = runtime.error('episodes');

  const wake = async () => {
    setWaking(true);
    try {
      await botRuntimeApi.triggers.wake(botId, wakeNote.trim() || undefined);
      setToast({ message: 'Wake requested. The bot will pick it up shortly.', tone: 'success' });
      setWakeNote('');
      setWakeOpen(false);
      void refreshStatus();
      void runtime.refresh('episodes');
    } catch (caught) {
      setToast({ message: caught instanceof Error ? caught.message : 'Unable to wake the bot.', tone: 'error' });
    } finally {
      setWaking(false);
    }
  };

  return (
    <div className="space-y-4 p-4 sm:p-6">
      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-border/70 bg-card p-3">
        <div className="flex min-w-0 flex-1 items-center gap-2 text-xs" role="status" aria-live="polite">
          <span className={`h-2 w-2 shrink-0 rounded-full ${STATUS_DOT[runtimeStatus.tone]}`} aria-hidden="true" />
          <span className="truncate" title={runtimeStatus.label}>{runtimeStatus.label}</span>
        </div>
        <Button size="sm" variant="outline" onClick={() => setWakeOpen((open) => !open)} aria-expanded={wakeOpen} disabled={waking}>
          <Zap className="h-3.5 w-3.5" />Wake now
        </Button>
        {wakeOpen ? (
          <form
            className="flex w-full flex-wrap items-center gap-2"
            onSubmit={(event) => { event.preventDefault(); void wake(); }}
          >
            <label className="sr-only" htmlFor="bot-wake-note">Optional note for the bot</label>
            <input
              id="bot-wake-note"
              value={wakeNote}
              onChange={(event) => setWakeNote(event.target.value)}
              maxLength={500}
              placeholder="Optional note: what should the bot look at?"
              className="min-w-0 flex-1 rounded-lg border border-border bg-background px-3 py-2 text-xs outline-none focus:border-primary focus:ring-2 focus:ring-primary/10"
            />
            <Button size="sm" type="submit" disabled={waking}>{waking ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Zap className="h-3.5 w-3.5" />}Send wake</Button>
          </form>
        ) : null}
      </div>
      <InlineToast message={toast?.message ?? null} tone={toast?.tone} onDismiss={() => setToast(null)} />

      <div className="flex flex-wrap items-center gap-3">
        <SegmentedControl
          value={filter}
          onChange={setFilter}
          label="Filter episodes by status"
          options={EPISODE_STATUS_FILTERS.map((entry) => ({ value: entry.value, label: entry.label, count: counts[entry.value] }))}
        />
        <div className="relative min-w-48 flex-1 sm:max-w-sm">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <label className="sr-only" htmlFor="bot-episode-search">Search episodes</label>
          <input
            id="bot-episode-search"
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search episodes…"
            className="w-full rounded-lg border border-border bg-background py-2 pl-8 pr-8 text-xs outline-none focus:border-primary focus:ring-2 focus:ring-primary/10"
          />
          {searching ? <Loader2 className="absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 animate-spin text-muted-foreground" aria-label="Searching" /> : query ? (
            <button type="button" onClick={() => setQuery('')} aria-label="Clear search" className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><X className="h-3.5 w-3.5" /></button>
          ) : null}
        </div>
      </div>
      {searchError ? <p role="alert" className="text-xs text-destructive">{searchError}</p> : null}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <div className="space-y-2">
          {listState === 'error' && episodes.length === 0 ? (
            <p role="alert" className="flex items-center gap-1.5 rounded-xl border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive"><AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />{listError ?? 'Unable to load episodes.'}</p>
          ) : null}
          {(listState === 'loading' || listState === 'idle') && episodes.length === 0 ? (
            <div className="space-y-2" aria-busy="true"><Skeleton className="h-20 w-full" /><Skeleton className="h-20 w-full" /><Skeleton className="h-20 w-full" /></div>
          ) : null}
          {listState === 'ready' && episodes.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border p-6 text-center">
              <Activity className="mx-auto h-5 w-5 text-muted-foreground" aria-hidden="true" />
              <p className="mt-2 text-sm font-medium">No activity yet</p>
              <p className="mt-1 text-xs text-muted-foreground">Each time the bot wakes (a schedule, a message, a webhook, or Wake now) it records an episode here.</p>
            </div>
          ) : null}
          {episodes.length > 0 && visible.episodes.length === 0 && visible.extra.length === 0 && !searching ? (
            <p className="rounded-xl border border-dashed border-border p-4 text-center text-xs text-muted-foreground">
              {hits !== null ? `No episodes match “${query.trim()}”.` : `No ${filter} episodes.`}
            </p>
          ) : null}
          {visible.episodes.map((episode) => (
            <EpisodeRow key={episode.episode_id} episode={episode} now={now} selected={episode.episode_id === selectedId} onSelect={() => setSelectedId(episode.episode_id)} />
          ))}
          {visible.extra.length > 0 ? (
            <div className="space-y-1.5">
              <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">Older matches</p>
              {visible.extra.map((hit) => (
                <div key={hit.episode_id} className="rounded-xl border border-border/70 bg-card p-3 text-xs">
                  <p className="line-clamp-2">{truncateText(hit.summary, 240)}</p>
                  <p className="mt-1 font-mono text-[10px] text-muted-foreground">{hit.episode_id.slice(0, 8)} · older than the most recent 50</p>
                </div>
              ))}
            </div>
          ) : null}
        </div>

        <div className={selected ? 'order-first min-w-0 lg:order-none' : 'min-w-0'}>
          {selected ? (
            <EpisodeDetailPanel key={selected.episode_id} botId={botId} episode={selected} now={now} onClose={() => setSelectedId(null)} />
          ) : (
            <div className="hidden rounded-xl border border-dashed border-border p-6 text-center text-xs text-muted-foreground lg:block">Select an episode to see its plan, outcome, events, gate decisions and runs.</div>
          )}
        </div>
      </div>
    </div>
  );
}

export default ActivityTab;
