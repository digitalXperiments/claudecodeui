import { useState, useEffect, useRef, useCallback } from 'react';

import { fetchSessionLiveUsage, fetchSessionTokenUsage } from '../../utils/sessionRequests';
import { runAfterSessionPaint } from '../../utils/sessionPaintGate';
import type { SessionActivity } from '../../hooks/useSessionProtection';
import type {
  SessionStatusBarTelemetry,
  SessionSpendTelemetry,
  ContextPressureTelemetry,
  SessionHeartbeatTelemetry,
  HeartbeatPhase,
} from './types';
import { computeContextPressure, evaluateStallState } from './statusBarHelpers';


/**
 * Applies `patch` to the heartbeat, returning `prev` itself when nothing
 * changes so React bails out. Raw stream events arrive many times a second;
 * each used to allocate a new heartbeat object and re-render the status bar
 * even though phase/idle/stalled were already current. Time-based fields are
 * published by the 1s tick.
 */
function patchHeartbeat(
  prev: SessionHeartbeatTelemetry,
  patch: Partial<SessionHeartbeatTelemetry>,
): SessionHeartbeatTelemetry {
  for (const key of Object.keys(patch) as Array<keyof SessionHeartbeatTelemetry>) {
    if (!Object.is(prev[key], patch[key])) {
      return { ...prev, ...patch };
    }
  }
  return prev;
}

function sameHeartbeat(left: SessionHeartbeatTelemetry, right: SessionHeartbeatTelemetry): boolean {
  for (const key of Object.keys(right) as Array<keyof SessionHeartbeatTelemetry>) {
    if (!Object.is(left[key], right[key])) return false;
  }
  return Object.keys(left).length === Object.keys(right).length;
}

export interface UseSessionStatusBarTelemetryOptions {
  sessionId: string | null;
  activity: SessionActivity | null;
  subscribe?: (callback: (data: unknown) => void) => () => void;
  sendMessage?: (data: unknown) => void;
  stallThresholdSeconds?: number;
  projectId?: string | null;
}

const DEFAULT_STALL_THRESHOLD_SEC = 18;

function readNumber(val: unknown): number {
  const n = Number(val);
  return Number.isFinite(n) ? n : 0;
}

export interface CachedSessionTelemetry {
  spend: SessionSpendTelemetry;
  context: ContextPressureTelemetry;
  lastUpdated: number;
}

// Module-level in-memory cache across conversation switches so switching back & forth is instantaneous
const sessionTelemetryCache = new Map<string, CachedSessionTelemetry>();

export function getCachedSessionTelemetry(sessionId: string): CachedSessionTelemetry | undefined {
  return sessionTelemetryCache.get(sessionId);
}

export function clearSessionTelemetryCache(): void {
  sessionTelemetryCache.clear();
}

const INITIAL_SPEND: SessionSpendTelemetry = {
  spentUsd: 0,
  lastTurnCostUsd: 0,
  burnRateUsdPerMin: 0,
  runCount: 0,
  totalTokens: 0,
  verdict: null,
  isLoading: false,
};

const INITIAL_CONTEXT: ContextPressureTelemetry = {
  usedTokens: 0,
  contextWindow: 0,
  percent: null,
};

