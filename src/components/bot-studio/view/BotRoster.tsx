import { AlertCircle, Bot as BotIcon, CheckCircle2, PauseCircle, RotateCw } from 'lucide-react';
import type { Bot } from '../types';
import { formatAge } from '../types';
import StatusPill from '../ui/StatusPill';
import Sparkline from '../ui/Sparkline';

type Group = { label: string; bots: Bot[]; icon: typeof BotIcon };

export default function BotRoster({ bots, selectedBotId, search, onSelect }: { bots: Bot[]; selectedBotId: string | null; search: string; onSelect: (bot: Bot) => void }) {
  const filtered = bots.filter((bot) => `${bot.title} ${bot.purpose} ${bot.provider}`.toLowerCase().includes(search.toLowerCase()));
  const groups: Group[] = [
    { label: 'Needs me', bots: filtered.filter((bot) => bot.pending > 0), icon: AlertCircle },
    { label: 'Healthy', bots: filtered.filter((bot) => bot.pending === 0 && bot.enabled && !bot.lastError), icon: CheckCircle2 },
    { label: 'Paused', bots: filtered.filter((bot) => !bot.enabled), icon: PauseCircle },
    { label: 'Failing', bots: filtered.filter((bot) => bot.enabled && Boolean(bot.lastError)), icon: RotateCw },
  ];
  return <aside className="flex min-h-0 flex-col border-b border-border/70 bg-card/30 xl:border-b-0"><div className="border-b border-border/70 px-4 py-3"><p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">Roster</p><p className="mt-1 text-xs text-muted-foreground">{filtered.length} bot{filtered.length === 1 ? '' : 's'}</p></div><div className="min-h-0 flex-1 overflow-y-auto p-2">{groups.map((group) => group.bots.length ? <section key={group.label} className="mb-4"><div className="flex items-center gap-1.5 px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground"><group.icon className="h-3 w-3" />{group.label}<span className="ml-auto">{group.bots.length}</span></div>{group.bots.map((bot) => <button key={bot.section_id} type="button" onClick={() => onSelect(bot)} className={`mb-1 w-full rounded-xl border p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${selectedBotId === bot.section_id ? 'border-primary/40 bg-primary/5' : 'border-transparent hover:border-border/70 hover:bg-accent/40'}`}><div className="flex items-start gap-2"><span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary"><span aria-hidden>{bot.icon || '🤖'}</span></span><span className="min-w-0 flex-1"><span className="block truncate text-xs font-semibold">{bot.title}</span><span className="mt-1 block truncate text-[10px] text-muted-foreground">{bot.purpose}</span></span>{bot.pending > 0 ? <span className="rounded-full bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700 dark:text-amber-300">{bot.pending}</span> : null}</div><div className="mt-2 flex items-center gap-2"><StatusPill status={bot.autonomy} /><span className="truncate text-[10px] text-muted-foreground">{bot.last_run_at ? `Last tick ${formatAge(bot.last_run_at)}` : 'No ticks yet'}</span><Sparkline /></div></button>)}</section> : null)}{filtered.length === 0 ? <div className="rounded-xl border border-dashed border-border p-5 text-center text-xs text-muted-foreground">No bots match this search.</div> : null}</div></aside>;
}
