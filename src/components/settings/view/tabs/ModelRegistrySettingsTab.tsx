import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowUpDown,
  Bot,
  Check,
  ChevronDown,
  Clock3,
  Database,
  Filter,
  Gauge,
  RefreshCw,
  Search,
  SlidersHorizontal,
  Sparkles,
} from 'lucide-react';

import { cn } from '../../../../lib/utils';
import { authenticatedFetch } from '../../../../utils/api';
import { Badge, Button } from '../../../../shared/view/ui';
import SessionProviderLogo from '../../../llm-logo-provider/SessionProviderLogo';
import { AGENT_NAMES, AGENT_PROVIDERS } from '../../constants/constants';

type ModelCapability = {
  modelId: string;
  provider: string;
  displayName: string | null;
  contextWindow: number | null;
  maxContextWindow: number | null;
  officialContextWindow: number | null;
  inputCostPerMtok: number | null;
  outputCostPerMtok: number | null;
  codingScore: number;
  agenticScore: number;
  longContextScore: number;
  speedScore: number | null;
  confidence: number;
  sources: string[];
  aliases: string[];
  assessmentKind: 'heuristic' | 'benchmark' | 'catalog-only';
  fetchedAt: string;
  enabled: boolean;
};

type StaffingPrefs = {
  allowedProviders: string[] | null;
  defaultOrchestratorProvider: string | null;
  defaultOrchestratorModel: string | null;
};

type StatusFilter = 'all' | 'enabled' | 'disabled';
type SortMode = 'recommended' | 'name' | 'context' | 'confidence';

const PRIMARY_RESEARCH_PROVIDERS = ['claude', 'codex', 'grok'];
const ORCHESTRATOR_MIN_SCORE = 0.85;

async function requestJson<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await authenticatedFetch(url, options);
  const payload = (await response.json().catch(() => null)) as T | null;
  if (!response.ok) {
    const detail = payload && typeof payload === 'object' && 'error' in payload
      ? String(payload.error)
      : `Request failed (${response.status})`;
    throw new Error(detail);
  }
  return (payload ?? {}) as T;
}

function providerLabel(provider: string): string {
  return AGENT_NAMES[provider as keyof typeof AGENT_NAMES] ?? provider;
}