export function useSessionStatusBarTelemetry({
  sessionId,
  activity,
  subscribe,
  sendMessage: _sendMessage,
  stallThresholdSeconds = DEFAULT_STALL_THRESHOLD_SEC,
  projectId,
}: UseSessionStatusBarTelemetryOptions): SessionStatusBarTelemetry {
  const currentSessionIdRef = useRef<string | null>(sessionId);
  currentSessionIdRef.current = sessionId;

  const [spend, setSpend] = useState<SessionSpendTelemetry>(() => {
    if (sessionId && sessionTelemetryCache.has(sessionId)) {
      return sessionTelemetryCache.get(sessionId)!.spend;
    }
    return { ...INITIAL_SPEND, isLoading: Boolean(sessionId) };
  });

  const [context, setContext] = useState<ContextPressureTelemetry>(() => {
    if (sessionId && sessionTelemetryCache.has(sessionId)) {
      return sessionTelemetryCache.get(sessionId)!.context;
    }
    return INITIAL_CONTEXT;
  });

  const [heartbeat, setHeartbeat] = useState<SessionHeartbeatTelemetry>(() => {
    const isProcessing = Boolean(activity);
    const initialPhase: HeartbeatPhase = isProcessing
      ? (activity?.statusText ? 'tool' : 'thinking')
      : 'idle';
    return {
      phase: initialPhase,
      toolName: null,
      statusText: activity?.statusText ?? null,
      elapsedSeconds: activity?.startedAt ? Math.max(0, Math.floor((Date.now() - activity.startedAt) / 1000)) : 0,
      idleSeconds: 0,
      isStalled: false,
      canInterrupt: Boolean(activity?.canInterrupt),
      lastRunDurationSeconds: null,
    };
  });

  const lastActivityAtRef = useRef<number>(Date.now());
  const activeToolNameRef = useRef<string | null>(null);
  const phaseRef = useRef<HeartbeatPhase>(activity ? (activity.statusText ? 'tool' : 'thinking') : 'idle');
  const runStartRef = useRef<number | null>(activity?.startedAt || null);
  const lastFinishedDurationRef = useRef<number | null>(null);

  // Synchronously adjust state during render when sessionId prop changes.
  // This guarantees ZERO delay and ZERO display of previous conversation data when switching conversations.
  const [prevSessionId, setPrevSessionId] = useState<string | null>(sessionId);
  if (sessionId !== prevSessionId) {
    setPrevSessionId(sessionId);

    const cached = sessionId ? sessionTelemetryCache.get(sessionId) : null;
    if (cached) {
      setSpend(cached.spend);
      setContext(cached.context);
    } else {
      setSpend({
        ...INITIAL_SPEND,
        isLoading: Boolean(sessionId),
      });
      setContext(INITIAL_CONTEXT);
    }

    const now = Date.now();
    lastActivityAtRef.current = now;
    activeToolNameRef.current = null;
    phaseRef.current = activity ? (activity.statusText ? 'tool' : 'thinking') : 'idle';
    runStartRef.current = activity?.startedAt || null;
    lastFinishedDurationRef.current = null;

    setHeartbeat({
      phase: activity ? (activity.statusText ? 'tool' : 'thinking') : 'idle',
      toolName: null,
      statusText: activity?.statusText ?? null,
      elapsedSeconds: activity?.startedAt ? Math.max(0, Math.floor((now - activity.startedAt) / 1000)) : 0,
      idleSeconds: 0,
      isStalled: false,
      canInterrupt: Boolean(activity?.canInterrupt),
      lastRunDurationSeconds: null,
    });
  }

  // 1. Fetch live usage & spend from server
  const fetchLiveUsage = useCallback(async (options: { force?: boolean } = {}) => {
    const targetSessionId = currentSessionIdRef.current;
    if (!targetSessionId) {
      setSpend(INITIAL_SPEND);
      return;
    }

    try {
      // Shared with LiveSpendMeter's identical poll (one request per session).
      const res = await fetchSessionLiveUsage<Record<string, any>>(targetSessionId, options);
      if (!res.ok) return;
      const data = res.data;

      // Guard: drop stale response if user switched to another session while request was in-flight
      if (currentSessionIdRef.current !== targetSessionId) return;

      if (data?.success && data?.usage) {
        const newSpend: SessionSpendTelemetry = {
          spentUsd: readNumber(data.usage.costUsd),
          lastTurnCostUsd: readNumber(data.usage.lastRunCostUsd),
          burnRateUsdPerMin: readNumber(data.usage.burnRateUsdPerMin),
          runCount: readNumber(data.usage.runCount),
          totalTokens: readNumber(data.usage.tokens),
          verdict: data.verdict ?? null,
          isLoading: false,
        };

        setSpend(newSpend);

        let newContext: ContextPressureTelemetry | null = null;
        if (data.usage.context) {
          const ctxData = data.usage.context;
          newContext = {
            usedTokens: readNumber(ctxData.usedTokens),
            contextWindow: readNumber(ctxData.contextWindow),
            percent: ctxData.percent != null ? readNumber(ctxData.percent) : null,
            inputTokens: ctxData.inputTokens != null ? readNumber(ctxData.inputTokens) : undefined,
            outputTokens: ctxData.outputTokens != null ? readNumber(ctxData.outputTokens) : undefined,
            model: typeof ctxData.model === 'string' ? ctxData.model : undefined,
          };
          setContext(prev => ({
            ...prev,
            ...newContext,
          }));
        }

        // Cache result for instant future switching
        const prevCached = sessionTelemetryCache.get(targetSessionId);
        sessionTelemetryCache.set(targetSessionId, {
          spend: newSpend,
          context: newContext ?? prevCached?.context ?? INITIAL_CONTEXT,
          lastUpdated: Date.now(),
        });
      }
    } catch {
      // Non-fatal telemetry polling
    }
  }, []);

  // Periodic polling for live usage. The first fetch (and the interval) wait
  // until the transcript has painted so they don't compete with it.
  useEffect(() => {
    if (!sessionId) {
      void fetchLiveUsage();
      return;
    }

    let interval: ReturnType<typeof setInterval> | null = null;
    const cancelDeferred = runAfterSessionPaint(() => {
      void fetchLiveUsage();
      interval = setInterval(() => { void fetchLiveUsage(); }, 15000);
    });
    return () => {
      cancelDeferred();
      if (interval) clearInterval(interval);
    };
  }, [sessionId, fetchLiveUsage]);

  // 2. Fetch session token usage directly on session switch or mount
  useEffect(() => {
    if (!sessionId) return;

    let isSubscribed = true;
    const targetSessionId = sessionId;

    const loadSessionTokenUsage = async () => {
      try {
        // Shared with useChatSessionState's identical request.
        const res = await fetchSessionTokenUsage(targetSessionId, projectId);
        if (!res.ok || !isSubscribed || currentSessionIdRef.current !== targetSessionId) return;
        const data = res.data;
        if (data && typeof data === 'object' && isSubscribed && currentSessionIdRef.current === targetSessionId) {
          const computed = computeContextPressure(data as Record<string, unknown>);
          if (computed.usedTokens > 0 || (computed.percent != null && computed.percent > 0) || computed.contextWindow > 0) {
            setContext(computed);

            // Update in-memory session cache
            const prev = sessionTelemetryCache.get(targetSessionId);
            sessionTelemetryCache.set(targetSessionId, {
              spend: prev?.spend ?? INITIAL_SPEND,
              context: computed,
              lastUpdated: Date.now(),
            });
          }
        }
      } catch {
        // Non-fatal
      }
    };

    const cancelDeferred = runAfterSessionPaint(() => { void loadSessionTokenUsage(); });
    return () => {
      isSubscribed = false;
      cancelDeferred();
    };
  }, [sessionId, projectId]);

  // Track activity transitions from activity prop immediately (instant reaction, no 1-second delay)
  useEffect(() => {
    const now = Date.now();
    if (activity) {
      if (!runStartRef.current) {
        runStartRef.current = activity.startedAt || now;
      }
      lastActivityAtRef.current = now;
      phaseRef.current = activity.statusText ? 'tool' : 'thinking';

      setHeartbeat({
        phase: phaseRef.current,
        toolName: activeToolNameRef.current,
        statusText: activity.statusText ?? null,
        elapsedSeconds: Math.max(0, Math.floor((now - (runStartRef.current || now)) / 1000)),
        idleSeconds: 0,
        isStalled: false,
        canInterrupt: Boolean(activity.canInterrupt),
        lastRunDurationSeconds: null,
      });
    } else {
      if (runStartRef.current) {
        lastFinishedDurationRef.current = Math.max(1, Math.round((now - runStartRef.current) / 1000));
        runStartRef.current = null;
      }
      phaseRef.current = 'idle';
      activeToolNameRef.current = null;

      setHeartbeat(prev => ({
        phase: 'idle',
        toolName: null,
        statusText: null,
        elapsedSeconds: 0,
        idleSeconds: 0,
        isStalled: false,
        canInterrupt: false,
        lastRunDurationSeconds: lastFinishedDurationRef.current ?? prev.lastRunDurationSeconds,
      }));
    }
  }, [activity]);

  // 3. Real-time WebSocket event listener
  useEffect(() => {
    if (!subscribe) return;

    const unsubscribe = subscribe((event: unknown) => {
      if (!event || typeof event !== 'object') return;
      const msg = event as Record<string, unknown>;
      const eventSessionId = (msg.sessionId as string) || (msg.appSessionId as string) || null;

      // Real-time token budget update
      if (msg.kind === 'status' && msg.text === 'token_budget' && msg.tokenBudget && typeof msg.tokenBudget === 'object') {
        const computed = computeContextPressure(msg.tokenBudget as Record<string, unknown>);
        if (eventSessionId) {
          const prev = sessionTelemetryCache.get(eventSessionId);
          sessionTelemetryCache.set(eventSessionId, {
            spend: prev?.spend ?? INITIAL_SPEND,
            context: computed,
            lastUpdated: Date.now(),
          });
        }
        if (!eventSessionId || eventSessionId === currentSessionIdRef.current) {
          setContext(computed);
        }
      }

      // Filter events not affecting the active session for heartbeat
      if (currentSessionIdRef.current && eventSessionId && eventSessionId !== currentSessionIdRef.current) {
        return;
      }

      const now = Date.now();

      switch (msg.kind) {
        case 'status': {
          if (msg.text && typeof msg.text === 'string' && msg.text !== 'token_budget') {
            lastActivityAtRef.current = now;
          }
          break;
        }

        case 'tool_use': {
          lastActivityAtRef.current = now;
          phaseRef.current = 'tool';
          const name = typeof msg.toolName === 'string' ? msg.toolName : null;
          activeToolNameRef.current = name;
          setHeartbeat(prev => patchHeartbeat(prev, {
            phase: 'tool',
            toolName: name,
            idleSeconds: 0,
            isStalled: false,
          }));
          break;
        }

        case 'tool_result': {
          lastActivityAtRef.current = now;
          phaseRef.current = 'tool';
          setHeartbeat(prev => patchHeartbeat(prev, {
            idleSeconds: 0,
            isStalled: false,
          }));
          break;
        }

        case 'thinking': {
          lastActivityAtRef.current = now;
          phaseRef.current = 'thinking';
          setHeartbeat(prev => patchHeartbeat(prev, {
            phase: 'thinking',
            idleSeconds: 0,
            isStalled: false,
          }));
          break;
        }

        case 'stream_delta': {
          lastActivityAtRef.current = now;
          phaseRef.current = 'streaming';
          setHeartbeat(prev => patchHeartbeat(prev, {
            phase: 'streaming',
            idleSeconds: 0,
            isStalled: false,
          }));
          break;
        }

        case 'complete': {
          lastActivityAtRef.current = now;
          phaseRef.current = 'idle';
          activeToolNameRef.current = null;
          if (runStartRef.current) {
            lastFinishedDurationRef.current = Math.max(1, Math.round((now - runStartRef.current) / 1000));
            runStartRef.current = null;
          }
          setHeartbeat({
            phase: 'idle',
            toolName: null,
            statusText: null,
            elapsedSeconds: 0,
            idleSeconds: 0,
            isStalled: false,
            canInterrupt: false,
            lastRunDurationSeconds: lastFinishedDurationRef.current,
          });
          // Fetch updated usage right after turn completion
          setTimeout(() => { void fetchLiveUsage({ force: true }); }, 200);
          break;
        }

        default:
          break;
      }
    });

    return unsubscribe;
  }, [subscribe, fetchLiveUsage]);

  // 4. Heartbeat & stall evaluation tick (every 1 second)
  useEffect(() => {
    const updateTick = () => {
      const now = Date.now();
      const isProcessing = Boolean(activity);

      if (!isProcessing) {
        setHeartbeat(prev => {
          if (prev.phase === 'idle' && prev.elapsedSeconds === 0 && !prev.isStalled) {
            return prev;
          }
          return {
            phase: 'idle',
            toolName: null,
            statusText: null,
            elapsedSeconds: 0,
            idleSeconds: 0,
            isStalled: false,
            canInterrupt: false,
            lastRunDurationSeconds: lastFinishedDurationRef.current,
          };
        });
        return;
      }

      const startTime = runStartRef.current || activity?.startedAt || now;
      const elapsedSeconds = Math.max(0, Math.floor((now - startTime) / 1000));
      const idleSeconds = Math.max(0, Math.floor((now - lastActivityAtRef.current) / 1000));

      const { isStalled, phase: evalPhase } = evaluateStallState({
        isProcessing,
        elapsedSeconds,
        idleSeconds,
        thresholdSeconds: stallThresholdSeconds,
        currentPhase: phaseRef.current,
      });

      const next: SessionHeartbeatTelemetry = {
        phase: evalPhase,
        toolName: activeToolNameRef.current,
        statusText: activity?.statusText ?? null,
        elapsedSeconds,
        idleSeconds,
        isStalled,
        canInterrupt: Boolean(activity?.canInterrupt),
        lastRunDurationSeconds: null,
      };
      setHeartbeat(prev => (sameHeartbeat(prev, next) ? prev : next));
    };

    const interval = setInterval(updateTick, 1000);
    return () => clearInterval(interval);
  }, [activity, stallThresholdSeconds]);

  const refresh = useCallback(() => fetchLiveUsage({ force: true }), [fetchLiveUsage]);

  const abort = useCallback(() => {
    // No-op placeholder
  }, []);

  return {
    spend,
    context,
    heartbeat,
    refresh,
    abort,
  };
}
