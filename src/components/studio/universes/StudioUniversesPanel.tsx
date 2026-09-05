import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  Circle,
  ExternalLink,
  GitCompare,
  Loader2,
  Play,
  Rocket,
  Square,
  Trash2,
  XCircle,
} from 'lucide-react';

import { authenticatedFetch } from '../../../utils/api';
import { Button } from '../../../shared/view/ui';
import type { LLMProvider, Project, ProviderModelsDefinition } from '../../../types/app';
import { studioUniversesApi } from './api/studioUniversesApi';
import type {
  CreateUniverseApproachDraft,
  StudioUniverse,
  UniverseDiffResult,
  UniverseVariant,
} from './types';

const POLL_MS = 3500;

type ModelsByProvider = Partial<Record<LLMProvider, ProviderModelsDefinition>>;

function emptyApproach(label: string): CreateUniverseApproachDraft {
  return { label, approach: '', provider: '', model: '' };
}

function statusTone(status: string): string {
  if (status === 'completed') return 'text-emerald-600';
  if (status === 'failed' || status === 'timed_out' || status === 'cancelled') return 'text-red-600';
  if (status === 'running' || status === 'queued' || status === 'waiting_approval') return 'text-amber-600';
  return 'text-muted-foreground';
}

function statusIcon(status: string) {
  if (status === 'completed') return <CheckCircle2 className="h-3.5 w-3.5" />;
  if (status === 'failed' || status === 'timed_out' || status === 'cancelled') return <XCircle className="h-3.5 w-3.5" />;
  if (status === 'running' || status === 'queued' || status === 'waiting_approval') return <Loader2 className="h-3.5 w-3.5 animate-spin" />;
  return <Circle className="h-3.5 w-3.5" />;
}

async function fetchWorkerProviders(): Promise<LLMProvider[]> {
  const res = await authenticatedFetch('/api/agent-relay/settings');
  const body = await res.json().catch(() => null) as { success?: boolean; data?: { settings?: { workerProviders?: LLMProvider[] } } } | null;
  const providers = body?.data?.settings?.workerProviders;
  return Array.isArray(providers) ? providers : [];
}

async function fetchModels(provider: LLMProvider): Promise<ProviderModelsDefinition> {
  const res = await authenticatedFetch(`/api/providers/${provider}/models`);
  const body = await res.json().catch(() => null) as { success?: boolean; data?: { models?: ProviderModelsDefinition } } | null;
  if (!res.ok || !body?.success || !body.data?.models) {
    throw new Error(`Could not load models for ${provider}`);
  }
  return body.data.models;
}

type ApproachFormProps = {
  title: string;
  draft: CreateUniverseApproachDraft;
  providers: LLMProvider[];
  models: ProviderModelsDefinition | undefined;
  loadingModels: boolean;
  onChange: (next: CreateUniverseApproachDraft) => void;
};

