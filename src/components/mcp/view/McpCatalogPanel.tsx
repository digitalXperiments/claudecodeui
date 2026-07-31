import { useCallback, useMemo, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  Cloud,
  Globe,
  Loader2,
  Lock,
  Plus,
  RefreshCw,
  Search,
  Server,
  Trash2,
} from 'lucide-react';

import type { LLMProvider } from '../../../types/app';
import { cn } from '../../../lib/utils';
import { Badge, Button, Input } from '../../../shared/view/ui';
import ProviderBindingMatrix, {
  FANOUT_PROVIDERS,
  PROVIDER_LABELS,
} from '../../shared/view/ProviderBindingMatrix';
import { MCP_SUPPORTED_TRANSPORTS } from '../constants';
import { useMcpCatalog } from '../hooks/useMcpCatalog';
import type { McpFormState, McpInventoryItem, McpInventorySource, McpProject, ProviderMcpServer } from '../types';
import { maskSecret } from '../utils/mcpFormatting';

import McpServerFormModal from './modals/McpServerFormModal';

type McpCatalogPanelProps = {
  currentProjects: McpProject[];
};

type SectionId = 'cloudcli' | 'cloud' | 'native' | 'managed';

const SECTIONS: Array<{
  id: SectionId;
  title: string;
  description: string;
  sources: McpInventorySource[];
  defaultOpen: boolean;
}> = [
  {
    id: 'cloudcli',
    title: 'Your servers (CloudCLI)',
    description: 'Defined once here. Enable agents with the matrix — no duplicate definitions.',
    sources: ['cloudcli'],
    defaultOpen: true,
  },
  {
    id: 'cloud',
    title: 'From provider accounts',
    description: 'claude.ai / grok.com connectors. Stay on that agent only — not portable.',
    sources: ['provider_cloud'],
    defaultOpen: true,
  },
  {
    id: 'native',
    title: 'Found on this machine',
    description: 'Already in a provider config. Adopt into CloudCLI to manage and fan out.',
    sources: ['provider_native'],
    defaultOpen: false,
  },
  {
    id: 'managed',
    title: 'Managed by CloudCLI features',
    description: 'Installed by Browser and similar toggles. Edit via the feature, not here.',
    sources: ['managed'],
    defaultOpen: false,
  },
];

const sourceBadge = (item: McpInventoryItem): string => {
  if (item.kind === 'memory') return 'Memory · CloudCLI';
  if (item.source === 'cloudcli') return 'CloudCLI';
  if (item.source === 'provider_cloud') return item.cloudLabel || 'Provider cloud';
  if (item.source === 'managed') return 'Managed';
  return 'On disk';
};

function ProviderChips({ providers }: { providers: LLMProvider[] }) {
  if (!providers.length) {
    return <span className="text-xs text-muted-foreground">No agents</span>;
  }
  return (
    <div className="flex flex-wrap gap-1">
      {providers.map((p) => (
        <span
          key={p}
          className="rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-foreground"
        >
          {PROVIDER_LABELS[p] ?? p}
        </span>
      ))}
    </div>
  );
}

