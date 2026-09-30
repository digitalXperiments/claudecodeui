import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import { GripVertical, Menu } from 'lucide-react';
import { useLocation, useNavigate } from 'react-router-dom';

import type { Project } from '../../../types/app';
import { useDeviceSettings } from '../../../hooks/useDeviceSettings';
import type { CreateMcSectionInput, McAction, McItem, McSection, WorkProjectMatch } from '../../mission-control/api/missionControlApi';
import BotArchitect from '../architect/BotArchitect';
import type { BotTemplate } from '../templates/BotTemplatesGallery';
import BotTemplatesGallery from '../templates/BotTemplatesGallery';
import { useBotStudio } from '../hooks/useBotStudio';
import { useBotStudioLayout } from '../hooks/useBotStudioLayout';
import { getActionSemantics } from '../../mission-control/utils/actionSemantics';
import { routeWorkProject, workRetryMessage, type Bot, type WorkThisSessionRequest } from '../types';
import { botStudioApi, type BotException } from '../api/botStudioApi';
import InlineToast from '../ui/InlineToast';
import Skeleton from '../ui/Skeleton';

import ActivityView from './ActivityView';
import BoardView from './BoardView';
import BotDetailView from './BotDetailView';
import { resolveDetailTab } from './detail/detailTabs';
import BotRoster from './BotRoster';
import BotStudioHeader from './BotStudioHeader';
import CommandCenterView from './CommandCenterView';
import ExceptionsView from './ExceptionsView';
import ContextPane from './ContextPane';
import ImportView from './ImportView';
import InboxView from './InboxView';

type BotStudioViewKey = 'dashboard' | 'inbox' | 'board' | 'bots' | 'templates' | 'activity' | 'exceptions' | 'import';

type BotStudioRoute = {
  page: BotStudioViewKey | 'import' | 'new';
  botId?: string;
  /** Raw tab id from the URL; BotDetailView maps legacy ids to the consolidated tabs. */
  tab?: string;
};


function parseRoute(pathname: string): BotStudioRoute {
  const parts = pathname.split('/').filter(Boolean);
  const tail = parts[0] === 'bots' ? parts.slice(1) : [];
  if (tail[0] === 'new') return { page: 'new' };
  if (tail[0] === 'templates') return { page: 'templates' };
  if (tail[0] === 'board') return { page: 'board' };
  if (tail[0] === 'activity') return { page: 'activity' };
  if (tail[0] === 'exceptions') return { page: 'exceptions' };
  if (tail[0] === 'import') return { page: 'import' };
  if (tail[0] === 'b' && tail[1]) {
    const tab = tail[2] || 'overview';
    return { page: 'bots', botId: decodeURIComponent(tail[1]), tab };
  }
  if (tail[0] === 'inbox') return { page: 'inbox' };
  if (!tail.length) return { page: 'dashboard' };
  return { page: 'dashboard' };
}

