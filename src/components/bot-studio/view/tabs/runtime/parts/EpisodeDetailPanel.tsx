import { AlertTriangle, ChevronRight, Loader2, RefreshCw, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { cn } from '../../../../../../lib/utils';
import { Button } from '../../../../../../shared/view/ui';
import { botRuntimeApi } from '../../../../api/botRuntimeApi';
import type { BotEpisode, BotEpisodeDetail, BotEvent } from '../../../../types/botRuntime';
import { formatDuration } from '../../../../ui/runFormatting';
import StatusPill from '../../../../ui/StatusPill';
import RunTimeline from '../../../RunTimeline';

import { episodeRunToBotRun, outcomeHasContent, parseEpisodeOutcome } from './episodes';
import GateDecisionList from './GateDecisionList';
import JsonDisclosure from './JsonDisclosure';
import { episodeDurationMs, formatCostUsd, shortDateTime, triggerKindLabels } from './runtimeFormat';
import TaintedBadge from './TaintedBadge';

const SectionLabel = ({ children }: { children: string }) => (
  <h4 className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">{children}</h4>
);

const TRUST_TONE: Record<string, string> = {
  operator: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
  internal: 'bg-sky-500/10 text-sky-700 dark:text-sky-300',
  external: 'bg-amber-500/10 text-amber-700 dark:text-amber-300',
};

function EventRow({ event }: { event: BotEvent }) {
  return (
    <li className="rounded-lg border border-border/70 bg-background p-2.5 text-xs">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="font-medium">{event.kind}</span>
        <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">source · {event.source}</span>
        <span className={cn('rounded-full px-2 py-0.5 text-[10px] font-medium capitalize', TRUST_TONE[event.trust] ?? 'bg-muted text-muted-foreground')}>{event.trust}</span>
        <span className="ml-auto text-[10px] text-muted-foreground">{shortDateTime(event.received_at)}</span>
      </div>
      <div className="mt-1.5"><JsonDisclosure label="Payload" value={event.payload} /></div>
    </li>
  );
}

function RunEntry({ run }: { run: BotEpisodeDetail['runs'][number] }) {
  const [open, setOpen] = useState(false);
  const botRun = episodeRunToBotRun(run);
  return (
    <li className="rounded-lg border border-border/70 bg-background">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        className="flex w-full flex-wrap items-center gap-1.5 rounded-lg p-2.5 text-left text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ChevronRight className={cn('h-3 w-3 shrink-0 transition-transform', open && 'rotate-90')} aria-hidden="true" />
        <span className="font-mono text-[11px]">{run.run_id.slice(0, 8)}</span>
        <StatusPill status={run.status} />
        {run.provider ? <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">{run.provider}{run.model ? ` · ${run.model}` : ''}</span> : null}
        <span className="ml-auto text-[10px] text-muted-foreground">{formatDuration(botRun.duration_ms)} · {formatCostUsd(run.cost_usd)}</span>
      </button>
      {open ? <div className="border-t border-border/70 p-2"><RunTimeline run={botRun} /></div> : null}
    </li>
  );
}

/**
 * Full record of one episode: plan, summary, outcome, the events that woke it, the gate decisions
 * it triggered, and its runs. The detail is refetched whenever the list row changes (live updates).
 */
export default function EpisodeDetailPanel({ botId, episode, now, onClose }: { botId: string; episode: BotEpisode; now: number; onClose: () => void }) {
  const [detail, setDetail] = useState<BotEpisodeDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const seq = useRef(0);
  const episodeId = episode.episode_id;
  // Changes whenever the live row changes, which is our cue to refetch events/decisions/runs.
  const version = `${episode.status}|${episode.finished_at ?? ''}|${episode.run_ids.length}|${episode.event_ids.length}`;

  const load = useCallback(async () => {
    const mine = ++seq.current;
    setLoading(true);
    try {
      const next = await botRuntimeApi.episodes.detail(botId, episodeId);
      if (seq.current !== mine) return;
      setDetail(next);
      setError(null);
    } catch (caught) {
      if (seq.current !== mine) return;
      setError(caught instanceof Error ? caught.message : 'Unable to load the episode.');
    } finally {
      if (seq.current === mine) setLoading(false);
    }
  }, [botId, episodeId]);

  useEffect(() => { setDetail(null); }, [episodeId]);
  useEffect(() => { void load(); }, [load, version]);

  const current = detail?.episode ?? episode;
  const outcome = parseEpisodeOutcome(current.outcome);
  const triggers = triggerKindLabels(current.trigger_kinds);

  return (
    <div className="rounded-xl border border-border/70 bg-card p-4" role="region" aria-label="Episode detail">
      <div className="flex flex-wrap items-center gap-1.5">
        <StatusPill status={current.status} />
        {triggers.map((label) => <span key={label} className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">{label}</span>)}
        {current.tainted ? <TaintedBadge /> : null}
        <span className="ml-auto flex items-center gap-1">
          <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => void load()} aria-label="Refresh episode detail" title="Refresh">
            {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          </Button>
          <Button size="icon" variant="ghost" className="h-7 w-7" onClick={onClose} aria-label="Close episode detail" title="Close"><X className="h-3.5 w-3.5" /></Button>
        </span>
      </div>
      <p className="mt-1 text-[11px] text-muted-foreground">
        Started {shortDateTime(current.started_at)} · {formatDuration(episodeDurationMs(current, now))} · {formatCostUsd(current.cost_usd)}
        {current.bot_version != null ? ` · bot v${current.bot_version}` : ''}
      </p>
      {error ? <p role="alert" className="mt-2 flex items-center gap-1.5 text-xs text-destructive"><AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />{error}</p> : null}

      <div className="mt-4 space-y-4">
        <section className="space-y-1.5">
          <SectionLabel>Summary</SectionLabel>
          <p className="whitespace-pre-wrap break-words text-xs text-foreground">{current.summary || 'No summary recorded yet.'}</p>
        </section>

        <section className="space-y-1.5">
          <SectionLabel>Plan</SectionLabel>
          {current.plan_text ? <p className="whitespace-pre-wrap break-words rounded-lg bg-muted/40 p-2.5 text-xs text-foreground">{current.plan_text}</p> : <p className="text-xs text-muted-foreground">No plan recorded.</p>}
        </section>

        <section className="space-y-1.5">
          <SectionLabel>Outcome</SectionLabel>
          {outcomeHasContent(outcome) ? (
            <div className="space-y-1.5 text-xs">
              <ul className="flex flex-wrap gap-1.5">
                {outcome.created > 0 || outcome.itemIds.length > 0 ? <li className="rounded-full bg-muted px-2 py-0.5 text-[10px]">{outcome.created || outcome.itemIds.length} item{(outcome.created || outcome.itemIds.length) === 1 ? '' : 's'} created</li> : null}
                {outcome.skipped > 0 ? <li className="rounded-full bg-muted px-2 py-0.5 text-[10px]">{outcome.skipped} skipped</li> : null}
                {outcome.commitments > 0 ? <li className="rounded-full bg-muted px-2 py-0.5 text-[10px]">{outcome.commitments} commitment{outcome.commitments === 1 ? '' : 's'}</li> : null}
                {outcome.goalUpdates > 0 ? <li className="rounded-full bg-muted px-2 py-0.5 text-[10px]">{outcome.goalUpdates} goal update{outcome.goalUpdates === 1 ? '' : 's'}</li> : null}
                {outcome.notified ? <li className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] text-primary">operator notified</li> : null}
                {outcome.flags.map((flag) => <li key={flag} className="rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] text-amber-700 dark:text-amber-300">{flag}</li>)}
              </ul>
              {outcome.itemIds.length > 0 ? <p className="break-all font-mono text-[10px] text-muted-foreground">{outcome.itemIds.join(', ')}</p> : null}
              {outcome.reply ? <blockquote className="whitespace-pre-wrap break-words rounded-lg border-l-2 border-primary/50 bg-muted/40 p-2.5 text-foreground"><span className="mb-1 block text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">Reply</span>{outcome.reply}</blockquote> : null}
              {outcome.error ? <p className="break-words text-destructive">{outcome.error}</p> : null}
              {outcome.notes.map((note) => <p key={note} className="text-[11px] text-muted-foreground">{note}</p>)}
            </div>
          ) : <p className="text-xs text-muted-foreground">{current.status === 'running' ? 'Still running.' : 'No outcome recorded.'}</p>}
          <JsonDisclosure label="Raw outcome" value={current.outcome} />
        </section>

        <section className="space-y-1.5">
          <SectionLabel>{`Events · ${detail?.events.length ?? current.event_ids.length}`}</SectionLabel>
          {detail && detail.events.length > 0 ? <ul className="space-y-1.5">{detail.events.map((event) => <EventRow key={event.event_id} event={event} />)}</ul> : <p className="text-xs text-muted-foreground">{detail ? 'No events attached.' : 'Loading…'}</p>}
        </section>

        <section className="space-y-1.5">
          <SectionLabel>{`Gate decisions · ${detail?.gate_decisions.length ?? 0}`}</SectionLabel>
          {detail ? <GateDecisionList decisions={detail.gate_decisions} now={now} /> : <p className="text-xs text-muted-foreground">Loading…</p>}
        </section>

        <section className="space-y-1.5">
          <SectionLabel>{`Runs · ${detail?.runs.length ?? current.run_ids.length}`}</SectionLabel>
          {detail && detail.runs.length > 0 ? <ul className="space-y-1.5">{detail.runs.map((run) => <RunEntry key={run.run_id} run={run} />)}</ul> : <p className="text-xs text-muted-foreground">{detail ? 'No runs recorded.' : 'Loading…'}</p>}
        </section>
      </div>
    </div>
  );
}
