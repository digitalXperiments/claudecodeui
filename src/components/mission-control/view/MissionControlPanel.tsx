import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  AlertCircle,
  Check,
  Clock,
  Download,
  Eye,
  Loader2,
  Pencil,
  Play,
  Plus,
  Radar,
  RefreshCw,
  RotateCw,
  Trash2,
  X,
} from 'lucide-react';

import { Button, Pill, PillBar } from '../../../shared/view/ui';
import type { Project } from '../../../types/app';
import { authenticatedFetch } from '../../../utils/api';
import {
  missionControlApi,
  type McItem,
  type McSection,
  type McSectionInput,
} from '../api/missionControlApi';
import { isXArticleBody } from '../utils/xArticle';

import ArticleDraftCard from './subcomponents/ArticleDraftCard';

export type WorkThisSessionRequest = {
  sessionId: string;
  projectId: string;
  projectPath: string;
  provider: string;
  prompt: string;
  title: string;
};

type MissionControlPanelProps = {
  isOpen: boolean;
  onClose: () => void;
  projects?: Project[];
  onPendingCountChange?: (count: number) => void;
  onWorkThis?: (request: WorkThisSessionRequest) => void;
};

type ModelOption = { value: string; label: string };

const PROVIDERS = ['claude', 'grok', 'opencode', 'kilo', 'cline', 'codex', 'cursor', 'kimi', 'pi'] as const;

const emptyForm = (): McSectionInput => ({
  title: '',
  scope: 'global',
  project_id: null,
  mode: 'review',
  schedule_cron: '',
  provider: 'claude',
  model: '',
  permission_mode: 'bypassPermissions',
  dry_run: false,
  auto_approve: false,
  produce_prompt: '',
  produce_tools: [],
  resolve_prompt: '',
  resolve_tools: [],
  create_kanban_task: false,
  kanban_assignee_provider: null,
  kanban_review_provider: null,
  kanban_mcp_tools: [],
  enabled: true,
});

function statusBadgeClass(status: McItem['status']): string {
  switch (status) {
    case 'pending':
      return 'bg-amber-500/15 text-amber-700 dark:text-amber-300';
    case 'resolving':
      return 'bg-blue-500/15 text-blue-700 dark:text-blue-300';
    case 'resolved':
      return 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300';
    case 'failed':
      return 'bg-red-500/15 text-red-700 dark:text-red-300';
    case 'dismissed':
      return 'bg-muted text-muted-foreground';
    default:
      return 'bg-muted text-muted-foreground';
  }
}

function actionButtonClass(style: string): string {
  if (style === 'primary') {
    return 'bg-primary text-primary-foreground hover:bg-primary/90';
  }
  if (style === 'destructive') {
    return 'bg-red-500/10 text-red-700 hover:bg-red-500/20 dark:text-red-300';
  }
  return 'bg-muted text-foreground hover:bg-muted/80';
}

function extractServerNamesFromTools(tools: string[]): string[] {
  // Stored values may be raw server names or mcp__Server__tool patterns.
  const names = new Set<string>();
  for (const t of tools) {
    const trimmed = t.trim();
    if (!trimmed) continue;
    const mcpMatch = trimmed.match(/^mcp__([^_]+(?:_[^_]+)*)(?:__|\*|$)/);
    if (mcpMatch) {
      names.add(mcpMatch[1].replace(/_/g, ' '));
      // Also keep normalized underscore form for matching list entries
      names.add(mcpMatch[1]);
    } else {
      names.add(trimmed);
    }
  }
  return [...names];
}

