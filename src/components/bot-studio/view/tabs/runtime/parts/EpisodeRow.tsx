import { Coins, Timer } from 'lucide-react';

import { cn } from '../../../../../../lib/utils';
import type { BotEpisode } from '../../../../types/botRuntime';
import { formatDuration } from '../../../../ui/runFormatting';
import StatusPill from '../../../../ui/StatusPill';

import { episodeDurationMs, formatCostUsd, formatRelativeTime, triggerKindLabels } from './runtimeFormat';
import TaintedBadge from './TaintedBadge';

export default function EpisodeRow({ episode, selected, now, onSelect }: { episode: BotEpisode; selected: boolean; now: number; onSelect: () => void }) {
  const triggers = triggerKindLabels(episode.trigger_kinds);
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={cn(
        'block w-full rounded-xl border bg-card p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        selected ? 'border-primary/60 bg-primary/5' : 'border-border/70 hover:border-border hover:bg-accent/40',
      )}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <StatusPill status={episode.status} />
        {triggers.map((label) => (
          <span key={label} className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">{label}</span>
        ))}
        {episode.tainted ? <TaintedBadge /> : null}
        <span className="ml-auto text-[10px] text-muted-foreground">{formatRelativeTime(episode.started_at, now)}</span>
      </div>
      <p className="mt-2 line-clamp-2 text-xs text-foreground">
        {episode.summary || (episode.status === 'running' ? 'Working…' : 'No summary recorded.')}
      </p>
      <div className="mt-2 flex items-center gap-3 text-[10px] text-muted-foreground">
        <span className="inline-flex items-center gap-1" title="Duration"><Timer className="h-3 w-3" aria-hidden="true" />{formatDuration(episodeDurationMs(episode, now))}</span>
        <span className="inline-flex items-center gap-1" title="Cost"><Coins className="h-3 w-3" aria-hidden="true" />{formatCostUsd(episode.cost_usd)}</span>
      </div>
    </button>
  );
}
