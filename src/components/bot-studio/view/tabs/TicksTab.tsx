import type { Bot } from '../../types';
import type { BotRun } from '../../api/botStudioApi';
import { formatAge } from '../../types';

export default function TicksTab({ bot, runs, onSelectRun }: { bot: Bot; runs: BotRun[]; onSelectRun?: (run: BotRun) => void }) {
  return <div className="p-4 sm:p-6"><p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">Ticks</p><div className="mt-3 divide-y divide-border/60 rounded-xl border border-border/70 bg-card">{runs.length ? runs.map((run) => <button key={run.run_id} type="button" onClick={() => onSelectRun?.(run)} className="flex w-full items-center gap-3 px-4 py-3 text-left text-xs hover:bg-accent/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><span className="h-1.5 w-1.5 rounded-full bg-primary" /><span className="flex-1 capitalize">{run.status} · {run.trigger || 'manual'}</span><span className="text-muted-foreground">{run.started_at ? formatAge(run.started_at) : '—'}</span><span className="text-muted-foreground">{run.duration_ms != null ? `${Math.round(run.duration_ms)}ms` : ''}</span></button>) : <p className="px-4 py-5 text-xs text-muted-foreground">No ticks recorded for {bot.title}.</p>}</div></div>;
}
