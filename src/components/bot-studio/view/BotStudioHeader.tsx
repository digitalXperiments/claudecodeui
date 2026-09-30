import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Bot, ChevronDown, FileInput, LayoutTemplate, Pause, Play, Plus, Search, Sparkles } from 'lucide-react';

import { Button } from '../../../shared/view/ui';

/** "New bot" split button: the main click opens the Architect; the menu offers templates and import. */
function NewBotButton({ onNewBot, onTemplates, onImport }: { onNewBot: () => void; onTemplates?: () => void; onImport?: () => void }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return undefined;
    const onPointer = (event: PointerEvent) => { if (!rootRef.current?.contains(event.target as Node)) setOpen(false); };
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    window.addEventListener('pointerdown', onPointer);
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('pointerdown', onPointer); window.removeEventListener('keydown', onKey); };
  }, [open]);
  const choose = (handler?: () => void) => { setOpen(false); handler?.(); };
  const itemClass = 'flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-xs hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';
  return <div ref={rootRef} className="relative flex">
    <Button size="sm" onClick={onNewBot} className="rounded-r-none"><Plus className="h-3.5 w-3.5" />New bot</Button>
    <Button size="sm" onClick={() => setOpen((current) => !current)} className="rounded-l-none border-l border-primary-foreground/20 px-1.5" aria-label="More ways to create a bot" aria-haspopup="menu" aria-expanded={open}><ChevronDown className="h-3.5 w-3.5" /></Button>
    {open ? <div role="menu" className="absolute right-0 top-10 z-20 w-48 rounded-xl border border-border bg-popover p-1 shadow-lg">
      <button type="button" role="menuitem" className={itemClass} onClick={() => choose(onNewBot)}><Sparkles className="h-3.5 w-3.5" />Start with Architect</button>
      <button type="button" role="menuitem" className={itemClass} onClick={() => choose(onTemplates)}><LayoutTemplate className="h-3.5 w-3.5" />From a template</button>
      <button type="button" role="menuitem" className={itemClass} onClick={() => choose(onImport)}><FileInput className="h-3.5 w-3.5" />Import</button>
    </div> : null}
  </div>;
}

export default function BotStudioHeader({ search, onSearchChange, onBackToChat, onNewBot, onTemplates, onImport, onPauseAll, pauseAllLabel = 'Pause all', isConnected = false }: {
  search: string;
  onSearchChange: (value: string) => void;
  onBackToChat: () => void;
  onNewBot: () => void;
  onTemplates?: () => void;
  onImport?: () => void;
  onPauseAll: () => void;
  pauseAllLabel?: string;
  isConnected?: boolean;
}) {
  return <header className="relative z-20 shrink-0 border-b border-border/70 bg-card/80 px-4 py-3 backdrop-blur sm:px-6">
    <div className="flex min-w-0 flex-wrap items-center gap-3">
      <Button size="sm" variant="ghost" onClick={onBackToChat} title="Back to chat"><ArrowLeft className="h-3.5 w-3.5" /><span className="hidden sm:inline">Back to chat</span></Button>
      <div className="hidden h-7 w-px bg-border sm:block" />
      <div className="flex min-w-0 items-center gap-2"><Bot className="h-4 w-4 shrink-0 text-primary" /><h1 className="truncate text-base font-semibold">Bot Studio</h1><span className={`hidden items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider sm:inline-flex ${isConnected ? 'bg-emerald-500/10 text-emerald-600' : 'bg-muted text-muted-foreground'}`}><span className={`h-1.5 w-1.5 rounded-full ${isConnected ? 'bg-emerald-500' : 'bg-muted-foreground'}`} />{isConnected ? 'Live' : 'Offline'}</span></div>
    </div>
    <div className="mt-3 flex min-w-0 flex-wrap items-center gap-2">
      <label className="relative w-full min-w-0 flex-1 sm:min-w-[180px] sm:max-w-xl"><Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" /><input value={search} onChange={(event) => onSearchChange(event.target.value)} placeholder="Search bots and inbox…" aria-label="Search bots and inbox" className="h-9 w-full rounded-lg border border-border bg-background pl-8 pr-3 text-xs outline-none transition-colors placeholder:text-muted-foreground/70 focus:border-primary focus:ring-2 focus:ring-primary/10" /></label>
      <div className="flex shrink-0 items-center gap-2"><Button size="sm" variant="ghost" onClick={onPauseAll} title={`${pauseAllLabel} bots`}><span className="sr-only">{pauseAllLabel} bots</span>{pauseAllLabel === 'Resume all' ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}<span className="hidden md:inline">{pauseAllLabel}</span></Button><NewBotButton onNewBot={onNewBot} onTemplates={onTemplates} onImport={onImport} /></div>
    </div>
  </header>;
}
