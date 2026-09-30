import { AlertTriangle, CheckCircle2, Circle, Clock3, Loader2, Pause, Play, RefreshCw, RotateCcw, XCircle } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { cn } from '../../../lib/utils';
import { Button } from '../../../shared/view/ui';
import { botStudioApi, type BotRun, type BotRunTimeline } from '../api/botStudioApi';
import { formatAge } from '../types';
import StatusPill from '../ui/StatusPill';
import { formatDuration, isRunActive } from '../ui/runFormatting';

import { selectExplainableRunSteps, type TimelineTone } from './run-timeline/runTimelineSelectors';

const toneStyles: Record<TimelineTone, string> = {
  neutral: 'border-border bg-muted text-muted-foreground',
  info: 'border-primary/30 bg-primary/10 text-primary',
  success: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600',
  warning: 'border-amber-500/30 bg-amber-500/10 text-amber-600',
  error: 'border-destructive/30 bg-destructive/10 text-destructive',
};

function ToneIcon({ tone }: { tone: TimelineTone }) {
  const Icon = tone === 'success' ? CheckCircle2 : tone === 'warning' ? AlertTriangle : tone === 'error' ? XCircle : Circle;
  return <span className={cn('relative z-[1] flex h-6 w-6 shrink-0 items-center justify-center rounded-full border', toneStyles[tone])}><Icon className="h-3 w-3" /></span>;
}

function dateTime(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '—';
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' }).format(date);
}

function durationFor(timeline: BotRunTimeline | null, fallback: BotRun): number | null {
  if (!timeline) return fallback.duration_ms ?? null;
  const start = timeline.run.started_at ?? timeline.run.created_at;
  const end = timeline.run.finished_at ?? (isRunActive(timeline.run.status) ? new Date().toISOString() : null);
  if (!start || !end) return fallback.duration_ms ?? null;
  const duration = Date.parse(end) - Date.parse(start);
  return Number.isFinite(duration) ? Math.max(0, duration) : fallback.duration_ms ?? null;
}

