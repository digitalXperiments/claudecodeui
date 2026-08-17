import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  Activity, AlertCircle, Bot, ChevronRight, CircleDot,
  FlaskConical, Gauge, Layers3, Loader2, Play, Plus, RefreshCw,
  ShieldCheck, Sparkles, Trash2, WandSparkles,
} from 'lucide-react';

import {
  EVAL_SUITE_SCOPES,
  EVAL_SUITE_TRIGGERS,
  evalsApi,
  type EvalCenterSummary,
  type EvalSuite,
  type EvalSuiteScope,
  type EvalSuiteStatus,
  type EvalSuiteTrigger,
} from '../../../evals/api/evalsApi';
import { useProviderAuthStatus } from '../../../provider-auth/hooks/useProviderAuthStatus';
import { CLI_PROVIDERS } from '../../../provider-auth/types';
import type { LLMProvider, ProviderModelOption, ProviderModelsDefinition } from '../../../../types/app';
import { authenticatedFetch } from '../../../../utils/api';
import { Button, Input } from '../../../../shared/view/ui';
import { cn } from '../../../../lib/utils';
import type { SettingsProject } from '../../types/types';

type Section = 'overview' | 'suites' | 'generate';

const SCOPE_COPY: Record<EvalSuiteScope, { label: string; description: string; trigger: EvalSuiteTrigger }> = {
  agent_profile: { label: 'Agent profiles', description: 'Benchmark provider/model/profile capability.', trigger: 'after_run' },
  chat: { label: 'Chat', description: 'Response quality, grounding and tool decisions.', trigger: 'after_run' },
  kanban: { label: 'Kanban', description: 'Implementation and review task outcomes.', trigger: 'after_run' },
  swarm_plan: { label: 'Swarm planning', description: 'Coverage, dependencies, staffing and scopes.', trigger: 'after_plan' },
  swarm_step: { label: 'Swarm steps', description: 'Worker acceptance evidence and verified outcomes.', trigger: 'after_step' },
  swarm: { label: 'Full swarm', description: 'End-to-end quality before handoff or PR.', trigger: 'before_handoff' },
  browser: { label: 'Browser', description: 'UI, browser console and backend state.', trigger: 'after_run' },
  mission_control: { label: 'Mission Control', description: 'Structured outputs and side effects.', trigger: 'after_run' },
  custom: { label: 'Custom', description: 'A project-specific evaluation boundary.', trigger: 'manual' },
};

const STATUS_TONE: Record<EvalSuiteStatus, string> = {
  active: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
  draft: 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300',
  archived: 'border-border bg-muted text-muted-foreground',
};

const GRADER_LABELS: Record<string, string> = {
  command: 'Command', json_schema: 'JSON schema', diff_scope: 'Diff scope',
  workspace_diff: 'Workspace diff', tool_policy: 'Tool policy', model_rubric: 'Model rubric',
  browser_state: 'Browser state', human_review: 'Human review',
};

function SectionButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'rounded-md px-3 py-2 text-sm font-medium transition-colors',
        active ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-accent hover:text-foreground',
      )}
    >
      {children}
    </button>
  );
}

function Metric({ label, value, icon: Icon, detail }: { label: string; value: number; icon: typeof Activity; detail: string }) {
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm text-muted-foreground">{label}</span>
        <Icon className="h-4 w-4 text-primary" />
      </div>
      <div className="mt-2 text-2xl font-semibold text-foreground">{value.toLocaleString()}</div>
      <p className="mt-1 text-xs text-muted-foreground">{detail}</p>
    </div>
  );
}

function JsonSummary({ value }: { value: Record<string, unknown> }) {
  const entries = Object.entries(value);
  if (entries.length === 0) return <span className="text-muted-foreground">No structured expectation</span>;
  return (
    <div className="space-y-1">
      {entries.slice(0, 4).map(([key, item]) => (
        <div key={key}><span className="font-medium text-foreground">{key}:</span> {Array.isArray(item) ? item.join(' · ') : String(item)}</div>
      ))}
    </div>
  );
}

