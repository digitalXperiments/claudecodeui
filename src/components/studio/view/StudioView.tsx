import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowLeft, Loader2, MonitorSmartphone, PanelLeft, Plus, RefreshCw, Sparkles, Trash2 } from 'lucide-react';

import { useDeviceSettings } from '../../../hooks/useDeviceSettings';
import { Button } from '../../../shared/view/ui';
import type { Project } from '../../../types/app';
import { studioApi } from '../api/studioApi';
import type { StudioPrototype, StudioPrototypeDetail } from '../types';

type StudioViewProps = {
  selectedProject: Project | null;
  projects: Project[];
  isVisible: boolean;
  onIdeateInChat: (input: { project: Project; prompt: string; title: string }) => void;
  onOpenSwarm: () => void;
  onBackToChat?: () => void;
};

export default function StudioView({
  selectedProject,
  projects,
  isVisible,
  onIdeateInChat,
  onOpenSwarm,
  onBackToChat,
}: StudioViewProps) {
  const [projectId, setProjectId] = useState(selectedProject?.projectId ?? '');
  const [items, setItems] = useState<StudioPrototype[]>([]);
  const [active, setActive] = useState<StudioPrototypeDetail | null>(null);
  const [brief, setBrief] = useState('');
  const [skills, setSkills] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [frame, setFrame] = useState<'desktop' | 'mobile'>('desktop');
  const { isMobile } = useDeviceSettings({ mobileBreakpoint: 1024, trackPWA: false });
  // Lazy init only: the user's manual toggle wins for the rest of the session.
  const [controlsOpen, setControlsOpen] = useState(() => !isMobile);

  const project = useMemo(
    () => projects.find((entry) => entry.projectId === projectId) ?? selectedProject,
    [projects, projectId, selectedProject],
  );

  const loadList = useCallback(async (id: string) => {
    if (!id) {
      setItems([]);
      return;
    }
    const next = await studioApi.list(id);
    setItems(next);
  }, []);

  useEffect(() => {
    if (selectedProject?.projectId) setProjectId(selectedProject.projectId);
  }, [selectedProject?.projectId]);

  useEffect(() => {
    if (!isVisible || !projectId) return;
    void loadList(projectId).catch((err: Error) => setError(err.message));
  }, [isVisible, projectId, loadList]);

  useEffect(() => {
    if (!isVisible || !active || active.status !== 'generating') return;
    const timer = window.setInterval(() => {
      void studioApi.get(active.projectId, active.id).then(setActive).catch(() => undefined);
    }, 2500);
    return () => window.clearInterval(timer);
  }, [isVisible, active?.id, active?.status, active?.projectId]);

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

  const handleCreate = async () => {
    await createPrototype();
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

  const handleSwarm = async () => {
    const proto = active ?? await createPrototype();
    if (!proto || !project) return;
    setBusy(true);
    try {
      const result = await studioApi.launchSwarm(project.projectId, proto.id);
      setActive(result.prototype);
      await loadList(project.projectId);
      onOpenSwarm();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start design swarm');
    } finally {
      setBusy(false);
    }
  };

  const handleSelect = async (item: StudioPrototype) => {
    setBusy(true);
    try {
      setActive(await studioApi.get(item.projectId, item.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load prototype');
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async (item: StudioPrototype) => {
    await studioApi.remove(item.projectId, item.id);
    if (active?.id === item.id) setActive(null);
    await loadList(item.projectId);
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <header className="border-b border-border px-5 py-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            {onBackToChat ? (
              <button
                type="button"
                onClick={onBackToChat}
                className="mb-1 inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
              >
                <ArrowLeft className="h-3.5 w-3.5" />
                Back to chat
              </button>
            ) : (
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Studio</p>
            )}
            <h1 className="text-lg font-semibold leading-tight">Clickable prototypes</h1>
            <p className="text-sm text-muted-foreground">
              Describe the product, generate a first cut, then refine in chat or with the design swarm.
            </p>
          </div>
          <select
            className="h-9 rounded-md border border-border bg-background px-2 text-sm"
            value={projectId}
            onChange={(event) => {
              setProjectId(event.target.value);
              setActive(null);
            }}
          >
            <option value="">Select project</option>
            {projects.map((entry) => (
              <option key={entry.projectId} value={entry.projectId}>
                {entry.displayName}
              </option>
            ))}
          </select>
        </div>
      </header>

      <div className={`grid min-h-0 flex-1 grid-cols-1 ${controlsOpen ? 'lg:grid-cols-[320px_minmax(0,1fr)]' : ''}`}>
        {controlsOpen ? (
        <aside className="flex min-h-0 flex-col border-b border-border lg:border-b-0 lg:border-r">
          <div className="space-y-3 p-4">
            <textarea
              value={brief}
              onChange={(event) => setBrief(event.target.value)}
              placeholder="Landing page for a prawn-farm monitor: live pond telemetry, alerts, and a walkthrough request."
              className="min-h-28 w-full resize-y rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
            />
            <input
              value={skills}
              onChange={(event) => setSkills(event.target.value)}
              placeholder="Optional skills, comma-separated"
              className="h-9 w-full rounded-md border border-border bg-background px-3 text-sm"
            />
            <div className="flex flex-wrap gap-2">
              <Button size="sm" onClick={() => void handleCreate()} disabled={busy}>
                <Plus className="mr-1 h-3.5 w-3.5" /> Generate draft
              </Button>
              <Button size="sm" variant="secondary" onClick={() => void handleIdeate()} disabled={busy}>
                <Sparkles className="mr-1 h-3.5 w-3.5" /> Ideate in chat
              </Button>
              <Button size="sm" variant="secondary" onClick={() => void handleSwarm()} disabled={busy}>
                Run design swarm
              </Button>
            </div>
            {error ? <p className="text-xs text-destructive">{error}</p> : null}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
            {items.length === 0 ? (
              <p className="px-2 text-sm text-muted-foreground">No prototypes in this project yet.</p>
            ) : (
              items.map((item) => (
                <div
                  key={item.id}
                  className={`mb-1 flex items-start justify-between rounded-md px-2 py-2 ${
                    active?.id === item.id ? 'bg-primary/10' : 'hover:bg-accent/60'
                  }`}
                >
                  <button type="button" className="min-w-0 flex-1 text-left" onClick={() => void handleSelect(item)}>
                    <div className="truncate text-sm font-medium">{item.title}</div>
                    <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{item.status}</div>
                  </button>
                  <button
                    type="button"
                    className="p-1 text-muted-foreground hover:text-destructive"
                    onClick={() => void handleDelete(item)}
                    aria-label="Delete prototype"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))
            )}
          </div>
        </aside>
        ) : null}

        <section className="flex min-h-0 flex-col">
          <div className="flex items-center justify-between border-b border-border px-4 py-2">
            <div className="min-w-0">
              <div className="truncate text-sm font-medium">{active?.title ?? 'Preview'}</div>
              {active ? (
                <div className="truncate text-xs text-muted-foreground">{active.htmlRelativePath}</div>
              ) : null}
            </div>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setControlsOpen((open) => !open)}
                aria-label="Toggle controls panel"
                title="Toggle controls panel"
              >
                <PanelLeft className="h-3.5 w-3.5" />
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setFrame(frame === 'desktop' ? 'mobile' : 'desktop')}>
                <MonitorSmartphone className="mr-1 h-3.5 w-3.5" />
                {frame === 'desktop' ? 'Mobile' : 'Desktop'}
              </Button>
              {active ? (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void studioApi.get(active.projectId, active.id).then(setActive)}
                >
                  {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                </Button>
              ) : null}
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-hidden bg-muted/30 p-4">
            {active ? (
              <div
                className={`mx-auto h-full min-h-0 overflow-hidden rounded-xl border border-border bg-white shadow-sm ${
                  frame === 'mobile' ? 'max-w-[390px]' : 'w-full max-w-none'
                }`}
              >
                <iframe
                  title={active.title}
                  sandbox="allow-scripts allow-forms allow-modals"
                  className="h-full w-full border-0"
                  srcDoc={active.html}
                />
              </div>
            ) : (
              <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                Describe a product, then create a prototype or send it to chat / swarm.
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
