import { useCallback, useEffect, useReducer, useRef, useState } from 'react';

import { useWebSocket } from '../../../contexts/WebSocketContext';
import { botRuntimeApi } from '../api/botRuntimeApi';
import type { BotRuntimeStatus } from '../types/botRuntime';

import {
  createRuntimeState,
  isRuntimeEventKind,
  mergeSections,
  routeRuntimeEvent,
  runtimeEventKind,
  runtimeReducer,
  type RuntimeSection,
  type RuntimeSectionData,
} from './botRuntimeReducers';

const REFRESH_DEBOUNCE_MS = 150;
const STATUS_POLL_MS = 30_000;

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : 'Request failed';
}

const FETCHERS: { [S in RuntimeSection]: (botId: string) => Promise<RuntimeSectionData[S]> } = {
  goals: (botId) => botRuntimeApi.goals.list(botId),
  commitments: (botId) => botRuntimeApi.commitments.list(botId),
  episodes: (botId) => botRuntimeApi.episodes.list(botId, { limit: 50 }),
  events: (botId) => botRuntimeApi.events.list(botId, 50),
  thread: (botId) => botRuntimeApi.thread.list(botId, { limit: 100 }),
  proposals: (botId) => botRuntimeApi.learning.proposals(botId),
  skills: (botId) => botRuntimeApi.skills.list(botId),
  triggers: (botId) => botRuntimeApi.triggers.list(botId),
  gateDecisions: (botId) => botRuntimeApi.gate.decisions(botId, { limit: 50 }),
  budget: (botId) => botRuntimeApi.budget.status(botId),
};

export type UseBotRuntimeOptions = {
  /** Sections to load as soon as the bot is selected; others load on demand via `load`/`refresh`. */
  sections?: RuntimeSection[];
};

/**
 * Per-bot runtime data, loaded lazily by section and kept fresh from websocket events
 * (bot_event_received, bot_episode_updated, bot_gate_decision, bot_thread_message,
 * bot_proposal_updated, bot_goal_updated). Thread messages are appended straight from the frame;
 * the other events trigger a debounced, targeted refetch of only the sections that were loaded.
 */
