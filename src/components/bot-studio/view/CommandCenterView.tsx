import {
  AlertTriangle,
  ArrowRight,
  Bot as BotGlyph,
  CheckCircle2,
  CircleDollarSign,
  Clock3,
  Inbox,
  LayoutDashboard,
  PauseCircle,
  PlayCircle,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useMemo } from 'react';

import { cn } from '../../../lib/utils';
import type { BotRun } from '../api/botStudioApi';
import type { Bot, BotHealth } from '../types';
import { formatAge } from '../types';
import BotIcon from '../ui/BotIcon';
import Skeleton from '../ui/Skeleton';
import StatusPill from '../ui/StatusPill';

import { selectCommandCenterSnapshot } from './dashboard/commandCenterSelectors';

type CommandCenterViewProps = {
  bots: Bot[];
  runsBySection: Record<string, BotRun[]>;
  search: string;
  isLoading?: boolean;
  onLoad?: () => void;
  onSelectBot: (bot: Bot) => void;
  onOpenInbox: () => void;
  onOpenActivity: () => void;
};

const healthLabels: Record<BotHealth, string> = {
  healthy: 'Healthy',
  needs: 'Needs attention',
  failing: 'Failing',
  paused: 'Paused',
};

const healthStyles: Record<BotHealth, string> = {
  healthy: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
  needs: 'bg-amber-500/10 text-amber-700 dark:text-amber-300',
  failing: 'bg-destructive/10 text-destructive',
  paused: 'bg-muted text-muted-foreground',
};

function HealthPill({ health }: { health: BotHealth }) {
  return <span className={cn('inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[10px] font-medium', healthStyles[health])}>{healthLabels[health]}</span>;
}

function Metric({ label, value, detail, icon: Icon, tone = 'default', onClick }: {
  label: string;
  value: string;
  detail: string;
  icon: LucideIcon;
  tone?: 'default' | 'success' | 'warning' | 'error';
  onClick?: () => void;
}) {
  const toneClass = tone === 'success'
    ? 'bg-emerald-500/10 text-emerald-600'
    : tone === 'warning'
      ? 'bg-amber-500/10 text-amber-600'
      : tone === 'error'
        ? 'bg-destructive/10 text-destructive'
        : 'bg-primary/10 text-primary';
  const content = <>
    <span className={cn('flex h-9 w-9 shrink-0 items-center justify-center rounded-xl', toneClass)}><Icon className="h-4 w-4" /></span>
    <span className="min-w-0">
      <span className="block text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">{label}</span>
      <span className="mt-1 flex items-baseline gap-2"><span className="text-xl font-semibold tabular-nums">{value}</span><span className="truncate text-[10px] text-muted-foreground">{detail}</span></span>
    </span>
  </>;
  const className = 'flex min-w-0 items-center gap-3 rounded-xl border border-border/70 bg-card p-3 text-left shadow-sm transition-colors';
  return onClick
    ? <button type="button" onClick={onClick} className={cn(className, 'hover:border-primary/30 hover:bg-accent/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring')}>{content}</button>
    : <div className={className}>{content}</div>;
}