function McpRow({
  item,
  expanded,
  onToggleExpand,
  draftProviders,
  onDraftChange,
  busy,
  onApply,
  onRemove,
}: {
  item: McpInventoryItem;
  expanded: boolean;
  onToggleExpand: () => void;
  draftProviders: LLMProvider[];
  onDraftChange: (providers: LLMProvider[]) => void;
  busy: boolean;
  onApply: () => void;
  onRemove: () => void;
}) {
  const isCloudcli = item.source === 'cloudcli';
  const canEditBindings = isCloudcli || item.source === 'provider_native';
  const matrixLocked = item.source === 'provider_cloud' || item.source === 'managed';
  const dirty = isCloudcli
    && JSON.stringify([...draftProviders].sort()) !== JSON.stringify([...(item.providers ?? [])].sort());
  const summary = item.command
    ? `${item.command} ${(item.args || []).slice(0, 3).join(' ')}${(item.args?.length || 0) > 3 ? '…' : ''}`
    : item.url || '';

  return (
    <div className="rounded-lg border border-border bg-card/40">
      <button
        type="button"
        onClick={onToggleExpand}
        className="flex w-full items-start gap-2 px-3 py-2.5 text-left hover:bg-muted/30"
      >
        <span className="mt-0.5 text-muted-foreground">
          {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </span>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-foreground">{item.name}</span>
            <Badge variant="outline" className="text-[10px]">
              {sourceBadge(item)}
            </Badge>
            {item.transport && (
              <Badge variant="outline" className="text-[10px] text-muted-foreground">{item.transport}</Badge>
            )}
            {item.needsAuth && (
              <Badge variant="outline" className="text-[10px] text-amber-600">Needs auth</Badge>
            )}
            {item.connected === true && (
              <Badge variant="outline" className="text-[10px] text-emerald-600">Connected</Badge>
            )}
          </div>
          {!expanded && (
            <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
              <code className="max-w-full truncate text-[11px] text-muted-foreground">{summary}</code>
              <ProviderChips providers={item.providers} />
            </div>
          )}
        </div>
        {isCloudcli && item.kind !== 'memory' && (
          <Button
            variant="ghost"
            size="sm"
            className="h-8 w-8 shrink-0 p-0 text-red-600 hover:text-red-700"
            disabled={busy}
            onClick={(e) => {
              e.stopPropagation();
              onRemove();
            }}
            title="Remove from catalog"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        )}
      </button>

      {expanded && (
        <div className="space-y-3 border-t border-border/60 px-3 py-3">
          <div className="space-y-0.5 text-xs text-muted-foreground">
            {item.command && (
              <div>
                command:{' '}
                <code className="rounded bg-muted px-1">
                  {item.command} {(item.args || []).join(' ')}
                </code>
              </div>
            )}
            {item.url && (
              <div>
                url: <code className="rounded bg-muted px-1">{item.url}</code>
              </div>
            )}
            {item.env && Object.keys(item.env).length > 0 && (
              <div>
                env:{' '}
                <code className="rounded bg-muted px-1">
                  {Object.entries(item.env).map(([k, v]) => `${k}=${maskSecret(v)}`).join(', ')}
                </code>
              </div>
            )}
            {item.kind === 'memory' && (
              <p>
                Shared Obsidian MCP for project memory (user-scope CloudCLI catalog).
                One definition for all memory-enabled projects — vault settings under Settings → Memory.
              </p>
            )}
            {item.source === 'provider_cloud' && (
              <p>
                Hosted by {item.cloudLabel || 'the provider account'}. Only available when chatting with that agent.
              </p>
            )}
            {item.configPaths && item.configPaths.length > 0 && (
              <div className="space-y-0.5">
                <div className="text-[11px] font-medium text-muted-foreground">Config source(s)</div>
                {item.configPaths.map((p, i) => (
                  <div key={`${p}-${i}`} className="break-all font-mono text-[10px] text-muted-foreground">
                    {(item.configKinds?.[i]) ? `[${item.configKinds[i]}] ` : ''}
                    {p.replace(/^\/Users\/[^/]+/, '~')}
                  </div>
                ))}
              </div>
            )}
          </div>

          <ProviderBindingMatrix
            selected={
              // Cloud/managed: only the origin agent — never a fake multi-select.
              matrixLocked
                ? (item.providers.length ? item.providers : item.originProvider ? [item.originProvider] : [])
                : draftProviders
            }
            onChange={(next) => {
              if (!canEditBindings) return;
              onDraftChange(next);
            }}
            locked={matrixLocked}
            lockedMessage={
              item.source === 'provider_cloud'
                ? 'Account connector — cannot fan out to other agents.'
                : item.source === 'managed'
                  ? 'Managed by a CloudCLI feature toggle.'
                  : undefined
            }
            // For account connectors, only render the owning agent column.
            providers={
              matrixLocked
                ? (item.providers.length
                  ? item.providers
                  : item.originProvider
                    ? [item.originProvider]
                    : FANOUT_PROVIDERS)
                : FANOUT_PROVIDERS
            }
            disabledProviders={
              item.transport
                ? FANOUT_PROVIDERS.filter(
                  (p) => !(MCP_SUPPORTED_TRANSPORTS[p] || []).includes(item.transport!),
                )
                : []
            }
            disabledReason={(p) => (
              item.transport && !(MCP_SUPPORTED_TRANSPORTS[p] || []).includes(item.transport)
                ? `${PROVIDER_LABELS[p]} does not support ${item.transport}`
                : undefined
            )}
          />

          {canEditBindings && (dirty || item.source === 'provider_native') && (
            <div className="flex flex-wrap gap-2">
              <Button size="sm" disabled={busy} onClick={onApply}>
                {busy ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
                {item.source === 'provider_native' ? 'Adopt into CloudCLI & apply' : 'Apply bindings'}
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function McpCatalogPanel({ currentProjects }: McpCatalogPanelProps) {
  const {
    items,
    isLoading,
    loadError,
    saveStatus,
    refresh,
    upsertFromForm,
    setBindings,
    remove,
    adopt,
  } = useMcpCatalog();

  const [searchQuery, setSearchQuery] = useState('');
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [formProviders, setFormProviders] = useState<LLMProvider[]>(['claude']);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyName, setBusyName] = useState<string | null>(null);
  const [bindingDrafts, setBindingDrafts] = useState<Record<string, LLMProvider[]>>({});
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(new Set());
  const [openSections, setOpenSections] = useState<Record<SectionId, boolean>>(() => (
    Object.fromEntries(SECTIONS.map((s) => [s.id, s.defaultOpen])) as Record<SectionId, boolean>
  ));

  const filtered = useMemo(() => {
    const q = searchQuery.trim().toLocaleLowerCase();
    if (!q) return items;
    return items.filter((item) => (
      [item.name, item.command, item.url, item.source, item.cloudLabel, item.kind]
        .filter(Boolean)
        .some((v) => String(v).toLocaleLowerCase().includes(q))
    ));
  }, [items, searchQuery]);

  const counts = useMemo(() => {
    const c = { cloudcli: 0, cloud: 0, native: 0, managed: 0, total: filtered.length };
    for (const item of filtered) {
      if (item.source === 'cloudcli') c.cloudcli += 1;
      else if (item.source === 'provider_cloud') c.cloud += 1;
      else if (item.source === 'managed') c.managed += 1;
      else c.native += 1;
    }
    return c;
  }, [filtered]);

  const rowKey = (item: McpInventoryItem) => (
    `${item.source}:${item.originProvider ?? ''}:${item.name}`
  );

  const handleCreate = useCallback(async (formData: McpFormState) => {
    setActionError(null);
    try {
      await upsertFromForm(formData, formProviders);
      setIsFormOpen(false);
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

  const formProvider: LLMProvider = 'claude';
  const editingAsServer: ProviderMcpServer | null = null;

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
          <Button variant="outline" size="sm" onClick={() => void refresh()} disabled={isLoading}>
            <RefreshCw className={cn('mr-1.5 h-3.5 w-3.5', isLoading && 'animate-spin')} />
            Refresh
          </Button>
          <Button
            size="sm"
            onClick={() => {
              setFormProviders(['claude']);
              setIsFormOpen(true);
            }}
          >
            <Plus className="mr-1.5 h-3.5 w-3.5" />
            Add local MCP
          </Button>
        </div>
      </div>

      {/* Summary strip */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {[
          { label: 'CloudCLI', count: counts.cloudcli, icon: Globe },
          { label: 'Account', count: counts.cloud, icon: Cloud },
          { label: 'On disk', count: counts.native, icon: Server },
          { label: 'Managed', count: counts.managed, icon: Lock },
        ].map(({ label, count, icon: Icon }) => (
          <div
            key={label}
            className="flex items-center gap-2 rounded-lg border border-border/70 bg-muted/20 px-3 py-2"
          >
            <Icon className="h-3.5 w-3.5 text-muted-foreground" />
            <div>
              <div className="text-sm font-semibold text-foreground">{count}</div>
              <div className="text-[11px] text-muted-foreground">{label}</div>
            </div>
          </div>
        ))}
      </div>

      <div className="relative">
        <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="Search by name, command, or provider…"
          className="pl-8"
        />
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

      <div className="space-y-3">
        {SECTIONS.map((section) => {
          const sectionItems = filtered.filter((i) => section.sources.includes(i.source));
          if (sectionItems.length === 0 && searchQuery) return null;
          const open = openSections[section.id];

          return (
            <section key={section.id} className="overflow-hidden rounded-xl border border-border">
              <button
                type="button"
                className="flex w-full items-center gap-2 bg-muted/30 px-3 py-2.5 text-left"
                onClick={() => setOpenSections((prev) => ({ ...prev, [section.id]: !prev[section.id] }))}
              >
                {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-foreground">{section.title}</span>
                    <Badge variant="outline" className="text-[10px]">{sectionItems.length}</Badge>
                  </div>
                  <p className="text-[11px] text-muted-foreground">{section.description}</p>
                </div>
              </button>
              {open && (
                <div className="space-y-2 p-2">
                  {sectionItems.length === 0 ? (
                    <p className="px-2 py-4 text-center text-xs text-muted-foreground">
                      {section.id === 'cloudcli'
                        ? 'No CloudCLI servers yet. Add a local MCP to get started.'
                        : 'Nothing in this category.'}
                    </p>
                  ) : (
                    sectionItems.map((item) => {
                      const key = rowKey(item);
                      const expanded = expandedKeys.has(key);
                      const draft = bindingDrafts[item.name] ?? item.providers ?? [];
                      return (
                        <McpRow
                          key={key}
                          item={item}
                          expanded={expanded}
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
                        />
                      );
                    })
                  )}
                </div>
              )}
            </section>
          );
        })}
      </div>

      <McpServerFormModal
        provider={formProvider}
        isOpen={isFormOpen}
        editingServer={editingAsServer}
        currentProjects={currentProjects}
        title="Add local MCP Server"
        description="Saved once in the CloudCLI catalog, then projected into each checked provider’s native config. Unchecked providers never receive this server."
        submitLabel="Save to catalog"
        supportedScopes={['user', 'project']}
        supportedTransports={['stdio', 'http', 'sse']}
        extraFields={(
          <ProviderBindingMatrix
            selected={formProviders}
            onChange={setFormProviders}
          />
        )}
        onClose={() => setIsFormOpen(false)}
        onSubmit={async (formData) => {
          await handleCreate(formData);
        }}
      />
    </div>
  );
}