export default function BotStudioView({ projects, isMobile, onMenuClick, onBackToChat, onWorkThis }: { projects: Project[]; isMobile: boolean; onMenuClick?: () => void; onBackToChat: () => void; onWorkThis?: (request: WorkThisSessionRequest) => void }) {
  const navigate = useNavigate();
  const location = useLocation();
  const route = useMemo(() => parseRoute(location.pathname), [location.pathname]);
  const data = useBotStudio();
  const layout = useBotStudioLayout();
  const { isMobile: belowXl } = useDeviceSettings({ mobileBreakpoint: 1280, trackPWA: false });
  const [search, setSearch] = useState('');
  const [selectedItem, setSelectedItem] = useState<McItem | null>(null);
  const [selectedRun, setSelectedRun] = useState<import('./contracts').RunDetail | null>(null);
  const [preview, setPreview] = useState<Record<string, unknown> | null>(null);
  const [operatorContexts, setOperatorContexts] = useState<Record<string, string>>({});
  const [bodyDrafts, setBodyDrafts] = useState<Record<string, Record<string, unknown>>>({});
  const [architectOpen, setArchitectOpen] = useState(route.page === 'new');
  const [architectInitial, setArchitectInitial] = useState<(Partial<CreateMcSectionInput> & { section_id?: string }) | undefined>();
  const [toast, setToast] = useState<{ message: string; tone: 'default' | 'error' | 'success' } | null>(null);
  const [workChoice, setWorkChoice] = useState<{ itemId: string; candidates: WorkProjectMatch[]; loading: boolean; error: string | null } | null>(null);
  const compact = isMobile || belowXl;
  const { centerWidth, restoreContext, shouldTemporarilyCollapseContext, temporarilyCollapseContext } = layout;
  const selectedBot = route.botId ? data.bots.find((bot) => bot.section_id === route.botId) : undefined;
  const itemForContext = selectedItem ? data.items.find((item) => item.item_id === selectedItem.item_id) ?? selectedItem : null;
  const botForContext = selectedBot ?? (itemForContext ? data.bots.find((bot) => bot.section_id === itemForContext.section_id) : undefined);
  const workProjects = useMemo(() => projects.map((project) => ({ projectId: project.projectId, displayName: project.displayName })), [projects]);
  const hasContextSelection = Boolean(itemForContext || selectedRun);
  const allPaused = data.bots.length > 0 && data.bots.every((bot) => !bot.enabled);
  const connectedMcpServers = data.mcpServers.filter((server) => server.connected && !server.needsAuth).map((server) => server.name);
  const loadActivity = data.loadActivityRuns;

  useEffect(() => {
    if (hasContextSelection) {
      restoreContext();
    } else if (shouldTemporarilyCollapseContext(centerWidth, false, route.page === 'bots' && Boolean(selectedBot))) {
      temporarilyCollapseContext();
    }
  }, [centerWidth, hasContextSelection, restoreContext, route.botId, route.page, selectedBot, shouldTemporarilyCollapseContext, temporarilyCollapseContext]);

  useEffect(() => {
    if (route.page === 'new') setArchitectOpen(true);
    else if (route.page !== 'bots') setArchitectOpen(false);
  }, [route.page]);

  const go = useCallback((path: string) => {
    setArchitectOpen(false);
    setSelectedItem(null);
    setSelectedRun(null);
    setPreview(null);
    setWorkChoice(null);
    navigate(path);
  }, [navigate]);

  const openArchitect = useCallback((initial?: Partial<CreateMcSectionInput> & { section_id?: string }) => {
    setArchitectInitial(initial);
    setArchitectOpen(true);
    if (initial?.section_id) navigate(`/bots/b/${encodeURIComponent(initial.section_id)}/overview`);
    else navigate('/bots/new');
  }, [navigate]);

  const saveArchitect = useCallback((section: McSection) => {
    data.setSections((current) => current.some((entry) => entry.section_id === section.section_id)
      ? current.map((entry) => entry.section_id === section.section_id ? section : entry)
      : [...current, section]);
    setArchitectOpen(false);
    setArchitectInitial(undefined);
    navigate(`/bots/b/${encodeURIComponent(section.section_id)}/overview`);
  }, [data, navigate]);

  const filteredItems = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return data.items;
    return data.items.filter((item) => {
      const bot = data.bots.find((entry) => entry.section_id === item.section_id);
      return `${item.title} ${item.summary} ${bot?.title ?? ''}`.toLowerCase().includes(needle);
    });
  }, [data.bots, data.items, search]);

  const action = useCallback(async (item: McItem, entry: McAction) => {
    const semantics = getActionSemantics(entry, item.title);
    if (semantics.confirmation && !window.confirm(semantics.confirmation)) return;
    const body = { ...(bodyDrafts[item.item_id] ?? item.body) };
    const context = operatorContexts[item.item_id] ?? (typeof item.body.operatorContext === 'string' ? item.body.operatorContext : '');
    if (context.trim()) body.operatorContext = context.trim();
    else delete body.operatorContext;
    try {
      await data.itemAction(item.item_id, entry.id, body);
      setSelectedItem(null);
      setToast({ message: 'Inbox item updated.', tone: 'success' });
    } catch (nextError) {
      setToast({ message: nextError instanceof Error ? nextError.message : 'Action failed.', tone: 'error' });
    }
  }, [bodyDrafts, data, operatorContexts]);

  const previewItem = useCallback(async (item: McItem, entry?: McAction) => {
    setToast({ message: 'Previewing… nothing will be executed.', tone: 'default' });
    try {
      const body = { ...(bodyDrafts[item.item_id] ?? item.body) };
      const context = operatorContexts[item.item_id] ?? (typeof item.body.operatorContext === 'string' ? item.body.operatorContext : '');
      if (context.trim()) body.operatorContext = context.trim();
      else delete body.operatorContext;
      const result = await data.previewItem(item.item_id, entry?.id, body);
      setPreview(result.preview ?? null);
      setSelectedItem(item);
      setToast({ message: result.success === false ? result.error || 'Preview failed.' : 'Preview ready.', tone: result.success === false ? 'error' : 'success' });
    } catch (nextError) {
      setPreview({ error: nextError instanceof Error ? nextError.message : 'Preview failed.' });
      setSelectedItem(item);
      setToast({ message: nextError instanceof Error ? nextError.message : 'Preview failed.', tone: 'error' });
    }
  }, [bodyDrafts, data, operatorContexts]);

  const openWorkChooser = useCallback(async (item: McItem) => {
    setSelectedItem(item);
    setSelectedRun(null);
    setPreview(null);
    setWorkChoice({ itemId: item.item_id, candidates: [], loading: true, error: null });
    try {
      const result = await data.workMatches(item.item_id);
      const matchesById = new Map(result.candidates.map((candidate) => [candidate.projectId, candidate]));
      const candidates = [
        ...result.candidates,
        ...(result.candidates.some((candidate) => ['bot work project', 'client mapping'].includes(candidate.reason)) ? [] : projects
          .filter((project) => !matchesById.has(project.projectId))
          .map((project) => ({ projectId: project.projectId, projectPath: project.fullPath, name: project.displayName, score: 0, reason: 'manual selection' }))),
      ];
      setWorkChoice({ itemId: item.item_id, candidates, loading: false, error: candidates.length ? null : 'No projects are available. Add a project before opening a work chat.' });
    } catch (nextError) {
      setWorkChoice({ itemId: item.item_id, candidates: [], loading: false, error: nextError instanceof Error ? nextError.message : 'Unable to find a project for this item.' });
    }
  }, [data, projects]);

  const workItem = useCallback(async (item: McItem, projectId?: string) => {
    if (!projectId && item.body.workSession && typeof item.body.workSession === 'object') {
      const work = item.body.workSession as Record<string, unknown>;
      const project = projects.find((entry) => entry.projectId === work.projectId);
      if (project && typeof work.sessionId === 'string' && typeof work.provider === 'string') {
        onWorkThis?.({ sessionId: work.sessionId, projectId: project.projectId, projectPath: project.fullPath, provider: work.provider, prompt: '', title: item.title });
        return;
      }
    }
    if (!projectId) {
      void openWorkChooser(item);
      return;
    }
    try {
      const result = await data.workItem(item.item_id, projectId);
      setWorkChoice(null);
      if (result && onWorkThis) onWorkThis({ sessionId: result.sessionId, projectId: result.projectId, projectPath: result.projectPath, provider: result.provider, prompt: result.prompt, title: item.title });
    } catch (nextError) {
      setWorkChoice((current) => current?.itemId === item.item_id ? { ...current, error: nextError instanceof Error ? nextError.message : 'Unable to start work session.' } : current);
    }
  }, [data, onWorkThis, openWorkChooser, projects]);

  const selectItem = useCallback((item: McItem) => {
    setSelectedItem(item);
    setSelectedRun(null);
    setPreview(null);
    setWorkChoice(null);
  }, []);

  /** Start work in an explicit project, or the routed one; without either, ask in the context pane. */
  const startWork = useCallback(async (item: McItem, projectId?: string) => {
    const bot = data.bots.find((entry) => entry.section_id === item.section_id);
    const target = projectId || routeWorkProject(item, bot?.work_profile);
    if (!target) {
      selectItem(item);
      setToast({ message: 'Choose a project in the context pane to start work.', tone: 'default' });
      return;
    }
    try {
      await data.workItem(item.item_id, target);
      setToast({ message: 'Work session started.', tone: 'success' });
    } catch (nextError) {
      setToast({ message: nextError instanceof Error ? nextError.message : 'Unable to start work.', tone: 'error' });
    }
  }, [data, selectItem]);

  const acceptWork = useCallback(async (item: McItem) => {
    try {
      await data.acceptWork(item.item_id);
      setToast({ message: 'Work accepted.', tone: 'success' });
    } catch (nextError) {
      setToast({ message: nextError instanceof Error ? nextError.message : 'Unable to accept work.', tone: 'error' });
    }
  }, [data]);

  const followUpWork = useCallback(async (item: McItem, message: string, success: string) => {
    try {
      await data.followUpWork(item.item_id, message);
      setToast({ message: success, tone: 'success' });
    } catch (nextError) {
      setToast({ message: nextError instanceof Error ? nextError.message : 'Unable to continue work.', tone: 'error' });
    }
  }, [data]);

  /** Open an item in the inbox context pane (same path as ExceptionsView). */
  const openInInbox = useCallback((item: McItem) => {
    navigate('/bots/inbox');
    setSelectedItem(item);
    setSelectedRun(null);
    setPreview(null);
    setWorkChoice(null);
  }, [navigate]);

  /** Board Start work: routed items start now; unrouted ones open in the inbox for a project choice. */
  const startWorkFromBoard = useCallback((item: McItem) => {
    const bot = data.bots.find((entry) => entry.section_id === item.section_id);
    if (routeWorkProject(item, bot?.work_profile)) void startWork(item);
    else {
      openInInbox(item);
      setToast({ message: 'Choose a project in the context pane to start work.', tone: 'default' });
    }
  }, [data.bots, openInInbox, startWork]);

  const openException = useCallback((entry: BotException) => {
    if (entry.itemId) {
      void botStudioApi.getItem(entry.itemId).then((item) => { navigate('/bots/inbox'); setSelectedItem(item); setSelectedRun(null); }).catch((reason: unknown) => setToast({ message: reason instanceof Error ? reason.message : 'Unable to open item.', tone: 'error' }));
    } else if (entry.runId) {
      navigate(`/bots/b/${encodeURIComponent(entry.sectionId)}/history`);
      setSelectedItem(null);
      setSelectedRun({ run_id: entry.runId, status: 'failed', bot_id: entry.sectionId, bot_title: entry.botTitle });
    } else go(`/bots/b/${encodeURIComponent(entry.sectionId)}/history`);
  }, [go, navigate]);

  const pauseOrResumeAll = useCallback(async () => {
    const enabled = allPaused;
    if (!window.confirm(`${enabled ? 'Resume' : 'Pause'} all bots?`)) return;
    try {
      await data.bulkEnabled(enabled);
      setToast({ message: enabled ? 'All bots resumed.' : 'All bots paused.', tone: 'success' });
    } catch (nextError) {
      setToast({ message: nextError instanceof Error ? nextError.message : 'Bulk update failed.', tone: 'error' });
    }
  }, [allPaused, data]);

  const openView = useCallback((view: BotStudioViewKey | 'import') => {
    const path = view === 'dashboard' ? '/bots' : '/bots/' + view;
    go(path);
  }, [go]);

  const activeView = route.page === 'new' || route.page === 'exceptions' ? 'inbox' : route.page === 'dashboard' || route.page === 'inbox' || route.page === 'board' || route.page === 'activity' ? route.page : undefined;
  const projectsForArchitect = projects.map((project) => ({ id: project.projectId, name: project.displayName, path: project.fullPath }));
  const contextTemporarilyCollapsed = architectOpen || route.page === 'dashboard' || route.page === 'board' || route.page === 'templates' || (route.page === 'bots' && resolveDetailTab(route.tab).tab === 'test') || layout.contextTemporarilyCollapsed;
  const contextOpen = !contextTemporarilyCollapsed;
  const contextWorkChoice = workChoice?.itemId === itemForContext?.item_id ? workChoice : null;
  const gridStyle = { '--bot-grid': `${layout.rosterWidth}px 8px minmax(480px,1fr)${contextOpen ? ` 8px ${layout.contextWidth}px` : ''}` } as CSSProperties;

  if (data.loading && !data.bots.length) return <div className="space-y-4 p-5" role="status" aria-label="Loading Bot Studio"><Skeleton className="h-10 w-48" /><div className="grid gap-4 xl:grid-cols-[280px_minmax(0,1fr)_400px]"><Skeleton className="h-[min(36rem,70vh)]" /><Skeleton className="h-[min(36rem,70vh)]" /><Skeleton className="h-[min(36rem,70vh)]" /></div></div>;

  return <div className="flex h-full min-h-0 flex-col bg-background text-foreground">
    {compact && onMenuClick ? <button type="button" onClick={onMenuClick} aria-label="Open sidebar" className="absolute left-3 top-3 z-10 rounded-lg border border-border bg-card p-2 text-muted-foreground shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><Menu className="h-4 w-4" /></button> : null}
    <BotStudioHeader search={search} onSearchChange={setSearch} onBackToChat={onBackToChat} onNewBot={() => openArchitect()} onTemplates={() => openView('templates')} onImport={() => openView('import')} onPauseAll={() => void pauseOrResumeAll()} pauseAllLabel={allPaused ? 'Resume all' : 'Pause all'} isConnected={data.isConnected} />
    {data.error ? <div className="mx-4 mt-3 rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">{data.error}<button type="button" className="ml-2 rounded underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => void data.refreshAll({ includeRuns: true })}>Retry</button></div> : null}
    {toast ? <div className="pointer-events-none fixed bottom-4 right-4 z-20"><div className="pointer-events-auto"><InlineToast message={toast.message} tone={toast.tone} onDismiss={() => setToast(null)} /></div></div> : null}
    {architectOpen ? <div className="min-h-0 flex-1 overflow-y-auto"><BotArchitect mode={architectInitial?.section_id ? 'edit' : 'create'} initialSection={architectInitial} projects={projectsForArchitect} onSaved={saveArchitect} onCancel={() => go(selectedBot ? `/bots/b/${encodeURIComponent(selectedBot.section_id)}/overview` : '/bots')} /></div> : <div ref={layout.containerRef} className="grid min-h-0 flex-1 grid-cols-1 xl:[grid-template-columns:var(--bot-grid)]" style={gridStyle}>
      <BotRoster bots={data.bots} selectedBotId={route.botId ?? null} search={search} activeView={activeView} onNavigate={openView} onSelect={(bot: Bot) => go(`/bots/b/${encodeURIComponent(bot.section_id)}/overview`)} /><button type="button" className="group hidden w-2 cursor-col-resize items-center justify-center border-border/70 bg-background/60 xl:flex" onPointerDown={(event) => layout.startResize('roster', event)} aria-label="Resize bot roster" title="Resize bot roster"><GripVertical className="h-5 w-3 text-muted-foreground/50 group-hover:text-primary" /></button>
      <section ref={layout.centerRef} className="flex min-h-0 min-w-0 flex-col overflow-hidden">
        {route.page === 'dashboard' ? <CommandCenterView bots={data.bots} runsBySection={data.runsBySection} search={search} isLoading={data.activityLoading} onLoad={loadActivity} onSelectBot={(bot) => go('/bots/b/' + encodeURIComponent(bot.section_id) + '/overview')} onOpenInbox={() => openView('inbox')} onOpenActivity={() => openView('activity')} /> : null}
        {route.page === 'inbox' || route.page === 'exceptions' ? <InboxView initialView={route.page === 'exceptions' ? 'exceptions' : 'items'} exceptionCount={data.exceptionCount} exceptions={<ExceptionsView onOpen={openException} onLoaded={data.setExceptionCount} />} items={filteredItems} bots={data.bots} search="" selectedItemId={selectedItem?.item_id ?? null} onSelectItem={selectItem} onAction={(item, entry) => void action(item, entry)} onPreview={(item, entry) => void previewItem(item, entry)} onRetry={(item) => void data.retryItem(item.item_id)} onWork={(item) => void workItem(item)} onStartWork={(item) => void startWork(item)} onAcceptWork={(item) => void acceptWork(item)} onRetryWork={(item) => void followUpWork(item, workRetryMessage(item), 'Retry sent to the work session.')} onSendBack={(item) => { selectItem(item); setToast({ message: 'Write your feedback in the context pane, then send it back.', tone: 'default' }); }} onGenerateAssets={(item, force) => data.generateAssets(item.item_id, force)} onNotice={(message) => setToast({ message, tone: 'default' })} /> : null}
        {route.page === 'board' ? <BoardView items={data.items} bots={data.bots} projects={workProjects} search={search} onOpenItem={openInInbox} onAction={(item, entry) => void action(item, entry)} onOpenSession={(item) => void workItem(item)} onStartWork={startWorkFromBoard} onAcceptWork={(item) => void acceptWork(item)} onSendBack={(item, message) => void followUpWork(item, message, 'Sent back to the work session.')} onRetryWork={(item) => void followUpWork(item, workRetryMessage(item), 'Retry sent to the work session.')} onRetry={(item) => void data.retryItem(item.item_id).catch((error) => setToast({ message: error instanceof Error ? error.message : 'Retry failed.', tone: 'error' }))} /> : null}
        {route.page === 'bots' ? (selectedBot ? <BotDetailView workProjects={workProjects} bot={selectedBot} projectName={projects.find((project) => project.projectId === selectedBot.project_id)?.displayName ?? null} workProjectName={projects.find((project) => project.projectId === selectedBot.work_project_id)?.displayName ?? null} items={data.items.filter((item) => item.section_id === selectedBot.section_id)} runs={data.runsFor(selectedBot.section_id)} selectedTab={route.tab} onTabChange={(tab) => navigate(`/bots/b/${encodeURIComponent(selectedBot.section_id)}/${tab}`)} onUpdate={async (patch) => { await data.saveBot(selectedBot.section_id, patch); }} onRun={() => data.runBot(selectedBot)} onCancelRun={(run) => void data.cancelRun(selectedBot.section_id, run.run_id).catch((error) => setToast({ message: error instanceof Error ? error.message : 'Unable to cancel tick.', tone: 'error' }))} onDelete={async () => { await data.deleteBot(selectedBot.section_id); go('/bots/inbox'); }} onDuplicate={async () => { const duplicate = await data.duplicateBot(selectedBot.section_id); go(`/bots/b/${encodeURIComponent(duplicate.section_id)}/overview`); }} onEdit={() => openArchitect(selectedBot)} onSelectItem={(item) => { setSelectedItem(item); setSelectedRun(null); setPreview(null); }} onSelectRun={(run) => { setSelectedItem(null); setSelectedRun({ ...run, bot_id: selectedBot.section_id, bot_title: selectedBot.title }); }} /> : <div className="flex flex-1 items-center justify-center p-8 text-center text-xs text-muted-foreground">Select a bot from the roster to inspect it.</div>) : null}
        {route.page === 'templates' ? <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6"><BotTemplatesGallery connectedMcpServers={connectedMcpServers} onUse={(template: BotTemplate) => openArchitect(template.section)} /></div> : null}
        {route.page === 'activity' ? <ActivityView bots={data.bots} runsBySection={data.runsBySection} isLoading={data.activityLoading} onLoad={loadActivity} onLoadMore={() => void data.loadActivityRuns(data.activityPage + 1)} hasMore={data.activityHasMore} isLoadingMore={data.activityLoading} onSelectRun={(run, bot) => { setSelectedItem(null); setSelectedRun({ ...run, bot_id: bot.section_id, bot_title: bot.title }); }} /> : null}
        {route.page === 'import' ? <ImportView projects={projects} onImported={() => void data.refreshAll()} /> : null}
      </section>
      {contextOpen ? <><button type="button" className="group hidden w-2 cursor-col-resize items-center justify-center border-border/70 bg-background/60 xl:flex" onPointerDown={(event) => layout.startResize('context', event)} aria-label="Resize context pane" title="Resize context pane"><GripVertical className="h-5 w-3 text-muted-foreground/50 group-hover:text-primary" /></button><ContextPane item={itemForContext} selectedRun={selectedRun} bot={botForContext} preview={preview} operatorContext={itemForContext ? operatorContexts[itemForContext.item_id] ?? (typeof itemForContext.body.operatorContext === 'string' ? itemForContext.body.operatorContext : '') : ''} onOperatorContextChange={(value) => { if (itemForContext) setOperatorContexts((current) => ({ ...current, [itemForContext.item_id]: value })); }} onBodyChange={(body) => { if (itemForContext) setBodyDrafts((current) => ({ ...current, [itemForContext.item_id]: body })); }} onGenerateAssets={(item, force) => data.generateAssets(item.item_id, force)} workCandidates={contextWorkChoice?.candidates ?? null} workLoading={contextWorkChoice?.loading ?? false} workError={contextWorkChoice?.error ?? null} onWork={(item, projectId) => void workItem(item, projectId)} workProjects={workProjects} onStartWork={(item, projectId) => void startWork(item, projectId)} onAcceptWork={(item) => void acceptWork(item)} onSendBack={(item, message) => void followUpWork(item, message, 'Sent back to the work session.')} onRetryWork={(item) => void followUpWork(item, workRetryMessage(item), 'Retry sent to the work session.')} onClose={() => { setSelectedItem(null); setSelectedRun(null); setWorkChoice(null); }} /></> : null}
    </div>}
  </div>;
}