export default function CommandCenterView({
  bots,
  runsBySection,
  search,
  isLoading = false,
  onLoad,
  onSelectBot,
  onOpenInbox,
  onOpenActivity,
}: CommandCenterViewProps) {
  useEffect(() => { onLoad?.(); }, [onLoad]);
  const needle = search.trim().toLowerCase();
  const visibleBots = useMemo(
    () => needle
      ? bots.filter((bot) => [bot.title, bot.purpose, bot.provider, bot.model ?? ''].join(' ').toLowerCase().includes(needle))
      : bots,
    [bots, needle],
  );
  const visibleIds = useMemo(() => new Set(visibleBots.map((bot) => bot.section_id)), [visibleBots]);
  const visibleRuns = useMemo(
    () => Object.fromEntries(Object.entries(runsBySection).filter(([sectionId]) => visibleIds.has(sectionId))),
    [runsBySection, visibleIds],
  );
  const snapshot = useMemo(() => selectCommandCenterSnapshot(visibleBots, visibleRuns), [visibleBots, visibleRuns]);

  return <section className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
    <div className="mx-auto max-w-7xl">
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-primary"><LayoutDashboard className="h-4 w-4" /><p className="text-[10px] font-semibold uppercase tracking-[0.16em]">Fleet overview</p></div>
          <h2 className="mt-1 text-xl font-semibold">Command center</h2>
          <p className="mt-1 text-xs text-muted-foreground">What is running, what needs you, and how the fleet is performing today.</p>
        </div>
        {needle ? <p className="rounded-full bg-muted px-2.5 py-1 text-[10px] text-muted-foreground">Showing {visibleBots.length} of {bots.length} bots</p> : null}
      </div>

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-4">
        <Metric label="Running now" value={String(snapshot.runningRuns.length)} detail={snapshot.runningRuns.length === 1 ? 'active tick' : 'active ticks'} icon={PlayCircle} onClick={onOpenActivity} />
        <Metric label="Needs attention" value={String(snapshot.attentionBots.length)} detail={snapshot.failedToday ? String(snapshot.failedToday) + ' failed today' : 'bots requiring review'} icon={AlertTriangle} tone={snapshot.attentionBots.length ? 'warning' : 'success'} onClick={onOpenInbox} />
        <Metric label="Resolved today" value={String(snapshot.resolvedToday)} detail={String(snapshot.ticksToday) + ' ticks loaded'} icon={CheckCircle2} tone="success" />
        <Metric label="Spend today" value={snapshot.costToday ? '$' + snapshot.costToday.toFixed(2) : '—'} detail="across loaded ticks" icon={CircleDollarSign} />
      </div>

      <div className="mt-5 grid gap-4 xl:grid-cols-2">
        <div className="overflow-hidden rounded-xl border border-border/70 bg-card">
          <div className="flex items-center justify-between border-b border-border/70 px-4 py-3">
            <div><p className="text-xs font-semibold">Needs attention</p><p className="mt-0.5 text-[10px] text-muted-foreground">Failures and work awaiting review</p></div>
            <button type="button" onClick={onOpenInbox} className="flex items-center gap-1 rounded text-[10px] font-medium text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">Open inbox<ArrowRight className="h-3 w-3" /></button>
          </div>
          <div className="divide-y divide-border/50">
            {snapshot.attentionBots.slice(0, 5).map((bot) => <button key={bot.section_id} type="button" onClick={() => onSelectBot(bot)} className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-accent/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-primary/10 text-primary"><BotIcon icon={bot.icon} size={17} /></span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2"><span className="truncate text-xs font-medium">{bot.title}</span><HealthPill health={bot.health} /></span>
                <span className={cn('mt-1 block truncate text-[10px]', bot.health === 'failing' ? 'text-destructive' : 'text-muted-foreground')}>
                  {bot.health === 'failing' ? bot.lastError || String(bot.failed) + ' failed item' + (bot.failed === 1 ? '' : 's') : String(bot.pending) + ' item' + (bot.pending === 1 ? '' : 's') + ' waiting for review'}
                </span>
              </span>
              <ArrowRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            </button>)}
            {!snapshot.attentionBots.length ? <div className="flex min-h-36 flex-col items-center justify-center px-5 py-8 text-center">
              <span className="flex h-9 w-9 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-600"><CheckCircle2 className="h-4 w-4" /></span>
              <p className="mt-3 text-xs font-medium">Nothing needs attention</p>
              <p className="mt-1 text-[10px] text-muted-foreground">The visible fleet has no failed bots or pending reviews.</p>
            </div> : null}
          </div>
        </div>

        <div className="overflow-hidden rounded-xl border border-border/70 bg-card">
          <div className="flex items-center justify-between border-b border-border/70 px-4 py-3">
            <div><p className="text-xs font-semibold">Recent activity</p><p className="mt-0.5 text-[10px] text-muted-foreground">Latest ticks across the fleet</p></div>
            <button type="button" onClick={onOpenActivity} className="flex items-center gap-1 rounded text-[10px] font-medium text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">View activity<ArrowRight className="h-3 w-3" /></button>
          </div>
          <div className="divide-y divide-border/50">
            {isLoading && !snapshot.recentRuns.length ? <div className="space-y-2 p-4" role="status" aria-label="Loading recent bot activity"><Skeleton className="h-9 w-full" /><Skeleton className="h-9 w-full" /><Skeleton className="h-9 w-full" /></div> : snapshot.recentRuns.slice(0, 5).map(({ bot, run }) => <button key={bot.section_id + '-' + run.run_id} type="button" onClick={() => onSelectBot(bot)} className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-accent/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-primary/10 text-primary"><BotIcon icon={bot.icon} size={17} /></span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs font-medium">{bot.title}</span>
                <span className="mt-1 flex min-w-0 items-center gap-2 text-[10px] text-muted-foreground">
                  <span className="truncate">{run.trigger || 'manual'} tick</span><span>·</span><span className="shrink-0">{formatAge(run.started_at)}</span>
                  {run.cost_usd != null ? <><span>·</span><span className="shrink-0">{'$'}{run.cost_usd.toFixed(2)}</span></> : null}
                </span>
              </span>
              <StatusPill status={run.status} />
            </button>)}
            {!isLoading && !snapshot.recentRuns.length ? <div className="flex min-h-36 flex-col items-center justify-center px-5 py-8 text-center">
              <span className="flex h-9 w-9 items-center justify-center rounded-full bg-muted text-muted-foreground"><Clock3 className="h-4 w-4" /></span>
              <p className="mt-3 text-xs font-medium">No ticks recorded yet</p>
              <p className="mt-1 text-[10px] text-muted-foreground">Run a bot to start building its activity history.</p>
            </div> : null}
          </div>
        </div>
      </div>

      <div className="mt-5 overflow-hidden rounded-xl border border-border/70 bg-card">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/70 px-4 py-3">
          <div><p className="text-xs font-semibold">Fleet</p><p className="mt-0.5 text-[10px] text-muted-foreground">{snapshot.healthyBots} healthy · {snapshot.pausedBots} paused · {visibleBots.length} total</p></div>
          <div className="flex items-center gap-1 text-[10px] text-muted-foreground"><BotGlyph className="h-3 w-3" />Select a bot to inspect it</div>
        </div>
        {visibleBots.length ? <div className="divide-y divide-border/50">{visibleBots.map((bot) => <button key={bot.section_id} type="button" onClick={() => onSelectBot(bot)} className="grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-accent/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:grid-cols-[minmax(0,1.5fr)_minmax(100px,.7fr)_minmax(100px,.7fr)_auto]">
          <span className="flex min-w-0 items-center gap-3">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-primary/10 text-primary"><BotIcon icon={bot.icon} size={17} /></span>
            <span className="min-w-0"><span className="block truncate text-xs font-medium">{bot.title}</span><span className="mt-0.5 block truncate text-[10px] text-muted-foreground">{bot.purpose}</span></span>
          </span>
          <span className="hidden min-w-0 text-[10px] text-muted-foreground sm:block"><span className="block truncate capitalize">{bot.provider}{bot.model ? ' · ' + bot.model : ''}</span><span className="mt-0.5 block truncate">{bot.scope === 'project' ? 'Project scoped' : 'Global'}</span></span>
          <span className="hidden text-[10px] text-muted-foreground sm:block"><span className="block">{bot.last_run_at ? 'Last tick ' + formatAge(bot.last_run_at) : 'No ticks yet'}</span><span className="mt-0.5 block">{bot.resolvedToday} resolved today</span></span>
          <span className="flex items-center gap-2"><HealthPill health={bot.health} />{bot.health === 'paused' ? <PauseCircle className="h-3.5 w-3.5 text-muted-foreground" /> : bot.pending > 0 ? <span className="rounded-full bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700 dark:text-amber-300">{bot.pending}</span> : null}</span>
        </button>)}</div> : <div className="flex min-h-44 flex-col items-center justify-center px-5 py-8 text-center">
          <span className="flex h-10 w-10 items-center justify-center rounded-full bg-muted text-muted-foreground"><Inbox className="h-4 w-4" /></span>
          <p className="mt-3 text-xs font-medium">{needle ? 'No bots match this search' : 'No bots in the fleet yet'}</p>
          <p className="mt-1 text-[10px] text-muted-foreground">{needle ? 'Try a different name, purpose, provider, or model.' : 'Create a bot or start from a template.'}</p>
        </div>}
      </div>
    </div>
  </section>;
}
