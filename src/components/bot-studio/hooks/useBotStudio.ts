import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useWebSocket } from '../../../contexts/WebSocketContext';
import type { CreateMcSectionInput, McItem, McSection } from '../../mission-control/api/missionControlApi';

import { botStudioApi, type BotRun } from '../api/botStudioApi';
import { sectionToBot, type Bot } from '../types';

export type BotStudioItemStatus = McItem['status'];

export function useBotStudio() {
  const { subscribe } = useWebSocket();
  const [sections, setSections] = useState<McSection[]>([]);
  const [items, setItems] = useState<McItem[]>([]);
  const [summary, setSummary] = useState<Awaited<ReturnType<typeof botStudioApi.summary>> | null>(null);
  const [runsBySection, setRunsBySection] = useState<Record<string, BotRun[]>>({});
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const refreshGeneration = useRef(0);

  const refresh = useCallback(async (options: { sectionId?: string; runs?: boolean } = {}) => {
    const generation = ++refreshGeneration.current;
    setError(null);
    try {
      const [nextSections, nextItems, nextSummary] = await Promise.all([
        botStudioApi.listSections(),
        botStudioApi.listItems({ sectionId: options.sectionId, limit: 250 }),
        botStudioApi.summary(),
      ]);
      if (generation !== refreshGeneration.current) return;
      setSections(nextSections);
      setItems(nextItems.items ?? []);
      setSummary(nextSummary);
      if (options.runs) {
        const pairs = await Promise.all(
          nextSections.map(async (section) => [section.section_id, await botStudioApi.listRuns(section.section_id)] as const),
        );
        if (generation === refreshGeneration.current) {
          setRunsBySection(Object.fromEntries(pairs));
        }
      }
    } catch (nextError) {
      if (generation === refreshGeneration.current) {
        setError(nextError instanceof Error ? nextError.message : 'Unable to load Bot Studio');
      }
    } finally {
      if (generation === refreshGeneration.current) setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh({ runs: true });
    const interval = window.setInterval(() => void refresh(), 30_000);
    return () => window.clearInterval(interval);
  }, [refresh]);

  useEffect(() => subscribe((event) => {
    if (event.kind === 'mc_item_created' || event.kind === 'mc_item_updated' || event.kind === 'mc_section_updated') {
      void refresh();
    }
    if (event.kind === 'websocket_reconnected') {
      void refresh({ runs: true });
    }
  }), [refresh, subscribe]);

  const bots = useMemo(() => {
    const sectionSummaries = summary?.sections ?? [];
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

  const setOptimisticStatus = useCallback((itemId: string, status: BotStudioItemStatus) => {
    setItems((current) => current.map((item) => item.item_id === itemId ? { ...item, status } : item));
  }, []);

  const applyAction = useCallback(async (item: McItem, actionId: string, body?: Record<string, unknown>) => {
    setOptimisticStatus(item.item_id, 'resolving');
    try {
      const result = await botStudioApi.applyAction(item.item_id, actionId, body);
      if (result.deleted || !result.item) {
        setItems((current) => current.filter((entry) => entry.item_id !== item.item_id));
      } else {
        setItems((current) => current.map((entry) => entry.item_id === item.item_id ? result.item as McItem : entry));
      }
      void refresh();
      return result;
    } catch (nextError) {
      setOptimisticStatus(item.item_id, item.status);
      throw nextError;
    }
  }, [refresh, setOptimisticStatus]);

  const retryItem = useCallback(async (item: McItem) => {
    setOptimisticStatus(item.item_id, 'resolving');
    try {
      const result = await botStudioApi.retryItem(item.item_id);
      if (result.item) {
        setItems((current) => current.map((entry) => entry.item_id === item.item_id ? result.item as McItem : entry));
      }
      void refresh();
      return result;
    } catch (nextError) {
      setOptimisticStatus(item.item_id, 'failed');
      throw nextError;
    }
  }, [refresh, setOptimisticStatus]);

  const runBot = useCallback(async (bot: Bot) => {
    const result = await botStudioApi.runSection(bot.section_id);
    void refresh({ runs: true });
    return result;
  }, [refresh]);

  const updateBot = useCallback(async (id: string, patch: Parameters<typeof botStudioApi.updateSection>[1]) => {
    const updated = await botStudioApi.updateSection(id, patch);
    setSections((current) => current.map((section) => section.section_id === id ? updated : section));
    return updated;
  }, []);

  const deleteBot = useCallback(async (id: string) => {
    await botStudioApi.deleteSection(id);
    setSections((current) => current.filter((section) => section.section_id !== id));
    setItems((current) => current.filter((item) => item.section_id !== id));
  }, []);

  const createBot = useCallback(async (input: Partial<CreateMcSectionInput>) => {
    const created = await botStudioApi.createSection({ title: input.title || 'New bot', ...input });
    setSections((current) => [...current, created]);
    return created;
  }, []);

  const previewItem = useCallback((itemId: string, actionId?: string, body?: Record<string, unknown>) => (
    botStudioApi.previewItem(itemId, actionId, body)
  ), []);

  const workThis = useCallback((itemId: string, projectId?: string) => botStudioApi.workThis(itemId, projectId), []);
  const generateAssets = useCallback((itemId: string, force = false) => botStudioApi.generateAssets(itemId, force), []);

  return {
    bots,
    sections,
    items,
    summary,
    runsBySection,
    isLoading,
    error,
    refresh,
    setSections,
    setItems,
    applyAction,
    retryItem,
    runBot,
    updateBot,
    deleteBot,
    createBot,
    previewItem,
    workThis,
    generateAssets,
  };
}
