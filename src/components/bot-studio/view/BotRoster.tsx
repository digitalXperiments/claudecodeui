import { AlertCircle, Activity, CheckCircle2, FileInput, LayoutTemplate, PauseCircle, RotateCw, Inbox } from 'lucide-react';

import type { Bot, BotHealth } from '../types';
import { formatAge } from '../types';
import StatusPill from '../ui/StatusPill';
import BotIcon from '../ui/BotIcon';

type RosterView = 'inbox' | 'activity' | 'templates' | 'import';
type Group = { label: string; health: BotHealth; icon: typeof AlertCircle };

const groups: Group[] = [
  { label: 'Needs me', health: 'needs', icon: AlertCircle },
  { label: 'Healthy', health: 'healthy', icon: CheckCircle2 },
  { label: 'Paused', health: 'paused', icon: PauseCircle },
  { label: 'Failing', health: 'failing', icon: RotateCw },
];

const subNavigation: Array<{ view: RosterView; label: string; icon: typeof Inbox }> = [
  { view: 'inbox', label: 'Inbox', icon: Inbox },
  { view: 'activity', label: 'Activity', icon: Activity },
  { view: 'templates', label: 'Templates', icon: LayoutTemplate },
  { view: 'import', label: 'Import', icon: FileInput },
];

export default function BotRoster({ bots, selectedBotId, search, onSelect, activeView, onNavigate }: { bots: Bot[]; selectedBotId: string | null; search: string; onSelect: (bot: Bot) => void; activeView?: RosterView; onNavigate?: (view: RosterView) => void }) {
  const filtered = bots.filter((bot) => `${bot.title} ${bot.purpose} ${bot.provider}`.toLowerCase().includes(search.trim().toLowerCase()));
  return <aside className="flex min-h-0 flex-col border-b border-border/70 bg-card/30 xl:border-b-0"><div className="border-b border-border/70 px-4 py-3"><p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">Bot Studio</p><p className="mt-1 text-xs text-muted-foreground">{filtered.length} bot{filtered.length === 1 ? '' : 's'}</p></div><nav aria-label="Bot Studio sections" className="border-b border-border/70 p-2">{subNavigation.map(({ view, label, icon: Icon }) => <button key={view} type="button" onClick={() => onNavigate?.(view)} className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${activeView === view ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-accent/40 hover:text-foreground'}`}><Icon className="h-3.5 w-3.5" />{label}</button>)}</nav><div className="min-h-0 flex-1 overflow-y-auto p-2">{groups.map((group) => { const grouped = filtered.filter((bot) => bot.health === group.health); if (!grouped.length) return null; return <section key={group.health} className="mb-4"><div className="flex items-center gap-1.5 px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground"><group.icon className="h-3 w-3" />{group.label}<span className="ml-auto">{grouped.length}</span></div>{grouped.map((bot) => <button key={bot.section_id} type="button" onClick={() => onSelect(bot)} className={`mb-1 w-full rounded-xl border p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${selectedBotId === bot.section_id ? 'border-primary/40 bg-primary/5' : 'border-transparent hover:border-border/70 hover:bg-accent/40'}`}><div className="flex min-w-0 items-start gap-2"><span className="flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-primary/10 text-primary"><BotIcon icon={bot.icon} size={18} /></span><span className="min-w-0 flex-1"><span className="block truncate text-xs font-semibold">{bot.title}</span><span className="mt-1 block truncate text-[10px] text-muted-foreground">{bot.purpose}</span></span>{bot.pending > 0 ? <span className="shrink-0 rounded-full bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700 dark:text-amber-300">{bot.pending}</span> : null}</div><div className="mt-2 flex min-w-0 items-center gap-2"><StatusPill status={bot.autonomy} /><span className={`min-w-0 flex-1 truncate text-[10px] ${bot.health === 'failing' ? 'text-destructive' : 'text-muted-foreground'}`}>{bot.health === 'failing' ? 'Last tick failed' : bot.schedule_cron ? `Next tick · ${bot.schedule_cron}` : bot.last_run_at ? `Last tick ${formatAge(bot.last_run_at)}` : 'No ticks yet'}</span></div></button>)}</section>; })}{filtered.length === 0 ? <div className="rounded-xl border border-dashed border-border p-5 text-center text-xs text-muted-foreground">No bots match this search.</div> : null}</div></aside>;
}