export default function RunTimeline({ run }: { run: BotRun }) {
  const [timeline, setTimeline] = useState<BotRunTimeline | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [playbackIndex, setPlaybackIndex] = useState<number | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const generationRef = useRef(0);

  const load = useCallback(async (initial = false) => {
    const generation = ++generationRef.current;
    if (initial) setLoading(true);
    else setRefreshing(true);
    try {
      const next = await botStudioApi.getRunTimeline(run.run_id);
      if (generation !== generationRef.current) return;
      setTimeline(next);
      setError(null);
    } catch (nextError) {
      if (generation !== generationRef.current) return;
      setError(nextError instanceof Error ? nextError.message : 'Unable to load the run timeline.');
    } finally {
      if (generation === generationRef.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [run.run_id]);

  useEffect(() => {
    setTimeline(null);
    setError(null);
    void load(true);
    return () => { generationRef.current += 1; };
  }, [load]);

  const currentStatus = timeline?.run.status ?? run.status;
  useEffect(() => {
    if (!isRunActive(currentStatus)) return undefined;
    const interval = window.setInterval(() => void load(false), 2_500);
    return () => window.clearInterval(interval);
  }, [currentStatus, load]);

  const steps = useMemo(() => selectExplainableRunSteps(timeline?.events ?? []), [timeline?.events]);
  useEffect(() => {
    if (!isPlaying || playbackIndex == null || steps.length < 2) return undefined;
    const timeout = window.setTimeout(() => {
      if (playbackIndex >= steps.length - 1) {
        setIsPlaying(false);
        return;
      }
      setPlaybackIndex(playbackIndex + 1);
    }, 1_000);
    return () => window.clearTimeout(timeout);
  }, [isPlaying, playbackIndex, steps.length]);

  const startReplay = () => {
    if (playbackIndex == null || playbackIndex >= steps.length - 1) {
      setPlaybackIndex(0);
    }
    setIsPlaying(true);
  };
  const replayValue = playbackIndex ?? Math.max(steps.length - 1, 0);
  const visibleSteps = playbackIndex == null ? steps : steps.slice(0, playbackIndex + 1);
  const currentStep = playbackIndex == null ? null : steps[playbackIndex] ?? null;
  const detail = timeline?.run;
  const tokens = detail?.token_total ?? run.tokens ?? null;
  const cost = detail?.cost_usd_estimate ?? run.cost_usd ?? null;
  const duration = durationFor(timeline, run);
  const toolCalls = timeline?.events.filter((event) => event.type === 'tool.call').length ?? 0;

  return <div className="space-y-5 p-4">
    <section>
      <div className="flex flex-wrap items-center gap-2"><StatusPill status={currentStatus} />{refreshing ? <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground"><Loader2 className="h-3 w-3 animate-spin" />Updating</span> : null}</div>
      <p className="mt-2 text-xs text-muted-foreground">{detail?.provider ?? 'Unknown provider'}{detail?.model ? ' · ' + detail.model : ''}{detail?.effort ? ' · ' + detail.effort : ''}</p>
      <p className="mt-1 text-[10px] text-muted-foreground">{detail?.trigger ?? run.trigger ?? 'manual'} trigger · {detail?.started_at || run.started_at ? dateTime(detail?.started_at ?? run.started_at) : 'Not started'}</p>
    </section>

    <dl className="grid grid-cols-2 gap-2">
      <div className="rounded-lg border border-border/70 bg-card px-3 py-2"><dt className="text-[10px] text-muted-foreground">Duration</dt><dd className="mt-0.5 text-xs font-medium tabular-nums">{formatDuration(duration)}</dd></div>
      <div className="rounded-lg border border-border/70 bg-card px-3 py-2"><dt className="text-[10px] text-muted-foreground">Tool calls</dt><dd className="mt-0.5 text-xs font-medium tabular-nums">{timeline ? toolCalls : '—'}</dd></div>
      <div className="rounded-lg border border-border/70 bg-card px-3 py-2"><dt className="text-[10px] text-muted-foreground">Tokens</dt><dd className="mt-0.5 text-xs font-medium tabular-nums">{tokens?.toLocaleString() ?? '—'}</dd></div>
      <div className="rounded-lg border border-border/70 bg-card px-3 py-2"><dt className="text-[10px] text-muted-foreground">Cost</dt><dd className="mt-0.5 text-xs font-medium tabular-nums">{cost != null ? '$' + cost.toFixed(4) : '—'}</dd></div>
    </dl>

    {(detail?.error_summary ?? run.error_summary) ? <section className="rounded-lg border border-destructive/20 bg-destructive/10 px-3 py-2"><p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-destructive">Failure</p><p className="mt-1 whitespace-pre-wrap break-words text-xs leading-5 text-destructive">{detail?.error_summary ?? run.error_summary}</p></section> : null}
    {run.item_id ? <section className="rounded-lg border border-border/70 bg-card px-3 py-2"><p className="text-[10px] text-muted-foreground">Output</p><p className="mt-1 text-xs">Produced inbox item <span className="font-mono text-[10px]">{run.item_id}</span></p></section> : null}

    <section>
      <div className="flex items-center justify-between gap-2">
        <div><p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">Run story</p><p className="mt-0.5 text-[10px] text-muted-foreground">{steps.length ? String(steps.length) + ' durable events' : 'Durable run events'}</p></div>
        <Button size="sm" variant="ghost" onClick={() => void load(false)} disabled={loading || refreshing} title="Refresh run timeline"><RefreshCw className={cn('h-3 w-3', refreshing && 'animate-spin')} /><span className="sr-only">Refresh</span></Button>
      </div>

      {steps.length > 1 ? <div className="mt-3 rounded-lg border border-border/70 bg-card px-3 py-2.5">
        <div className="flex items-center gap-2">
          <Button size="icon" variant="outline" onClick={isPlaying ? () => setIsPlaying(false) : startReplay} aria-label={isPlaying ? 'Pause run replay' : playbackIndex == null || replayValue === steps.length - 1 ? 'Replay run from the beginning' : 'Continue run replay'} title={isPlaying ? 'Pause replay' : playbackIndex == null || replayValue === steps.length - 1 ? 'Replay from the beginning' : 'Continue replay'}>
            {isPlaying ? <Pause className="h-3.5 w-3.5" /> : playbackIndex == null || replayValue === steps.length - 1 ? <RotateCcw className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
          </Button>
          <label className="min-w-0 flex-1">
            <span className="sr-only">Replay position</span>
            <input type="range" min={0} max={steps.length - 1} step={1} value={replayValue} onChange={(event) => { setIsPlaying(false); setPlaybackIndex(Number(event.currentTarget.value)); }} className="h-1.5 w-full cursor-pointer accent-primary" aria-valuetext={`Step ${replayValue + 1} of ${steps.length}`} />
          </label>
          <span className="w-14 shrink-0 text-right text-[10px] tabular-nums text-muted-foreground">{playbackIndex == null ? 'All' : `${replayValue + 1}/${steps.length}`}</span>
        </div>
        {currentStep ? <div className="mt-2 flex items-start gap-2 border-t border-border/60 pt-2" aria-live="polite">
          <ToneIcon tone={currentStep.tone} />
          <div className="min-w-0 pt-0.5"><p className="text-xs font-medium">{currentStep.title}</p><p className="mt-0.5 whitespace-pre-wrap break-words text-[10px] leading-4 text-muted-foreground">{currentStep.description}</p></div>
        </div> : null}
      </div> : null}

      {loading && !timeline ? <div className="mt-4 flex items-center gap-2 rounded-lg border border-border/70 bg-card px-3 py-4 text-xs text-muted-foreground" role="status"><Loader2 className="h-3.5 w-3.5 animate-spin" />Loading the run story…</div> : null}
      {error ? <div className="mt-4 rounded-lg border border-amber-500/20 bg-amber-500/10 px-3 py-2" role="alert"><p className="text-xs font-medium text-amber-700 dark:text-amber-300">Detailed timeline unavailable</p><p className="mt-1 break-words text-[10px] leading-4 text-muted-foreground">{error}</p></div> : null}
      {!loading && !error && !steps.length ? <div className="mt-4 rounded-lg border border-dashed border-border px-3 py-5 text-center"><Clock3 className="mx-auto h-4 w-4 text-muted-foreground" /><p className="mt-2 text-xs font-medium">No durable events recorded</p><p className="mt-1 text-[10px] leading-4 text-muted-foreground">The summary above is available, but this older run has no event history.</p></div> : null}

      {visibleSteps.length ? <ol className="relative mt-4 space-y-0 before:absolute before:bottom-3 before:left-[11px] before:top-3 before:w-px before:bg-border">
        {visibleSteps.map((step, index) => <li key={step.id} aria-current={playbackIndex === index ? 'step' : undefined} className={cn('relative flex gap-3 pb-4 last:pb-0', playbackIndex === index && 'rounded-lg bg-primary/5')}>
          <ToneIcon tone={step.tone} />
          <div className="min-w-0 flex-1 pt-0.5">
            <div className="flex min-w-0 items-start justify-between gap-2"><p className="min-w-0 text-xs font-medium">{step.title}</p><time dateTime={step.timestamp} className="shrink-0 text-[9px] tabular-nums text-muted-foreground" title={dateTime(step.timestamp)}>{formatAge(step.timestamp)}</time></div>
            <p className="mt-1 whitespace-pre-wrap break-words text-[10px] leading-4 text-muted-foreground">{step.description}</p>
            {Object.keys(step.payload).length ? <details className="mt-1.5"><summary className="cursor-pointer select-none text-[9px] font-medium text-muted-foreground hover:text-foreground">Event data</summary><pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted/60 p-2 text-[9px] leading-4 text-muted-foreground">{JSON.stringify(step.payload, null, 2)}</pre></details> : null}
          </div>
        </li>)}
      </ol> : null}
    </section>

    <p className="border-t border-border/70 pt-3 text-[9px] leading-4 text-muted-foreground">Timeline events come from the durable run spine. Stored payloads are redacted before persistence.</p>
  </div>;
}
