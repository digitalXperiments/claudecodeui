import { useCallback, useMemo, useState } from 'react';
import {
  ChevronDown,
  Cloud,
  Copy,
  Globe,
  Loader2,
  Lock,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Server,
  Sparkles,
  Trash2,
} from 'lucide-react';

import type { LLMProvider } from '../../../types/app';
import { cn } from '../../../lib/utils';
import { Badge, Button, Input } from '../../../shared/view/ui';
import ProviderBindingMatrix, {
  FANOUT_PROVIDERS,
  PROVIDER_LABELS,
} from '../../shared/view/ProviderBindingMatrix';
import { DEFAULT_MCP_FORM, MCP_SUPPORTED_TRANSPORTS } from '../constants';
import { useMcpCatalog } from '../hooks/useMcpCatalog';
import { formStateFromTemplate, MCP_TEMPLATES, type McpTemplate } from '../templates';
import type {
  McpFormState,
  McpInventoryItem,
  McpInventorySource,
  McpProject,
  ProviderMcpServer,
} from '../types';
import { maskSecret } from '../utils/mcpFormatting';

import McpServerFormModal from './modals/McpServerFormModal';

type McpCatalogPanelProps = {
  currentProjects: McpProject[];
};

type SourceFilter = 'all' | 'cloudcli' | 'cloud' | 'native' | 'managed';
type StatusFilter = 'all' | 'connected' | 'needs_auth' | 'unbound';

const SOURCE_FILTERS: Array<{
  id: SourceFilter;
  title: string;
  icon: typeof Globe;
  sources?: McpInventorySource[];
}> = [
  {
    id: 'all',
    title: 'All servers',
    icon: Globe,
  },
  {
    id: 'cloudcli',
    title: 'Managed by CloudCLI',
    icon: Globe,
    sources: ['cloudcli'],
  },
  {
    id: 'cloud',
    title: 'Connected accounts',
    icon: Cloud,
    sources: ['provider_cloud'],
  },
  {
    id: 'native',
    title: 'Found on device',
    icon: Server,
    sources: ['provider_native'],
  },
  {
    id: 'managed',
    title: 'Managed features',
    icon: Lock,
    sources: ['managed'],
  },
];

const sourceBadge = (item: McpInventoryItem): string => {
  if (item.kind === 'memory') return 'Memory · CloudCLI';
  if (item.source === 'cloudcli') return 'CloudCLI';
  if (item.source === 'provider_cloud') return item.cloudLabel || 'Connected account';
  if (item.source === 'managed') return 'Managed feature';
  return 'On device';
};

const itemToFormState = (item: McpInventoryItem): McpFormState => ({
  ...DEFAULT_MCP_FORM,
  name: item.name,
  scope: item.scope === 'project' || item.scope === 'local' ? item.scope : 'user',
  workspacePath: item.workspacePath || '',
  transport: item.transport || 'stdio',
  command: item.command || '',
  args: item.args || [],
  env: item.env || {},
  cwd: item.cwd || '',
  url: item.url || '',
  headers: item.headers || {},
  importMode: 'form',
  jsonInput: '',
});

const itemToEditingServer = (item: McpInventoryItem): ProviderMcpServer => ({
  provider: item.originProvider || item.providers[0] || 'claude',
  name: item.name,
  scope: item.scope === 'project' || item.scope === 'local' ? item.scope : 'user',
  transport: item.transport || 'stdio',
  command: item.command,
  args: item.args,
  env: item.env,
  cwd: item.cwd,
  url: item.url,
  headers: item.headers,
  workspacePath: item.workspacePath,
});

