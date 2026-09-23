import { ArrowLeft, Bot, Pause, Play, Plus, Search } from 'lucide-react';

import { Button } from '../../../shared/view/ui';

export default function BotStudioHeader({ search, onSearchChange, onBackToChat, onNewBot, onPauseAll, pauseAllLabel = 'Pause all', isConnected = false }: {
  search: string;
  onSearchChange: (value: string) => void;
  onBackToChat: () => void;
  onNewBot: () => void;
  onPauseAll: () => void;
  pauseAllLabel?: string;
  isConnected?: boolean;
}) {
  return <header className="shrink-0 overflow-hidden border-b border-border/70 bg-card/80 px-4 py-3 backdrop-blur sm:px-6">
    <div className="flex min-w-0 flex-wrap items-center gap-3">
      <Button size="sm" variant="ghost" onClick={onBackToChat} title="Back to chat"><ArrowLeft className="h-3.5 w-3.5" /><span className="hidden sm:inline">Back to chat</span></Button>
      <div className="hidden h-7 w-px bg-border sm:block" />
      <div className="flex min-w-0 items-center gap-2"><Bot className="h-4 w-4 shrink-0 text-primary" /><h1 className="truncate text-base font-semibold">Bot Studio</h1><span className={`hidden items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider sm:inline-flex ${isConnected ? 'bg-emerald-500/10 text-emerald-600' : 'bg-muted text-muted-foreground'}`}><span className={`h-1.5 w-1.5 rounded-full ${isConnected ? 'bg-emerald-500' : 'bg-muted-foreground'}`} />{isConnected ? 'Live' : 'Offline'}</span></div>
    </div>
    <div className="mt-3 flex min-w-0 flex-wrap items-center gap-2">
      <label className="relative w-full min-w-0 flex-1 sm:min-w-[180px] sm:max-w-xl"><Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" /><input value={search} onChange={(event) => onSearchChange(event.target.value)} placeholder="Search bots and inbox…" aria-label="Search bots and inbox" className="h-9 w-full rounded-lg border border-border bg-background pl-8 pr-3 text-xs outline-none transition-colors placeholder:text-muted-foreground/70 focus:border-primary focus:ring-2 focus:ring-primary/10" /></label>
      <div className="flex shrink-0 items-center gap-2"><Button size="sm" variant="ghost" onClick={onPauseAll} title={`${pauseAllLabel} bots`}><span className="sr-only">{pauseAllLabel} bots</span>{pauseAllLabel === 'Resume all' ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}<span className="hidden md:inline">{pauseAllLabel}</span></Button><Button size="sm" onClick={onNewBot}><Plus className="h-3.5 w-3.5" />New bot</Button></div>
    </div>
  </header>;
}
