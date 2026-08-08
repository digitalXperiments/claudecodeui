import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { runsApi } from '../api/runsApi';
import type {
  AgentRunSummary,
  BudgetUpdate,
  ProjectRunBudget,
  ProjectRunStats,
  RunEvent,
  RunStatus,
} from '../types';

const ACTIVE_STATUSES: RunStatus[] = [
  'queued',
  'starting',
  'running',
  'waiting_permission',
  'waiting_approval',
];

const POLL_ACTIVE_MS = 3000;
const POLL_IDLE_MS = 15000;

export function useRuns(projectId: string | null) {
  const [runs, setRuns] = useState<AgentRunSummary[]>([]);
  const [stats, setStats] = useState<ProjectRunStats | null>(null);
  const [budget, setBudget] = useState<ProjectRunBudget | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [statusFilter, setStatusFilter] = useState<RunStatus | ''>('');
  const [sourceFilter, setSourceFilter] = useState('');
  const [search, setSearch] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isSavingBudget, setIsSavingBudget] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lastSeqByRun = useRef<Map<string, number>>(new Map());
  const eventsRunIdRef = useRef<string | null>(null);

  const hasActive = useMemo(
    () => runs.some((run) => ACTIVE_STATUSES.includes(run.status)),
    [runs],
  );

  const refresh = useCallback(async (opts?: { silent?: boolean }) => {
    if (!projectId) {
      setRuns([]);
      setStats(null);
      setBudget(null);
      setSelectedId(null);
      setEvents([]);
      return;
    }
    if (!opts?.silent) setIsLoading(true);
    setError(null);
    try {
      const [nextRuns, nextStats, nextBudget] = await Promise.all([
        runsApi.list(projectId, {
          status: statusFilter || undefined,
          source: sourceFilter || undefined,
          limit: 100,
        }),
        runsApi.stats(projectId),
        runsApi.getBudget(projectId),
      ]);
      setRuns(nextRuns);
      setStats(nextStats);
      setBudget(nextBudget);
      setSelectedId((current) =>
        current && nextRuns.some((run) => run.run_id === current)
          ? current
          : nextRuns[0]?.run_id ?? null,
      );
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Failed to load runs');
    } finally {
      if (!opts?.silent) setIsLoading(false);
    }
  }, [projectId, sourceFilter, statusFilter]);

  const loadEvents = useCallback(async (runId: string, opts?: { incremental?: boolean }) => {
    try {
      const afterSeq =
        opts?.incremental && eventsRunIdRef.current === runId
          ? lastSeqByRun.current.get(runId)
          : undefined;
      const next = await runsApi.events(runId, afterSeq);
      if (next.length === 0) {
        if (!opts?.incremental || eventsRunIdRef.current !== runId) {
          setEvents([]);
        }
        return;
      }
      const maxSeq = next.reduce((max, e) => Math.max(max, e.seq ?? 0), afterSeq ?? 0);
      lastSeqByRun.current.set(runId, maxSeq);
      if (opts?.incremental && eventsRunIdRef.current === runId && afterSeq) {
        setEvents((prev) => {
          const seen = new Set(prev.map((e) => e.event_id));
          const merged = [...prev];
          for (const event of next) {
            if (!seen.has(event.event_id)) merged.push(event);
          }
          return merged.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
        });
      } else {
        eventsRunIdRef.current = runId;
        setEvents(next);
      }
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Failed to load run events');
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!projectId) return undefined;
    const interval = hasActive ? POLL_ACTIVE_MS : POLL_IDLE_MS;
    const timer = window.setInterval(() => {
      void refresh({ silent: true });
      if (selectedId) {
        void loadEvents(selectedId, { incremental: true });
      }
    }, interval);
    return () => window.clearInterval(timer);
  }, [hasActive, loadEvents, projectId, refresh, selectedId]);

  useEffect(() => {
    if (selectedId) {
      lastSeqByRun.current.delete(selectedId);
      eventsRunIdRef.current = selectedId;
      void loadEvents(selectedId);
    } else {
      eventsRunIdRef.current = null;
      setEvents([]);
    }
  }, [loadEvents, selectedId]);

  const abort = useCallback(async () => {
    if (!selectedId) return;
    setIsLoading(true);
    setError(null);
    try {
      await runsApi.abort(selectedId);
      await refresh();
      await loadEvents(selectedId);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Failed to abort run');
    } finally {
      setIsLoading(false);
    }
  }, [loadEvents, refresh, selectedId]);

  const saveBudget = useCallback(
    async (update: BudgetUpdate) => {
      if (!projectId) return;
      setIsSavingBudget(true);
      setError(null);
      try {
        const next = await runsApi.putBudget(projectId, update);
        setBudget(next);
        const nextStats = await runsApi.stats(projectId);
        setStats(nextStats);
      } catch (requestError) {
        setError(requestError instanceof Error ? requestError.message : 'Failed to save budget');
      } finally {
        setIsSavingBudget(false);
      }
    },
    [projectId],
  );

  const filteredRuns = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return runs;
    return runs.filter((run) => {
      const haystack = [
        run.title,
        run.run_id,
        run.source,
        run.provider,
        run.model,
        run.effort,
        run.status,
        run.error_summary,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return haystack.includes(q);
    });
  }, [runs, search]);

  return {
    runs: filteredRuns,
    allRuns: runs,
    stats,
    budget,
    selectedId,
    selected: filteredRuns.find((run) => run.run_id === selectedId) ?? runs.find((run) => run.run_id === selectedId) ?? null,
    events,
    isLoading,
    isSavingBudget,
    error,
    statusFilter,
    sourceFilter,
    search,
    setStatusFilter,
    setSourceFilter,
    setSearch,
    refresh,
    select: setSelectedId,
    abort,
    saveBudget,
  };
}
