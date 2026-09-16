import { useEffect, useState } from 'react';
import { Pencil, Play, Power, Copy, Trash2 } from 'lucide-react';

import type { CreateMcSectionInput } from '../../mission-control/api/missionControlApi';
import { Button } from '../../../shared/view/ui';
import SegmentedControl from '../ui/SegmentedControl';
import Toggle from '../ui/Toggle';
import Tabs from '../ui/Tabs';
import type { BotAutonomy } from '../types';
import { botPatch, formatAge } from '../types';

import OverviewTab from './tabs/OverviewTab';
import BriefTab from './tabs/BriefTab';
import ToolsTab from './tabs/ToolsTab';
import TriggersTab from './tabs/TriggersTab';
import OutputsActionsTab from './tabs/OutputsActionsTab';
import TicksTab from './tabs/TicksTab';
import DangerTab from './tabs/DangerTab';
import type { BotDetailViewProps } from './contracts';

export type DetailTab = 'overview' | 'inbox' | 'brief' | 'tools' | 'triggers' | 'outputs' | 'ticks' | 'danger';
const DETAIL_TABS: DetailTab[] = ['overview', 'inbox', 'brief', 'tools', 'triggers', 'outputs', 'ticks', 'danger'];

export default function BotDetailView({ bot, items, runs, onUpdate, onRun, onDelete, onDuplicate, onEdit, onSelectItem, selectedTab, onTabChange, onSelectRun }: BotDetailViewProps) {
  const initialTab = DETAIL_TABS.includes(selectedTab as DetailTab) ? selectedTab as DetailTab : 'overview';
  const [tab, setTab] = useState<DetailTab>(initialTab);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    if (selectedTab && DETAIL_TABS.includes(selectedTab as DetailTab)) setTab(selectedTab as DetailTab);
  }, [selectedTab]);
  const changeTab = (nextTab: DetailTab) => { setTab(nextTab); onTabChange?.(nextTab); };
  const run = async () => { setBusy(true); try { const result = await onRun(); setNotice(result.created ? `Tick started · ${result.created} item${result.created === 1 ? '' : 's'} created.` : `Tick skipped${result.skipped ? ` · ${result.skipped} skipped` : ''}.`); } catch (error) { setNotice(error instanceof Error ? error.message : 'Unable to run bot.'); } finally { setBusy(false); } };
  const update = async (patch: Partial<CreateMcSectionInput>) => { setBusy(true); try { await onUpdate(patch); setNotice('Bot updated.'); } finally { setBusy(false); } };
  const deleteBot = async () => { if (!window.confirm(`Delete “${bot.title}”?`)) return; await onDelete(); };
  return <section className="flex min-h-0 flex-1 flex-col bg-muted/10"><div className="shrink-0 border-b border-border/70 bg-background px-4 py-4 sm:px-6"><div className="flex flex-wrap items-start gap-3"><div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-lg text-primary">{bot.icon || '🤖'}</div><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><h2 className="truncate text-base font-semibold">{bot.title}</h2><span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium capitalize text-muted-foreground">{bot.scope}</span>{bot.project_id ? <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">{bot.project_id}</span> : null}<span className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">{bot.provider}{bot.model ? ` · ${bot.model}` : ''}</span></div><p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{bot.purpose}</p><p className="mt-1 text-[10px] text-muted-foreground">{bot.schedule_cron ? `Trigger · ${bot.schedule_cron}` : 'Manual trigger'} · {bot.last_run_at ? `Last tick ${formatAge(bot.last_run_at)}` : 'No ticks yet'}</p></div><div className="flex items-center gap-1"><Button size="sm" variant="ghost" onClick={onEdit} title="Edit in Architect"><Pencil className="h-3.5 w-3.5" /><span className="hidden md:inline">Architect</span></Button><Button size="sm" variant="ghost" onClick={() => void run()} disabled={busy} title="Run bot now"><Play className="h-3.5 w-3.5" /><span className="hidden md:inline">Run now</span></Button><Button size="sm" variant="ghost" onClick={() => void onDuplicate()} aria-label="Duplicate bot" title="Duplicate bot"><Copy className="h-3.5 w-3.5" /></Button><Button size="sm" variant="ghost" onClick={() => void deleteBot()} aria-label="Delete bot" title="Delete bot"><Trash2 className="h-3.5 w-3.5 text-destructive" /></Button></div></div><div className="mt-4 flex flex-wrap items-center gap-3"><SegmentedControl value={bot.autonomy} onChange={(value: BotAutonomy) => void update(botPatch(value))} label="Bot autonomy" options={[{ value: 'dry_run', label: 'Dry run' }, { value: 'propose', label: 'Propose' }, { value: 'act', label: 'Act' }]} /><label className="flex items-center gap-2 text-xs text-muted-foreground"><Toggle checked={bot.enabled} onChange={(enabled) => void update({ enabled })} label="Enable bot" /><span className="flex items-center gap-1"><Power className="h-3 w-3" />{bot.enabled ? 'Enabled' : 'Paused'}</span></label>{notice ? <span className="text-xs text-muted-foreground">{notice}</span> : null}</div></div><Tabs value={tab} onChange={changeTab} options={[{ value: 'overview', label: 'Overview' }, { value: 'inbox', label: `Inbox${bot.pending ? ` · ${bot.pending}` : ''}` }, { value: 'brief', label: 'Brief' }, { value: 'tools', label: 'Tools' }, { value: 'triggers', label: 'Triggers' }, { value: 'outputs', label: 'Outputs & actions' }, { value: 'ticks', label: 'Ticks' }, { value: 'danger', label: 'Danger' }]} />{tab === 'overview' ? <OverviewTab bot={bot} items={items} runs={runs} /> : null}{tab === 'inbox' ? <div className="space-y-2 p-4 sm:p-6">{items.length ? items.map((item) => <button key={item.item_id} type="button" onClick={() => onSelectItem(item)} className="block w-full rounded-xl border border-border/70 bg-card p-3 text-left hover:border-primary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><p className="text-xs font-semibold">{item.title}</p><p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{item.summary}</p></button>) : <p className="text-xs text-muted-foreground">This bot has no inbox items.</p>}</div> : null}{tab === 'brief' ? <BriefTab bot={bot} onSave={update} /> : null}{tab === 'tools' ? <ToolsTab bot={bot} onSave={update} /> : null}{tab === 'triggers' ? <TriggersTab bot={bot} onSave={update} /> : null}{tab === 'outputs' ? <OutputsActionsTab bot={bot} onSave={update} /> : null}{tab === 'ticks' ? <TicksTab bot={bot} runs={runs} onSelectRun={onSelectRun} /> : null}{tab === 'danger' ? <DangerTab bot={bot} onDelete={deleteBot} /> : null}</section>;
}
