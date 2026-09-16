import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useWebSocket } from '../../../contexts/WebSocketContext';
import type { CreateMcSectionInput, McItem, McSection } from '../../mission-control/api/missionControlApi';
import { botStudioApi, type BotRun } from '../api/botStudioApi';
import { botPatch, sectionToBot, type Bot, type BotAutonomy } from '../types';

import { removeItem, setItemStatus, upsertItem, upsertSection } from './botStudioReducers';

export type BotStudioFilters = {
  status: 'pending' | 'resolving' | 'resolved' | 'failed' | 'all';
  botId: string;
  search: string;
};

export type BotStudioSummary = Awaited<ReturnType<typeof botStudioApi.summary>>;
export type BotStudioItemStatus = McItem['status'];
type SaveBotPatch = Partial<CreateMcSectionInput> & { section_id?: string; autonomy?: BotAutonomy };

const EMPTY_SUMMARY: BotStudioSummary = { pendingCount: 0, sectionCount: 0, sections: [] };

function errorMessage(value: unknown, fallback: string): string {
  return value instanceof Error ? value.message : fallback;
}

/**
 * The data spine for Bot Studio. Mission Control remains the persisted model;
 * this hook owns only view state, optimistic transitions, and the runs cache.
 */
export function useBotStudio() {
  const { subscribe } = useWebSocket();
  const [sections, setSections] = useState<McSection[]>([]);
  const [items, setItems] = useState<McItem[]>([]);
  const [summary, setSummary] = useState<BotStudioSummary>(EMPTY_SUMMARY);
  const [runsBySection, setRunsBySection] = useState<Record<string, BotRun[]>>({});
  const [mcpServers, setMcpServers] = useState<Array<{ name: string; displayName?: string; connected?: boolean; needsAuth?: boolean }>>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filters, setFilters] = useState<BotStudioFilters>({ status: 'pending', botId: 'all', search: '' });
  const generationRef = useRef(0);
  const runsRef = useRef<Record<string, BotRun[]>>({});
  const runsLoadingRef = useRef(new Set<string>());

  const refreshItems = useCallback(async (options: { sectionId?: string } = {}) => {
    try {
      const [nextItems, nextSummary] = await Promise.all([
        botStudioApi.listItems({ sectionId: options.sectionId, limit: 250 }),
        botStudioApi.summary(),
      ]);
      setItems(nextItems.items ?? []);
      setSummary(nextSummary ?? EMPTY_SUMMARY);
      setError(null);
    } catch (nextError) {
      setError(errorMessage(nextError, 'Unable to refresh Bot Studio inbox'));
    }
  }, []);

  const loadRuns = useCallback(async (sectionId: string, limit = 30) => {
    if (!sectionId || runsLoadingRef.current.has(sectionId)) return;
    runsLoadingRef.current.add(sectionId);
    try {
      const nextRuns = await botStudioApi.listRuns(sectionId, limit);
      runsRef.current = { ...runsRef.current, [sectionId]: nextRuns };
      setRunsBySection(runsRef.current);
    } catch (nextError) {
      // Runs are supplemental. Keep the core inbox usable if an older server
      // does not expose the new runs endpoint yet.
      console.warn('[BotStudio] unable to load runs', nextError);
    } finally {
      runsLoadingRef.current.delete(sectionId);
    }
  }, []);

  const refreshAll = useCallback(async (options: { includeRuns?: boolean } = {}) => {
    const generation = ++generationRef.current;
    setLoading(true);
    try {
      const [nextSections, nextItems, nextSummary] = await Promise.all([
        botStudioApi.listSections(),
        botStudioApi.listItems({ limit: 250 }),
        botStudioApi.summary(),
      ]);
      if (generation !== generationRef.current) return;
      setSections(nextSections);
      setItems(nextItems.items ?? []);
      setSummary(nextSummary ?? EMPTY_SUMMARY);
      setError(null);

      if (options.includeRuns) {
        await Promise.all(nextSections.map((section) => loadRuns(section.section_id)));
      }
    } catch (nextError) {
      if (generation === generationRef.current) setError(errorMessage(nextError, 'Unable to load Bot Studio'));
    } finally {
      if (generation === generationRef.current) setLoading(false);
    }
  }, [loadRuns]);

  useEffect(() => {
    void refreshAll({ includeRuns: true });
    const interval = window.setInterval(() => void refreshAll(), 30_000);
    return () => window.clearInterval(interval);
  }, [refreshAll]);

  useEffect(() => subscribe((event) => {
    const kind = event.kind ?? event.type;
    if (kind === 'mc_item_created' || kind === 'mc_item_updated') {
      void refreshItems();
    } else if (kind === 'mc_section_updated') {
      void refreshAll();
    } else if (kind === 'websocket_reconnected') {
      void refreshAll({ includeRuns: true });
    }
  }), [refreshAll, refreshItems, subscribe]);

  useEffect(() => {
    let cancelled = false;
    void botStudioApi.listMcpInventory().then((inventory) => {
      if (!cancelled) setMcpServers(inventory);
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, []);

  const bots = useMemo(() => {
    const sectionSummaries = summary.sections ?? [];
    return sections.map((section) => {
      const serverSummary = sectionSummaries.find((entry) => entry.section_id === section.section_id);
      return sectionToBot(section, serverSummary ? {
        pending: serverSummary.pending,
        failed: serverSummary.failed,
        resolvedToday: serverSummary.resolved_today,
        lastRunAt: serverSummary.last_run_at,
        lastError: serverSummary.last_error,
      } : undefined);
    });
  }, [sections, summary]);

  const optimisticItemStatus = useCallback((itemId: string, status: McItem['status']) => {
    setItems((current) => setItemStatus(current, itemId, status));
  }, []);

  const itemAction = useCallback(async (itemId: string, actionId: string, body?: Record<string, unknown>) => {
    const previous = items.find((item) => item.item_id === itemId);
    optimisticItemStatus(itemId, 'resolving');
    try {
      const result = await botStudioApi.applyAction(itemId, actionId, body);
      if (result.deleted || !result.item) setItems((current) => removeItem(current, itemId));
      else setItems((current) => upsertItem(current, result.item as McItem));
      void refreshItems();
      return result;
    } catch (nextError) {
      if (previous) optimisticItemStatus(itemId, previous.status);
      throw nextError;
    }
  }, [items, optimisticItemStatus, refreshItems]);

  const retryItem = useCallback(async (itemId: string) => {
    const previous = items.find((item) => item.item_id === itemId);
    optimisticItemStatus(itemId, 'resolving');
    try {
      const result = await botStudioApi.retryItem(itemId);
      if (result.item) setItems((current) => upsertItem(current, result.item as McItem));
      void refreshItems();
      return result;
    } catch (nextError) {
      if (previous) optimisticItemStatus(itemId, previous.status);
      throw nextError;
    }
  }, [items, optimisticItemStatus, refreshItems]);

  const runBot = useCallback(async (botOrId: Bot | string) => {
    const sectionId = typeof botOrId === 'string' ? botOrId : botOrId.section_id;
    const result = await botStudioApi.runSection(sectionId);
    void refreshAll({ includeRuns: true });
    return result;
  }, [refreshAll]);

  const saveBot = useCallback(async (idOrPatch: string | SaveBotPatch, maybePatch?: SaveBotPatch) => {
    const sectionId = typeof idOrPatch === 'string' ? idOrPatch : idOrPatch.section_id;
    if (!sectionId) throw new Error('A bot id is required to save a bot.');
    const sourcePatch = typeof idOrPatch === 'string' ? maybePatch ?? {} : idOrPatch;
    const payload = { ...sourcePatch };
    delete payload.section_id;
    const patch = payload.autonomy ? botPatch(payload) : payload;
    const updated = await botStudioApi.updateSection(sectionId, patch);
    setSections((current) => upsertSection(current, updated));
    return updated;
  }, []);

  const deleteBot = useCallback(async (sectionId: string) => {
    await botStudioApi.deleteSection(sectionId);
    setSections((current) => current.filter((section) => section.section_id !== sectionId));
    setItems((current) => current.filter((item) => item.section_id !== sectionId));
    runsRef.current = Object.fromEntries(Object.entries(runsRef.current).filter(([id]) => id !== sectionId));
    setRunsBySection(runsRef.current);
  }, []);

  const createBot = useCallback(async (input: Partial<CreateMcSectionInput>) => {
    const created = await botStudioApi.createSection({ title: input.title?.trim() || 'New bot', ...input });
    setSections((current) => upsertSection(current, created));
    return created;
  }, []);

  const duplicateBot = useCallback(async (sectionId: string) => {
    const source = sections.find((section) => section.section_id === sectionId);
    if (!source) throw new Error('Bot not found.');
    const copy: Partial<CreateMcSectionInput> = {
      title: `${source.title} copy`,
      icon: source.icon,
      sort_order: source.sort_order,
      enabled: false,
      scope: source.scope,
      project_id: source.project_id,
      mode: source.mode,
      schedule_cron: source.schedule_cron,
      provider: source.provider,
      model: source.model,
      permission_mode: source.permission_mode,
      dry_run: source.dry_run,
      auto_approve: source.auto_approve,
      produce_prompt: source.produce_prompt,
      produce_tools: source.produce_tools,
      resolve_prompt: source.resolve_prompt,
      resolve_tools: source.resolve_tools,
      actions: source.actions,
      create_kanban_task: source.create_kanban_task,
      create_swarm_on_approve: source.create_swarm_on_approve,
      kanban_assignee_provider: source.kanban_assignee_provider,
      kanban_review_provider: source.kanban_review_provider,
      kanban_mcp_tools: source.kanban_mcp_tools,
      tool_policy: source.tool_policy,
    };
    const duplicate = await createBot(copy);
    return duplicate;
  }, [createBot, sections]);

  const setAutonomy = useCallback((sectionId: string, autonomy: BotAutonomy) => saveBot(sectionId, botPatch(autonomy)), [saveBot]);
  const setEnabled = useCallback((sectionId: string, enabled: boolean) => saveBot(sectionId, { enabled }), [saveBot]);

  const bulkEnabled = useCallback(async (enabled: boolean) => {
    await botStudioApi.bulkUpdate('all', { enabled });
    setSections((current) => current.map((section) => ({ ...section, enabled })));
    await refreshAll({ includeRuns: true });
  }, [refreshAll]);

  const previewItem = useCallback((itemId: string, actionId?: string, body?: Record<string, unknown>) => botStudioApi.previewItem(itemId, actionId, body), []);
  const workItem = useCallback((itemId: string, projectId?: string) => botStudioApi.workThis(itemId, projectId), []);
  const runsFor = useCallback((sectionId: string, limit = 30) => {
    if (!runsRef.current[sectionId]) void loadRuns(sectionId, limit);
    return runsRef.current[sectionId] ?? [];
  }, [loadRuns]);

  // Compatibility aliases let the independently developed inbox/detail views
  // migrate to the stable contract without forcing a synchronized merge.
  const applyAction = useCallback((item: McItem, actionId: string, body?: Record<string, unknown>) => itemAction(item.item_id, actionId, body), [itemAction]);
  const updateBot = useCallback((sectionId: string, patch: SaveBotPatch) => saveBot(sectionId, patch), [saveBot]);
  const workThis = workItem;
  const generateAssets = useCallback((itemId: string, force = false) => botStudioApi.generateAssets(itemId, force), []);
  const setOptimisticStatus = optimisticItemStatus;
  const refresh = useCallback(async (options: { sectionId?: string; runs?: boolean } = {}) => {
    if (options.sectionId) await refreshItems({ sectionId: options.sectionId });
    else await refreshAll({ includeRuns: options.runs });
  }, [refreshAll, refreshItems]);

  return {
    bots,
    items,
    summary,
    loading,
    isLoading: loading,
    error,
    filters,
    setFilters,
    sections,
    setSections,
    setItems,
    mcpServers,
    runsBySection,
    refreshAll,
    refreshItems,
    runBot,
    setAutonomy,
    setEnabled,
    saveBot,
    deleteBot,
    duplicateBot,
    createBot,
    bulkEnabled,
    itemAction,
    optimisticItemStatus,
    setOptimisticStatus,
    previewItem,
    retryItem,
    workItem,
    runsFor,
    // Transitional names used by the current view workers.
    refresh,
    applyAction,
    updateBot,
    workThis,
    generateAssets,
  };
}
