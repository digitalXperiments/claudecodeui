import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react';
import {
  ArrowLeft,
  Bot,
  ChevronDown,
  CircleDot,
  Code2,
  ExternalLink,
  GripVertical,
  Loader2,
  Maximize2,
  Monitor,
  MousePointer2,
  PanelLeft,
  PanelRight,
  Plus,
  RefreshCw,
  Rocket,
  Send,
  Sparkles,
  Smartphone,
  Tablet,
  Trash2,
  WandSparkles,
  Workflow,
} from 'lucide-react';

import ChatInterface from '../../chat/view/ChatInterface';
import type { MainContentProps } from '../../main-content/types/types';
import { useDeviceSettings } from '../../../hooks/useDeviceSettings';
import { Button } from '../../../shared/view/ui';
import type { LLMProvider, Project, ProjectSession } from '../../../types/app';
import { authenticatedFetch } from '../../../utils/api';
import { studioApi } from '../api/studioApi';
import { formatSelectedElement } from '../preview/selectBridge';
import type {
  StudioPreviewFrame,
  StudioPrototype,
  StudioPrototypeDetail,
  StudioSelectedElement,
  StudioTokensPatch,
} from '../types';
import StudioUniversesPanel from '../universes/StudioUniversesPanel';

import StudioArtifacts from './StudioArtifacts';
import StudioHistoryTimeline from './StudioHistoryTimeline';
import StudioPreviewPane from './StudioPreviewPane';
import StudioTokenPanel from './StudioTokenPanel';
import StudioVariantStrip from './StudioVariantStrip';

type StudioChatProps = Pick<
  MainContentProps,
  | 'ws'
  | 'sendMessage'
  | 'onInputFocusChange'
  | 'onSessionProcessing'
  | 'onSessionIdle'
  | 'processingSessions'
  | 'onNavigateToSession'
  | 'onSessionEstablished'
  | 'onShowSettings'
  | 'externalMessageUpdate'
  | 'newSessionTrigger'
>;

type StudioViewProps = {
  selectedProject: Project | null;
  projects: Project[];
  isVisible: boolean;
  onIdeateInChat: (input: { project: Project; prompt: string; title: string }) => void;
  onBackToChat?: () => void;
} & StudioChatProps;

type StudioChatSession = ProjectSession & {
  __studioPrototypeId: string;
};

type ResizeTarget = 'controls' | 'chat';
type InspectorTab = 'library' | 'history' | 'tokens' | 'artifacts';
type StudioMode = 'prototypes' | 'universes';