function ApproachForm({ title, draft, providers, models, loadingModels, onChange }: ApproachFormProps) {
  return (
    <div className="rounded-xl border border-border bg-card/60 p-3">
      <p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">{title}</p>
      <input
        value={draft.label}
        onChange={(event) => onChange({ ...draft, label: event.target.value })}
        placeholder="Name this approach (e.g. Optimistic UI)"
        className="mb-2 h-9 w-full rounded-lg border border-border bg-background px-3 text-xs outline-none focus:border-primary"
      />
      <textarea
        value={draft.approach}
        onChange={(event) => onChange({ ...draft, approach: event.target.value })}
        placeholder="Describe what makes this attempt distinct (the strategy, library, or tradeoff to take)."
        className="mb-2 min-h-16 w-full resize-y rounded-lg border border-border bg-background px-3 py-2 text-xs leading-5 outline-none focus:border-primary"
      />
      <div className="flex gap-2">
        <span className="relative flex-1">
          <select
            value={draft.provider}
            onChange={(event) => onChange({ ...draft, provider: event.target.value as LLMProvider, model: '' })}
            className="h-8 w-full appearance-none rounded-lg border border-border bg-background pl-2 pr-7 text-xs outline-none focus:border-primary"
          >
            <option value="">Provider…</option>
            {providers.map((provider) => <option key={provider} value={provider}>{provider}</option>)}
          </select>
          <ChevronDown className="pointer-events-none absolute right-1.5 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
        </span>
        <span className="relative flex-1">
          <select
            value={draft.model}
            onChange={(event) => onChange({ ...draft, model: event.target.value })}
            disabled={!draft.provider || loadingModels}
            className="h-8 w-full appearance-none rounded-lg border border-border bg-background pl-2 pr-7 text-xs outline-none focus:border-primary disabled:opacity-50"
          >
            <option value="">{loadingModels ? 'Loading…' : 'Model…'}</option>
            {models?.OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
          <ChevronDown className="pointer-events-none absolute right-1.5 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
        </span>
      </div>
    </div>
  );
}

type VariantCardProps = {
  projectId: string;
  universeId: string;
  variant: UniverseVariant;
  onChanged: (universe: StudioUniverse) => void;
};

function VariantCard({ projectId, universeId, variant, onChanged }: VariantCardProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [diff, setDiff] = useState<UniverseDiffResult | null>(null);
  const [diffOpen, setDiffOpen] = useState(false);
  const [command, setCommand] = useState(variant.preview.command ?? '');
  const [commit, setCommit] = useState(false);
  const [commitMessage, setCommitMessage] = useState(`Apply Studio universe variant: ${variant.label}`);

  const run = useCallback(async (action: () => Promise<StudioUniverse>) => {
    setBusy(true);
    setError(null);
    try {
      onChanged(await action());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Action failed');
    } finally {
      setBusy(false);
    }
  }, [onChanged]);

  const toggleDiff = async () => {
    if (diffOpen) {
      setDiffOpen(false);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      setDiff(await studioUniversesApi.diffVariant(projectId, universeId, variant.id));
      setDiffOpen(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load diff');
    } finally {
      setBusy(false);
    }
  };

  const isTerminal = ['completed', 'failed', 'cancelled', 'timed_out'].includes(variant.status);
  const canPreview = Boolean(variant.workspaceId);
  const previewRunning = variant.preview.status === 'starting' || variant.preview.status === 'running';

  return (
    <div className="flex min-h-0 flex-col rounded-xl border border-border bg-card/60 p-3">
      <div className="mb-1 flex items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">{variant.label}</p>
          <p className="truncate text-[10px] text-muted-foreground">{variant.provider} · {variant.model}</p>
        </div>
        <span className={`flex shrink-0 items-center gap-1 text-[10px] font-semibold uppercase tracking-wide ${statusTone(variant.status)}`}>
          {statusIcon(variant.status)}
          {variant.status.replace('_', ' ')}
        </span>
      </div>
      <p className="mb-2 line-clamp-3 text-[11px] leading-4 text-muted-foreground">{variant.approach}</p>
      {variant.branch ? <p className="mb-2 truncate font-mono text-[10px] text-muted-foreground">{variant.branch}</p> : null}

      {variant.error ? (
        <div className="mb-2 flex items-start gap-1.5 rounded-lg border border-red-200 bg-red-50 px-2 py-1.5 text-[11px] leading-4 text-red-700">
          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
          <span className="break-words">{variant.error}</span>
        </div>
      ) : null}

      {variant.result ? (
        <div className="mb-2 rounded-lg bg-muted/60 px-2 py-1.5 text-[11px] leading-4">
          <p className="mb-1">{variant.result.summary}</p>
          {variant.result.filesTouched.length > 0 ? <p className="text-muted-foreground">Files: {variant.result.filesTouched.join(', ')}</p> : null}
          {variant.result.testsRun.length > 0 ? <p className="text-muted-foreground">Tests: {variant.result.testsRun.join(', ')}</p> : null}
        </div>
      ) : null}

      {error ? <p className="mb-2 text-[11px] text-destructive">{error}</p> : null}

      <div className="mt-auto flex flex-wrap items-center gap-1.5 border-t border-border/60 pt-2">
        {!isTerminal ? (
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run(() => studioUniversesApi.cancelVariant(projectId, universeId, variant.id))}>
            <Square className="mr-1 h-3 w-3" /> Cancel
          </Button>
        ) : null}
        <Button size="sm" variant="ghost" disabled={busy || !variant.workspaceId} onClick={() => void toggleDiff()}>
          <GitCompare className="mr-1 h-3 w-3" /> {diffOpen ? 'Hide diff' : 'Diff'}
        </Button>
      </div>

      {diffOpen && diff ? (
        <div className="mt-2 max-h-48 overflow-y-auto rounded-lg border border-border bg-background p-2 text-[10px]">
          {diff.files.length === 0 ? <p className="text-muted-foreground">No changes yet.</p> : diff.files.map((file) => (
            <div key={file.path} className="mb-1 border-b border-border/40 pb-1 last:mb-0 last:border-0">
              <p className="font-mono">{file.status} {file.path}</p>
              {file.patch ? <pre className="mt-1 max-h-24 overflow-y-auto whitespace-pre-wrap break-words text-[9px] text-muted-foreground">{file.patch}</pre> : null}
            </div>
          ))}
        </div>
      ) : null}

      <div className="mt-2 border-t border-border/60 pt-2">
        <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Local preview</p>
        <div className="flex gap-1.5">
          <input
            value={command}
            onChange={(event) => setCommand(event.target.value)}
            placeholder="npm run dev"
            disabled={previewRunning}
            className="h-7 flex-1 rounded-md border border-border bg-background px-2 text-[11px] outline-none focus:border-primary disabled:opacity-60"
          />
          {previewRunning ? (
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run(() => studioUniversesApi.stopPreview(projectId, universeId, variant.id))}>
              <Square className="mr-1 h-3 w-3" /> Stop
            </Button>
          ) : (
            <Button size="sm" variant="ghost" disabled={busy || !canPreview || !command.trim()} onClick={() => void run(() => studioUniversesApi.startPreview(projectId, universeId, variant.id, { command }))}>
              <Play className="mr-1 h-3 w-3" /> Start
            </Button>
          )}
        </div>
        {variant.preview.status !== 'stopped' ? (
          <div className="mt-1.5 rounded-md bg-muted/60 px-2 py-1.5 text-[10px] leading-4">
            <div className="flex items-center justify-between">
              <span className={statusTone(variant.preview.status === 'running' ? 'completed' : variant.preview.status === 'failed' ? 'failed' : 'running')}>{variant.preview.status}</span>
              {variant.preview.url && variant.preview.status === 'running' ? (
                <a href={variant.preview.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-medium text-primary hover:underline">
                  Open <ExternalLink className="h-3 w-3" />
                </a>
              ) : null}
            </div>
            {variant.preview.error ? <p className="mt-0.5 text-red-600">{variant.preview.error}</p> : null}
            {variant.preview.logTail.length > 0 ? (
              <pre className="mt-1 max-h-20 overflow-y-auto whitespace-pre-wrap break-words font-mono text-[9px] text-muted-foreground">
                {variant.preview.logTail.slice(-12).join('\n')}
              </pre>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="mt-2 border-t border-border/60 pt-2">
        <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Apply to project</p>
        {variant.applied ? (
          <p className="text-[10px] text-emerald-600">
            Applied {new Date(variant.applied.at).toLocaleString()}{variant.applied.commitSha ? ` · commit ${variant.applied.commitSha.slice(0, 8)}` : ''}
            {variant.applied.skipped.length > 0 ? ` · ${variant.applied.skipped.length} skipped (dirty overlap)` : ''}
          </p>
        ) : (
          <div className="flex flex-col gap-1.5">
            <label className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
              <input type="checkbox" checked={commit} onChange={(event) => setCommit(event.target.checked)} />
              Commit on the primary checkout
            </label>
            {commit ? (
              <input
                value={commitMessage}
                onChange={(event) => setCommitMessage(event.target.value)}
                className="h-7 w-full rounded-md border border-border bg-background px-2 text-[11px] outline-none focus:border-primary"
              />
            ) : null}
            <Button
              size="sm"
              disabled={busy || !variant.workspaceId || !isTerminal || variant.status !== 'completed'}
              onClick={() => {
                if (!window.confirm(`Apply "${variant.label}" onto the primary checkout? This copies its files over (no auto-merge).`)) return;
                void run(() => studioUniversesApi.applyVariant(projectId, universeId, variant.id, { commit, message: commit ? commitMessage : undefined }));
              }}
            >
              <Rocket className="mr-1 h-3 w-3" /> Apply this variant
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

type StudioUniversesPanelProps = {
  project: Project | null;
  isVisible: boolean;
};

export default function StudioUniversesPanel({ project, isVisible }: StudioUniversesPanelProps) {
  const [universes, setUniverses] = useState<StudioUniverse[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [active, setActive] = useState<StudioUniverse | null>(null);
  const [goal, setGoal] = useState('');
  const [approaches, setApproaches] = useState<[CreateUniverseApproachDraft, CreateUniverseApproachDraft]>([
    emptyApproach('Approach A'),
    emptyApproach('Approach B'),
  ]);
  const [providers, setProviders] = useState<LLMProvider[]>([]);
  const [modelsByProvider, setModelsByProvider] = useState<ModelsByProvider>({});
  const [loadingModelsFor, setLoadingModelsFor] = useState<Set<LLMProvider>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const projectId = project?.projectId ?? '';

  const loadList = useCallback(async () => {
    if (!projectId) {
      setUniverses([]);
      return;
    }
    try {
      setUniverses(await studioUniversesApi.list(projectId));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load universes');
    }
  }, [projectId]);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  useEffect(() => {
    void fetchWorkerProviders().then(setProviders).catch(() => setProviders([]));
  }, []);

  useEffect(() => {
    for (const draft of approaches) {
      const provider = draft.provider;
      if (!provider || modelsByProvider[provider] || loadingModelsFor.has(provider)) continue;
      setLoadingModelsFor((prev) => new Set(prev).add(provider));
      void fetchModels(provider)
        .then((models) => setModelsByProvider((prev) => ({ ...prev, [provider]: models })))
        .catch(() => undefined)
        .finally(() => setLoadingModelsFor((prev) => {
          const next = new Set(prev);
          next.delete(provider);
          return next;
        }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [approaches]);

  useEffect(() => {
    if (!activeId || !projectId) {
      setActive(null);
      return;
    }
    let cancelled = false;
    const load = () => {
      studioUniversesApi.get(projectId, activeId).then((next) => {
        if (!cancelled) setActive(next);
      }).catch(() => undefined);
    };
    load();
    if (!isVisible) return () => { cancelled = true; };
    const timer = window.setInterval(load, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [activeId, projectId, isVisible]);

  const handleChanged = useCallback((next: StudioUniverse) => {
    setActive(next);
    setUniverses((prev) => {
      const idx = prev.findIndex((entry) => entry.id === next.id);
      if (idx === -1) return [next, ...prev];
      const copy = [...prev];
      copy[idx] = next;
      return copy;
    });
  }, []);

  const canLaunch = useMemo(() => {
    if (!goal.trim()) return false;
    return approaches.every((draft) => draft.approach.trim() && draft.provider && draft.model);
  }, [goal, approaches]);

  const handleLaunch = async () => {
    if (!projectId) {
      setError('Select a project first.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const universe = await studioUniversesApi.create(projectId, {
        goal: goal.trim(),
        approaches,
      });
      setUniverses((prev) => [universe, ...prev]);
      setActiveId(universe.id);
      setActive(universe);
      setGoal('');
      setApproaches([emptyApproach('Approach A'), emptyApproach('Approach B')]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not launch universe');
    } finally {
      setBusy(false);
    }
  };

  const handleRemove = async (id: string) => {
    if (!projectId) return;
    if (!window.confirm('Remove this universe from Studio? This stops any local previews and forgets it here (the underlying Agent Relay jobs and workspaces are left untouched).')) return;
    try {
      await studioUniversesApi.remove(projectId, id);
      setUniverses((prev) => prev.filter((entry) => entry.id !== id));
      if (activeId === id) {
        setActiveId(null);
        setActive(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not remove universe');
    }
  };

  return (
    <div className="grid h-full min-h-0 grid-cols-1 gap-4 overflow-y-auto p-4 xl:grid-cols-[340px_minmax(0,1fr)] xl:overflow-hidden sm:p-5">
      <aside className="flex min-h-0 flex-col gap-4 xl:overflow-y-auto">
        <div className="rounded-xl border border-border bg-card/60 p-3">
          <p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">New universe</p>
          <textarea
            value={goal}
            onChange={(event) => setGoal(event.target.value)}
            placeholder="Describe the goal to implement in this repository."
            className="mb-3 min-h-16 w-full resize-y rounded-lg border border-border bg-background px-3 py-2 text-xs leading-5 outline-none focus:border-primary"
          />
          <div className="flex flex-col gap-2">
            {(['A', 'B'] as const).map((slot, index) => (
              <ApproachForm
                key={slot}
                title={`Named approach ${slot}`}
                draft={approaches[index]}
                providers={providers}
                models={approaches[index].provider ? modelsByProvider[approaches[index].provider as LLMProvider] : undefined}
                loadingModels={approaches[index].provider ? loadingModelsFor.has(approaches[index].provider as LLMProvider) : false}
                onChange={(next) => setApproaches((prev) => {
                  const copy = [...prev] as [CreateUniverseApproachDraft, CreateUniverseApproachDraft];
                  copy[index] = next;
                  return copy;
                })}
              />
            ))}
          </div>
          <Button className="mt-3 w-full justify-center" size="sm" disabled={busy || !canLaunch} onClick={() => void handleLaunch()}>
            {busy ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Rocket className="mr-1.5 h-3.5 w-3.5" />}
            Launch both approaches
          </Button>
          {error ? <p className="mt-2 text-xs leading-4 text-destructive">{error}</p> : null}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <p className="mb-2 px-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">Universes ({universes.length})</p>
          {universes.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border p-4 text-center text-xs leading-5 text-muted-foreground">
              Launched universes will appear here.
            </div>
          ) : universes.map((universe) => (
            <button
              key={universe.id}
              type="button"
              onClick={() => setActiveId(universe.id)}
              className={`mb-2 block w-full rounded-xl border p-3 text-left transition-colors ${activeId === universe.id ? 'border-primary/40 bg-primary/5' : 'border-transparent hover:border-border hover:bg-accent/40'}`}
            >
              <p className="line-clamp-2 text-xs font-medium">{universe.goal}</p>
              <div className="mt-1 flex items-center justify-between">
                <span className={`text-[10px] font-semibold uppercase tracking-wide ${statusTone(universe.status === 'ready' ? 'completed' : universe.status)}`}>{universe.status}</span>
                <span className="text-[10px] text-muted-foreground">{new Date(universe.updatedAt).toLocaleDateString()}</span>
              </div>
            </button>
          ))}
        </div>
      </aside>

      <section className="flex min-h-0 flex-col">
        {active ? (
          <>
            <div className="mb-3 flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="text-sm font-semibold leading-5">{active.goal}</p>
                <p className={`mt-0.5 text-[10px] font-semibold uppercase tracking-wide ${statusTone(active.status === 'ready' ? 'completed' : active.status)}`}>{active.status}</p>
              </div>
              <Button size="sm" variant="ghost" onClick={() => void handleRemove(active.id)} aria-label="Remove universe">
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
            <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 overflow-y-auto md:grid-cols-2">
              {active.variants.map((variant) => (
                <VariantCard key={variant.id} projectId={projectId} universeId={active.id} variant={variant} onChanged={handleChanged} />
              ))}
            </div>
          </>
        ) : (
          <div className="flex h-full min-h-[280px] items-center justify-center rounded-2xl border border-dashed border-border bg-card/40 p-8 text-center">
            <div className="max-w-sm">
              <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/10 text-primary"><Rocket className="h-5 w-5" /></div>
              <h2 className="mt-4 text-lg font-semibold">Explore two approaches at once</h2>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">Describe a goal, name two alternative approaches, and pick a provider and model for each. Both run as independent, isolated implementation jobs against this repository so you can compare, preview, and apply the one you like.</p>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
