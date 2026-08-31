import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Bot,
  CheckCircle2,
  CircleAlert,
  Filter,
  GitBranch,
  Loader2,
  RefreshCw,
  Save,
  Sparkles,
  Waypoints,
} from 'lucide-react';

import { agentRelayApi } from '../../../agent-relay/api/agentRelayApi';
import type { AgentRelayRuntimeStatus, AgentRelaySettings, AgentRelayWorkerProfile } from '../../../agent-relay/types';
import type { LLMProvider } from '../../../../types/app';
import { authenticatedFetch } from '../../../../utils/api';
import { Button } from '../../../../shared/view/ui';
import { AGENT_NAMES, AGENT_PROVIDERS } from '../../constants/constants';
import SettingsSection from '../SettingsSection';
import SettingsToggle from '../SettingsToggle';

type WorkerModelOption = { value: string; label: string };
type WorkerModelCatalog = {
  options: WorkerModelOption[];
  defaultModel: string | null;
  error: string | null;
};

const hydrateSettings = (next: AgentRelaySettings): AgentRelaySettings => ({
  ...next,
  allowedWorkerModels: next.allowedWorkerModels ?? {},
  workerProfiles: next.workerProfiles ?? {},
});

const providerTone = (available: boolean) => available
  ? 'border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
  : 'border-border bg-muted/40 text-muted-foreground';

