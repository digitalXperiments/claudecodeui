import { Activity, ArrowLeft, Bot, Inbox, LayoutTemplate, PanelLeft, PanelRight, Pause, Play, Plus, Search } from 'lucide-react';

import { Button } from '../../../shared/view/ui';
import SegmentedControl from '../ui/SegmentedControl';

export type BotStudioViewKey = 'inbox' | 'bots' | 'templates' | 'activity' | 'import';

export default function BotStudioHeader({ activeView, counts, search, onSearchChange, onViewChange, onBackToChat, onNewBot, onPauseAll, pauseAllLabel = 'Pause all', onToggleRoster, onToggleContext, rosterOpen, contextOpen, isConnected = false }: {
  activeView: BotStudioViewKey;
  counts: { inbox: number; bots: number; templates?: number; activity?: number };
  search: string;
  onSearchChange: (value: string) => void;
  onViewChange: (value: BotStudioViewKey) => void;
  onBackToChat: () => void;
  onNewBot: () => void;
  onPauseAll: () => void;
  pauseAllLabel?: string;
  onToggleRoster: () => void;
  onToggleContext: () => void;
  rosterOpen: boolean;
  contextOpen: boolean;
  isConnected?: boolean;
}) {
  return <header className="shrink-0 border-b border-border/70 bg-card/80 px-3 py-3 backdrop-blur sm:px-5">
    <div className="flex flex-wrap items-center gap-3">
      <Button size="sm" variant="ghost" onClick={onBackToChat} title="Back to chat"><ArrowLeft className="h-3.5 w-3.5" /><span className="hidden sm:inline">Back to chat</span></Button>
      <div className="hidden h-7 w-px bg-border sm:block" />
      <div className="flex min-w-0 items-center gap-2"><Bot className="h-4 w-4 shrink-0 text-primary" /><h1 className="truncate text-base font-semibold">Bot Studio</h1><span className={`hidden items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider sm:inline-flex ${isConnected ? 'bg-emerald-500/10 text-emerald-600' : 'bg-muted text-muted-foreground'}`}><span className={`h-1.5 w-1.5 rounded-full ${isConnected ? 'bg-emerald-500' : 'bg-muted-foreground'}`} />{isConnected ? 'Live' : 'Offline'}</span></div>
      <div className="ml-auto flex items-center gap-1"><Button size="sm" variant="ghost" onClick={onToggleRoster} aria-label={`${rosterOpen ? 'Collapse' : 'Expand'} bot roster`} title="Toggle bot roster"><PanelLeft className="h-3.5 w-3.5" /></Button><Button size="sm" variant="ghost" onClick={onToggleContext} aria-label={`${contextOpen ? 'Collapse' : 'Expand'} context pane`} title="Toggle context pane"><PanelRight className="h-3.5 w-3.5" /></Button></div>
    </div>
    <div className="mt-3 flex flex-wrap items-center gap-2">
      <SegmentedControl value={activeView} onChange={onViewChange} label="Bot Studio views" options={[{ value: 'inbox', label: <><Inbox className="mr-1 inline h-3 w-3" />Inbox</>, count: counts.inbox }, { value: 'bots', label: <><Bot className="mr-1 inline h-3 w-3" />Bots</>, count: counts.bots }, { value: 'templates', label: <><LayoutTemplate className="mr-1 inline h-3 w-3" />Templates</>, count: counts.templates }, { value: 'activity', label: <><Activity className="mr-1 inline h-3 w-3" />Activity</>, count: counts.activity }]} />
      <label className="relative min-w-[180px] flex-1 sm:max-w-xs"><Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" /><input value={search} onChange={(event) => onSearchChange(event.target.value)} placeholder="Search bots and inbox…" aria-label="Search bots and inbox" className="h-9 w-full rounded-lg border border-border bg-background pl-8 pr-3 text-xs outline-none transition-colors placeholder:text-muted-foreground/70 focus:border-primary focus:ring-2 focus:ring-primary/10" /></label>
      <Button size="sm" variant="ghost" onClick={onPauseAll} title={`${pauseAllLabel} bots`}><span className="sr-only">{pauseAllLabel} bots</span>{pauseAllLabel === 'Resume all' ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}<span className="hidden md:inline">{pauseAllLabel}</span></Button><Button size="sm" onClick={onNewBot}><Plus className="h-3.5 w-3.5" />New bot</Button>
    </div>
  </header>;
}