export default function MissionControlPanel({
  isOpen,
  onClose,
  projects = [],
  onPendingCountChange,
  onWorkThis,
}: MissionControlPanelProps) {
  const [sections, setSections] = useState<McSection[]>([]);
  const [items, setItems] = useState<McItem[]>([]);
  const [selectedSectionId, setSelectedSectionId] = useState<string | 'all'>('all');
  const [statusFilter, setStatusFilter] = useState<'actionable' | 'all'>('actionable');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Non-error run/import feedback (success banners). Kept separate so success is not red/amber. */
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [runningSectionId, setRunningSectionId] = useState<string | null>(null);
  const [actingItemId, setActingItemId] = useState<string | null>(null);
  const [showEditor, setShowEditor] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<McSectionInput>(emptyForm);
  const [produceMcp, setProduceMcp] = useState<string[]>([]);
  const [resolveMcp, setResolveMcp] = useState<string[]>([]);
  const [kanbanMcp, setKanbanMcp] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);
  const [importing, setImporting] = useState(false);
  const [importPath, setImportPath] = useState('');
  const [showImport, setShowImport] = useState(false);

  // Provider catalogs (loaded when editor is open / provider changes)
  const [models, setModels] = useState<ModelOption[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [mcpServers, setMcpServers] = useState<string[]>([]);
  const [mcpLoading, setMcpLoading] = useState(false);

  // Inline body edit
  const [editingBodyId, setEditingBodyId] = useState<string | null>(null);
  const [bodyDraft, setBodyDraft] = useState('');
  const [bodyError, setBodyError] = useState<string | null>(null);

  // Per-item retry / resolution preview
  const [retryingItemId, setRetryingItemId] = useState<string | null>(null);
  const [previewingItemId, setPreviewingItemId] = useState<string | null>(null);
  const [previewData, setPreviewData] = useState<{
    itemId: string;
    type: 'static' | 'agent';
    preview: Record<string, unknown>;
  } | null>(null);

  const projectNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of projects) {
      if (p.projectId) {
        map.set(p.projectId, p.displayName || p.projectId);
      }
    }
    return map;
  }, [projects]);

  const projectPathById = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of projects) {
      if (p.projectId) {
        map.set(p.projectId, p.fullPath || p.path || '');
      }
    }
    return map;
  }, [projects]);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [sectionList, itemResult] = await Promise.all([
        missionControlApi.listSections(),
        missionControlApi.listItems({
          sectionId: selectedSectionId === 'all' ? undefined : selectedSectionId,
          status: statusFilter === 'actionable' ? 'pending,failed' : undefined,
          limit: 100,
        }),
      ]);
      setSections(sectionList);
      setItems(itemResult.items);
      setPendingCount(itemResult.pendingCount);
      onPendingCountChange?.(itemResult.pendingCount);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load Mission Control');
    } finally {
      setLoading(false);
    }
  }, [onPendingCountChange, selectedSectionId, statusFilter]);

  useEffect(() => {
    if (!isOpen) return;
    void refresh();
  }, [isOpen, refresh]);

  useEffect(() => {
    if (!isOpen) return;
    const id = window.setInterval(() => {
      void missionControlApi
        .summary()
        .then((s) => {
          setPendingCount(s.pendingCount);
          onPendingCountChange?.(s.pendingCount);
        })
        .catch(() => {});
    }, 15_000);
    return () => window.clearInterval(id);
  }, [isOpen, onPendingCountChange]);

  // Load models + MCP servers when provider (or project scope) changes in the editor
  useEffect(() => {
    if (!showEditor || !form.provider) return;
    const provider = form.provider;
    let cancelled = false;

    setModelsLoading(true);
    setMcpLoading(true);

    (async () => {
      // Models
      try {
        const res = await authenticatedFetch(`/api/providers/${provider}/models`);
        const body = (await res.json()) as {
          success?: boolean;
          data?: {
            models?: {
              OPTIONS?: Array<{ value: string; label?: string }>;
              DEFAULT?: string;
            };
          };
        };
        const options = Array.isArray(body?.data?.models?.OPTIONS)
          ? body.data!.models!.OPTIONS!.map((m) => ({
              value: m.value,
              label: m.label || m.value,
            }))
          : [];
        if (cancelled) return;
        setModels(options);
        setForm((f) => {
          if (f.provider !== provider) return f;
          if (f.model && options.some((o) => o.value === f.model)) return f;
          const defaultModel = body?.data?.models?.DEFAULT ?? '';
          if (defaultModel && options.some((o) => o.value === defaultModel)) {
            return { ...f, model: defaultModel };
          }
          if (options[0]?.value) {
            return { ...f, model: options[0].value };
          }
          return f;
        });
      } catch {
        if (!cancelled) setModels([]);
      } finally {
        if (!cancelled) setModelsLoading(false);
      }

      // MCP servers: user (+ project/local when applicable). Backend merges
      // live CLI inventory for claude (claude.ai connectors) and grok
      // (config.toml + project mcps + `grok mcp list`).
      try {
        const names = new Set<string>();
        const scopes: Array<{ scope: string; workspacePath?: string }> = [{ scope: 'user' }];
        if (form.scope === 'project' && form.project_id) {
          const wp = projectPathById.get(form.project_id);
          if (wp) {
            scopes.push({ scope: 'project', workspacePath: wp });
            scopes.push({ scope: 'local', workspacePath: wp });
          }
        } else {
          // Global sections still benefit from project-scoped servers on disk
          // (e.g. obsidian in a workspace .mcp.json) when the CLI reports them.
          scopes.push({ scope: 'project' });
          scopes.push({ scope: 'local' });
        }
        await Promise.all(
          scopes.map(async ({ scope, workspacePath }) => {
            const params = new URLSearchParams({ scope });
            if (workspacePath) params.set('workspacePath', workspacePath);
            const res = await authenticatedFetch(
              `/api/providers/${provider}/mcp/servers?${params.toString()}`,
            );
            if (!res.ok) return;
            const body = (await res.json()) as {
              success?: boolean;
              data?: { servers?: Array<{ name?: string }> };
            };
            for (const s of body?.data?.servers ?? []) {
              if (s?.name) names.add(s.name);
            }
          }),
        );
        // Unscoped grouped list as a final merge.
        {
          const res = await authenticatedFetch(`/api/providers/${provider}/mcp/servers`);
          if (res.ok) {
            const body = (await res.json()) as {
              success?: boolean;
              data?: {
                scopes?: Record<string, Array<{ name?: string }>>;
                servers?: Array<{ name?: string }>;
              };
            };
            if (body?.data?.servers) {
              for (const s of body.data.servers) {
                if (s?.name) names.add(s.name);
              }
            }
            if (body?.data?.scopes) {
              for (const list of Object.values(body.data.scopes)) {
                for (const s of list || []) {
                  if (s?.name) names.add(s.name);
                }
              }
            }
          }
        }
        if (!cancelled) {
          setMcpServers([...names].sort((a, b) => a.localeCompare(b)));
        }
      } catch {
        if (!cancelled) setMcpServers([]);
      } finally {
        if (!cancelled) setMcpLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [showEditor, form.provider, form.scope, form.project_id, projectPathById]);

  const openCreate = () => {
    setEditingId(null);
    setForm(emptyForm());
    setProduceMcp([]);
    setResolveMcp([]);
    setKanbanMcp([]);
    setShowEditor(true);
  };

  const openEdit = (section: McSection) => {
    setEditingId(section.section_id);
    setForm({
      title: section.title,
      scope: section.scope,
      project_id: section.project_id,
      mode: section.mode,
      schedule_cron: section.schedule_cron ?? '',
      provider: section.provider,
      model: section.model ?? '',
      permission_mode: section.permission_mode,
      dry_run: section.dry_run,
      auto_approve: section.auto_approve,
      produce_prompt: section.produce_prompt,
      produce_tools: section.produce_tools,
      resolve_prompt: section.resolve_prompt,
      resolve_tools: section.resolve_tools,
      create_kanban_task: section.create_kanban_task,
      kanban_assignee_provider: section.kanban_assignee_provider,
      kanban_review_provider: section.kanban_review_provider,
      kanban_mcp_tools: section.kanban_mcp_tools ?? [],
      enabled: section.enabled,
    });
    setProduceMcp(extractServerNamesFromTools(section.produce_tools));
    setResolveMcp(extractServerNamesFromTools(section.resolve_tools));
    setKanbanMcp(
      Array.isArray(section.kanban_mcp_tools)
        ? section.kanban_mcp_tools
        : extractServerNamesFromTools(section.kanban_mcp_tools ?? []),
    );
    setShowEditor(true);
  };

  const onProviderChange = (provider: string) => {
    setForm((f) => ({ ...f, provider, model: '' }));
    setProduceMcp([]);
    setResolveMcp([]);
    setKanbanMcp([]);
    setModels([]);
    setMcpServers([]);
  };

  const toggleMcp = (
    list: string[],
    setList: (next: string[]) => void,
    name: string,
  ) => {
    if (list.includes(name)) {
      setList(list.filter((n) => n !== name));
    } else {
      setList([...list, name]);
    }
  };

  const saveSection = async () => {
    if (!form.title?.trim()) {
      setError('Section title is required');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      // Persist selected MCP server names (expanded to tool patterns at run time)
      const payload: McSectionInput = {
        ...form,
        produce_tools: produceMcp,
        resolve_tools: resolveMcp,
        kanban_mcp_tools: kanbanMcp,
        schedule_cron: form.schedule_cron?.trim() || null,
        model: form.model?.trim() || null,
        project_id: form.scope === 'project' ? form.project_id : null,
      };
      if (editingId) {
        await missionControlApi.updateSection(editingId, payload);
      } else {
        await missionControlApi.createSection(payload);
      }
      setShowEditor(false);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save section');
    } finally {
      setSaving(false);
    }
  };

  const deleteSection = async (sectionId: string) => {
    if (!window.confirm('Delete this section and all of its items?')) return;
    try {
      await missionControlApi.deleteSection(sectionId);
      if (selectedSectionId === sectionId) setSelectedSectionId('all');
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete section');
    }
  };

  const runNow = async (sectionId: string) => {
    setRunningSectionId(sectionId);
    setError(null);
    setStatusMessage(null);
    try {
      const result = await missionControlApi.runSection(sectionId);
      const banner =
        result.message ||
        result.error ||
        `Run finished: ${result.created} new` +
          (result.skipped ? `, ${result.skipped} skipped (already seen)` : '');
      // Real provider/runtime failures go to the error banner; success/skip
      // summaries use a neutral status line so "4 skipped" does not look like
      // the old `Provider "grok" run failed` alert.
      if (result.error) {
        setError(banner);
      } else {
        setStatusMessage(banner);
      }
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Run failed');
      await refresh();
    } finally {
      setRunningSectionId(null);
    }
  };

  const startBodyEdit = (item: McItem) => {
    setEditingBodyId(item.item_id);
    setBodyDraft(JSON.stringify(item.body, null, 2));
    setBodyError(null);
  };

  const cancelBodyEdit = () => {
    setEditingBodyId(null);
    setBodyDraft('');
    setBodyError(null);
  };

  const parseBodyDraft = (): Record<string, unknown> | null => {
    try {
      const parsed = JSON.parse(bodyDraft);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        setBodyError('Body must be a JSON object');
        return null;
      }
      setBodyError(null);
      return parsed as Record<string, unknown>;
    } catch {
      setBodyError('Invalid JSON');
      return null;
    }
  };

  const actOnItem = async (item: McItem, actionId: string) => {
    const action = item.actions.find((a) => a.id === actionId);
    if (action?.kind === 'delete') {
      const ok = window.confirm(
        `Delete “${item.title}” permanently?\n\nThis frees its dedupe key so a re-run can recreate it. Dismiss keeps the key and blocks re-create.`,
      );
      if (!ok) return;
    }

    setActingItemId(item.item_id);
    setError(null);
    try {
      if (action?.kind === 'work') {
        const result = await missionControlApi.workThis(item.item_id);
        onWorkThis?.({
          sessionId: result.sessionId,
          projectId: result.projectId,
          projectPath: result.projectPath,
          provider: result.provider,
          prompt: result.prompt,
          title: item.title,
        });
        onClose();
        return;
      }
      let body: Record<string, unknown> | undefined;
      if (editingBodyId === item.item_id && action?.kind !== 'delete') {
        const parsed = parseBodyDraft();
        if (!parsed) {
          setActingItemId(null);
          return;
        }
        body = parsed;
      }
      const result = await missionControlApi.applyAction(item.item_id, actionId, body);
      setPendingCount(result.pendingCount);
      onPendingCountChange?.(result.pendingCount);
      if (result.deleted) {
        setItems((prev) => prev.filter((i) => i.item_id !== item.item_id));
        cancelBodyEdit();
      } else {
        cancelBodyEdit();
        await refresh();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Action failed');
    } finally {
      setActingItemId(null);
    }
  };

  /** Re-run produce for just this item and refresh it in place. */
  const retryItem = async (item: McItem) => {
    setRetryingItemId(item.item_id);
    setError(null);
    setStatusMessage(null);
    try {
      const result = await missionControlApi.retryItem(item.item_id);
      if (result.success) {
        setStatusMessage(result.message || 'Item retried');
      } else {
        setError(result.error || 'Retry failed');
      }
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Retry failed');
    } finally {
      setRetryingItemId(null);
    }
  };

  /** Preview the resolution result for an action without committing it. */
  const previewItem = async (item: McItem, actionId: string) => {
    setPreviewingItemId(item.item_id);
    setError(null);
    try {
      let body: Record<string, unknown> | undefined;
      if (editingBodyId === item.item_id) {
        const parsed = parseBodyDraft();
        if (!parsed) {
          setPreviewingItemId(null);
          return;
        }
        body = parsed;
      }
      const result = await missionControlApi.previewItem(item.item_id, actionId, body);
      if (result.success && result.preview) {
        setPreviewData({
          itemId: item.item_id,
          type: result.type ?? 'agent',
          preview: result.preview,
        });
      } else {
        setError(result.error || 'Preview failed');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Preview failed');
    } finally {
      setPreviewingItemId(null);
    }
  };

  /**
   * Render an article draft's images and swap the returned item in place, so
   * the card picks up the new asset URLs without a full refresh.
   */
  const generateAssets = useCallback(async (itemId: string, force: boolean) => {
    const result = await missionControlApi.generateAssets(itemId, force);
    setItems((prev) => prev.map((i) => (i.item_id === itemId ? result.item : i)));
    return {
      generated: result.generated,
      skipped: result.skipped,
      failed: result.failed,
      messages: result.messages ?? [],
    };
  }, []);

  const openImport = async () => {
    setShowImport(true);
    try {
      const info = await missionControlApi.importDefaultPath();
      if (info.path) setImportPath(info.path);
    } catch {
      // leave empty
    }
  };

  const runImport = async () => {
    setImporting(true);
    setError(null);
    try {
      const result = await missionControlApi.importFromLegacy(importPath.trim() || undefined);
      setShowImport(false);
      setError(
        `Imported ${result.imported} section(s)` +
          (result.skipped ? `, skipped ${result.skipped}` : '') +
          (result.errors.length ? `. Errors: ${result.errors.join('; ')}` : ''),
      );
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Import failed');
    } finally {
      setImporting(false);
    }
  };

  // Ensure selected MCP names appear even if not in the current list
  const produceOptions = useMemo(() => {
    const set = new Set(mcpServers);
    for (const n of produceMcp) set.add(n);
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [mcpServers, produceMcp]);

  const resolveOptions = useMemo(() => {
    const set = new Set(mcpServers);
    for (const n of resolveMcp) set.add(n);
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [mcpServers, resolveMcp]);

  const kanbanMcpOptions = useMemo(() => {
    const set = new Set(mcpServers);
    for (const n of kanbanMcp) set.add(n);
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [mcpServers, kanbanMcp]);

  if (!isOpen) return null;

  const selectedSection =
    selectedSectionId === 'all'
      ? null
      : sections.find((s) => s.section_id === selectedSectionId) ?? null;

  return (
    <div
      className="modal-backdrop fixed inset-0 z-[9999] flex items-stretch justify-center bg-background md:items-center md:bg-background/80 md:p-4 md:backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="relative flex h-dvh max-h-dvh w-full flex-col overflow-hidden border-0 bg-background shadow-none md:h-[92vh] md:max-h-[92vh] md:max-w-6xl md:rounded-xl md:border md:border-border md:shadow-2xl">
        {/* Header */}
        <div className="flex flex-shrink-0 items-center justify-between gap-2 border-b border-border px-3 py-2.5 pt-[max(0.625rem,env(safe-area-inset-top))] md:px-5 md:py-3">
          <div className="flex min-w-0 items-center gap-2.5">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10">
              <Radar className="h-4 w-4 text-primary" />
            </div>
            <div className="min-w-0">
              <h2 className="truncate text-base font-semibold text-foreground">Mission Control</h2>
              <p className="hidden truncate text-[11px] text-muted-foreground sm:block">
                Produce → review → resolve automations
                {pendingCount > 0 ? ` · ${pendingCount} need attention` : ''}
              </p>
              {pendingCount > 0 ? (
                <p className="truncate text-[11px] text-muted-foreground sm:hidden">
                  {pendingCount} need attention
                </p>
              ) : null}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void openImport()}
              className="h-10 touch-manipulation gap-1.5 px-2 text-xs md:h-9"
              title="Import from legacy Mission Control DB"
            >
              <Download className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Import</span>
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void refresh()}
              disabled={loading}
              className="h-10 w-10 touch-manipulation p-0 md:h-9 md:w-9"
              title="Refresh"
            >
              <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={onClose}
              className="h-10 w-10 touch-manipulation p-0 md:h-9 md:w-9"
            >
              <X className="h-5 w-5 md:h-4 md:w-4" />
            </Button>
          </div>
        </div>

        {error ? (
          <div className="flex items-start gap-2 border-b border-red-500/20 bg-red-500/10 px-3 py-2 text-sm text-red-800 dark:text-red-200 md:px-4">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <span className="min-w-0 flex-1 break-words">{error}</span>
            <button
              type="button"
              className="shrink-0 touch-manipulation text-xs underline"
              onClick={() => setError(null)}
            >
              Dismiss
            </button>
          </div>
        ) : null}

        {!error && statusMessage ? (
          <div className="flex items-start gap-2 border-b border-emerald-500/20 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-900 dark:text-emerald-200 md:px-4">
            <span className="min-w-0 flex-1 break-words">{statusMessage}</span>
            <button
              type="button"
              className="shrink-0 touch-manipulation text-xs underline"
              onClick={() => setStatusMessage(null)}
            >
              Dismiss
            </button>
          </div>
        ) : null}

        <div className="flex min-h-0 min-w-0 flex-1 flex-col md:flex-row">
          {/* Mobile: horizontal section pills */}
          <div className="flex flex-shrink-0 flex-col gap-2 border-b border-border px-3 py-2 md:hidden">
            <div className="flex items-center gap-2">
              <PillBar className="scrollbar-hide min-w-0 flex-1 overflow-x-auto">
                <Pill
                  isActive={selectedSectionId === 'all'}
                  onClick={() => setSelectedSectionId('all')}
                  className="flex-shrink-0 whitespace-nowrap"
                >
                  All
                </Pill>
                {sections.map((section) => (
                  <Pill
                    key={section.section_id}
                    isActive={selectedSectionId === section.section_id}
                    onClick={() => setSelectedSectionId(section.section_id)}
                    className="max-w-40 flex-shrink-0 truncate whitespace-nowrap"
                  >
                    {section.title}
                    {!section.enabled ? ' (off)' : ''}
                  </Pill>
                ))}
              </PillBar>
              <Button
                variant="ghost"
                size="sm"
                className="h-9 w-9 shrink-0 touch-manipulation p-0"
                onClick={openCreate}
                title="New section"
              >
                <Plus className="h-4 w-4" />
              </Button>
            </div>
            {selectedSection ? (
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
                  {selectedSection.scope === 'project'
                    ? projectNameById.get(selectedSection.project_id ?? '') || 'Project'
                    : 'Global'}
                  {' · '}
                  {selectedSection.mode === 'fire_and_forget' ? 'Fire & forget' : 'Review'}
                  {selectedSection.schedule_cron ? ` · ${selectedSection.schedule_cron}` : ''}
                </span>
                <button
                  type="button"
                  className="inline-flex touch-manipulation items-center gap-1 rounded-md bg-muted px-2 py-1.5 text-[11px] font-medium text-foreground"
                  onClick={() => void runNow(selectedSection.section_id)}
                  disabled={runningSectionId === selectedSection.section_id}
                >
                  {runningSectionId === selectedSection.section_id ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <Play className="h-3 w-3" />
                  )}
                  Run
                </button>
                <button
                  type="button"
                  className="touch-manipulation rounded-md bg-muted px-2 py-1.5 text-[11px] font-medium text-foreground"
                  onClick={() => openEdit(selectedSection)}
                >
                  Edit
                </button>
                <button
                  type="button"
                  className="touch-manipulation rounded-md bg-muted px-2 py-1.5 text-[11px] text-red-600 dark:text-red-400"
                  onClick={() => void deleteSection(selectedSection.section_id)}
                  aria-label="Delete section"
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </div>
            ) : sections.length === 0 && !loading ? (
              <p className="text-[11px] text-muted-foreground">No sections yet. Tap + to create one.</p>
            ) : null}
          </div>

          {/* Desktop: vertical sections sidebar */}
          <aside className="hidden w-64 flex-shrink-0 flex-col border-r border-border md:flex">
            <div className="flex items-center justify-between px-3 py-2">
              <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Sections
              </span>
              <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={openCreate} title="New section">
                <Plus className="h-3.5 w-3.5" />
              </Button>
            </div>
            <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2 pb-3">
              <button
                type="button"
                onClick={() => setSelectedSectionId('all')}
                className={`flex w-full items-center rounded-lg px-2.5 py-2 text-left text-sm transition-colors ${
                  selectedSectionId === 'all'
                    ? 'bg-accent text-foreground'
                    : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground'
                }`}
              >
                All items
              </button>
              {sections.map((section) => (
                <div
                  key={section.section_id}
                  className={`group rounded-lg ${
                    selectedSectionId === section.section_id ? 'bg-accent' : 'hover:bg-accent/60'
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => setSelectedSectionId(section.section_id)}
                    className="flex w-full flex-col gap-0.5 px-2.5 py-2 text-left"
                  >
                    <span className="truncate text-sm font-medium text-foreground">
                      {section.title}
                      {!section.enabled ? (
                        <span className="ml-1 text-[10px] text-muted-foreground">(off)</span>
                      ) : null}
                    </span>
                    <span className="truncate text-[10px] text-muted-foreground">
                      {section.scope === 'project'
                        ? projectNameById.get(section.project_id ?? '') || 'Project'
                        : 'Global'}
                      {' · '}
                      {section.mode === 'fire_and_forget' ? 'Fire & forget' : 'Review'}
                      {section.schedule_cron ? ` · ${section.schedule_cron}` : ''}
                    </span>
                    {section.last_run_error ? (
                      <span className="truncate text-[10px] text-red-600 dark:text-red-400">
                        Last run: {section.last_run_error}
                      </span>
                    ) : section.last_run_at ? (
                      <span className="truncate text-[10px] text-muted-foreground/70">
                        Last run {new Date(section.last_run_at).toLocaleString()}
                      </span>
                    ) : null}
                  </button>
                  <div className="flex gap-1 px-2 pb-2 opacity-80 group-hover:opacity-100">
                    <button
                      type="button"
                      className="rounded px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-background hover:text-foreground"
                      onClick={() => void runNow(section.section_id)}
                      disabled={runningSectionId === section.section_id}
                      title="Run now"
                    >
                      {runningSectionId === section.section_id ? (
                        <Loader2 className="inline h-3 w-3 animate-spin" />
                      ) : (
                        <Play className="inline h-3 w-3" />
                      )}{' '}
                      Run
                    </button>
                    <button
                      type="button"
                      className="rounded px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-background hover:text-foreground"
                      onClick={() => openEdit(section)}
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      className="rounded px-1.5 py-0.5 text-[10px] text-red-600 hover:bg-background dark:text-red-400"
                      onClick={() => void deleteSection(section.section_id)}
                    >
                      <Trash2 className="inline h-3 w-3" />
                    </button>
                  </div>
                </div>
              ))}
              {sections.length === 0 && !loading ? (
                <p className="px-2 py-4 text-xs text-muted-foreground">
                  No sections yet. Create one or import from the legacy Mission Control app.
                </p>
              ) : null}
            </div>
          </aside>

          {/* Queue */}
          <main className="flex min-h-0 min-w-0 flex-1 flex-col">
            <div className="flex flex-shrink-0 items-center justify-between gap-2 border-b border-border px-3 py-2 md:px-4">
              <div className="scrollbar-hide flex min-w-0 items-center gap-1 overflow-x-auto sm:gap-2">
                <button
                  type="button"
                  onClick={() => setStatusFilter('actionable')}
                  className={`touch-manipulation whitespace-nowrap rounded-md px-2.5 py-1.5 text-xs ${
                    statusFilter === 'actionable'
                      ? 'bg-accent font-medium text-foreground'
                      : 'text-muted-foreground'
                  }`}
                >
                  Needs attention
                </button>
                <button
                  type="button"
                  onClick={() => setStatusFilter('all')}
                  className={`touch-manipulation whitespace-nowrap rounded-md px-2.5 py-1.5 text-xs ${
                    statusFilter === 'all'
                      ? 'bg-accent font-medium text-foreground'
                      : 'text-muted-foreground'
                  }`}
                >
                  All history
                </button>
              </div>
              {selectedSectionId !== 'all' ? (
                <Button
                  size="sm"
                  variant="outline"
                  className="hidden h-8 shrink-0 touch-manipulation gap-1.5 text-xs md:inline-flex"
                  disabled={runningSectionId === selectedSectionId}
                  onClick={() => void runNow(selectedSectionId)}
                >
                  {runningSectionId === selectedSectionId ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Play className="h-3.5 w-3.5" />
                  )}
                  Run section
                </Button>
              ) : null}
            </div>

            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto overflow-x-hidden p-3 pb-[max(1rem,env(safe-area-inset-bottom))] md:p-4">
              {loading && items.length === 0 ? (
                <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" /> Loading…
                </div>
              ) : null}

              {!loading && items.length === 0 ? (
                <div className="flex flex-col items-center justify-center gap-2 px-2 py-16 text-center">
                  <Clock className="h-8 w-8 text-muted-foreground/40" />
                  <p className="text-sm text-muted-foreground">
                    {statusFilter === 'actionable'
                      ? 'Nothing needs review right now.'
                      : 'No items yet. Run a section to produce drafts.'}
                  </p>
                </div>
              ) : null}

              {items.map((item) => {
                const section = sections.find((s) => s.section_id === item.section_id);
                const isEditingBody = editingBodyId === item.item_id;
                const actionable = item.status === 'pending' || item.status === 'failed';
                return (
                  <article
                    key={item.item_id}
                    className="rounded-xl border border-border bg-card p-3 shadow-sm sm:p-4"
                  >
                    <div className="mb-2 flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <h3 className="break-words text-sm font-semibold text-foreground">{item.title}</h3>
                        {item.summary ? (
                          <p className="mt-0.5 break-words text-xs text-muted-foreground">{item.summary}</p>
                        ) : null}
                        <p className="mt-1 break-words text-[10px] text-muted-foreground/80">
                          {section?.title ?? item.section_id}
                          {item.provider ? ` · ${item.provider}` : ''}
                          {item.model ? `/${item.model}` : ''}
                          {' · '}
                          {new Date(item.created_at).toLocaleString()}
                        </p>
                      </div>
                      <span
                        className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium capitalize ${statusBadgeClass(item.status)}`}
                      >
                        {item.status}
                      </span>
                    </div>

                    {item.error ? (
                      <p className="mb-2 break-words rounded-md bg-red-500/10 px-2 py-1.5 text-xs text-red-700 dark:text-red-300">
                        {item.error}
                      </p>
                    ) : null}

                    <div className="mb-1 flex items-center justify-between gap-2">
                      <p className="text-[10px] font-medium uppercase text-muted-foreground">Body</p>
                      {actionable ? (
                        <button
                          type="button"
                          className="inline-flex touch-manipulation items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground"
                          onClick={() => (isEditingBody ? cancelBodyEdit() : startBodyEdit(item))}
                        >
                          <Pencil className="h-3 w-3" />
                          <span className="sm:hidden">{isEditingBody ? 'Cancel' : 'Edit'}</span>
                          <span className="hidden sm:inline">
                            {isEditingBody ? 'Cancel edit' : 'Edit before approve'}
                          </span>
                        </button>
                      ) : null}
                    </div>

                    {isEditingBody ? (
                      <div className="mb-3">
                        <textarea
                          className="field-input min-h-[120px] font-mono text-[11px] sm:min-h-[140px]"
                          value={bodyDraft}
                          onChange={(e) => {
                            setBodyDraft(e.target.value);
                            setBodyError(null);
                          }}
                        />
                        {bodyError ? (
                          <p className="mt-1 text-[11px] text-red-600 dark:text-red-400">{bodyError}</p>
                        ) : (
                          <p className="mt-1 text-[10px] text-muted-foreground">
                            Edits are sent with Approve / other resolve actions.
                          </p>
                        )}
                      </div>
                    ) : isXArticleBody(item.body) ? (
                      // Prose items get an article-shaped view; the raw JSON is
                      // still reachable through "Edit before approve".
                      <ArticleDraftCard
                        article={item.body}
                        itemId={item.item_id}
                        onGenerateAssets={(force) => generateAssets(item.item_id, force)}
                      />
                    ) : (
                      <pre className="mb-3 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted/50 p-2.5 text-[11px] leading-relaxed text-foreground/90 sm:max-h-48 sm:whitespace-pre sm:break-normal">
                        {JSON.stringify(item.body, null, 2)}
                      </pre>
                    )}

                    {item.result ? (
                      <div className="mb-3">
                        <p className="mb-1 text-[10px] font-medium uppercase text-muted-foreground">
                          Result
                        </p>
                        <pre className="max-h-28 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-emerald-500/5 p-2.5 text-[11px] sm:max-h-32 sm:whitespace-pre sm:break-normal">
                          {JSON.stringify(item.result, null, 2)}
                        </pre>
                      </div>
                    ) : null}

                    {(() => {
                      // Full review actions on pending/failed; Delete alone on
                      // terminal rows so history can free a dedupe key for re-run.
                      const visibleActions = actionable
                        ? item.actions
                        : item.status !== 'resolving'
                          ? item.actions.filter((a) => a.kind === 'delete' || a.id === 'delete')
                          : [];
                      if (visibleActions.length === 0 && !actionable) return null;
                      const itemPreview = previewData?.itemId === item.item_id ? previewData : null;
                      return (
                        <div className="space-y-2">
                          {itemPreview ? (
                            <div className="rounded-lg border border-primary/30 bg-primary/5 p-2.5">
                              <div className="mb-1.5 flex items-center justify-between gap-2">
                                <p className="text-[10px] font-medium uppercase text-muted-foreground">
                                  {itemPreview.type === 'static'
                                    ? 'Preview — instant resolve'
                                    : 'Preview — agent result'}
                                </p>
                                <button
                                  type="button"
                                  className="shrink-0 text-muted-foreground hover:text-foreground"
                                  onClick={() => setPreviewData(null)}
                                  aria-label="Close preview"
                                >
                                  <X className="h-3.5 w-3.5" />
                                </button>
                              </div>
                              {itemPreview.type === 'static' ? (
                                <p className="mb-1.5 text-[10px] text-muted-foreground">
                                  This action resolves instantly — the body below is what would be
                                  approved.
                                </p>
                              ) : null}
                              <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-background p-2.5 text-[11px] leading-relaxed text-foreground/90">
                                {JSON.stringify(itemPreview.preview, null, 2)}
                              </pre>
                            </div>
                          ) : null}
                          <div className="flex flex-wrap gap-2">
                            {actionable ? (
                              <button
                                type="button"
                                disabled={actingItemId === item.item_id || retryingItemId === item.item_id}
                                onClick={() => void retryItem(item)}
                                title="Re-run produce for just this item"
                                className="inline-flex min-h-9 touch-manipulation items-center gap-1 rounded-lg border border-border bg-background px-3 py-2 text-xs font-medium text-foreground transition-colors hover:bg-muted/70 disabled:opacity-50 sm:min-h-0 sm:py-1.5"
                              >
                                {retryingItemId === item.item_id ? (
                                  <Loader2 className="h-3 w-3 animate-spin" />
                                ) : (
                                  <RotateCw className="h-3 w-3" />
                                )}
                                Retry
                              </button>
                            ) : null}
                            {visibleActions.map((action) => (
                              <div key={action.id} className="flex items-center gap-1.5">
                                <button
                                  type="button"
                                  disabled={actingItemId === item.item_id}
                                  onClick={() => void actOnItem(item, action.id)}
                                  className={`inline-flex min-h-9 touch-manipulation items-center gap-1 rounded-lg px-3 py-2 text-xs font-medium transition-colors disabled:opacity-50 sm:min-h-0 sm:py-1.5 ${actionButtonClass(action.style)}`}
                                >
                                  {actingItemId === item.item_id ? (
                                    <Loader2 className="h-3 w-3 animate-spin" />
                                  ) : action.kind === 'approve' ? (
                                    <Check className="h-3 w-3" />
                                  ) : action.kind === 'work' ? (
                                    <Play className="h-3 w-3" />
                                  ) : action.kind === 'delete' ? (
                                    <Trash2 className="h-3 w-3" />
                                  ) : action.kind === 'dismiss' ? (
                                    <X className="h-3 w-3" />
                                  ) : null}
                                  {action.label}
                                </button>
                                {actionable && action.kind === 'approve' ? (
                                  <button
                                    type="button"
                                    disabled={actingItemId === item.item_id || previewingItemId === item.item_id}
                                    onClick={() => void previewItem(item, action.id)}
                                    title={`Preview “${action.label}” result`}
                                    className="inline-flex h-9 touch-manipulation items-center gap-1 rounded-lg border border-border bg-background px-2 text-[10px] font-medium text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground disabled:opacity-50 sm:h-auto sm:py-1.5"
                                  >
                                    {previewingItemId === item.item_id ? (
                                      <Loader2 className="h-3 w-3 animate-spin" />
                                    ) : (
                                      <Eye className="h-3 w-3" />
                                    )}
                                    Preview
                                  </button>
                                ) : null}
                              </div>
                            ))}
                          </div>
                        </div>
                      );
                    })()}
                  </article>
                );
              })}
            </div>
          </main>
        </div>

        {/* Section editor — full screen on mobile */}
        {showEditor ? (
          <div className="absolute inset-0 z-10 flex items-stretch justify-center bg-background md:items-center md:bg-background/70 md:p-6 md:backdrop-blur-sm">
            <div className="flex h-full max-h-dvh w-full flex-col overflow-hidden border-0 bg-background shadow-none md:h-auto md:max-h-[85vh] md:max-w-2xl md:rounded-xl md:border md:border-border md:shadow-2xl">
              <div className="flex items-center justify-between border-b border-border px-4 py-3 pt-[max(0.75rem,env(safe-area-inset-top))] md:pt-3">
                <h3 className="text-sm font-semibold">
                  {editingId ? 'Edit section' : 'New section'}
                </h3>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-10 w-10 touch-manipulation p-0 md:h-8 md:w-8"
                  onClick={() => setShowEditor(false)}
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
              <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
                <Field label="Title">
                  <input
                    className="field-input"
                    value={form.title ?? ''}
                    onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
                    placeholder="e.g. Jira drafts from Slack"
                  />
                </Field>

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <Field label="Scope">
                    <select
                      className="field-input"
                      value={form.scope}
                      onChange={(e) =>
                        setForm((f) => ({
                          ...f,
                          scope: e.target.value as 'global' | 'project',
                        }))
                      }
                    >
                      <option value="global">Global</option>
                      <option value="project">Project</option>
                    </select>
                  </Field>
                  <Field label="Mode">
                    <select
                      className="field-input"
                      value={form.mode}
                      onChange={(e) =>
                        setForm((f) => ({
                          ...f,
                          mode: e.target.value as 'review' | 'fire_and_forget',
                        }))
                      }
                    >
                      <option value="review">Review (produce → approve → resolve)</option>
                      <option value="fire_and_forget">Fire & forget (scheduled prompt)</option>
                    </select>
                  </Field>
                </div>

                {form.scope === 'project' ? (
                  <Field label="Project">
                    <select
                      className="field-input"
                      value={form.project_id ?? ''}
                      onChange={(e) =>
                        setForm((f) => ({ ...f, project_id: e.target.value || null }))
                      }
                    >
                      <option value="">Select project…</option>
                      {projects.map((p) => (
                        <option key={p.projectId} value={p.projectId}>
                          {p.displayName || p.projectId}
                        </option>
                      ))}
                    </select>
                  </Field>
                ) : null}

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <Field label="Provider">
                    <select
                      className="field-input"
                      value={form.provider}
                      onChange={(e) => onProviderChange(e.target.value)}
                    >
                      {PROVIDERS.map((p) => (
                        <option key={p} value={p}>
                          {p}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Model">
                    <select
                      className="field-input"
                      value={form.model ?? ''}
                      onChange={(e) => setForm((f) => ({ ...f, model: e.target.value }))}
                      disabled={modelsLoading}
                    >
                      {modelsLoading ? (
                        <option value="">Loading models…</option>
                      ) : models.length === 0 ? (
                        <option value="">No models found</option>
                      ) : (
                        models.map((m) => (
                          <option key={m.value} value={m.value}>
                            {m.label}
                          </option>
                        ))
                      )}
                    </select>
                  </Field>
                </div>

                <Field label="Schedule cron (optional)">
                  <input
                    className="field-input"
                    value={form.schedule_cron ?? ''}
                    onChange={(e) => setForm((f) => ({ ...f, schedule_cron: e.target.value }))}
                    placeholder="0 * * * * (hourly)"
                  />
                </Field>

                <Field label="Produce prompt">
                  <textarea
                    className="field-input min-h-[100px] font-mono text-xs"
                    value={form.produce_prompt ?? ''}
                    onChange={(e) => setForm((f) => ({ ...f, produce_prompt: e.target.value }))}
                    placeholder={
                      form.mode === 'fire_and_forget'
                        ? 'Prompt to run on schedule…'
                        : 'Instructions to gather context and draft items as JSON…'
                    }
                  />
                </Field>

                <Field label="Produce MCP servers (multi-select)">
                  <McpMultiSelect
                    loading={mcpLoading}
                    options={produceOptions}
                    selected={produceMcp}
                    onToggle={(name) => toggleMcp(produceMcp, setProduceMcp, name)}
                  />
                </Field>

                {form.mode === 'review' ? (
                  <>
                    <Field label="Resolve prompt (on Approve)">
                      <textarea
                        className="field-input min-h-[80px] font-mono text-xs"
                        value={form.resolve_prompt ?? ''}
                        onChange={(e) =>
                          setForm((f) => ({ ...f, resolve_prompt: e.target.value }))
                        }
                        placeholder="Instructions to execute the approved draft via tools…"
                      />
                    </Field>
                    <Field label="Resolve MCP servers (multi-select)">
                      <McpMultiSelect
                        loading={mcpLoading}
                        options={resolveOptions}
                        selected={resolveMcp}
                        onToggle={(name) => toggleMcp(resolveMcp, setResolveMcp, name)}
                      />
                    </Field>

                    <div className="rounded-md border border-border p-3">
                      <label className="flex items-center gap-2 text-xs font-medium">
                        <input
                          type="checkbox"
                          checked={Boolean(form.create_kanban_task)}
                          onChange={(e) =>
                            setForm((f) => ({ ...f, create_kanban_task: e.target.checked }))
                          }
                        />
                        Create a Kanban card on approval
                      </label>
                      <p className="mt-1 text-[11px] text-muted-foreground">
                        On Approve, add a card to the global board&apos;s backlog with an exhaustive
                        description and a generated implementer prompt (linked to the created
                        ticket). Attach a project and move it to In Progress to auto-run.
                      </p>
                      {form.create_kanban_task ? (
                        <div className="mt-3 space-y-3">
                          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                            <Field label="Default implementation agent">
                              <select
                                className="field-input"
                                value={form.kanban_assignee_provider ?? ''}
                                onChange={(e) =>
                                  setForm((f) => ({
                                    ...f,
                                    kanban_assignee_provider: e.target.value || null,
                                  }))
                                }
                              >
                                <option value="">None (set per card)</option>
                                {PROVIDERS.map((p) => (
                                  <option key={p} value={p}>
                                    {p}
                                  </option>
                                ))}
                              </select>
                            </Field>
                            <Field label="Default review agent">
                              <select
                                className="field-input"
                                value={form.kanban_review_provider ?? ''}
                                onChange={(e) =>
                                  setForm((f) => ({
                                    ...f,
                                    kanban_review_provider: e.target.value || null,
                                  }))
                                }
                              >
                                <option value="">None</option>
                                {PROVIDERS.map((p) => (
                                  <option key={p} value={p}>
                                    {p}
                                  </option>
                                ))}
                              </select>
                            </Field>
                          </div>
                          <Field label="Kanban task MCP servers (multi-select)">
                            <McpMultiSelect
                              loading={mcpLoading}
                              options={kanbanMcpOptions}
                              selected={kanbanMcp}
                              onToggle={(name) => toggleMcp(kanbanMcp, setKanbanMcp, name)}
                            />
                            <p className="mt-1 text-[11px] text-muted-foreground">
                              Attached to each bridged Kanban card so the implementer is steered to
                              the right integrations (e.g. Leong Associates for platform work).
                            </p>
                          </Field>
                        </div>
                      ) : null}
                    </div>
                  </>
                ) : null}

                <div className="flex flex-wrap gap-4 text-xs">
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={form.enabled !== false}
                      onChange={(e) => setForm((f) => ({ ...f, enabled: e.target.checked }))}
                    />
                    Enabled
                  </label>
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={Boolean(form.dry_run)}
                      onChange={(e) => setForm((f) => ({ ...f, dry_run: e.target.checked }))}
                    />
                    Dry run
                  </label>
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={Boolean(form.auto_approve)}
                      onChange={(e) =>
                        setForm((f) => ({ ...f, auto_approve: e.target.checked }))
                      }
                    />
                    Auto-approve
                  </label>
                </div>
              </div>
              <div className="flex justify-end gap-2 border-t border-border px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] md:pb-3">
                <Button variant="ghost" size="sm" className="touch-manipulation" onClick={() => setShowEditor(false)}>
                  Cancel
                </Button>
                <Button size="sm" className="touch-manipulation" onClick={() => void saveSection()} disabled={saving}>
                  {saving ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
                  {editingId ? 'Save' : 'Create'}
                </Button>
              </div>
            </div>
          </div>
        ) : null}

        {/* Import dialog */}
        {showImport ? (
          <div className="absolute inset-0 z-20 flex items-end justify-center bg-background/70 p-0 backdrop-blur-sm sm:items-center sm:p-4">
            <div className="w-full max-w-md rounded-t-xl border border-border bg-background p-4 pb-[max(1rem,env(safe-area-inset-bottom))] shadow-2xl sm:rounded-xl sm:pb-4">
              <h3 className="mb-1 text-sm font-semibold">Import from Mission Control</h3>
              <p className="mb-3 text-xs text-muted-foreground">
                Import section configs (prompts, MCP, schedule, engine) from the legacy
                mission-control.db. Existing items are not imported.
              </p>
              <Field label="Database path">
                <input
                  className="field-input font-mono text-xs"
                  value={importPath}
                  onChange={(e) => setImportPath(e.target.value)}
                  placeholder="~/Sites/mission_control/backend/mission-control.db"
                />
              </Field>
              <div className="mt-4 flex justify-end gap-2">
                <Button variant="ghost" size="sm" onClick={() => setShowImport(false)}>
                  Cancel
                </Button>
                <Button size="sm" onClick={() => void runImport()} disabled={importing}>
                  {importing ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
                  Import sections
                </Button>
              </div>
            </div>
          </div>
        ) : null}
      </div>

      <style>{`
        .field-input {
          width: 100%;
          border-radius: 0.5rem;
          border: 1px solid hsl(var(--border));
          background: hsl(var(--background));
          padding: 0.5rem 0.75rem;
          font-size: 0.8125rem;
          color: hsl(var(--foreground));
        }
        .field-input:focus {
          outline: 2px solid hsl(var(--ring));
          outline-offset: 1px;
        }
      `}</style>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

function McpMultiSelect({
  loading,
  options,
  selected,
  onToggle,
}: {
  loading: boolean;
  options: string[];
  selected: string[];
  onToggle: (name: string) => void;
}) {
  if (loading) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-border px-3 py-3 text-xs text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading MCP servers…
      </div>
    );
  }
  if (options.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border px-3 py-3 text-xs text-muted-foreground">
        No MCP servers found for this provider. Configure them in Settings → MCP.
      </div>
    );
  }
  return (
    <div className="max-h-40 space-y-1 overflow-y-auto rounded-lg border border-border p-2">
      {options.map((name) => {
        const checked = selected.includes(name);
        return (
          <label
            key={name}
            className={`flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-xs transition-colors ${
              checked ? 'bg-primary/10 text-foreground' : 'text-muted-foreground hover:bg-muted/60'
            }`}
          >
            <input
              type="checkbox"
              className="rounded border-border"
              checked={checked}
              onChange={() => onToggle(name)}
            />
            <span className="font-mono">{name}</span>
          </label>
        );
      })}
      {selected.length > 0 ? (
        <p className="px-2 pt-1 text-[10px] text-muted-foreground">
          {selected.length} selected
        </p>
      ) : null}
    </div>
  );
}