export function useBotRuntime(botId: string | null, options: UseBotRuntimeOptions = {}) {
  const { subscribe } = useWebSocket();
  const [state, dispatch] = useReducer(runtimeReducer, botId, createRuntimeState);
  const botIdRef = useRef(botId);
  const stateRef = useRef(state);
  const requestSeq = useRef<Partial<Record<RuntimeSection, number>>>({});
  const pendingRef = useRef<RuntimeSection[]>([]);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  botIdRef.current = botId;
  stateRef.current = state;

  const sectionsKey = (options.sections ?? []).join(',');

  const fetchSection = useCallback(async (section: RuntimeSection) => {
    const id = botIdRef.current;
    if (!id) return;
    const seq = (requestSeq.current[section] ?? 0) + 1;
    requestSeq.current[section] = seq;
    dispatch({ type: 'start', botId: id, section });
    try {
      const data = await FETCHERS[section](id);
      // A newer request for this section superseded this one; the reducer drops bot switches.
      if (requestSeq.current[section] !== seq) return;
      dispatch({ type: 'loaded', botId: id, section, data });
    } catch (error) {
      if (requestSeq.current[section] !== seq) return;
      dispatch({ type: 'failed', botId: id, section, error: errorMessage(error) });
    }
  }, []);

  const refresh = useCallback((section: RuntimeSection) => fetchSection(section), [fetchSection]);

  /** Load a section once; a no-op while it is loading or already loaded. */
  const load = useCallback((section: RuntimeSection) => {
    const current = stateRef.current.load[section].state;
    if (current === 'loading' || current === 'ready') return Promise.resolve();
    return fetchSection(section);
  }, [fetchSection]);

  const refreshAll = useCallback(() => {
    const loaded = (Object.keys(stateRef.current.load) as RuntimeSection[]).filter(
      (section) => stateRef.current.load[section].state !== 'idle',
    );
    return Promise.all(loaded.map((section) => fetchSection(section))).then(() => undefined);
  }, [fetchSection]);

  const scheduleRefresh = useCallback((sections: RuntimeSection[]) => {
    const loaded = sections.filter((section) => stateRef.current.load[section].state !== 'idle');
    if (loaded.length === 0) return;
    pendingRef.current = mergeSections(pendingRef.current, loaded);
    if (timerRef.current) return;
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      const batch = pendingRef.current;
      pendingRef.current = [];
      for (const section of batch) void fetchSection(section);
    }, REFRESH_DEBOUNCE_MS);
  }, [fetchSection]);

  // Switching bots resets the store and drops anything still queued for the previous one.
  useEffect(() => {
    dispatch({ type: 'reset', botId });
    pendingRef.current = [];
    requestSeq.current = {};
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, [botId]);

  useEffect(() => {
    if (!botId) return;
    // The reset above has not been applied to stateRef yet; fetchers key off botIdRef, so this is safe.
    for (const section of sectionsKey ? (sectionsKey.split(',') as RuntimeSection[]) : []) void fetchSection(section);
  }, [botId, sectionsKey, fetchSection]);

  useEffect(() => subscribe((frame) => {
    const kind = runtimeEventKind(frame);
    if (kind === 'websocket_reconnected') {
      void refreshAll();
      return;
    }
    const effect = routeRuntimeEvent(frame, botIdRef.current);
    if (!effect) return;
    if (effect.type === 'thread_message') {
      const id = botIdRef.current;
      // Only append into a thread the operator has opened; otherwise the first load fetches it.
      if (id && stateRef.current.load.thread.state !== 'idle') dispatch({ type: 'thread_message', botId: id, message: effect.message });
    } else {
      scheduleRefresh(effect.sections);
    }
  }), [refreshAll, scheduleRefresh, subscribe]);

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  /** Apply a local change (e.g. after a successful create) without waiting for the next refetch. */
  const patchSection = useCallback(<S extends RuntimeSection>(section: S, update: (current: RuntimeSectionData[S]) => RuntimeSectionData[S]) => {
    const id = botIdRef.current;
    if (!id) return;
    dispatch({
      type: 'patch',
      botId: id,
      section,
      update: update as unknown as (current: RuntimeSectionData[RuntimeSection]) => RuntimeSectionData[RuntimeSection],
    });
  }, []);

  return {
    botId,
    ...state.data,
    sectionState: state.load,
    isLoading: (section: RuntimeSection) => state.load[section].state === 'loading',
    error: (section: RuntimeSection) => state.load[section].error,
    load,
    refresh,
    refreshAll,
    patchSection,
  };
}

export type BotRuntimeHandle = ReturnType<typeof useBotRuntime>;

/**
 * Global runtime status (enabled flag, running bots, queue depth, leases), polled every 30s and
 * refreshed when any bot runtime event arrives. Pass `enabled: false` to stay idle.
 */
export function useBotRuntimeStatus(options: { enabled?: boolean } = {}) {
  const enabled = options.enabled ?? true;
  const { subscribe } = useWebSocket();
  const [status, setStatus] = useState<BotRuntimeStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const seqRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(async () => {
    const seq = ++seqRef.current;
    setLoading(true);
    try {
      const next = await botRuntimeApi.runtime.status();
      if (seqRef.current !== seq) return;
      setStatus(next);
      setError(null);
    } catch (caught) {
      if (seqRef.current !== seq) return;
      setError(errorMessage(caught));
    } finally {
      if (seqRef.current === seq) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!enabled) return undefined;
    void refresh();
    const interval = setInterval(() => void refresh(), STATUS_POLL_MS);
    return () => clearInterval(interval);
  }, [enabled, refresh]);

  useEffect(() => {
    if (!enabled) return undefined;
    const unsubscribe = subscribe((frame) => {
      const kind = runtimeEventKind(frame);
      if (kind !== 'websocket_reconnected' && !isRuntimeEventKind(kind)) return;
      if (timerRef.current) return;
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        void refresh();
      }, REFRESH_DEBOUNCE_MS);
    });
    return () => {
      unsubscribe();
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [enabled, refresh, subscribe]);

  return { status, error, loading, refresh };
}