function McpRow({
  item,
  expanded,
  onToggleExpand,
  draftProviders,
  onDraftChange,
  busy,
  onApply,
  onRemove,
  onEdit,
  onDuplicate,
  visibleProviders,
}: {
  item: McpInventoryItem;
  expanded: boolean;
  onToggleExpand: () => void;
  draftProviders: LLMProvider[];
  onDraftChange: (providers: LLMProvider[]) => void;
  busy: boolean;
  onApply: () => void;
  onRemove: () => void;
  onEdit: () => void;
  onDuplicate: () => void;
  visibleProviders: LLMProvider[];
}) {
  const isCloudcli = item.source === 'cloudcli';
  const canEditBindings = isCloudcli || item.source === 'provider_native';
  const matrixLocked = item.source === 'provider_cloud' || item.source === 'managed';
  const lockedProviders = item.providers?.length
    ? item.providers
    : item.originProvider
      ? [item.originProvider]
      : [];
  const selectedProviders = matrixLocked ? lockedProviders : draftProviders;
  const dirty = canEditBindings
    && JSON.stringify([...draftProviders].sort()) !== JSON.stringify([...(item.providers ?? [])].sort());
  const summary = item.command
    ? `${item.command} ${(item.args || []).slice(0, 3).join(' ')}${(item.args?.length || 0) > 3 ? '…' : ''}`
    : item.url || '';
  const [actionsOpen, setActionsOpen] = useState(false);

  const isUnsupported = (provider: LLMProvider) => Boolean(
    item.transport && !(MCP_SUPPORTED_TRANSPORTS[provider] || []).includes(item.transport),
  );

  return (
    <article className="overflow-visible rounded-xl border border-border bg-card/40 transition-colors hover:border-border/80 hover:bg-card/70">
      <div className="p-3 sm:p-4">
        <div className="flex items-start gap-2.5">
          <button
            type="button"
            onClick={onToggleExpand}
            className="mt-0.5 rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label={`${expanded ? 'Hide' : 'Show'} ${item.name} details`}
          >
            <ChevronDown className={`h-4 w-4 transition-transform ${expanded ? '' : '-rotate-90'}`} />
          </button>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-1.5 pr-1">
              <span className="break-words font-medium text-foreground">{item.name}</span>
              <Badge variant="outline" className="text-[10px]">{sourceBadge(item)}</Badge>
              {item.transport && (
                <Badge variant="outline" className="text-[10px] text-muted-foreground">{item.transport}</Badge>
              )}
            </div>
            <code className="mt-1 block max-w-full truncate text-[11px] text-muted-foreground">
              {summary || 'No connection details'}
            </code>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11px]">
              {item.needsAuth && <span className="text-amber-600">Needs auth</span>}
              {item.connected === true && <span className="text-emerald-600">Connected</span>}
              {isCloudcli && item.providers.length === 0 && <span className="text-amber-600">No agents enabled</span>}
              {item.source === 'provider_cloud' && <span className="text-muted-foreground">Provider locked</span>}
            </div>
          </div>

          {isCloudcli && item.kind !== 'memory' && (
            <div className="relative shrink-0">
              <Button
                variant="ghost"
                size="sm"
                className="h-8 w-8 p-0"
                disabled={busy}
                onClick={() => setActionsOpen((open) => !open)}
                aria-label={`Actions for ${item.name}`}
                aria-expanded={actionsOpen}
              >
                <MoreHorizontal className="h-4 w-4" />
              </Button>
              {actionsOpen && (
                <div className="absolute right-0 top-9 z-20 w-36 rounded-md border border-border bg-background p-1 text-left shadow-lg">
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-xs hover:bg-muted"
                    onClick={() => { setActionsOpen(false); onEdit(); }}
                  >
                    <Pencil className="h-3.5 w-3.5" /> Edit
                  </button>
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-xs hover:bg-muted"
                    onClick={() => { setActionsOpen(false); onDuplicate(); }}
                  >
                    <Copy className="h-3.5 w-3.5" /> Duplicate
                  </button>
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-xs text-red-600 hover:bg-red-50 dark:hover:bg-red-950/30"
                    onClick={() => { setActionsOpen(false); onRemove(); }}
                  >
                    <Trash2 className="h-3.5 w-3.5" /> Remove
                  </button>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="mt-3 border-t border-border/70 pt-3">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div className="text-xs font-medium text-foreground">
              {matrixLocked ? 'Available on' : 'Use with'}
              {matrixLocked && <span className="ml-1.5 font-normal text-muted-foreground">(managed)</span>}
            </div>
            {canEditBindings && dirty && (
              <Button
                size="sm"
                className="h-8 self-start px-2.5 text-xs sm:self-auto"
                disabled={busy}
                onClick={onApply}
              >
                {busy ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : null}
                Apply changes
              </Button>
            )}
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {visibleProviders.map((provider) => {
              const isOn = selectedProviders.includes(provider);
              const unsupported = isUnsupported(provider);
              const disabled = matrixLocked || unsupported;
              const title = unsupported
                ? `${PROVIDER_LABELS[provider]} does not support ${item.transport}`
                : matrixLocked
                  ? item.source === 'provider_cloud'
                    ? 'Connected account MCPs stay on their provider'
                    : 'Managed by a CloudCLI feature toggle'
                  : undefined;

              return (
                <label
                  key={provider}
                  title={title}
                  className={cn(
                    'inline-flex cursor-pointer items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs transition-colors',
                    isOn && !disabled
                      ? 'border-primary/50 bg-primary/10 text-foreground'
                      : 'border-border bg-background/50 text-muted-foreground',
                    disabled && 'cursor-not-allowed opacity-55',
                  )}
                >
                  <input
                    type="checkbox"
                    checked={isOn}
                    disabled={disabled}
                    onChange={() => {
                      if (disabled) return;
                      onDraftChange(
                        isOn
                          ? draftProviders.filter((p) => p !== provider)
                          : [...draftProviders, provider],
                      );
                    }}
                    className="h-3.5 w-3.5 rounded border-border"
                    aria-label={`${isOn ? 'Disable' : 'Enable'} ${item.name} for ${PROVIDER_LABELS[provider]}`}
                  />
                  {PROVIDER_LABELS[provider] ?? provider}
                </label>
              );
            })}
          </div>
          {canEditBindings && item.source === 'provider_native' && (
            <p className="mt-2 text-[11px] text-muted-foreground">
              Detected on this device. Apply to adopt it into CloudCLI.
            </p>
          )}
        </div>
      </div>

      {expanded && (
        <div className="border-t border-border/70 bg-muted/10 px-3 py-3 sm:px-4">
          <div className="grid gap-3 text-xs text-muted-foreground md:grid-cols-2">
            <div className="min-w-0 space-y-1.5">
              {item.command && (
                <div className="min-w-0">command: <code className="break-all rounded bg-muted px-1">{item.command} {(item.args || []).join(' ')}</code></div>
              )}
              {item.url && <div className="min-w-0">url: <code className="break-all rounded bg-muted px-1">{item.url}</code></div>}
              {item.env && Object.keys(item.env).length > 0 && (
                <div className="min-w-0">env: <code className="break-all rounded bg-muted px-1">{Object.entries(item.env).map(([k, v]) => `${k}=${maskSecret(v)}`).join(', ')}</code></div>
              )}
              {item.kind === 'memory' && (
                <p>Shared Obsidian MCP for project memory. Configure it under Settings → Memory.</p>
              )}
              {item.source === 'provider_cloud' && (
                <p>Hosted by {item.cloudLabel || 'the provider account'}. It is only available with that agent.</p>
              )}
            </div>
            <div className="min-w-0 space-y-1">
              {item.configPaths && item.configPaths.length > 0 && (
                <>
                  <div className="font-medium text-muted-foreground">Config source(s)</div>
                  {item.configPaths.map((path, index) => (
                    <div key={`${path}-${index}`} className="break-all font-mono text-[10px]">
                      {item.configKinds?.[index] ? `[${item.configKinds[index]}] ` : ''}
                      {path.replace(/^\/Users\/[^/]+/, '~')}
                    </div>
                  ))}
                </>
              )}
            </div>
          </div>
          {canEditBindings && (dirty || item.source === 'provider_native') && (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Button size="sm" disabled={busy} onClick={onApply}>
                {busy ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
                {item.source === 'provider_native' ? 'Adopt into CloudCLI & apply' : 'Apply bindings'}
              </Button>
              <span className="text-[11px] text-muted-foreground">
                {item.source === 'provider_native'
                  ? 'This copies the detected server into the CloudCLI catalog.'
                  : 'Changes are written to each selected agent.'}
              </span>
            </div>
          )}
        </div>
      )}
    </article>
  );
}

export default function McpCatalogPanel({ currentProjects }: McpCatalogPanelProps) {
  const {
    items,
    isLoading,
    isEnriching,
    loadError,
    saveStatus,
    phase,
    warnings,
    refresh,
    upsertFromForm,
    setBindings,
    remove,
    adopt,
  } = useMcpCatalog();

  const [searchQuery, setSearchQuery] = useState('');
  const [agentFilter, setAgentFilter] = useState<LLMProvider | 'all'>('all');
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('all');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [showTemplates, setShowTemplates] = useState(false);
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [formProviders, setFormProviders] = useState<LLMProvider[]>(['claude']);
  const [formSeed, setFormSeed] = useState<ProviderMcpServer | null>(null);
  const [formTitle, setFormTitle] = useState('Add local MCP Server');
  const [formSubmitLabel, setFormSubmitLabel] = useState('Save to catalog');
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyName, setBusyName] = useState<string | null>(null);
  const [bindingDrafts, setBindingDrafts] = useState<Record<string, LLMProvider[]>>({});
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(new Set());
  const filtered = useMemo(() => {
    const q = searchQuery.trim().toLocaleLowerCase();
    return items.filter((item) => {
      if (sourceFilter !== 'all') {
        const source = SOURCE_FILTERS.find((filter) => filter.id === sourceFilter);
        if (source?.sources && !source.sources.includes(item.source)) return false;
      }
      if (statusFilter === 'connected' && item.connected !== true) return false;
      if (statusFilter === 'needs_auth' && !item.needsAuth) return false;
      if (statusFilter === 'unbound' && (item.source !== 'cloudcli' || (item.providers || []).length > 0)) {
        return false;
      }
      if (!q) return true;
      return (
        [item.name, item.command, item.url, item.source, item.cloudLabel, item.kind, ...(item.providers || [])]
          .filter(Boolean)
          .some((v) => String(v).toLocaleLowerCase().includes(q))
      );
    });
  }, [items, searchQuery, sourceFilter, statusFilter]);

  const counts = useMemo(() => {
    const c = { cloudcli: 0, cloud: 0, native: 0, managed: 0 };
    for (const item of items) {
      if (item.source === 'cloudcli') c.cloudcli += 1;
      else if (item.source === 'provider_cloud') c.cloud += 1;
      else if (item.source === 'managed') c.managed += 1;
      else c.native += 1;
    }
    return c;
  }, [items]);

  const visibleProviders = agentFilter === 'all' ? FANOUT_PROVIDERS : [agentFilter];
  const nativeCount = counts.native;

  const rowKey = (item: McpInventoryItem) => (
    `${item.source}:${item.originProvider ?? ''}:${item.name}`
  );

  const openCreateForm = useCallback((seed?: {
    form?: Partial<McpFormState>;
    providers?: LLMProvider[];
    editing?: ProviderMcpServer | null;
    title?: string;
    submitLabel?: string;
  }) => {
    setFormProviders(seed?.providers ?? ['claude']);
    setFormSeed(seed?.editing ?? (seed?.form
      ? {
        provider: 'claude',
        name: seed.form.name || '',
        scope: seed.form.scope || 'user',
        transport: seed.form.transport || 'stdio',
        command: seed.form.command,
        args: seed.form.args,
        env: seed.form.env,
        cwd: seed.form.cwd,
        url: seed.form.url,
        headers: seed.form.headers,
        workspacePath: seed.form.workspacePath,
      }
      : null));
    setFormTitle(seed?.title ?? 'Add local MCP Server');
    setFormSubmitLabel(seed?.submitLabel ?? 'Save to catalog');
    setIsFormOpen(true);
  }, []);

  const applyTemplate = useCallback((template: McpTemplate) => {
    const form = formStateFromTemplate(template);
    openCreateForm({
      form,
      providers: (template.defaultProviders as LLMProvider[] | undefined) ?? ['claude'],
      editing: {
        provider: 'claude',
        name: form.name,
        scope: 'user',
        transport: form.transport,
        command: form.command,
        args: form.args,
        url: form.url,
      },
      title: `Add ${template.label}`,
      submitLabel: 'Save template to catalog',
    });
    setShowTemplates(false);
  }, [openCreateForm]);

  const handleCreate = useCallback(async (formData: McpFormState) => {
    setActionError(null);
    try {
      await upsertFromForm(formData, formProviders);
      setIsFormOpen(false);
      setFormSeed(null);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Failed to save');
      throw error;
    }
  }, [formProviders, upsertFromForm]);

  const applyBindings = useCallback(async (item: McpInventoryItem, providers: LLMProvider[]) => {
    setBusyName(item.name);
    setActionError(null);
    try {
      if (item.source === 'cloudcli') {
        await setBindings(item.name, providers);
      } else if (item.source === 'provider_native' && item.originProvider) {
        await adopt(item.name, item.originProvider, providers, {
          scope: item.scope,
          workspacePath: item.workspacePath,
        });
      }
      setBindingDrafts((prev) => {
        const next = { ...prev };
        delete next[item.name];
        return next;
      });
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Failed to update bindings');
    } finally {
      setBusyName(null);
    }
  }, [adopt, setBindings]);

  const handleRemove = useCallback(async (item: McpInventoryItem) => {
    if (item.source !== 'cloudcli') return;
    if (!window.confirm(`Remove "${item.name}" from CloudCLI catalog and all provider projections?`)) {
      return;
    }
    setBusyName(item.name);
    setActionError(null);
    try {
      await remove(item.name);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Failed to remove');
    } finally {
      setBusyName(null);
    }
  }, [remove]);

  const adoptAllNative = useCallback(async () => {
    const natives = items.filter((i) => i.source === 'provider_native' && i.originProvider);
    if (natives.length === 0) {
      setActionError('No on-disk servers to adopt.');
      return;
    }
    if (!window.confirm(`Adopt ${natives.length} on-disk MCP server(s) into CloudCLI for their current agent only?`)) {
      return;
    }
    setActionError(null);
    for (const item of natives) {
      setBusyName(item.name);
      try {
        await adopt(item.name, item.originProvider!, item.providers?.length ? item.providers : [item.originProvider!], {
          scope: item.scope,
          workspacePath: item.workspacePath,
        });
      } catch (error) {
        setActionError(error instanceof Error ? error.message : `Failed to adopt ${item.name}`);
        break;
      }
    }
    setBusyName(null);
  }, [adopt, items]);

  const formProvider: LLMProvider = 'claude';

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <Server className="mt-0.5 h-5 w-5 flex-shrink-0 text-purple-500" />
          <div className="min-w-0 space-y-1">
            <h3 className="text-lg font-medium text-foreground">MCP Servers</h3>
            <p className="text-sm text-muted-foreground">
              Define local servers once in CloudCLI, enable only the agents you need.
              Account connectors stay isolated per provider.
            </p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => void refresh({ full: true, bypassCache: true })}
            disabled={isLoading || isEnriching}
          >
            <RefreshCw className={cn('mr-1.5 h-3.5 w-3.5', (isLoading || isEnriching) && 'animate-spin')} />
            Refresh
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowTemplates((v) => !v)}
          >
            <Sparkles className="mr-1.5 h-3.5 w-3.5" />
            Templates
          </Button>
          <Button
            size="sm"
            onClick={() => openCreateForm()}
          >
            <Plus className="mr-1.5 h-3.5 w-3.5" />
            Add local MCP
          </Button>
        </div>
      </div>

      {(isEnriching || phase === 'fast') && items.length > 0 && (
        <div className="flex items-center gap-2 rounded-lg border border-border/60 bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Showing local catalog, on-disk configs, and cached account connectors — refreshing live status…
        </div>
      )}

      {warnings.length > 0 && !isEnriching && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-800/60 dark:bg-amber-900/20 dark:text-amber-200">
          {warnings.join(' ')}
        </div>
      )}

      {showTemplates && (
        <div className="space-y-2 rounded-xl border border-border bg-card/50 p-3">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-sm font-medium text-foreground">
              <Sparkles className="h-4 w-4 text-purple-500" />
              Quick-add templates
            </div>
            <Button variant="ghost" size="sm" onClick={() => setShowTemplates(false)}>Hide</Button>
          </div>
          <p className="text-[11px] text-muted-foreground">
            Pre-filled recipes. Review env vars and agent bindings before saving — nothing is installed until you confirm.
          </p>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {MCP_TEMPLATES.map((template) => (
              <button
                key={template.id}
                type="button"
                onClick={() => applyTemplate(template)}
                className="rounded-lg border border-border bg-background px-3 py-2.5 text-left transition hover:border-primary/40 hover:bg-muted/30"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium text-foreground">{template.label}</span>
                  <Badge variant="outline" className="text-[10px]">{template.category}</Badge>
                </div>
                <p className="mt-1 line-clamp-2 text-[11px] text-muted-foreground">{template.description}</p>
                {template.envHints && template.envHints.length > 0 && (
                  <p className="mt-1 font-mono text-[10px] text-amber-600">
                    needs {template.envHints.join(', ')}
                  </p>
                )}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="space-y-2 rounded-xl border border-border bg-muted/10 p-2.5">
        <div className="flex items-center gap-2 overflow-x-auto">
          <span className="shrink-0 px-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Agent</span>
          <button
            type="button"
            onClick={() => setAgentFilter('all')}
            className={cn(
              'shrink-0 rounded-md px-2.5 py-1.5 text-xs transition-colors',
              agentFilter === 'all' ? 'bg-background font-medium text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            All agents
          </button>
          {FANOUT_PROVIDERS.map((provider) => (
            <button
              key={provider}
              type="button"
              onClick={() => setAgentFilter(provider)}
              className={cn(
                'shrink-0 rounded-md px-2.5 py-1.5 text-xs transition-colors',
                agentFilter === provider ? 'bg-background font-medium text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {PROVIDER_LABELS[provider] ?? provider}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-1 overflow-x-auto border-t border-border/70 pt-2">
          {SOURCE_FILTERS.map((source) => {
            const Icon = source.icon;
            const count = source.id === 'all'
              ? items.length
              : source.sources?.reduce((total, value) => (
                total + items.filter((item) => item.source === value).length
              ), 0) ?? 0;
            return (
              <button
                key={source.id}
                type="button"
                onClick={() => setSourceFilter(source.id)}
                className={cn(
                  'flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs transition-colors',
                  sourceFilter === source.id
                    ? 'bg-primary/10 font-medium text-foreground'
                    : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground',
                )}
              >
                <Icon className="h-3.5 w-3.5" />
                {source.title}
                <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px]">{count}</span>
              </button>
            );
          })}
        </div>

        <div className="flex flex-col gap-2 sm:flex-row">
          <div className="relative min-w-0 flex-1">
            <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search servers, commands, providers…"
              className="bg-background pl-8"
            />
          </div>
          <div className="flex gap-2">
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
              className="h-9 min-w-0 flex-1 rounded-md border border-border bg-background px-2 text-xs text-foreground sm:flex-none"
              aria-label="Filter by status"
            >
              <option value="all">Any status</option>
              <option value="connected">Connected</option>
              <option value="needs_auth">Needs auth</option>
              <option value="unbound">No agents enabled</option>
            </select>
            {nativeCount > 0 && (
              <Button variant="outline" size="sm" className="shrink-0" onClick={() => void adoptAllNative()} disabled={Boolean(busyName)}>
                Adopt {nativeCount}
              </Button>
            )}
          </div>
        </div>
      </div>

      {saveStatus === 'success' && (
        <p className="text-xs text-muted-foreground">Saved.</p>
      )}
      {(loadError || actionError) && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-800/60 dark:bg-red-900/20 dark:text-red-200">
          {actionError || loadError}
        </div>
      )}

      {isLoading && items.length === 0 && (
        <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading MCP inventory…
        </div>
      )}

      {filtered.length > 0 ? (
        <div className="space-y-2.5">
          {filtered.map((item) => {
            const key = rowKey(item);
            const draft = bindingDrafts[item.name] ?? item.providers ?? [];
            return (
              <McpRow
                key={key}
                item={item}
                expanded={expandedKeys.has(key)}
                visibleProviders={visibleProviders}
                onToggleExpand={() => setExpandedKeys((prev) => {
                  const next = new Set(prev);
                  if (next.has(key)) next.delete(key);
                  else next.add(key);
                  return next;
                })}
                draftProviders={draft}
                onDraftChange={(providers) => setBindingDrafts((prev) => ({
                  ...prev,
                  [item.name]: providers,
                }))}
                busy={busyName === item.name}
                onApply={() => void applyBindings(item, draft)}
                onRemove={() => void handleRemove(item)}
                onEdit={() => openCreateForm({
                  editing: itemToEditingServer(item),
                  providers: item.providers?.length ? item.providers : ['claude'],
                  title: `Edit ${item.name}`,
                  submitLabel: 'Update catalog',
                })}
                onDuplicate={() => {
                  const form = itemToFormState(item);
                  form.name = `${item.name}-copy`;
                  openCreateForm({
                    form,
                    providers: item.providers?.length ? item.providers : ['claude'],
                    title: `Duplicate ${item.name}`,
                    submitLabel: 'Save copy to catalog',
                  });
                }}
              />
            );
          })}
        </div>
      ) : (
        <div className="rounded-xl border border-dashed border-border px-4 py-10 text-center text-sm text-muted-foreground">
          {sourceFilter === 'cloud' && (isEnriching || phase !== 'full')
            ? 'Scanning connected account MCPs…'
            : sourceFilter === 'cloudcli'
              ? 'No CloudCLI servers yet. Add a local MCP or pick a template to get started.'
              : 'No MCP servers match these filters.'}
        </div>
      )}

      <McpServerFormModal
        provider={formProvider}
        isOpen={isFormOpen}
        editingServer={formSeed}
        currentProjects={currentProjects}
        title={formTitle}
        description="Saved once in the CloudCLI catalog, then projected into each checked provider’s native config. Unchecked providers never receive this server."
        submitLabel={formSubmitLabel}
        supportedScopes={['user', 'project']}
        supportedTransports={['stdio', 'http', 'sse']}
        extraFields={(
          <ProviderBindingMatrix
            selected={formProviders}
            onChange={setFormProviders}
          />
        )}
        onClose={() => {
          setIsFormOpen(false);
          setFormSeed(null);
        }}
        onSubmit={async (formData) => {
          await handleCreate(formData);
        }}
      />
    </div>
  );
}
