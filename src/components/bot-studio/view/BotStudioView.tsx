import { useMemo, useState, type CSSProperties } from 'react';
import { GripVertical, Loader2, Menu } from 'lucide-react';
import type { Project } from '../../../types/app';
import type { CreateMcSectionInput, McAction, McItem, McSection } from '../../mission-control/api/missionControlApi';
import { getActionSemantics } from '../../mission-control/utils/actionSemantics';
import { useBotStudio } from '../hooks/useBotStudio';
import { useBotStudioLayout } from '../hooks/useBotStudioLayout';
import type { BotTemplate } from '../templates/BotTemplatesGallery';
import BotTemplatesGallery from '../templates/BotTemplatesGallery';
import BotArchitect from '../architect/BotArchitect';
import { type Bot, type WorkThisSessionRequest } from '../types';
import { botStudioApi } from '../api/botStudioApi';
import BotStudioHeader, { type BotStudioViewKey } from './BotStudioHeader';
import BotRoster from './BotRoster';
import InboxView from './InboxView';
import BotDetailView from './BotDetailView';
import ContextPane from './ContextPane';
import ActivityView from './ActivityView';
import ImportView from './ImportView';

export default function BotStudioView({ projects, isMobile, onMenuClick, onBackToChat, onWorkThis }: { projects: Project[]; isMobile: boolean; onMenuClick?: () => void; onBackToChat: () => void; onWorkThis?: (request: WorkThisSessionRequest) => void }) {
  const data = useBotStudio();
  const layout = useBotStudioLayout();
  const [view, setView] = useState<BotStudioViewKey>('inbox');
  const [search, setSearch] = useState('');
  const [selectedBotId, setSelectedBotId] = useState<string | null>(null);
  const [selectedItem, setSelectedItem] = useState<McItem | null>(null);
  const [preview, setPreview] = useState<Record<string, unknown> | null>(null);
  const [operatorContexts, setOperatorContexts] = useState<Record<string, string>>({});
  const [bodyDrafts, setBodyDrafts] = useState<Record<string, Record<string, unknown>>>({});
  const [showArchitect, setShowArchitect] = useState(false);
  const [architectInitial, setArchitectInitial] = useState<(Partial<CreateMcSectionInput> & { section_id?: string }) | undefined>();
  const selectedBot = data.bots.find((bot) => bot.section_id === selectedBotId);
  const itemForContext = selectedItem ? data.items.find((item) => item.item_id === selectedItem.item_id) ?? selectedItem : null;
  const projectsForArchitect = projects.map((project) => ({ id: project.projectId, name: project.displayName, path: project.fullPath }));
  const inboxCount = data.bots.reduce((total, bot) => total + bot.pending, 0);
  const filteredItems = useMemo(() => data.items.filter((item) => { const bot = data.bots.find((entry) => entry.section_id === item.section_id); return `${item.title} ${item.summary} ${bot?.title ?? ''}`.toLowerCase().includes(search.toLowerCase()); }), [data.bots, data.items, search]);

  const openArchitect = (initial?: Partial<CreateMcSectionInput> & { section_id?: string }) => { setArchitectInitial(initial); setShowArchitect(true); };
  const saveArchitect = (section: McSection) => { data.setSections((current) => current.some((entry) => entry.section_id === section.section_id) ? current.map((entry) => entry.section_id === section.section_id ? section : entry) : [...current, section]); setSelectedBotId(section.section_id); setShowArchitect(false); setView('bots'); };
  const action = async (item: McItem, entry: McAction) => {
    const semantics = getActionSemantics(entry, item.title);
    if (semantics.confirmation && !window.confirm(semantics.confirmation)) return;
    const body = { ...(bodyDrafts[item.item_id] ?? item.body) };
    const context = operatorContexts[item.item_id] ?? (typeof item.body.operatorContext === 'string' ? item.body.operatorContext : '');
    if (context.trim()) body.operatorContext = context.trim(); else delete body.operatorContext;
    try { await data.applyAction(item, entry.id, body); setSelectedItem(null); } catch (error) { console.error('[BotStudio] action failed', error); }
  };
  const previewItem = async (item: McItem, entry?: McAction) => { try { const result = await data.previewItem?.(item.item_id, entry?.id); setPreview(result?.preview ?? null); setSelectedItem(item); } catch (error) { setPreview({ error: error instanceof Error ? error.message : 'Preview failed' }); setSelectedItem(item); } };
  const workItem = async (item: McItem) => { try { const result = await data.workThis?.(item.item_id); if (result && onWorkThis) onWorkThis({ sessionId: result.sessionId, projectId: result.projectId, projectPath: result.projectPath, provider: result.provider, prompt: result.prompt, title: item.title }); } catch (error) { setPreview({ error: error instanceof Error ? error.message : 'Unable to start work session' }); setSelectedItem(item); } };
  const updateBot = async (bot: Bot, patch: Partial<CreateMcSectionInput>) => { await data.updateBot(bot.section_id, patch); };
  const bulkPause = async () => { const shouldPause = data.bots.some((bot) => bot.enabled); if (!window.confirm(`${shouldPause ? 'Pause' : 'Resume'} all bots?`)) return; try { await botStudioApi.bulkUpdate('all', { enabled: !shouldPause }); await data.refresh({ runs: true }); } catch (error) { setPreview({ error: error instanceof Error ? error.message : 'Bulk update failed' }); } };
  const selectBot = (bot: Bot) => { setSelectedBotId(bot.section_id); setSelectedItem(null); setPreview(null); setView('bots'); };
  const selectItem = (item: McItem) => { setSelectedItem(item); setPreview(null); };

  if (data.isLoading && !data.bots.length) return <div className="flex h-full items-center justify-center gap-2 text-xs text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Loading Bot Studio…</div>;
  return <div className="flex h-full min-h-0 flex-col bg-background text-foreground">{isMobile && onMenuClick ? <button type="button" onClick={onMenuClick} aria-label="Open sidebar" className="absolute left-3 top-3 z-10 rounded-lg border border-border bg-card p-2 text-muted-foreground shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><Menu className="h-4 w-4" /></button> : null}<BotStudioHeader activeView={view} counts={{ inbox: inboxCount, bots: data.bots.length, activity: Object.values(data.runsBySection).reduce((total, runs) => total + runs.length, 0) }} search={search} onSearchChange={setSearch} onViewChange={(nextView) => { setView(nextView); setShowArchitect(false); }} onBackToChat={onBackToChat} onNewBot={() => openArchitect()} onPauseAll={() => void bulkPause()} onToggleRoster={layout.toggleRoster} onToggleContext={layout.toggleContext} rosterOpen={layout.rosterOpen} contextOpen={layout.contextOpen} />{data.error ? <div className="mx-4 mt-3 rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">{data.error}<button type="button" className="ml-2 underline" onClick={() => void data.refresh({ runs: true })}>Retry</button></div> : null}{showArchitect ? <div className="min-h-0 flex-1"><BotArchitect mode={architectInitial?.section_id ? 'edit' : 'create'} initialSection={architectInitial} projects={projectsForArchitect} onSaved={saveArchitect} onCancel={() => setShowArchitect(false)} /></div> : <div className="grid min-h-0 flex-1 grid-cols-1 xl:[grid-template-columns:var(--bot-grid)]" style={{ '--bot-grid': `${layout.rosterOpen ? `${layout.rosterWidth}px 8px` : ''} minmax(0,1fr)${layout.contextOpen ? ` 8px ${layout.contextWidth}px` : ''}` } as CSSProperties}>{layout.rosterOpen ? <><BotRoster bots={data.bots} selectedBotId={selectedBotId} search={search} onSelect={selectBot} /><button type="button" className="group hidden w-2 cursor-col-resize items-center justify-center border-border/70 bg-background/60 xl:flex" onPointerDown={(event) => layout.startResize('roster', event)} aria-label="Resize bot roster" title="Resize bot roster"><GripVertical className="h-5 w-3 text-muted-foreground/50 group-hover:text-primary" /></button></> : null}<main className="flex min-h-0 min-w-0 flex-col overflow-hidden">{view === 'inbox' ? <InboxView items={filteredItems} bots={data.bots} search="" selectedItemId={selectedItem?.item_id ?? null} onSelectItem={selectItem} onAction={(item, entry) => void action(item, entry)} onPreview={(item, entry) => void previewItem(item, entry)} onRetry={(item) => void data.retryItem(item)} onWork={(item) => void workItem(item)} onGenerateAssets={(item, force) => data.generateAssets(item.item_id, force)} /> : null}{view === 'bots' ? (selectedBot ? <BotDetailView bot={selectedBot} items={data.items.filter((item) => item.section_id === selectedBot.section_id)} runs={data.runsBySection[selectedBot.section_id] ?? []} onUpdate={(patch) => updateBot(selectedBot, patch)} onRun={() => data.runBot(selectedBot)} onDelete={async () => { await data.deleteBot(selectedBot.section_id); setSelectedBotId(null); setView('inbox'); }} onDuplicate={async () => { const copy: Partial<CreateMcSectionInput> = { title: `${selectedBot.title} copy`, icon: selectedBot.icon, scope: selectedBot.scope, project_id: selectedBot.project_id, mode: selectedBot.mode, schedule_cron: selectedBot.schedule_cron, provider: selectedBot.provider, model: selectedBot.model, permission_mode: selectedBot.permission_mode, dry_run: selectedBot.dry_run, auto_approve: selectedBot.auto_approve, produce_prompt: selectedBot.produce_prompt, produce_tools: selectedBot.produce_tools, resolve_prompt: selectedBot.resolve_prompt, resolve_tools: selectedBot.resolve_tools, actions: selectedBot.actions, enabled: false, tool_policy: selectedBot.tool_policy }; const duplicate = await data.createBot(copy); setSelectedBotId(duplicate.section_id); }} onEdit={() => openArchitect(selectedBot)} onSelectItem={selectItem} /> : <div className="flex flex-1 items-center justify-center p-8 text-center text-xs text-muted-foreground">Select a bot from the roster to inspect it.</div>) : null}{view === 'templates' ? <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6"><BotTemplatesGallery connectedMcpServers={[]} onUse={(template: BotTemplate) => openArchitect(template.section)} /></div> : null}{view === 'activity' ? <ActivityView bots={data.bots} runsBySection={data.runsBySection} isLoading={data.isLoading} /> : null}{view === 'import' ? <ImportView /> : null}</main>{layout.contextOpen ? <><button type="button" className="group hidden w-2 cursor-col-resize items-center justify-center border-border/70 bg-background/60 xl:flex" onPointerDown={(event) => layout.startResize('context', event)} aria-label="Resize context pane" title="Resize context pane"><GripVertical className="h-5 w-3 text-muted-foreground/50 group-hover:text-primary" /></button><ContextPane item={itemForContext} bot={selectedBot} preview={preview} operatorContext={itemForContext ? operatorContexts[itemForContext.item_id] ?? (typeof itemForContext.body.operatorContext === 'string' ? itemForContext.body.operatorContext : '') : ''} onOperatorContextChange={(value) => { if (itemForContext) setOperatorContexts((current) => ({ ...current, [itemForContext.item_id]: value })); }} onBodyChange={(body) => { if (itemForContext) setBodyDrafts((current) => ({ ...current, [itemForContext.item_id]: body })); }} onClose={() => setSelectedItem(null)} /></> : null}</div>}</div>;
}