function clampWidth(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

const STUDIO_CHAT_SESSION_PREFIX = 'cloudcli:studio-chat:';
const STUDIO_PROVIDERS: LLMProvider[] = [
  'claude',
  'cursor',
  'codex',
  'opencode',
  'kilo',
  'cline',
  'grok',
  'kimi',
  'qwencode',
  'pi',
  'omp',
  'antigravity',
];

function statusLabel(status: StudioPrototype['status']): string {
  if (status === 'ready') return 'Ready';
  if (status === 'generating') return 'Generating';
  if (status === 'failed') return 'Needs attention';
  return 'Draft';
}

function statusTone(status: StudioPrototype['status']): string {
  if (status === 'ready') return 'bg-emerald-500';
  if (status === 'generating') return 'bg-amber-500 animate-pulse';
  if (status === 'failed') return 'bg-red-500';
  return 'bg-sky-500';
}

function iterationContext(proto: StudioPrototypeDetail): string {
  return [
    `You are iterating on the active CloudCLI Studio prototype “${proto.title}”.`,
    `Work only in \`${proto.relativeDir}\` inside the selected project.`,
    `Read the existing \`${proto.htmlRelativePath}\` before editing it, then make the requested change in place.`,
    `Keep the prototype self-contained and clickable. Update \`${proto.notesRelativePath}\` and \`${proto.handoffRelativePath}\` when the change affects the handoff.`,
    `Do not run a design swarm and do not modify the host CloudCLI application.`,
  ].join('\n');
}

export default function StudioView({
  selectedProject,
  projects,
  isVisible,
  onIdeateInChat,
  onBackToChat,
  ws,
  sendMessage,
  onInputFocusChange,
  onSessionProcessing,
  onSessionIdle,
  processingSessions,
  onNavigateToSession,
  onSessionEstablished,
  onShowSettings,
  externalMessageUpdate,
  newSessionTrigger,
}: StudioViewProps) {
  const [mode, setMode] = useState<StudioMode>('prototypes');
  const [projectId, setProjectId] = useState(selectedProject?.projectId ?? projects[0]?.projectId ?? '');
  const [items, setItems] = useState<StudioPrototype[]>([]);
  const [active, setActive] = useState<StudioPrototypeDetail | null>(null);
  const [studioSession, setStudioSession] = useState<StudioChatSession | null>(null);
  const [brief, setBrief] = useState('');
  const [skills, setSkills] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [frame, setFrame] = useState<StudioPreviewFrame>('desktop');
  const [selectMode, setSelectMode] = useState(false);
  const [pendingSelection, setPendingSelection] = useState<StudioSelectedElement | null>(null);
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>('library');
  const { isMobile } = useDeviceSettings({ mobileBreakpoint: 1024, trackPWA: false });
  const [controlsOpen, setControlsOpen] = useState(() => !isMobile);
  const [chatOpen, setChatOpen] = useState(() => !isMobile);
  const [controlsWidth, setControlsWidth] = useState(272);
  const [chatWidth, setChatWidth] = useState(390);
  const [resizeTarget, setResizeTarget] = useState<ResizeTarget | null>(null);
  const resizeStartRef = useRef<{ x: number; width: number } | null>(null);

  const project = useMemo(
    () => projects.find((entry) => entry.projectId === projectId) ?? selectedProject,
    [projects, projectId, selectedProject],
  );

  const loadList = useCallback(async (id: string) => {
    if (!id) {
      setItems([]);
      return;
    }
    setItems(await studioApi.list(id));
  }, []);

  useEffect(() => {
    if (selectedProject?.projectId) setProjectId(selectedProject.projectId);
  }, [selectedProject?.projectId]);

  useEffect(() => {
    if (!isVisible || !projectId) return;
    void loadList(projectId).catch((err: Error) => setError(err.message));
  }, [isVisible, projectId, loadList]);

  const activeId = active?.id;
  const activeProjectId = active?.projectId;

  useEffect(() => {
    let cancelled = false;
    const prototype = active;
    const targetProject = project;
    if (!prototype || !targetProject || prototype.projectId !== targetProject.projectId) {
      setStudioSession(null);
      return () => {
        cancelled = true;
      };
    }

    const storageKey = `${STUDIO_CHAT_SESSION_PREFIX}${targetProject.projectId}:${prototype.id}`;
    setStudioSession(null);

    const createOrRestoreStudioSession = async () => {
      let stored: { id?: unknown; provider?: unknown } | null = null;
      try {
        const raw = window.localStorage.getItem(storageKey);
        stored = raw ? JSON.parse(raw) as { id?: unknown; provider?: unknown } : null;
      } catch {
        stored = null;
      }

      const storedId = typeof stored?.id === 'string' ? stored.id : '';
      const storedProvider = typeof stored?.provider === 'string' && STUDIO_PROVIDERS.includes(stored.provider as LLMProvider)
        ? stored.provider as LLMProvider
        : null;

      let sessionId = storedId;
      let provider = storedProvider;
      if (!sessionId || !provider) {
        const selectedProvider = window.localStorage.getItem('selected-provider');
        provider = STUDIO_PROVIDERS.includes(selectedProvider as LLMProvider)
          ? selectedProvider as LLMProvider
          : 'claude';
        const response = await authenticatedFetch('/api/providers/sessions', {
          method: 'POST',
          body: JSON.stringify({
            provider,
            projectPath: targetProject.fullPath || targetProject.path || '',
          }),
        });
        if (!response.ok) {
          throw new Error(`Failed to create Studio chat (${response.status})`);
        }
        const body = await response.json();
        sessionId = body?.data?.sessionId || null;
        if (!sessionId) throw new Error('Studio chat allocation returned no session id');
        try {
          window.localStorage.setItem(storageKey, JSON.stringify({ id: sessionId, provider }));
        } catch {
          // Session remains usable for the current Studio visit.
        }
      }

      if (cancelled || !sessionId || !provider) return;
      setStudioSession({
        id: sessionId,
        __provider: provider,
        __projectId: targetProject.projectId,
        __studioPrototypeId: prototype.id,
        summary: `Studio · ${prototype.title}`,
      });
    };

    void createOrRestoreStudioSession().catch((err: Error) => {
      if (!cancelled) setError(err.message);
    });
    return () => {
      cancelled = true;
    };
  }, [active, project]);

  // A chat iteration writes prototype.html in the project checkout. Keep the
  // iframe live while the agent works so the user can see the change land.
  useEffect(() => {
    if (!isVisible || !activeId || !activeProjectId) return;
    const timer = window.setInterval(() => {
      void studioApi.get(activeProjectId, activeId).then((next) => {
        setActive((previous) => (previous?.html !== next.html || previous?.updatedAt !== next.updatedAt ? next : previous));
      }).catch(() => undefined);
    }, 3000);
    return () => window.clearInterval(timer);
  }, [isVisible, activeId, activeProjectId]);

  const parseSkills = () => skills.split(',').map((part) => part.trim()).filter(Boolean);

  const createPrototype = async () => {
    if (!project) {
      setError('Select a project first.');
      return null;
    }
    const text = brief.trim();
    if (!text) {
      setError('Describe what you want to prototype.');
      return null;
    }
    setBusy(true);
    setError(null);
    try {
      const proto = await studioApi.create(project.projectId, { brief: text, skills: parseSkills() });
      setActive(proto);
      setBrief('');
      await loadList(project.projectId);
      return proto;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create prototype');
      return null;
    } finally {
      setBusy(false);
    }
  };

  const handleIdeate = async () => {
    const existing = active;
    const proto = existing ?? await createPrototype();
    if (!proto || !project) return;
    setBusy(true);
    try {
      const { prompt } = await studioApi.ideatePrompt(project.projectId, proto.id);
      onIdeateInChat({ project, prompt, title: proto.title });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start chat');
    } finally {
      setBusy(false);
    }
  };

  const handleSelect = async (item: StudioPrototype) => {
    setBusy(true);
    setError(null);
    try {
      setActive(await studioApi.get(item.projectId, item.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load prototype');
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async (item: StudioPrototype) => {
    try {
      await studioApi.remove(item.projectId, item.id);
      if (active?.id === item.id) setActive(null);
      await loadList(item.projectId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete prototype');
    }
  };

  const runPrototypeAction = async (
    action: () => Promise<StudioPrototypeDetail>,
    fallbackMessage: string,
  ) => {
    if (!active) return;
    setBusy(true);
    setError(null);
    try {
      const next = await action();
      setActive(next);
      await loadList(next.projectId);
    } catch (err) {
      setError(err instanceof Error ? err.message : fallbackMessage);
    } finally {
      setBusy(false);
    }
  };

  const handleVariants = async () => {
    if (!active) return;
    await runPrototypeAction(
      () => studioApi.generateVariants(active.projectId, active.id, {
        count: 3,
        message: 'Explore three distinct visual directions while preserving the product structure.',
        selectedElement: pendingSelection,
      }),
      'Could not generate variants',
    );
  };

  const handlePromoteVariant = async (variantId: string) => {
    if (!active) return;
    await runPrototypeAction(
      () => studioApi.promoteVariant(active.projectId, active.id, variantId),
      'Could not promote variant',
    );
  };

  const handleRevert = async (versionId: string) => {
    if (!active) return;
    await runPrototypeAction(
      () => studioApi.revertToVersion(active.projectId, active.id, versionId),
      'Could not restore that version',
    );
  };

  const handleTokens = async (tokens: StudioTokensPatch) => {
    if (!active) return;
    await runPrototypeAction(
      () => studioApi.updateTokens(active.projectId, active.id, { tokens, regenerate: true }),
      'Could not apply design tokens',
    );
  };

  const sendStudioMessage = useCallback((message: unknown) => {
    if (!active || !message || typeof message !== 'object') return sendMessage(message);
    const candidate = message as { type?: string; content?: unknown; options?: Record<string, unknown> };
    if (candidate.type !== 'chat.send' || typeof candidate.content !== 'string') {
      return sendMessage(message);
    }
    return sendMessage({
      ...candidate,
      content: `${iterationContext(active)}${pendingSelection ? `\n\nPrimary edit target:\n${JSON.stringify(pendingSelection, null, 2)}` : ''}\n\nUser request:\n${candidate.content}`,
      // Studio previews read from the project checkout. An isolated chat
      // worktree would make a successful agent edit invisible to the iframe.
      options: { ...candidate.options, isolatedWorkspace: false, skipPermissions: true },
    });
  }, [active, pendingSelection, sendMessage]);

  const handleResizeStart = useCallback((target: ResizeTarget, event: ReactPointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    resizeStartRef.current = {
      x: event.clientX,
      width: target === 'controls' ? controlsWidth : chatWidth,
    };
    setResizeTarget(target);
  }, [chatWidth, controlsWidth]);

  useEffect(() => {
    if (!resizeTarget) return;

    const handlePointerMove = (event: PointerEvent) => {
      const start = resizeStartRef.current;
      if (!start) return;
      if (resizeTarget === 'controls') {
        setControlsWidth(clampWidth(start.width + event.clientX - start.x, 220, 420));
      } else {
        setChatWidth(clampWidth(start.width + start.x - event.clientX, 300, 560));
      }
    };
    const handlePointerUp = () => {
      resizeStartRef.current = null;
      setResizeTarget(null);
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
    };
  }, [resizeTarget]);

  const chatProcessing = Boolean(
    studioSession?.id && processingSessions?.has(studioSession.id),
  );
  const chatSession = studioSession?.__studioPrototypeId === active?.id ? studioSession : null;
  const gridTemplateColumns = controlsOpen
    ? chatOpen
      ? `${controlsWidth}px 8px minmax(0,1fr) 8px ${chatWidth}px`
      : `${controlsWidth}px 8px minmax(0,1fr)`
    : chatOpen
      ? `minmax(0,1fr) 8px ${chatWidth}px`
      : 'minmax(0,1fr)';

  const resizeHandle = (target: ResizeTarget, label: string) => (
    <button
      type="button"
      className={`group hidden w-2 shrink-0 cursor-col-resize items-center justify-center border-border/70 bg-background/60 transition-colors hover:bg-primary/5 xl:flex ${resizeTarget === target ? 'bg-primary/10' : ''}`}
      onPointerDown={(event) => handleResizeStart(target, event)}
      aria-label={label}
      title={label}
    >
      <GripVertical className="h-5 w-3 text-muted-foreground/50 transition-colors group-hover:text-primary" />
    </button>
  );

  return (
    <div className="flex h-full min-h-0 flex-col bg-background text-foreground">
      <header className="flex shrink-0 items-center justify-between gap-4 border-b border-border/70 bg-card/80 px-4 py-3 backdrop-blur sm:px-6">
        <div className="flex min-w-0 items-center gap-3">
          {onBackToChat ? (
            <button
              type="button"
              onClick={onBackToChat}
              className="inline-flex shrink-0 items-center gap-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              Back to chat
            </button>
          ) : null}
          <div className="hidden h-7 w-px bg-border sm:block" />
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <WandSparkles className="h-4 w-4 shrink-0 text-primary" />
              <h1 className="truncate text-base font-semibold">Design Studio</h1>
              <span className="hidden rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-primary sm:inline-flex">Live workspace</span>
            </div>
            <p className="hidden truncate text-xs text-muted-foreground sm:block">Generate a first cut, then keep shaping it with your agent.</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <label className="hidden items-center gap-2 text-xs text-muted-foreground sm:flex">
            Project
            <span className="relative">
              <select
                className="h-8 min-w-36 appearance-none rounded-lg border border-border bg-background pl-3 pr-8 text-xs font-medium text-foreground outline-none transition-colors focus:border-primary"
                value={projectId}
                onChange={(event) => {
                  setProjectId(event.target.value);
                  setActive(null);
                }}
              >
                <option value="">Select project</option>
                {projects.map((entry) => <option key={entry.projectId} value={entry.projectId}>{entry.displayName}</option>)}
              </select>
              <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            </span>
          </label>
          <div className="mr-1 hidden items-center gap-0.5 rounded-lg border border-border bg-background p-0.5 sm:flex">
            <button
              type="button"
              className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${mode === 'prototypes' ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:text-foreground'}`}
              onClick={() => setMode('prototypes')}
            >
              Prototypes
            </button>
            <button
              type="button"
              className={`inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${mode === 'universes' ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:text-foreground'}`}
              onClick={() => setMode('universes')}
            >
              <Rocket className="h-3 w-3" /> Universes
            </button>
          </div>
          {mode === 'prototypes' ? (
            <>
              <Button size="sm" variant="ghost" onClick={() => setControlsOpen((open) => !open)} title="Toggle prototypes panel" aria-label="Toggle prototypes panel">
                <PanelLeft className="h-4 w-4" />
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setChatOpen((open) => !open)} title="Toggle agent chat" aria-label="Toggle agent chat">
                <PanelRight className="h-4 w-4" />
                <span className="hidden md:inline">Agent chat</span>
              </Button>
            </>
          ) : null}
        </div>
      </header>

      {mode === 'universes' ? (
        <div className="min-h-0 flex-1">
          <StudioUniversesPanel project={project ?? null} isVisible={isVisible} />
        </div>
      ) : (
      <div
        className="grid min-h-0 flex-1 grid-cols-1 xl:[grid-template-columns:var(--studio-grid)]"
        style={{ '--studio-grid': gridTemplateColumns } as CSSProperties}
      >
        {controlsOpen ? (
          <>
          <aside className="flex min-h-0 flex-col border-b border-border/70 bg-card/40 xl:border-b-0">
            <div className="border-b border-border/70 p-4">
              <div className="mb-3 flex items-center justify-between">
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">Build</p>
                  <h2 className="mt-1 text-sm font-semibold">Start a prototype</h2>
                </div>
                <Code2 className="h-4 w-4 text-muted-foreground" />
              </div>
              <textarea
                value={brief}
                onChange={(event) => setBrief(event.target.value)}
                placeholder="Describe the product, key screen, and the action you want people to take."
                className="min-h-24 w-full resize-y rounded-xl border border-border bg-background px-3 py-2.5 text-sm leading-5 outline-none transition-colors placeholder:text-muted-foreground/70 focus:border-primary focus:ring-2 focus:ring-primary/10"
              />
              <input
                value={skills}
                onChange={(event) => setSkills(event.target.value)}
                placeholder="Skills (optional)"
                className="mt-2 h-9 w-full rounded-xl border border-border bg-background px-3 text-xs outline-none transition-colors placeholder:text-muted-foreground/70 focus:border-primary"
              />
              <Button className="mt-3 w-full justify-center" size="sm" onClick={() => void createPrototype()} disabled={busy}>
                {busy ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Plus className="mr-1.5 h-3.5 w-3.5" />}
                Generate first cut
              </Button>
              {error ? <p className="mt-2 text-xs leading-4 text-destructive">{error}</p> : null}
            </div>

            <div className="grid grid-cols-4 border-b border-border/70 px-2 py-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              {(['library', 'history', 'tokens', 'artifacts'] as InspectorTab[]).map((tab) => (
                <button
                  key={tab}
                  type="button"
                  className={`rounded-md px-1 py-1.5 capitalize tracking-normal ${inspectorTab === tab ? 'bg-primary/10 text-primary' : 'hover:bg-accent/60 hover:text-foreground'}`}
                  onClick={() => setInspectorTab(tab)}
                >
                  {tab}
                </button>
              ))}
            </div>

            {inspectorTab === 'library' ? (
              <div className="min-h-0 flex-1 overflow-y-auto p-3">
                <div className="mb-2 flex items-center justify-between px-1">
                  <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">Your prototypes</p>
                  <span className="text-[10px] text-muted-foreground">{items.length}</span>
                </div>
                {items.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-border p-4 text-center text-xs leading-5 text-muted-foreground">
                    Your generated prototypes will live here.
                  </div>
                ) : items.map((item) => (
                  <div key={item.id} className={`group mb-2 rounded-xl border p-3 transition-all ${active?.id === item.id ? 'border-primary/40 bg-primary/5 shadow-sm' : 'border-transparent hover:border-border hover:bg-accent/40'}`}>
                    <button type="button" className="w-full text-left" onClick={() => void handleSelect(item)}>
                      <div className="flex items-start gap-2">
                        <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${statusTone(item.status)}`} />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium">{item.title}</span>
                          <span className="mt-1 block text-[10px] uppercase tracking-wider text-muted-foreground">{statusLabel(item.status)}</span>
                        </span>
                      </div>
                    </button>
                    <div className="mt-2 flex items-center justify-between border-t border-border/60 pt-2">
                      <span className="truncate pr-2 text-[10px] text-muted-foreground">{new Date(item.updatedAt).toLocaleDateString()}</span>
                      <button
                        type="button"
                        disabled={item.status === 'generating'}
                        className="rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:text-destructive disabled:cursor-not-allowed disabled:opacity-30 group-hover:opacity-100"
                        onClick={() => void handleDelete(item)}
                        aria-label={`Delete ${item.title}`}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            ) : null}
            {inspectorTab === 'history' && active ? (
              <StudioHistoryTimeline
                versions={active.versions}
                activeVersionId={active.activeVersionId}
                busy={busy || active.status === 'generating'}
                onRevert={(versionId) => void handleRevert(versionId)}
              />
            ) : null}
            {inspectorTab === 'tokens' && active ? (
              <StudioTokenPanel
                tokens={active.tokens}
                busy={busy || active.status === 'generating'}
                onApply={(tokens) => void handleTokens(tokens)}
              />
            ) : null}
            {inspectorTab === 'artifacts' && active ? (
              <StudioArtifacts notes={active.notes} handoff={active.handoff} />
            ) : null}
            {inspectorTab !== 'library' && !active ? (
              <p className="p-4 text-xs leading-5 text-muted-foreground">Select a prototype to inspect its {inspectorTab}.</p>
            ) : null}
          </aside>
          {resizeHandle('controls', 'Resize prototypes panel')}
          </>
        ) : null}

        <section className="flex min-h-0 min-w-0 flex-col bg-muted/20">
          <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-border/70 bg-background px-4 py-2.5 sm:px-5">
            <div className="min-w-0">
              {active ? (
                <>
                  <div className="flex items-center gap-2">
                    <CircleDot className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
                    <h2 className="truncate text-sm font-semibold">{active.title}</h2>
                    <span className="hidden rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold text-emerald-600 sm:inline-flex">Preview live</span>
                  </div>
                  <p className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground">{active.htmlRelativePath}</p>
                </>
              ) : (
                <h2 className="text-sm font-semibold">Prototype preview</h2>
              )}
            </div>
            <div className="flex items-center gap-1.5">
              <Button size="sm" variant={frame === 'desktop' ? 'secondary' : 'ghost'} onClick={() => setFrame('desktop')} title="Desktop preview">
                <Monitor className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">Desktop</span>
              </Button>
              <Button size="sm" variant={frame === 'tablet' ? 'secondary' : 'ghost'} onClick={() => setFrame('tablet')} title="Tablet preview">
                <Tablet className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">Tablet</span>
              </Button>
              <Button size="sm" variant={frame === 'mobile' ? 'secondary' : 'ghost'} onClick={() => setFrame('mobile')} title="Mobile preview">
                <Smartphone className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">Mobile</span>
              </Button>
              {active ? (
                <>
                  <Button
                    size="sm"
                    variant={selectMode ? 'secondary' : 'ghost'}
                    onClick={() => setSelectMode((enabled) => !enabled)}
                    title="Select an element to target in chat"
                  >
                    <MousePointer2 className="h-3.5 w-3.5" />
                    <span className="hidden sm:inline">{selectMode ? 'Selecting' : 'Select'}</span>
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => void handleVariants()}
                    disabled={busy || active.status === 'generating'}
                    title="Generate three visual variants"
                  >
                    <Sparkles className="h-3.5 w-3.5" />
                    <span className="hidden sm:inline">Variants</span>
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => void studioApi.get(active.projectId, active.id).then(setActive)} title="Refresh preview" aria-label="Refresh preview">
                    <RefreshCw className="h-3.5 w-3.5" />
                  </Button>
                </>
              ) : null}
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-hidden p-3 sm:p-5">
            {active ? (
              <div className="relative h-full min-h-0">
                {chatProcessing || active.status === 'generating' ? <div className="absolute left-1/2 top-3 z-10 flex -translate-x-1/2 items-center gap-2 rounded-full border border-amber-200 bg-amber-50 px-3 py-1.5 text-[11px] font-medium text-amber-700 shadow-sm"><Loader2 className="h-3 w-3 animate-spin" />Updating the prototype…</div> : null}
                <StudioPreviewPane
                  title={active.title}
                  html={active.html}
                  frame={frame}
                  selectMode={selectMode}
                  onSelectElement={(element) => {
                    setPendingSelection(element);
                    setSelectMode(false);
                  }}
                />
              </div>
            ) : (
              <div className="flex h-full min-h-[360px] items-center justify-center rounded-2xl border border-dashed border-border bg-card/40 p-8 text-center">
                <div className="max-w-sm">
                  <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/10 text-primary"><Sparkles className="h-5 w-5" /></div>
                  <h2 className="mt-4 text-lg font-semibold">Make an idea clickable</h2>
                  <p className="mt-2 text-sm leading-6 text-muted-foreground">Generate a first cut from the Build panel. Once it’s here, ask the agent for focused changes and watch them appear in this preview.</p>
                </div>
              </div>
            )}
          </div>
          {active ? (
            <StudioVariantStrip
              variants={active.variants}
              generating={active.status === 'generating' && active.generation?.kind === 'variants'}
              busy={busy}
              onPromote={(variantId) => void handlePromoteVariant(variantId)}
            />
          ) : null}
        </section>

        {chatOpen ? (
          <>
          {resizeHandle('chat', 'Resize agent chat panel')}
          <aside className="flex min-h-0 flex-col border-t border-border/70 bg-card xl:border-t-0">
            <div className="shrink-0 border-b border-border/70 bg-card px-4 py-3">
              <div className="flex items-center gap-2">
                <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-primary/10 text-primary"><Bot className="h-4 w-4" /></div>
                <div className="min-w-0">
                  <h2 className="text-sm font-semibold">Iterate with your agent</h2>
                  <p className="truncate text-[11px] text-muted-foreground">{active ? `Editing ${active.title}` : 'Generate a prototype to begin'}</p>
                </div>
                <div className="ml-auto flex shrink-0 items-center gap-1">
                  <Button size="sm" variant="ghost" onClick={() => void handleIdeate()} disabled={!active || busy} title="Open this iteration in full chat" aria-label="Open this iteration in full chat">
                    <ExternalLink className="h-3.5 w-3.5" />
                  </Button>
                </div>
                <span className="flex shrink-0 items-center gap-1 text-[10px] font-medium text-emerald-600"><span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />Live</span>
              </div>
              {active ? <div className="mt-3 flex items-center gap-2 rounded-lg bg-muted/60 px-2.5 py-2 text-[10px] leading-4 text-muted-foreground"><Workflow className="h-3.5 w-3.5 shrink-0 text-primary" />Changes are scoped to this prototype and reflected in the preview.</div> : null}
              {pendingSelection ? (
                <div className="mt-2 flex items-center justify-between gap-2 rounded-lg border border-primary/25 bg-primary/5 px-2.5 py-2 text-[10px] text-primary">
                  <span className="truncate">Targeting {formatSelectedElement(pendingSelection)}</span>
                  <button type="button" className="shrink-0 font-semibold hover:underline" onClick={() => setPendingSelection(null)}>Clear</button>
                </div>
              ) : null}
            </div>
            <div className="min-h-0 flex-1 overflow-hidden">
              {project && chatSession ? (
                <ChatInterface
                  selectedProject={project}
                  selectedSession={chatSession}
                  studioMode
                  ws={ws}
                  sendMessage={sendStudioMessage}
                  onInputFocusChange={onInputFocusChange}
                  onSessionProcessing={onSessionProcessing}
                  onSessionIdle={onSessionIdle}
                  processingSessions={processingSessions}
                  onNavigateToSession={onNavigateToSession}
                  onSessionEstablished={onSessionEstablished}
                  onShowSettings={onShowSettings}
                  externalMessageUpdate={externalMessageUpdate}
                  newSessionTrigger={newSessionTrigger}
                  showRawParameters={false}
                  showThinking={true}
                  sendByCtrlEnter={false}
                />
              ) : (
                <div className="flex h-full items-center justify-center p-6 text-center text-xs leading-5 text-muted-foreground">Select a project to chat with the agent.</div>
              )}
            </div>
            {active ? <div className="border-t border-border/70 px-4 py-2 text-center text-[10px] text-muted-foreground">Ask for a visual change, interaction, copy pass, or responsive fix.</div> : null}
          </aside>
          </>
        ) : null}
      </div>
      )}

      {mode === 'prototypes' && active && !chatOpen ? (
        <div className="fixed bottom-4 right-4 z-20">
          <Button size="sm" onClick={() => setChatOpen(true)}><Send className="mr-1.5 h-3.5 w-3.5" />Chat to iterate</Button>
        </div>
      ) : null}

      {mode === 'prototypes' && active && chatOpen ? (
        <div className="pointer-events-none fixed bottom-4 left-1/2 z-20 hidden -translate-x-1/2 items-center gap-2 rounded-full border border-border bg-card/95 px-3 py-1.5 text-[10px] text-muted-foreground shadow-lg 2xl:flex">
          <Maximize2 className="h-3 w-3" /> Preview updates automatically after each agent edit
        </div>
      ) : null}
    </div>
  );
}