export default function AgentRelaySettingsTab() {
  const [settings, setSettings] = useState<AgentRelaySettings | null>(null);
  const [savedSettings, setSavedSettings] = useState<AgentRelaySettings | null>(null);
  const [status, setStatus] = useState<AgentRelayRuntimeStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [catalogs, setCatalogs] = useState<Partial<Record<LLMProvider, WorkerModelCatalog>>>({});
  const [catalogsLoading, setCatalogsLoading] = useState(false);
  const [modelSearch, setModelSearch] = useState<Partial<Record<LLMProvider, string>>>({});
  const [mcpCatalogByProvider, setMcpCatalogByProvider] = useState<Partial<Record<LLMProvider, string[]>>>({});
  const [mcpCatalogLoading, setMcpCatalogLoading] = useState(false);
  const [honorsMcpGrants, setHonorsMcpGrants] = useState<Partial<Record<LLMProvider, boolean>>>({});

  const refresh = useCallback(async () => {
    const [nextSettings, nextStatus] = await Promise.all([
      agentRelayApi.getSettings(),
      agentRelayApi.getStatus(),
    ]);
    const hydrated = hydrateSettings(nextSettings);
    setSettings(hydrated);
    setSavedSettings(hydrated);
    setStatus(nextStatus);
  }, []);

  useEffect(() => {
    setLoading(true);
    void refresh()
      .catch((caught) => setError(caught instanceof Error ? caught.message : 'Could not load Agent Relay.'))
      .finally(() => setLoading(false));
  }, [refresh]);

  const save = async () => {
    if (!settings) return;
    if (settings.enabled && settings.leadProviders.length === 0) {
      setError('Select at least one lead agent before enabling Agent Relay.');
      return;
    }
    if (settings.enabled && settings.workerProviders.length === 0) {
      setError('Select at least one worker before enabling Agent Relay.');
      return;
    }
    if (settings.enabled) {
      const emptyLimit = settings.workerProviders.find((provider) => {
        const allowed = settings.allowedWorkerModels[provider];
        return Array.isArray(allowed) && allowed.length === 0;
      });
      if (emptyLimit) {
        setError(`Select at least one ${AGENT_NAMES[emptyLimit]} model, or turn off Limit models for that agent.`);
        return;
      }
    }
    setSaving(true);
    setError(null);
    try {
      const next = hydrateSettings(await agentRelayApi.updateSettings(settings));
      setSettings(next);
      setSavedSettings(next);
      setStatus(await agentRelayApi.getStatus());
      window.dispatchEvent(new Event('agentRelaySettingsChanged'));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not save Agent Relay settings.');
    } finally {
      setSaving(false);
    }
  };

  const toggleProvider = (key: 'leadProviders' | 'workerProviders', provider: AgentRelaySettings[typeof key][number]) => {
    setSettings((current) => {
      if (!current) return current;
      const selected = new Set(current[key]);
      if (selected.has(provider)) selected.delete(provider);
      else selected.add(provider);
      return {
        ...current,
        [key]: AGENT_PROVIDERS.filter((candidate) => selected.has(candidate)),
      };
    });
  };

  const workerProviderKey = settings?.workerProviders.join(',') ?? '';

  useEffect(() => {
    const providers = workerProviderKey ? workerProviderKey.split(',') as LLMProvider[] : [];
    if (providers.length === 0) {
      setCatalogs({});
      return;
    }
    let cancelled = false;
    setCatalogsLoading(true);
    void Promise.all(providers.map(async (provider) => {
      try {
        const response = await authenticatedFetch(`/api/providers/${provider}/models`);
        const body = await response.json() as {
          success?: boolean;
          data?: { models?: { OPTIONS?: WorkerModelOption[]; DEFAULT?: string } };
          error?: string;
        };
        if (!response.ok || !body.success || !body.data?.models) {
          throw new Error(body.error || 'Could not load models.');
        }
        const options = Array.isArray(body.data.models.OPTIONS)
          ? body.data.models.OPTIONS.map((option) => ({ value: option.value, label: option.label || option.value }))
          : [];
        return {
          provider,
          catalog: {
            options,
            defaultModel: typeof body.data.models.DEFAULT === 'string' ? body.data.models.DEFAULT : null,
            error: null,
          } satisfies WorkerModelCatalog,
        };
      } catch (caught) {
        return {
          provider,
          catalog: {
            options: [],
            defaultModel: null,
            error: caught instanceof Error ? caught.message : 'Could not load models.',
          } satisfies WorkerModelCatalog,
        };
      }
    })).then((results) => {
      if (cancelled) return;
      const next: Partial<Record<LLMProvider, WorkerModelCatalog>> = {};
      for (const entry of results) next[entry.provider] = entry.catalog;
      setCatalogs(next);
    }).finally(() => {
      if (!cancelled) setCatalogsLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [workerProviderKey]);

  useEffect(() => {
    const providers = workerProviderKey ? workerProviderKey.split(',') as LLMProvider[] : [];
    if (providers.length === 0) {
      setMcpCatalogByProvider({});
      setHonorsMcpGrants({});
      return;
    }
    let cancelled = false;
    setMcpCatalogLoading(true);
    void Promise.all([
      authenticatedFetch('/api/agent-relay/capabilities').then(async (response) => {
        const body = await response.json() as {
          success?: boolean;
          data?: { capabilities?: { catalogs?: Array<{ provider: LLMProvider; honorsMcpGrants?: boolean }> } };
        };
        const map: Partial<Record<LLMProvider, boolean>> = {};
        for (const catalog of body.data?.capabilities?.catalogs ?? []) {
          map[catalog.provider] = Boolean(catalog.honorsMcpGrants);
        }
        return map;
      }).catch(() => ({}) as Partial<Record<LLMProvider, boolean>>),
      Promise.all(providers.map(async (provider) => {
        try {
          const response = await authenticatedFetch(`/api/providers/${provider}/mcp/servers`);
          const data = await response.json() as { data?: { servers?: unknown }; servers?: unknown };
          const servers = data?.data?.servers ?? data?.servers ?? [];
          const names = new Set<string>();
          for (const entry of Array.isArray(servers) ? servers : []) {
            const name = typeof entry === 'string' ? entry : (entry as { name?: unknown })?.name;
            if (typeof name === 'string' && name.trim()) names.add(name.trim());
          }
          return { provider, names: [...names].sort((a, b) => a.localeCompare(b)) };
        } catch {
          return { provider, names: [] as string[] };
        }
      })),
    ]).then(([grants, catalogs]) => {
      if (cancelled) return;
      setHonorsMcpGrants(grants);
      const next: Partial<Record<LLMProvider, string[]>> = {};
      for (const entry of catalogs) next[entry.provider] = entry.names;
      setMcpCatalogByProvider(next);
    }).finally(() => {
      if (!cancelled) setMcpCatalogLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [workerProviderKey]);

  const patchWorkerProfile = (provider: LLMProvider, patch: Partial<AgentRelayWorkerProfile> | null) => {
    setSettings((current) => {
      if (!current) return current;
      const nextProfiles = { ...(current.workerProfiles ?? {}) };
      if (patch === null) {
        delete nextProfiles[provider];
        return { ...current, workerProfiles: nextProfiles };
      }
      const existing = nextProfiles[provider] ?? {};
      const merged: AgentRelayWorkerProfile = { ...existing, ...patch };
      nextProfiles[provider] = merged;
      return { ...current, workerProfiles: nextProfiles };
    });
  };

  const toggleProfileMcp = (provider: LLMProvider, name: string) => {
    setSettings((current) => {
      if (!current) return current;
      const profiles = { ...(current.workerProfiles ?? {}) };
      const existing = profiles[provider] ?? {};
      const selected = new Set(existing.mcpServers ?? []);
      if (selected.has(name)) selected.delete(name);
      else selected.add(name);
      profiles[provider] = { ...existing, mcpServers: [...selected] };
      return { ...current, workerProfiles: profiles };
    });
  };

  const orderedSelection = (provider: LLMProvider, selected: Set<string>): string[] => {
    const catalog = catalogs[provider];
    const options = catalog?.options ?? [];
    const picked = options.map((option) => option.value).filter((value) => selected.has(value));
    const leftover = [...selected].filter((value) => !picked.includes(value));
    const defaultModel = catalog?.defaultModel;
    const merged = [...picked, ...leftover];
    if (defaultModel && merged.includes(defaultModel)) {
      return [defaultModel, ...merged.filter((value) => value !== defaultModel)];
    }
    return merged;
  };

  const isLimited = (provider: LLMProvider): boolean => (
    Object.prototype.hasOwnProperty.call(settings?.allowedWorkerModels ?? {}, provider)
  );

  const toggleLimit = (provider: LLMProvider) => {
    setSettings((current) => {
      if (!current) return current;
      const next = { ...current.allowedWorkerModels };
      if (Object.prototype.hasOwnProperty.call(next, provider)) {
        delete next[provider];
      } else {
        next[provider] = [];
      }
      return { ...current, allowedWorkerModels: next };
    });
  };

  const toggleWorkerModel = (provider: LLMProvider, model: string) => {
    setSettings((current) => {
      if (!current) return current;
      const currentList = current.allowedWorkerModels[provider];
      if (!currentList) return current;
      const selected = new Set(currentList);
      if (selected.has(model)) selected.delete(model);
      else selected.add(model);
      return {
        ...current,
        allowedWorkerModels: {
          ...current.allowedWorkerModels,
          [provider]: orderedSelection(provider, selected),
        },
      };
    });
  };

  const setWorkerModels = (provider: LLMProvider, values: string[]) => {
    setSettings((current) => {
      if (!current || !Object.prototype.hasOwnProperty.call(current.allowedWorkerModels, provider)) return current;
      return {
        ...current,
        allowedWorkerModels: {
          ...current.allowedWorkerModels,
          [provider]: orderedSelection(provider, new Set(values)),
        },
      };
    });
  };

  const runSync = async () => {
    setSyncing(true);
    setError(null);
    try {
      await agentRelayApi.sync();
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not sync Agent Relay integrations.');
    } finally {
      setSyncing(false);
    }
  };

  const statusByProvider = useMemo(
    () => new Map(status?.providers.map((entry) => [entry.provider, entry]) ?? []),
    [status],
  );
  const dirty = useMemo(
    () => Boolean(settings && savedSettings && JSON.stringify(settings) !== JSON.stringify(savedSettings)),
    [savedSettings, settings],
  );

  if (loading || !settings) {
    return <div className="flex min-h-64 items-center justify-center"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>;
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <SettingsSection
        title="Agent Relay"
        description="Let a normal Claude, Codex, OpenCode, or other lead chat fan work out to fresh provider agents through a lightweight MCP broker."
      >
        <div className="overflow-hidden rounded-2xl border border-border bg-card/50">
          <div className="border-b border-border bg-gradient-to-br from-primary/[0.12] via-transparent to-transparent p-5 sm:p-6">
            <div className="flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
              <div className="flex gap-3.5">
                <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-primary/20 bg-primary/10 text-primary">
                  <Waypoints className="h-5 w-5" />
                </div>
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-base font-semibold text-foreground">Cross-provider delegation</h3>
                    <span className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${savedSettings?.enabled ? providerTone(true) : providerTone(false)}`}>
                      {dirty ? 'Unsaved' : savedSettings?.enabled ? 'Ready' : 'Off'}
                    </span>
                  </div>
                  <p className="mt-1.5 max-w-2xl text-sm leading-6 text-muted-foreground">
                    The lead model plans and verifies. CloudCLI only starts workers, isolates writes, records results, and returns them to the lead chat.
                  </p>
                </div>
              </div>
              <SettingsToggle
                checked={settings.enabled}
                onChange={(enabled) => setSettings((current) => current ? { ...current, enabled } : current)}
                disabled={saving || syncing}
                ariaLabel="Enable Agent Relay"
              />
            </div>
          </div>

          <div className="grid divide-y divide-border sm:grid-cols-3 sm:divide-x sm:divide-y-0">
            <div className="p-4">
              <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Running</div>
              <div className="mt-1 text-xl font-semibold text-foreground">{status?.activeCount ?? 0}</div>
            </div>
            <div className="p-4">
              <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Queued</div>
              <div className="mt-1 text-xl font-semibold text-foreground">{status?.queuedCount ?? 0}</div>
            </div>
            <div className="p-4">
              <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Integration</div>
              <div className="mt-1 truncate text-sm font-medium text-foreground">MCP + managed skill</div>
            </div>
          </div>
        </div>

        {error ? (
          <div className="flex items-start gap-2 rounded-xl border border-red-500/25 bg-red-500/10 p-3 text-sm text-red-700 dark:text-red-300">
            <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" />
            {error}
          </div>
        ) : null}

        <div className="grid gap-5 xl:grid-cols-2">
          <div className="rounded-xl border border-border bg-card p-4">
            <div className="flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-primary" />
              <h4 className="text-sm font-semibold text-foreground">Lead agents</h4>
            </div>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">Only checked agents receive the Agent Relay MCP and delegation skill in their native configuration.</p>
            <div className="mt-4 grid gap-2 sm:grid-cols-2">
              {AGENT_PROVIDERS.map((provider) => (
                <label key={provider} className="flex cursor-pointer items-center gap-2.5 rounded-lg border border-border/70 px-3 py-2.5 hover:bg-muted/40">
                  <input
                    type="checkbox"
                    checked={settings.leadProviders.includes(provider)}
                    onChange={() => toggleProvider('leadProviders', provider)}
                    disabled={saving || syncing}
                    className="h-4 w-4 rounded border-border accent-primary"
                  />
                  <span className="text-sm font-medium text-foreground">{AGENT_NAMES[provider]}</span>
                </label>
              ))}
            </div>
          </div>

          <div className="rounded-xl border border-border bg-card p-4">
            <div className="flex items-center gap-2">
              <Bot className="h-4 w-4 text-primary" />
              <h4 className="text-sm font-semibold text-foreground">Worker pool</h4>
            </div>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">These providers may be launched as fresh delegates. Authentication and runtime health are shown per provider.</p>
            <div className="mt-4 grid gap-2 sm:grid-cols-2">
              {AGENT_PROVIDERS.map((provider) => {
                const runtime = statusByProvider.get(provider);
                const available = Boolean(runtime?.runtimeAvailable && runtime?.authenticated);
                return (
                  <label key={provider} className="flex cursor-pointer items-center gap-2.5 rounded-lg border border-border/70 px-3 py-2.5 hover:bg-muted/40">
                    <input
                      type="checkbox"
                      checked={settings.workerProviders.includes(provider)}
                      onChange={() => toggleProvider('workerProviders', provider)}
                      disabled={saving || syncing}
                      className="h-4 w-4 rounded border-border accent-primary"
                    />
                    <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{AGENT_NAMES[provider]}</span>
                    <span className={`h-2 w-2 rounded-full ${available ? 'bg-emerald-500' : 'bg-muted-foreground/30'}`} title={available ? 'Authenticated and available' : 'Unavailable or not authenticated'} />
                  </label>
                );
              })}
            </div>
          </div>
        </div>

        <div className="rounded-xl border border-border bg-card p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-start gap-2">
              <Filter className="mt-0.5 h-4 w-4 text-primary" />
              <div>
                <h4 className="text-sm font-semibold text-foreground">Allowed worker models</h4>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  Limit each worker agent to the models you want leads to pick from. Unrestricted agents keep their full catalog. Leads only see this allowlist through <span className="font-medium text-foreground">relay_capabilities</span>.
                </p>
              </div>
            </div>
            {catalogsLoading ? <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" /> : null}
          </div>

          <div className="mt-4 space-y-3">
            {settings.workerProviders.length === 0 ? (
              <p className="text-xs text-muted-foreground">Select at least one worker agent above to choose models.</p>
            ) : settings.workerProviders.map((provider) => {
              const catalog = catalogs[provider];
              const limited = isLimited(provider);
              const selected = new Set(settings.allowedWorkerModels[provider] ?? []);
              const query = (modelSearch[provider] ?? '').trim().toLowerCase();
              const options = (catalog?.options ?? []).filter((option) => {
                if (!query) return true;
                return `${option.label} ${option.value}`.toLowerCase().includes(query);
              });
              return (
                <div key={provider} className="rounded-lg border border-border/70 p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-foreground">{AGENT_NAMES[provider]}</div>
                      <div className="text-[11px] text-muted-foreground">
                        {limited
                          ? `${selected.size} of ${catalog?.options.length ?? 0} models allowed`
                          : 'All current models allowed'}
                      </div>
                    </div>
                    <label className="flex items-center gap-2 text-xs font-medium text-foreground">
                      <input
                        type="checkbox"
                        checked={limited}
                        onChange={() => toggleLimit(provider)}
                        disabled={saving || syncing}
                        className="h-4 w-4 rounded border-border accent-primary"
                      />
                      Limit models
                    </label>
                  </div>

                  {limited ? (
                    <div className="mt-3 space-y-2">
                      {catalog?.error ? (
                        <p className="text-xs text-red-600 dark:text-red-400">{catalog.error}</p>
                      ) : null}
                      <div className="flex flex-wrap items-center gap-2">
                        <input
                          type="search"
                          value={modelSearch[provider] ?? ''}
                          onChange={(event) => setModelSearch((current) => ({ ...current, [provider]: event.target.value }))}
                          placeholder="Search models…"
                          disabled={saving || syncing}
                          className="h-9 min-w-40 flex-1 rounded-lg border border-border bg-background px-3 text-sm text-foreground"
                        />
                        <button
                          type="button"
                          onClick={() => setWorkerModels(provider, catalog?.options.map((option) => option.value) ?? [])}
                          disabled={saving || syncing || !catalog?.options.length}
                          className="rounded-lg border border-input px-2.5 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-60"
                        >
                          Select all
                        </button>
                        <button
                          type="button"
                          onClick={() => setWorkerModels(provider, [])}
                          disabled={saving || syncing}
                          className="rounded-lg border border-input px-2.5 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-60"
                        >
                          Clear
                        </button>
                      </div>
                      <div className="scrollbar-thin max-h-56 space-y-1 overflow-y-auto rounded-lg border border-border/60 p-2">
                        {catalogsLoading && !catalog ? (
                          <p className="px-2 py-3 text-xs text-muted-foreground">Loading models…</p>
                        ) : options.length === 0 ? (
                          <p className="px-2 py-3 text-xs text-muted-foreground">
                            {catalog?.options.length ? 'No models match that search.' : 'No models available for this agent.'}
                          </p>
                        ) : options.map((option) => (
                          <label key={option.value} className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted/40">
                            <input
                              type="checkbox"
                              checked={selected.has(option.value)}
                              onChange={() => toggleWorkerModel(provider, option.value)}
                              disabled={saving || syncing}
                              className="h-4 w-4 shrink-0 rounded border-border accent-primary"
                            />
                            <span className="min-w-0 flex-1 truncate text-foreground">{option.label}</span>
                            {catalog?.defaultModel === option.value ? (
                              <span className="shrink-0 rounded bg-primary/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary">Default</span>
                            ) : null}
                          </label>
                        ))}
                      </div>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>

        <div className="rounded-xl border border-border bg-card p-4">
          <h4 className="text-sm font-semibold text-foreground">Worker profiles</h4>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            Per-worker MCP grants and optional mode/approval overrides. When a task omits those fields, Relay uses the profile, then the global defaults.
          </p>
          <div className="mt-4 space-y-3">
            {settings.workerProviders.length === 0 ? (
              <p className="text-xs text-muted-foreground">Select at least one worker agent above to configure profiles.</p>
            ) : settings.workerProviders.map((provider) => {
              const profile = settings.workerProfiles?.[provider] ?? {};
              const honors = honorsMcpGrants[provider] !== false;
              const mcpNames = mcpCatalogByProvider[provider] ?? [];
              const selectedMcp = new Set(profile.mcpServers ?? []);
              return (
                <div key={provider} className="rounded-lg border border-border/70 p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="text-sm font-medium text-foreground">{AGENT_NAMES[provider]}</div>
                    {honorsMcpGrants[provider] === false ? (
                      <span className="rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[11px] text-amber-800 dark:text-amber-200">
                        This CLI ignores per-task MCP grants (uses its native MCP). Profile MCP list is stored but not injected.
                      </span>
                    ) : null}
                  </div>
                  <div className="mt-3 grid gap-3 sm:grid-cols-2">
                    <label className="space-y-1.5 text-xs font-medium text-muted-foreground">
                      Default mode
                      <select
                        value={profile.defaultMode ?? ''}
                        onChange={(event) => {
                          const value = event.target.value;
                          patchWorkerProfile(provider, {
                            defaultMode: value === 'read_only' || value === 'isolated_write' ? value : null,
                          });
                        }}
                        disabled={saving || syncing}
                        className="h-9 w-full rounded-lg border border-border bg-background px-3 text-sm text-foreground"
                      >
                        <option value="">Use global</option>
                        <option value="read_only">Read only</option>
                        <option value="isolated_write">Isolated write</option>
                      </select>
                    </label>
                    <label className="space-y-1.5 text-xs font-medium text-muted-foreground">
                      Approval policy
                      <select
                        value={profile.defaultApprovalPolicy ?? ''}
                        onChange={(event) => {
                          const value = event.target.value;
                          patchWorkerProfile(provider, {
                            defaultApprovalPolicy: value === 'auto' || value === 'manual' ? value : null,
                          });
                        }}
                        disabled={saving || syncing}
                        className="h-9 w-full rounded-lg border border-border bg-background px-3 text-sm text-foreground"
                      >
                        <option value="">Use global</option>
                        <option value="auto">Auto</option>
                        <option value="manual">Manual</option>
                      </select>
                    </label>
                  </div>
                  <div className="mt-3">
                    <p className="text-xs font-medium text-foreground">MCP servers</p>
                    {honorsMcpGrants[provider] === false ? (
                      <p className="mt-1 text-[11px] text-muted-foreground">
                        Disabled: this provider does not honor Relay MCP grants. You can still save a list for documentation; it is not injected at spawn.
                      </p>
                    ) : mcpCatalogLoading && mcpNames.length === 0 ? (
                      <p className="mt-1 text-[11px] text-muted-foreground">Loading MCP catalog…</p>
                    ) : mcpNames.length === 0 ? (
                      <p className="mt-1 text-[11px] text-muted-foreground">No MCP servers found. Configure them in Settings → MCP.</p>
                    ) : (
                      <div className={`mt-2 flex max-h-36 flex-wrap gap-1.5 overflow-y-auto ${honors ? '' : 'pointer-events-none opacity-60'}`}>
                        {mcpNames.map((name) => {
                          const selected = selectedMcp.has(name);
                          return (
                            <button
                              key={name}
                              type="button"
                              disabled={saving || syncing || !honors}
                              onClick={() => toggleProfileMcp(provider, name)}
                              className={`rounded-full border px-2.5 py-1 text-[11px] transition-colors ${
                                selected
                                  ? 'border-primary bg-primary/10 text-primary'
                                  : 'border-border bg-background text-muted-foreground hover:border-primary/40'
                              }`}
                            >
                              {name}
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div className="rounded-xl border border-border bg-card p-4">
          <h4 className="text-sm font-semibold text-foreground">Execution defaults</h4>
          <div className="mt-4 grid gap-4 md:grid-cols-2 lg:grid-cols-5">
            <label className="space-y-1.5 text-xs font-medium text-muted-foreground">
              Max concurrent workers
              <input
                type="number"
                min={1}
                max={12}
                value={settings.maxConcurrency}
                onChange={(event) => setSettings((current) => current ? { ...current, maxConcurrency: Math.min(12, Math.max(1, Number(event.target.value) || 1)) } : current)}
                disabled={saving || syncing}
                className="h-10 w-full rounded-lg border border-border bg-background px-3 text-sm text-foreground"
              />
            </label>
            <label className="space-y-1.5 text-xs font-medium text-muted-foreground">
              Worker timeout (minutes)
              <input
                type="number"
                min={1}
                max={60}
                value={Math.round(settings.defaultTimeoutMs / 60_000)}
                onChange={(event) => setSettings((current) => current ? { ...current, defaultTimeoutMs: Math.min(60, Math.max(1, Number(event.target.value) || 15)) * 60_000 } : current)}
                disabled={saving || syncing}
                className="h-10 w-full rounded-lg border border-border bg-background px-3 text-sm text-foreground"
              />
            </label>
            <label className="space-y-1.5 text-xs font-medium text-muted-foreground">
              <span title="How long a worker waits for the lead to answer an out-of-envelope permission request before it is denied.">
                Approval wait (minutes)
              </span>
              <input
                type="number"
                min={1}
                max={30}
                value={Math.max(1, Math.round(settings.approvalTimeoutMs / 60_000))}
                onChange={(event) => setSettings((current) => current ? { ...current, approvalTimeoutMs: Math.min(30, Math.max(1, Number(event.target.value) || 3)) * 60_000 } : current)}
                disabled={saving || syncing}
                className="h-10 w-full rounded-lg border border-border bg-background px-3 text-sm text-foreground"
              />
            </label>
            <label className="space-y-1.5 text-xs font-medium text-muted-foreground">
              Default mode
              <select
                value={settings.defaultMode}
                onChange={(event) => setSettings((current) => current ? { ...current, defaultMode: event.target.value as AgentRelaySettings['defaultMode'] } : current)}
                disabled={saving || syncing}
                className="h-10 w-full rounded-lg border border-border bg-background px-3 text-sm text-foreground"
              >
                <option value="read_only">Read only</option>
                <option value="isolated_write">Isolated write</option>
              </select>
            </label>
            <label className="space-y-1.5 text-xs font-medium text-muted-foreground">
              <span title="Auto applies the task's permission envelope locally and only relays risky or unknown actions. Manual also asks before isolated-worktree writes.">
                Approval policy
              </span>
              <select
                value={settings.defaultApprovalPolicy}
                onChange={(event) => setSettings((current) => current ? { ...current, defaultApprovalPolicy: event.target.value as AgentRelaySettings['defaultApprovalPolicy'] } : current)}
                disabled={saving || syncing}
                className="h-10 w-full rounded-lg border border-border bg-background px-3 text-sm text-foreground"
              >
                <option value="auto">Auto (recommended)</option>
                <option value="manual">Manual writes</option>
              </select>
            </label>
          </div>

          <div className="mt-4 flex flex-col gap-3 rounded-lg border border-border/70 bg-muted/30 p-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-start gap-2.5">
              <GitBranch className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
              <div>
                <div className="text-sm font-medium text-foreground">One worktree and branch per isolated writer</div>
                <div className="mt-0.5 text-xs text-muted-foreground">Relay never auto-rebases or merges. The lead reviews each diff and integrates branches deliberately.</div>
              </div>
            </div>
            <label className="flex items-center gap-2 text-xs font-medium text-foreground">
              <input
                type="checkbox"
                checked={settings.installSkill}
                onChange={(event) => setSettings((current) => current ? { ...current, installSkill: event.target.checked } : current)}
                disabled={saving || syncing}
                className="h-4 w-4 accent-primary"
              />
              Install delegation skill
            </label>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            {dirty ? <CircleAlert className="h-4 w-4 text-amber-500" /> : savedSettings?.enabled ? <CheckCircle2 className="h-4 w-4 text-emerald-500" /> : <CircleAlert className="h-4 w-4" />}
            {dirty ? 'Save to apply these selections.' : savedSettings?.enabled ? 'Bindings are active. Start a new lead chat so the MCP server and skill load.' : 'Enable Agent Relay to write provider-native bindings.'}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => void runSync()} disabled={syncing || saving || dirty}>
              {syncing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
              Resync MCP & skill
            </Button>
            <Button onClick={() => void save()} disabled={saving || syncing || !dirty}>
              {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
              Save Relay settings
            </Button>
          </div>
        </div>
      </SettingsSection>
    </div>
  );
}
