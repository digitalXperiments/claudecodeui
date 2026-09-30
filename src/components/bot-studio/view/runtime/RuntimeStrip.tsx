import { Activity, CircleDollarSign, Gauge, Newspaper, ShieldAlert, ShieldQuestion, Zap, type LucideIcon } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import { cn } from '../../../../lib/utils';
import { botRuntimeApi } from '../../api/botRuntimeApi';
import { useBotRuntimeStatus } from '../../hooks/useBotRuntime';
import type { Bot } from '../../types';
import type { BotEpisode } from '../../types/botRuntime';

import { BRIEF_PRESETS, briefSince, formatUsd, titleLookup } from './briefModel';
import { mapLimit } from './concurrency';
import { botsToSample, runningTitles, runtimeState, summarizeEpisodes, type EpisodeSummary } from './runtimeStripModel';

const AGGREGATE_REFRESH_MS = 60_000;
const FETCH_CONCURRENCY = 4;

type Aggregates = { gateAsks: number | null; episodes: EpisodeSummary | null; error: string | null };

/** Gate asks come from the brief (no global endpoint); tainted/cost are summed from recent episodes. */
function useStripAggregates(bots: Bot[]): Aggregates {
  const [state, setState] = useState<Aggregates>({ gateAsks: null, episodes: null, error: null });
  const sample = useMemo(() => botsToSample(bots), [bots]);
  const key = sample.map((bot) => bot.section_id).join(',');
  const sampleRef = useRef(sample);
  sampleRef.current = sample;

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      try {
        const [brief, lists] = await Promise.all([
          botRuntimeApi.brief.get(briefSince(BRIEF_PRESETS[0].id)),
          mapLimit(sampleRef.current, FETCH_CONCURRENCY, async (bot): Promise<[string, BotEpisode[]]> => {
            try {
              return [bot.section_id, await botRuntimeApi.episodes.list(bot.section_id, { limit: 50 })];
            } catch {
              return [bot.section_id, []];
            }
          }),
        ]);
        if (cancelled) return;
        setState({ gateAsks: brief.gate_decisions_awaiting.length, episodes: summarizeEpisodes(Object.fromEntries(lists)), error: null });
      } catch (caught) {
        if (!cancelled) setState((current) => ({ ...current, error: caught instanceof Error ? caught.message : 'Unable to load runtime figures' }));
      }
    };
    void run();
    const timer = setInterval(() => void run(), AGGREGATE_REFRESH_MS);
    return () => { cancelled = true; clearInterval(timer); };
  }, [key]);

  return state;
}

function Stat({ label, value, detail, icon: Icon, tone = 'default', onClick, title }: {
  label: string;
  value: string;
  detail?: string;
  icon: LucideIcon;
  tone?: 'default' | 'success' | 'warning' | 'error';
  onClick?: () => void;
  title?: string;
}) {
  const toneClass = tone === 'success' ? 'bg-emerald-500/10 text-emerald-600' : tone === 'warning' ? 'bg-amber-500/10 text-amber-600' : tone === 'error' ? 'bg-destructive/10 text-destructive' : 'bg-primary/10 text-primary';
  const content = <>
    <span className={cn('flex h-8 w-8 shrink-0 items-center justify-center rounded-lg', toneClass)}><Icon className="h-3.5 w-3.5" /></span>
    <span className="min-w-0">
      <span className="block text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">{label}</span>
      <span className="flex items-baseline gap-1.5"><span className="text-base font-semibold tabular-nums">{value}</span>{detail ? <span className="truncate text-[10px] text-muted-foreground">{detail}</span> : null}</span>
    </span>
  </>;
  const className = 'flex min-w-0 items-center gap-2.5 rounded-lg border border-border/70 bg-card px-3 py-2 text-left';
  return onClick
    ? <button type="button" onClick={onClick} title={title} className={cn(className, 'transition-colors hover:border-primary/30 hover:bg-accent/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring')}>{content}</button>
    : <div className={className} title={title}>{content}</div>;
}

/** Command Center runtime strip (Bot runtime v2 only). */
export default function RuntimeStrip({ bots, onOpenBrief }: { bots: Bot[]; onOpenBrief: () => void }) {
  const { status, error, loading } = useBotRuntimeStatus();
  const aggregates = useStripAggregates(bots);
  const titleOf = useMemo(() => titleLookup(bots), [bots]);
  const runtime = runtimeState(status, error);
  const active = runningTitles(status, titleOf);
  const figure = (value: number | undefined | null): string => (value === null || value === undefined ? '…' : String(value));
  const tainted = aggregates.episodes?.taintedLast24h ?? null;
  const gate = aggregates.gateAsks;

  return <div className="mb-3" aria-label="Bot runtime">
    <div className="mb-2 flex items-center justify-between gap-2">
      <div className="flex items-center gap-1.5 text-primary"><Gauge className="h-3.5 w-3.5" /><p className="text-[10px] font-semibold uppercase tracking-[0.16em]">Runtime</p>{loading && !status ? <span className="text-[10px] text-muted-foreground">loading…</span> : null}</div>
      <button type="button" onClick={onOpenBrief} className="flex items-center gap-1 rounded-lg border border-border bg-background px-2.5 py-1 text-[11px] font-medium text-primary hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><Newspaper className="h-3 w-3" />Brief</button>
    </div>
    <div className="grid grid-cols-2 gap-2 lg:grid-cols-3 xl:grid-cols-6">
      <Stat label="Runtime" value={runtime.label} icon={Activity} tone={runtime.tone} title={runtime.detail} detail={runtime.state === 'stopped' ? 'forced off?' : runtime.state === 'running' ? runtime.detail : undefined} />
      <Stat label="Queued events" value={figure(status?.queuedEvents)} detail={status && status.queuedWakes ? `${status.queuedWakes} wake${status.queuedWakes === 1 ? '' : 's'}` : undefined} icon={Zap} />
      <Stat label="Active episodes" value={figure(status?.running.length)} detail={active.length ? active.slice(0, 2).join(', ') + (active.length > 2 ? ` +${active.length - 2}` : '') : undefined} title={active.join(', ') || undefined} icon={Activity} tone={active.length ? 'success' : 'default'} />
      <Stat label="Gate asks" value={figure(gate)} detail={gate ? 'waiting on you' : undefined} icon={ShieldQuestion} tone={gate ? 'warning' : 'default'} onClick={onOpenBrief} title="Open the brief to see pending action-gate approvals" />
      <Stat label="Cost today" value={aggregates.episodes ? formatUsd(aggregates.episodes.costToday) : '…'} detail="from recent episodes" icon={CircleDollarSign} />
      <Stat label="Tainted · 24h" value={figure(tainted)} detail={tainted ? 'episodes read untrusted input' : undefined} icon={ShieldAlert} tone={tainted ? 'warning' : 'default'} />
    </div>
    {error && !status ? <p className="mt-2 text-[10px] text-destructive">Runtime status unavailable: {error}</p> : null}
    {aggregates.error ? <p className="mt-2 text-[10px] text-muted-foreground">Some runtime figures are unavailable: {aggregates.error}</p> : null}
  </div>;
}