function formatContextWindow(value: number | null): string {
  if (!value) return 'Not reported';
  if (value >= 1_000_000) return `${Number((value / 1_000_000).toFixed(1))}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
  return value.toLocaleString();
}

function formatRefreshTime(value: string | null): string {
  if (!value) return 'Never refreshed';
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return 'Unknown';
  const minutes = Math.max(0, Math.round((Date.now() - time) / 60_000));
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function capabilityScore(capability: ModelCapability): number {
  return capability.codingScore * 0.45
    + capability.agenticScore * 0.35
    + capability.longContextScore * 0.15
    + (capability.speedScore ?? 0) * 0.05;
}

function bestFit(capability: ModelCapability): string {
  const scores = [
    { label: 'Implementation', value: capability.codingScore },
    { label: 'Orchestration', value: capability.agenticScore },
    { label: 'Long context', value: capability.longContextScore },
    { label: 'Fast tasks', value: capability.speedScore ?? -1 },
  ].sort((left, right) => right.value - left.value);
  return scores[0].value > 0 ? scores[0].label : 'Needs assessment';
}

function confidenceLabel(value: number): string {
  if (value >= 0.75) return 'High';
  if (value >= 0.45) return 'Medium';
  return 'Low';
}

function ScoreBar({ label, value }: { label: string; value: number | null }) {
  const normalized = value == null ? 0 : Math.max(0, Math.min(1, value));
  const hasData = value != null && value > 0;
  return (
    <div className="min-w-28 flex-1" title={`${label}: ${hasData ? `${Math.round(normalized * 100)}%` : 'not assessed'}`}>
      <div className="mb-1 flex items-center justify-between gap-2 text-[11px]">
        <span className="truncate text-muted-foreground">{label}</span>
        <span className={cn('tabular-nums', hasData ? 'font-medium text-foreground' : 'text-muted-foreground/60')}>
          {hasData ? Math.round(normalized * 100) : '—'}
        </span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
        <div
          className={cn(
            'h-full rounded-full transition-[width] duration-300',
            normalized >= 0.8 ? 'bg-emerald-500' : normalized >= 0.6 ? 'bg-primary' : 'bg-amber-500',
          )}
          style={{ width: `${Math.round(normalized * 100)}%` }}
        />
      </div>
    </div>
  );
}

function ProviderToggle({
  provider,
  enabled,
  modelCount,
  onChange,
}: {
  provider: string;
  enabled: boolean;
  modelCount: number;
  onChange: (enabled: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      onClick={() => onChange(!enabled)}
      className={cn(
        'flex min-w-0 items-center gap-3 rounded-xl border p-3 text-left transition-colors',
        enabled
          ? 'border-primary/25 bg-primary/[0.045] hover:bg-primary/[0.075]'
          : 'border-border/70 bg-muted/15 opacity-65 hover:bg-muted/30',
      )}
    >
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border/70 bg-background">
        <SessionProviderLogo provider={provider} className="h-5 w-5" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{providerLabel(provider)}</span>
        <span className="block text-xs text-muted-foreground">
          {modelCount} discovered model{modelCount === 1 ? '' : 's'}
        </span>
      </span>
      <span className={cn(
        'flex h-5 w-5 shrink-0 items-center justify-center rounded-md border',
        enabled ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-background',
      )}>
        {enabled && <Check className="h-3.5 w-3.5" />}
      </span>
    </button>
  );
}

function ModelStatusToggle({ capability, onChange }: { capability: ModelCapability; onChange: (enabled: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={capability.enabled}
      aria-label={`${capability.enabled ? 'Disable' : 'Enable'} ${capability.displayName || capability.modelId}`}
      onClick={() => onChange(!capability.enabled)}
      className={cn(
        'relative h-6 w-11 shrink-0 rounded-full border transition-colors',
        capability.enabled ? 'border-primary bg-primary' : 'border-border bg-muted',
      )}
    >
      <span className={cn(
        'absolute top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-transform',
        capability.enabled ? 'translate-x-[1.25rem]' : 'translate-x-0.5',
      )} />
    </button>
  );
}

function ModelIdentity({ capability }: { capability: ModelCapability }) {
  const label = capability.displayName || capability.modelId;
  return (
    <div className="flex min-w-0 items-start gap-3">
      <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border/70 bg-background">
        <SessionProviderLogo provider={capability.provider} className="h-5 w-5" />
      </span>
      <div className="min-w-0">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <p className="break-words text-sm font-semibold leading-5">{label}</p>
          {PRIMARY_RESEARCH_PROVIDERS.includes(capability.provider) && capability.assessmentKind !== 'catalog-only' && (
            <Badge variant="outline" className="border-primary/20 bg-primary/5 px-1.5 py-0 text-[10px] text-primary">
              Priority review
            </Badge>
          )}
        </div>
        {label !== capability.modelId && (
          <p className="mt-0.5 break-all font-mono text-[11px] text-muted-foreground">{capability.modelId}</p>
        )}
        <p className="mt-1 text-xs text-muted-foreground">{providerLabel(capability.provider)}</p>
        {capability.aliases.length > 0 && (
          <p className="mt-1 truncate text-[11px] text-muted-foreground" title={capability.aliases.join(', ')}>
            {capability.aliases.length === 1 ? `Alias: ${capability.aliases[0]}` : `${capability.aliases.length} invocation aliases`}
          </p>
        )}
      </div>
    </div>
  );
}

function ConfidenceBadge({ capability }: { capability: ModelCapability }) {
  const label = confidenceLabel(capability.confidence);
  return (
    <div title={`${capability.assessmentKind === 'heuristic' ? 'Heuristic routing prior' : capability.assessmentKind === 'benchmark' ? 'Benchmark assessment' : 'Catalog facts only'}. Sources: ${capability.sources.length > 0 ? capability.sources.join(', ') : 'none'}`}>
      <Badge
        variant="outline"
        className={cn(
          'gap-1.5 whitespace-nowrap font-medium',
          label === 'High' && 'border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
          label === 'Medium' && 'border-blue-500/25 bg-blue-500/10 text-blue-700 dark:text-blue-400',
          label === 'Low' && 'border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-400',
        )}
      >
        <span className="h-1.5 w-1.5 rounded-full bg-current" />
        {capability.assessmentKind === 'heuristic' ? 'Heuristic' : label} · {Math.round(capability.confidence * 100)}%
      </Badge>
    </div>
  );
}

export default function ModelRegistrySettingsTab() {
  const [capabilities, setCapabilities] = useState<ModelCapability[]>([]);
  const [stale, setStale] = useState(true);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [savingPrefs, setSavingPrefs] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [providerFilter, setProviderFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [sortMode, setSortMode] = useState<SortMode>('recommended');
  const [prefs, setPrefs] = useState<StaffingPrefs>({
    allowedProviders: null,
    defaultOrchestratorProvider: null,
    defaultOrchestratorModel: null,
  });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [registry, prefsPayload] = await Promise.all([
        requestJson<{ capabilities?: ModelCapability[]; stale?: boolean }>('/api/model-registry'),
        requestJson<{ prefs?: StaffingPrefs }>('/api/model-registry/prefs'),
      ]);
      setCapabilities(registry.capabilities ?? []);
      setStale(Boolean(registry.stale));
      if (prefsPayload.prefs) setPrefs(prefsPayload.prefs);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not load model profiles.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const payload = await requestJson<{ capabilities?: ModelCapability[]; stale?: boolean }>(
        '/api/model-registry/refresh',
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
      );
      setCapabilities(payload.capabilities ?? []);
      setStale(Boolean(payload.stale));
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Refresh failed.');
    } finally {
      setRefreshing(false);
    }
  }, []);

  const savePrefs = useCallback(async (next: StaffingPrefs) => {
    setPrefs(next);
    setSavingPrefs(true);
    try {
      const payload = await requestJson<{ prefs?: StaffingPrefs }>('/api/model-registry/prefs', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(next),
      });
      if (payload.prefs) setPrefs(payload.prefs);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not save staffing preferences.');
      void load();
    } finally {
      setSavingPrefs(false);
    }
  }, [load]);

  const toggleProvider = (provider: string, on: boolean) => {
    const base = prefs.allowedProviders == null ? [...AGENT_PROVIDERS] : [...prefs.allowedProviders];
    const next = on ? Array.from(new Set([...base, provider])) : base.filter((item) => item !== provider);
    void savePrefs({
      ...prefs,
      allowedProviders: next.length === AGENT_PROVIDERS.length ? null : next,
      defaultOrchestratorProvider:
        !on && prefs.defaultOrchestratorProvider === provider ? null : prefs.defaultOrchestratorProvider,
      defaultOrchestratorModel:
        !on && prefs.defaultOrchestratorProvider === provider ? null : prefs.defaultOrchestratorModel,
    });
  };

  const toggleModel = async (capability: ModelCapability, enabled: boolean) => {
    setCapabilities((current) => current.map((row) => (
      row.provider === capability.provider && row.modelId === capability.modelId ? { ...row, enabled } : row
    )));
    try {
      const payload = await requestJson<{ capabilities?: ModelCapability[] }>('/api/model-registry/models', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: capability.provider, modelId: capability.modelId, enabled }),
      });
      if (payload.capabilities) setCapabilities(payload.capabilities);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not update model.');
      void load();
    }
  };

  const providerCounts = useMemo(() => {
    const counts = new Map<string, number>();
    capabilities.forEach((capability) => counts.set(capability.provider, (counts.get(capability.provider) ?? 0) + 1));
    return counts;
  }, [capabilities]);

  const providerOptions = useMemo(() => {
    const discovered = new Set(capabilities.map((capability) => capability.provider));
    return [...AGENT_PROVIDERS]
      .filter((provider) => discovered.has(provider) || prefs.allowedProviders?.includes(provider))
      .sort((left, right) => {
        const leftPriority = PRIMARY_RESEARCH_PROVIDERS.indexOf(left);
        const rightPriority = PRIMARY_RESEARCH_PROVIDERS.indexOf(right);
        if (leftPriority >= 0 || rightPriority >= 0) {
          if (leftPriority < 0) return 1;
          if (rightPriority < 0) return -1;
          return leftPriority - rightPriority;
        }
        return providerLabel(left).localeCompare(providerLabel(right));
      });
  }, [capabilities, prefs.allowedProviders]);

  const enabledCount = capabilities.filter((capability) => capability.enabled).length;
  const assessedCount = capabilities.filter((capability) => capability.assessmentKind !== 'catalog-only').length;
  const latestRefresh = capabilities.reduce<string | null>((latest, capability) => {
    if (!latest || Date.parse(capability.fetchedAt) > Date.parse(latest)) return capability.fetchedAt;
    return latest;
  }, null);

  const visibleCapabilities = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    const filtered = capabilities.filter((capability) => {
      if (providerFilter !== 'all' && capability.provider !== providerFilter) return false;
      if (statusFilter === 'enabled' && !capability.enabled) return false;
      if (statusFilter === 'disabled' && capability.enabled) return false;
      if (!normalizedQuery) return true;
      return `${capability.displayName ?? ''} ${capability.modelId} ${capability.provider}`
        .toLowerCase()
        .includes(normalizedQuery);
    });

    return filtered.sort((left, right) => {
      if (sortMode === 'name') {
        return (left.displayName || left.modelId).localeCompare(right.displayName || right.modelId);
      }
      if (sortMode === 'context') return (right.contextWindow ?? 0) - (left.contextWindow ?? 0);
      if (sortMode === 'confidence') return right.confidence - left.confidence;
      return capabilityScore(right) - capabilityScore(left) || right.confidence - left.confidence;
    });
  }, [capabilities, providerFilter, query, sortMode, statusFilter]);

  const allowedProviderOptions = providerOptions.filter((provider) => (
    prefs.allowedProviders == null || prefs.allowedProviders.includes(provider)
  ));

  const orchestratorOptions = capabilities.filter((row) => (
    row.enabled
    && row.confidence >= 0.45
    && row.agenticScore * 0.6 + row.longContextScore * 0.4 >= ORCHESTRATOR_MIN_SCORE
    && (prefs.allowedProviders == null || prefs.allowedProviders.includes(row.provider))
    && (!prefs.defaultOrchestratorProvider || row.provider === prefs.defaultOrchestratorProvider)
  ));

  return (
    <div className="mx-auto w-full max-w-[1380px] space-y-6">
      <header className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
        <div className="max-w-3xl">
          <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-primary">
            <Gauge className="h-4 w-4" />
            Swarm intelligence
          </div>
          <h3 className="text-2xl font-semibold tracking-tight">Model profiles</h3>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            Compare the models discovered from your installed agents, control which ones can be staffed,
            and choose a dependable default orchestrator. Scores combine live catalogs with cached research
            and become more trustworthy as evidence accumulates.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {savingPrefs && <span className="text-xs text-muted-foreground">Saving preferences…</span>}
          <Button variant="outline" onClick={() => void refresh()} disabled={refreshing} className="shadow-sm">
            <RefreshCw className={cn('h-4 w-4', refreshing && 'animate-spin')} />
            {refreshing ? 'Refreshing profiles…' : 'Refresh profiles'}
          </Button>
        </div>
      </header>

      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4" aria-label="Registry summary">
        {[
          { label: 'Discovered', value: capabilities.length, detail: 'models in live catalogs', icon: Database },
          { label: 'Available to swarm', value: enabledCount, detail: `${capabilities.length - enabledCount} excluded`, icon: Bot },
          { label: 'Research matched', value: assessedCount, detail: `${capabilities.length - assessedCount} catalog-only`, icon: Sparkles },
          { label: stale ? 'Refresh overdue' : 'Registry current', value: formatRefreshTime(latestRefresh), detail: '24-hour catalog cadence', icon: Clock3 },
        ].map((stat) => {
          const Icon = stat.icon;
          return (
            <div key={stat.label} className="rounded-xl border border-border/70 bg-card/60 p-4 shadow-sm">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-xs font-medium text-muted-foreground">{stat.label}</p>
                  <p className="mt-1 truncate text-xl font-semibold tabular-nums">{stat.value}</p>
                  <p className="mt-1 truncate text-xs text-muted-foreground">{stat.detail}</p>
                </div>
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <Icon className="h-4 w-4" />
                </span>
              </div>
            </div>
          );
        })}
      </section>

      {(stale || error) && (
        <div className="space-y-2">
          {stale && !loading && (
            <div className="flex items-start gap-3 rounded-xl border border-amber-500/30 bg-amber-500/[0.08] px-4 py-3 text-sm text-amber-800 dark:text-amber-300">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <p><span className="font-medium">The registry is older than 24 hours.</span> Refresh it to discover new model releases and aliases.</p>
            </div>
          )}
          {error && (
            <div className="flex items-start gap-3 rounded-xl border border-destructive/30 bg-destructive/[0.07] px-4 py-3 text-sm text-destructive">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <p>{error}</p>
            </div>
          )}
        </div>
      )}

      <section className="overflow-hidden rounded-2xl border border-border/70 bg-card/40 shadow-sm">
        <div className="border-b border-border/70 px-4 py-4 sm:px-5">
          <div className="flex items-start gap-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <SlidersHorizontal className="h-4 w-4" />
            </span>
            <div>
              <h4 className="font-semibold">Staffing policy</h4>
              <p className="mt-0.5 text-sm text-muted-foreground">
                Providers and defaults used by automatic swarm staffing. You can still override the orchestrator per run.
              </p>
            </div>
          </div>
        </div>

        <div className="space-y-5 p-4 sm:p-5">
          <div>
            <div className="mb-3 flex items-end justify-between gap-3">
              <div>
                <p className="text-sm font-medium">Allowed providers</p>
                <p className="mt-0.5 text-xs text-muted-foreground">Disabled providers are never assigned to worker seats.</p>
              </div>
              <span className="text-xs text-muted-foreground">
                {allowedProviderOptions.length} of {providerOptions.length} allowed
              </span>
            </div>
            <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
              {providerOptions.map((provider) => {
                const on = prefs.allowedProviders == null || prefs.allowedProviders.includes(provider);
                return (
                  <ProviderToggle
                    key={provider}
                    provider={provider}
                    enabled={on}
                    modelCount={providerCounts.get(provider) ?? 0}
                    onChange={(enabled) => toggleProvider(provider, enabled)}
                  />
                );
              })}
            </div>
          </div>

          <div className="grid gap-4 border-t border-border/70 pt-5 lg:grid-cols-2">
            <label className="block">
              <span className="text-sm font-medium">Default orchestrator provider</span>
              <span className="mt-0.5 block text-xs text-muted-foreground">Leave open to choose when creating a swarm.</span>
              <span className="relative mt-2 block">
                <select
                  className="h-11 w-full appearance-none rounded-xl border border-input bg-background px-3 pr-10 text-sm shadow-sm outline-none focus:ring-2 focus:ring-ring"
                  value={prefs.defaultOrchestratorProvider ?? ''}
                  onChange={(event) => void savePrefs({
                    ...prefs,
                    defaultOrchestratorProvider: event.target.value || null,
                    defaultOrchestratorModel: null,
                  })}
                >
                  <option value="">Choose per swarm</option>
                  {allowedProviderOptions.map((provider) => (
                    <option key={provider} value={provider}>{providerLabel(provider)}</option>
                  ))}
                </select>
                <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              </span>
            </label>
            <label className="block">
              <span className="text-sm font-medium">Default orchestrator model</span>
              <span className="mt-0.5 block text-xs text-muted-foreground">Only strong, sufficiently assessed models from allowed providers appear here.</span>
              <span className="relative mt-2 block">
                <select
                  className="h-11 w-full appearance-none rounded-xl border border-input bg-background px-3 pr-10 text-sm shadow-sm outline-none focus:ring-2 focus:ring-ring"
                  value={prefs.defaultOrchestratorModel ?? ''}
                  onChange={(event) => void savePrefs({ ...prefs, defaultOrchestratorModel: event.target.value || null })}
                >
                  <option value="">Choose per swarm</option>
                  {orchestratorOptions.map((row) => (
                    <option key={`${row.provider}/${row.modelId}`} value={row.modelId}>
                      {row.displayName || row.modelId} · {providerLabel(row.provider)}
                    </option>
                  ))}
                </select>
                <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              </span>
            </label>
          </div>
        </div>
      </section>

      <section className="overflow-hidden rounded-2xl border border-border/70 bg-card/40 shadow-sm">
        <div className="space-y-4 border-b border-border/70 p-4 sm:p-5">
          <div className="flex flex-col gap-3 xl:flex-row xl:items-end xl:justify-between">
            <div>
              <h4 className="font-semibold">Model catalog</h4>
              <p className="mt-0.5 text-sm text-muted-foreground">
                {visibleCapabilities.length} of {capabilities.length} profiles shown. Low confidence means the model was discovered but lacks matched research.
              </p>
            </div>
            <div className="flex flex-col gap-2 sm:flex-row">
              <label className="relative min-w-0 sm:w-72">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <input
                  type="search"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search model or provider…"
                  aria-label="Search model profiles"
                  className="h-10 w-full rounded-xl border border-input bg-background pl-9 pr-3 text-sm shadow-sm outline-none focus:ring-2 focus:ring-ring"
                />
              </label>
              <label className="relative sm:w-40">
                <ArrowUpDown className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <select
                  value={sortMode}
                  onChange={(event) => setSortMode(event.target.value as SortMode)}
                  aria-label="Sort model profiles"
                  className="h-10 w-full appearance-none rounded-xl border border-input bg-background pl-9 pr-8 text-sm shadow-sm outline-none focus:ring-2 focus:ring-ring"
                >
                  <option value="recommended">Best fit</option>
                  <option value="confidence">Confidence</option>
                  <option value="context">Context</option>
                  <option value="name">Name</option>
                </select>
                <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              </label>
            </div>
          </div>

          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div className="scrollbar-hide flex min-w-0 gap-1.5 overflow-x-auto pb-1 lg:pb-0">
              <button
                type="button"
                onClick={() => setProviderFilter('all')}
                className={cn(
                  'shrink-0 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors',
                  providerFilter === 'all' ? 'border-foreground bg-foreground text-background' : 'border-border bg-background hover:bg-accent',
                )}
              >
                All providers · {capabilities.length}
              </button>
              {providerOptions.map((provider) => (
                <button
                  key={provider}
                  type="button"
                  onClick={() => setProviderFilter(provider)}
                  className={cn(
                    'flex shrink-0 items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors',
                    providerFilter === provider ? 'border-foreground bg-foreground text-background' : 'border-border bg-background hover:bg-accent',
                  )}
                >
                  <SessionProviderLogo provider={provider} className="h-3.5 w-3.5" />
                  {providerLabel(provider)} · {providerCounts.get(provider) ?? 0}
                </button>
              ))}
            </div>
            <div className="flex shrink-0 items-center gap-1 rounded-lg border border-border bg-background p-1">
              <Filter className="ml-1.5 h-3.5 w-3.5 text-muted-foreground" />
              {(['all', 'enabled', 'disabled'] as StatusFilter[]).map((status) => (
                <button
                  key={status}
                  type="button"
                  onClick={() => setStatusFilter(status)}
                  className={cn(
                    'rounded-md px-2.5 py-1 text-xs font-medium capitalize transition-colors',
                    statusFilter === status ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  {status}
                </button>
              ))}
            </div>
          </div>
        </div>

        {loading ? (
          <div className="grid gap-3 p-4 lg:grid-cols-2">
            {[0, 1, 2, 3].map((item) => (
              <div key={item} className="h-36 animate-pulse rounded-xl border bg-muted/40" />
            ))}
          </div>
        ) : visibleCapabilities.length === 0 ? (
          <div className="flex flex-col items-center px-6 py-14 text-center">
            <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-muted text-muted-foreground"><Search className="h-5 w-5" /></span>
            <p className="mt-3 font-medium">No model profiles match these filters</p>
            <p className="mt-1 max-w-sm text-sm text-muted-foreground">Clear the search or show every provider and status.</p>
            <Button
              variant="outline"
              size="sm"
              className="mt-4"
              onClick={() => { setQuery(''); setProviderFilter('all'); setStatusFilter('all'); }}
            >
              Reset filters
            </Button>
          </div>
        ) : (
          <>
            <div className="divide-y divide-border/70 lg:hidden">
              {visibleCapabilities.map((capability) => (
                <article key={`${capability.provider}/${capability.modelId}`} className={cn('space-y-4 p-4', !capability.enabled && 'opacity-60')}>
                  <div className="flex items-start justify-between gap-3">
                    <ModelIdentity capability={capability} />
                    <ModelStatusToggle capability={capability} onChange={(enabled) => void toggleModel(capability, enabled)} />
                  </div>
                  <div className="grid grid-cols-2 gap-x-3 gap-y-3">
                    <ScoreBar label="Coding" value={capability.codingScore} />
                    <ScoreBar label="Agentic" value={capability.agenticScore} />
                    <ScoreBar label="Long context" value={capability.longContextScore} />
                    <ScoreBar label="Speed" value={capability.speedScore} />
                  </div>
                  <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/60 pt-3 text-xs text-muted-foreground">
                    <span>{bestFit(capability)} · {formatContextWindow(capability.contextWindow)} runtime context</span>
                    <ConfidenceBadge capability={capability} />
                  </div>
                </article>
              ))}
            </div>

            <div className="hidden overflow-x-auto lg:block">
              <table className="w-full min-w-[980px] table-fixed text-sm">
                <thead className="bg-muted/35 text-left text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
                  <tr>
                    <th className="w-[5%] px-4 py-3">Use</th>
                    <th className="w-[27%] px-3 py-3">Model</th>
                    <th className="w-[34%] px-3 py-3">Capability profile</th>
                    <th className="w-[12%] px-3 py-3">Best fit</th>
                    <th className="w-[10%] px-3 py-3">Context</th>
                    <th className="w-[12%] px-3 py-3">Confidence</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/70">
                  {visibleCapabilities.map((capability) => (
                    <tr
                      key={`${capability.provider}/${capability.modelId}`}
                      className={cn('transition-colors hover:bg-muted/20', !capability.enabled && 'opacity-55')}
                    >
                      <td className="px-4 py-4 align-top">
                        <ModelStatusToggle capability={capability} onChange={(enabled) => void toggleModel(capability, enabled)} />
                      </td>
                      <td className="px-3 py-4 align-top"><ModelIdentity capability={capability} /></td>
                      <td className="px-3 py-4 align-top">
                        <div className="grid grid-cols-2 gap-x-3 gap-y-3">
                          <ScoreBar label="Coding" value={capability.codingScore} />
                          <ScoreBar label="Agentic" value={capability.agenticScore} />
                          <ScoreBar label="Long context" value={capability.longContextScore} />
                          <ScoreBar label="Speed" value={capability.speedScore} />
                        </div>
                      </td>
                      <td className="px-3 py-4 align-top text-xs font-medium">{bestFit(capability)}</td>
                      <td className="px-3 py-4 align-top">
                        <p className="font-medium tabular-nums">{formatContextWindow(capability.contextWindow)}</p>
                        <p className="mt-1 text-[11px] text-muted-foreground">
                          {capability.maxContextWindow && capability.maxContextWindow !== capability.contextWindow
                            ? `${formatContextWindow(capability.maxContextWindow)} max`
                            : capability.officialContextWindow && capability.officialContextWindow !== capability.contextWindow
                              ? `${formatContextWindow(capability.officialContextWindow)} official`
                              : 'runtime tokens'}
                        </p>
                      </td>
                      <td className="px-3 py-4 align-top">
                        <ConfidenceBadge capability={capability} />
                        <p className="mt-2 text-[11px] text-muted-foreground">{formatRefreshTime(capability.fetchedAt)}</p>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