export default function EvalCenterSettingsTab({ projects = [] }: { projects?: SettingsProject[] }) {
  const [section, setSection] = useState<Section>('overview');
  const [summary, setSummary] = useState<EvalCenterSummary | null>(null);
  const [suites, setSuites] = useState<EvalSuite[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<'' | EvalSuiteStatus>('');
  const [scopeFilter, setScopeFilter] = useState<'' | EvalSuiteScope>('');

  const { providerAuthStatus, refreshProviderAuthStatuses } = useProviderAuthStatus();
  const [provider, setProvider] = useState<LLMProvider>('claude');
  const [models, setModels] = useState<ProviderModelOption[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [model, setModel] = useState('');
  const [projectId, setProjectId] = useState('');
  const [objective, setObjective] = useState('');
  const [scope, setScope] = useState<EvalSuiteScope>('swarm_step');
  const [trigger, setTrigger] = useState<EvalSuiteTrigger>('after_step');
  const [caseCount, setCaseCount] = useState(12);
  const [constraints, setConstraints] = useState('');
  const [generating, setGenerating] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [nextSummary, nextSuites] = await Promise.all([evalsApi.summary(), evalsApi.list()]);
      setSummary(nextSummary);
      setSuites(nextSuites);
      setSelectedId((current) => current && nextSuites.some((suite) => suite.suite_id === current)
        ? current
        : nextSuites[0]?.suite_id ?? null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Failed to load Eval Center');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); void refreshProviderAuthStatuses(); }, [load, refreshProviderAuthStatuses]);

  useEffect(() => {
    let cancelled = false;
    setModelsLoading(true);
    setModels([]);
    setModel('');
    void (async () => {
      try {
        const response = await authenticatedFetch(`/api/providers/${provider}/models`);
        const payload = await response.json() as { data?: { models?: ProviderModelsDefinition }; models?: ProviderModelsDefinition };
        const definition = payload.data?.models ?? payload.models;
        if (cancelled) return;
        const options = Array.isArray(definition?.OPTIONS) ? definition.OPTIONS : [];
        setModels(options);
        setModel(definition?.DEFAULT && options.some((item) => item.value === definition.DEFAULT)
          ? definition.DEFAULT
          : options[0]?.value ?? '');
      } catch {
        if (!cancelled) setModels([]);
      } finally {
        if (!cancelled) setModelsLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [provider]);

  const filteredSuites = useMemo(() => suites.filter((suite) =>
    (!statusFilter || suite.status === statusFilter) && (!scopeFilter || suite.scope === scopeFilter),
  ), [scopeFilter, statusFilter, suites]);
  const selected = suites.find((suite) => suite.suite_id === selectedId) ?? null;
  const selectedProject = projects.find((project) => project.projectId === selected?.project_id);

  const updateStatus = async (suite: EvalSuite, status: EvalSuiteStatus) => {
    setBusyId(suite.suite_id);
    setError(null);
    try {
      const updated = await evalsApi.update(suite.suite_id, { status });
      setSuites((current) => current.map((item) => item.suite_id === updated.suite_id ? updated : item));
      setSummary(await evalsApi.summary());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Failed to update suite');
    } finally {
      setBusyId(null);
    }
  };

  const removeSuite = async (suite: EvalSuite) => {
    if (!window.confirm(`Delete eval suite “${suite.name}”? Its cases and future trial history will also be removed.`)) return;
    setBusyId(suite.suite_id);
    try {
      await evalsApi.remove(suite.suite_id);
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Failed to delete suite');
    } finally {
      setBusyId(null);
    }
  };

  const generate = async () => {
    if (!objective.trim() || !providerAuthStatus[provider].authenticated) return;
    setGenerating(true);
    setError(null);
    try {
      const suite = await evalsApi.generate({
        provider, model: model || undefined, projectId: projectId || undefined,
        objective: objective.trim(), scope, trigger, caseCount,
        constraints: constraints.trim() || undefined,
      });
      await load();
      setSelectedId(suite.suite_id);
      setSection('suites');
      setObjective('');
      setConstraints('');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Failed to generate eval suite');
    } finally {
      setGenerating(false);
    }
  };

  const authReady = providerAuthStatus[provider].authenticated;

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <FlaskConical className="h-5 w-5 text-primary" />
            <h3 className="text-lg font-semibold text-foreground">Eval Center</h3>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            Define measurable success, generate suites with your providers, and control automatic retry/reassign/replan behavior.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
          <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} /> Refresh
        </Button>
      </div>

      <div className="flex flex-wrap gap-1 rounded-lg border border-border bg-muted/30 p-1">
        <SectionButton active={section === 'overview'} onClick={() => setSection('overview')}>Overview</SectionButton>
        <SectionButton active={section === 'suites'} onClick={() => setSection('suites')}>Suites</SectionButton>
        <SectionButton active={section === 'generate'} onClick={() => setSection('generate')}>AI generator</SectionButton>
      </div>

      {error && (
        <div className="flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-200">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /> {error}
        </div>
      )}

      {loading && !summary ? (
        <div className="flex items-center justify-center gap-2 py-20 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading Eval Center…</div>
      ) : null}

      {section === 'overview' && summary ? (
        <div className="space-y-5">
          <div className="grid gap-3 sm:grid-cols-2">
            <Metric label="Active suites" value={summary.activeSuites} icon={Play} detail={`${summary.draftSuites} draft · ${summary.archivedSuites} archived`} />
            <Metric label="Eval cases" value={summary.totalCases} icon={Layers3} detail={`Across ${summary.totalSuites} versioned suites`} />
            <Metric label="Deterministic graders" value={summary.deterministicGraders} icon={ShieldCheck} detail={`${summary.modelGraders} model rubric graders`} />
            <Metric label="Recorded trials" value={summary.totalTrials} icon={Gauge} detail={`${summary.passedTrials} passed · ${summary.failedTrials} failed`} />
          </div>

          <div className="rounded-xl border border-border bg-card p-4">
            <h4 className="font-medium text-foreground">Automation contract</h4>
            <p className="mt-1 text-sm text-muted-foreground">Active suites resolve at lifecycle boundaries; their policies tell orchestration what to do next.</p>
            <div className="mt-4 grid gap-2 text-sm sm:grid-cols-5">
              {[
                ['Agent completes', Bot], ['Graders verify', FlaskConical], ['Retry with feedback', RefreshCw],
                ['Reassign or replan', WandSparkles], ['Human only if uncertain', CircleDot],
              ].map(([label, Icon], index) => (
                <div key={String(label)} className="relative rounded-lg border border-border bg-background p-3">
                  <Icon className="mb-2 h-4 w-4 text-primary" />
                  <span className="text-xs font-medium text-foreground">{String(label)}</span>
                  {index < 4 ? <ChevronRight className="absolute -right-3 top-1/2 z-10 hidden h-5 w-5 -translate-y-1/2 rounded-full bg-background text-muted-foreground sm:block" /> : null}
                </div>
              ))}
            </div>
          </div>

          {summary.totalSuites === 0 ? (
            <div className="rounded-xl border border-dashed border-border px-6 py-10 text-center">
              <Sparkles className="mx-auto h-8 w-8 text-primary/70" />
              <h4 className="mt-3 font-medium text-foreground">Create your first eval suite</h4>
              <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">Describe the behavior you care about; an authenticated provider will generate cases, graders and automation policy.</p>
              <Button className="mt-4" onClick={() => setSection('generate')}><Plus className="h-4 w-4" /> Generate suite</Button>
            </div>
          ) : null}
        </div>
      ) : null}

      {section === 'suites' ? (
        <div className="space-y-4">
          <div className="flex flex-col gap-2 sm:flex-row">
            <select className="h-9 rounded-md border border-input bg-background px-3 text-sm" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as '' | EvalSuiteStatus)}>
              <option value="">All statuses</option><option value="active">Active</option><option value="draft">Draft</option><option value="archived">Archived</option>
            </select>
            <select className="h-9 rounded-md border border-input bg-background px-3 text-sm" value={scopeFilter} onChange={(event) => setScopeFilter(event.target.value as '' | EvalSuiteScope)}>
              <option value="">All surfaces</option>
              {EVAL_SUITE_SCOPES.map((item) => <option key={item} value={item}>{SCOPE_COPY[item].label}</option>)}
            </select>
            <Button className="sm:ml-auto" size="sm" onClick={() => setSection('generate')}><Plus className="h-4 w-4" /> Generate</Button>
          </div>

          <div className="grid min-h-[360px] gap-4 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
            <div className="space-y-2">
              {filteredSuites.length === 0 ? (
                <div className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">No suites match these filters.</div>
              ) : filteredSuites.map((suite) => (
                <button key={suite.suite_id} type="button" onClick={() => setSelectedId(suite.suite_id)} className={cn('w-full rounded-lg border p-3 text-left transition-colors', selectedId === suite.suite_id ? 'border-primary bg-primary/5' : 'border-border bg-card hover:bg-accent/40')}>
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0"><div className="truncate text-sm font-medium text-foreground">{suite.name}</div><div className="mt-1 text-xs text-muted-foreground">{SCOPE_COPY[suite.scope].label} · {suite.cases.length} cases · v{suite.version}</div></div>
                    <span className={cn('rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase', STATUS_TONE[suite.status])}>{suite.status}</span>
                  </div>
                </button>
              ))}
            </div>

            {selected ? (
              <div className="min-w-0 rounded-xl border border-border bg-card p-4">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2"><h4 className="text-base font-semibold text-foreground">{selected.name}</h4><span className={cn('rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase', STATUS_TONE[selected.status])}>{selected.status}</span></div>
                    <p className="mt-1 text-sm text-muted-foreground">{selected.description || selected.objective}</p>
                    <div className="mt-2 flex flex-wrap gap-2 text-xs text-muted-foreground">
                      <span>{SCOPE_COPY[selected.scope].label}</span><span>·</span><span>{selected.trigger.replace(/_/g, ' ')}</span><span>·</span><span>{selectedProject?.displayName || (selected.project_id ? 'Project suite' : 'Global')}</span>
                      {selected.source === 'ai' ? <><span>·</span><span>AI: {selected.generator_provider}{selected.generator_model ? `/${selected.generator_model}` : ''}</span></> : null}
                    </div>
                  </div>
                  <div className="flex shrink-0 flex-wrap gap-2">
                    {selected.status !== 'active' ? <Button size="sm" onClick={() => void updateStatus(selected, 'active')} disabled={busyId === selected.suite_id}><Play className="h-4 w-4" /> Activate</Button> : <Button variant="outline" size="sm" onClick={() => void updateStatus(selected, 'draft')} disabled={busyId === selected.suite_id}>Pause</Button>}
                    {selected.status !== 'archived' ? <Button variant="outline" size="sm" onClick={() => void updateStatus(selected, 'archived')} disabled={busyId === selected.suite_id}>Archive</Button> : null}
                    <Button variant="ghost" size="sm" onClick={() => void removeSuite(selected)} disabled={busyId === selected.suite_id} aria-label="Delete suite"><Trash2 className="h-4 w-4 text-destructive" /></Button>
                  </div>
                </div>

                <div className="mt-4 rounded-lg border border-border bg-background p-3 text-xs">
                  <div className="grid gap-2 sm:grid-cols-2">
                    <div><span className="text-muted-foreground">Pass:</span> <span className="font-medium text-foreground">{selected.action_policy.onPass.replace(/_/g, ' ')}</span></div>
                    <div><span className="text-muted-foreground">Low confidence:</span> <span className="font-medium text-foreground">{selected.action_policy.onLowConfidence.replace(/_/g, ' ')}</span></div>
                    <div className="sm:col-span-2"><span className="text-muted-foreground">Failure ladder:</span> <span className="font-medium text-foreground">{selected.action_policy.onFailure.map((item) => item.replace(/_/g, ' ')).join(' → ')}</span></div>
                    <div><span className="text-muted-foreground">Threshold:</span> <span className="font-medium text-foreground">{Math.round(selected.action_policy.minimumScore * 100)}%</span></div>
                    <div><span className="text-muted-foreground">Automatic attempts:</span> <span className="font-medium text-foreground">{selected.action_policy.maxAutomaticAttempts}</span></div>
                  </div>
                </div>

                <div className="mt-4 space-y-3">
                  <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Cases</div>
                  {selected.cases.map((evalCase, index) => (
                    <details key={evalCase.case_id} className="group rounded-lg border border-border bg-background" open={index === 0}>
                      <summary className="flex cursor-pointer list-none items-start justify-between gap-3 p-3">
                        <div><div className="text-sm font-medium text-foreground">{evalCase.name}</div><div className="mt-0.5 text-xs text-muted-foreground">{evalCase.difficulty} · {evalCase.graders.length} graders</div></div>
                        <ChevronRight className="mt-0.5 h-4 w-4 text-muted-foreground transition-transform group-open:rotate-90" />
                      </summary>
                      <div className="space-y-3 border-t border-border p-3 text-xs">
                        {evalCase.description ? <p className="text-muted-foreground">{evalCase.description}</p> : null}
                        <div><div className="mb-1 font-medium text-foreground">Agent task</div><div className="whitespace-pre-wrap rounded-md bg-muted/50 p-2 text-muted-foreground">{evalCase.prompt}</div></div>
                        <div><div className="mb-1 font-medium text-foreground">Expected outcome</div><JsonSummary value={evalCase.expected_outcome} /></div>
                        <div className="flex flex-wrap gap-1.5">{evalCase.graders.map((grader) => <span key={grader.grader_id} className="rounded-md border border-border px-2 py-1 text-muted-foreground">{grader.required ? 'Required · ' : ''}{GRADER_LABELS[grader.type] || grader.type}</span>)}</div>
                      </div>
                    </details>
                  ))}
                </div>
              </div>
            ) : <div className="rounded-xl border border-dashed border-border p-10 text-center text-sm text-muted-foreground">Select a suite to inspect its automation contract.</div>}
          </div>
        </div>
      ) : null}

      {section === 'generate' ? (
        <div className="space-y-5 rounded-xl border border-border bg-card p-4">
          <div><div className="flex items-center gap-2"><WandSparkles className="h-5 w-5 text-primary" /><h4 className="font-semibold text-foreground">Generate an eval suite</h4></div><p className="mt-1 text-sm text-muted-foreground">CloudCLI provides bounded project context; the selected provider creates cases, graders and an automatic failure ladder. The result is saved as a draft.</p></div>

          <div className="grid gap-4 sm:grid-cols-2">
            <label className="space-y-1.5 text-sm"><span className="font-medium text-foreground">Provider</span><select className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm" value={provider} onChange={(event) => setProvider(event.target.value as LLMProvider)}>{CLI_PROVIDERS.map((item) => <option key={item} value={item}>{item}{providerAuthStatus[item].authenticated ? ' · connected' : ' · not connected'}</option>)}</select></label>
            <label className="space-y-1.5 text-sm"><span className="font-medium text-foreground">Model</span><select className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm" value={model} onChange={(event) => setModel(event.target.value)} disabled={modelsLoading || models.length === 0}>{modelsLoading ? <option>Loading models…</option> : models.length === 0 ? <option value="">Provider default</option> : models.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
            <label className="space-y-1.5 text-sm"><span className="font-medium text-foreground">Project context</span><select className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm" value={projectId} onChange={(event) => setProjectId(event.target.value)}><option value="">Global / reusable</option>{projects.filter((project) => project.projectId).map((project) => <option key={project.projectId} value={project.projectId}>{project.displayName || project.name}</option>)}</select></label>
            <label className="space-y-1.5 text-sm"><span className="font-medium text-foreground">Surface</span><select className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm" value={scope} onChange={(event) => { const next = event.target.value as EvalSuiteScope; setScope(next); setTrigger(SCOPE_COPY[next].trigger); }}>{EVAL_SUITE_SCOPES.map((item) => <option key={item} value={item}>{SCOPE_COPY[item].label}</option>)}</select><span className="block text-xs text-muted-foreground">{SCOPE_COPY[scope].description}</span></label>
            <label className="space-y-1.5 text-sm"><span className="font-medium text-foreground">Lifecycle trigger</span><select className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm" value={trigger} onChange={(event) => setTrigger(event.target.value as EvalSuiteTrigger)}>{EVAL_SUITE_TRIGGERS.map((item) => <option key={item} value={item}>{item.replace(/_/g, ' ')}</option>)}</select></label>
            <label className="space-y-1.5 text-sm"><span className="font-medium text-foreground">Number of cases</span><Input type="number" min={3} max={30} value={caseCount} onChange={(event) => setCaseCount(Math.max(3, Math.min(30, Number(event.target.value) || 3)))} /></label>
          </div>

          <label className="block space-y-1.5 text-sm"><span className="font-medium text-foreground">What should perform better?</span><textarea className="min-h-28 w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring" value={objective} onChange={(event) => setObjective(event.target.value)} placeholder="Example: Implementer agents should make the smallest correct change, run focused tests, avoid unrelated files, and recover automatically when verification fails." /></label>
          <label className="block space-y-1.5 text-sm"><span className="font-medium text-foreground">Extra constraints <span className="font-normal text-muted-foreground">(optional)</span></span><textarea className="min-h-20 w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring" value={constraints} onChange={(event) => setConstraints(event.target.value)} placeholder="Technologies, must-cover failure modes, safety restrictions, or quality thresholds." /></label>

          {!authReady ? <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-800 dark:text-amber-200">Connect {provider} in Settings → Agents before generating. <button type="button" className="ml-1 underline" onClick={() => window.dispatchEvent(new CustomEvent('cloudcli:open-settings', { detail: { tab: 'agents' } }))}>Open Agents</button></div> : null}

          <div className="flex justify-end"><Button onClick={() => void generate()} disabled={generating || !objective.trim() || !authReady}>{generating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}{generating ? 'Generating suite…' : `Generate ${caseCount} cases`}</Button></div>
        </div>
      ) : null}
    </div>
  );
}
