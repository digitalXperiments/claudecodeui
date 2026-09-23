import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';

import { authenticatedFetch } from '../../../utils/api';
import type { MarkSessionIdle, SessionActivityMap } from '../../../hooks/useSessionProtection';
import type { Project, ProjectSession, LLMProvider } from '../../../types/app';
import type {
  LatestHistoryRefreshResult,
  NormalizedMessage,
  SessionSlot,
  SessionStore,
} from '../../../stores/useSessionStore';
import { SESSION_MESSAGES_PAGE_SIZE } from '../../../stores/sessionMessagePagination';
import type { ChatMessage } from '../types/types';
import {
  createMessageHistoryRefreshCoordinator,
  type MessageHistoryRefreshCoordinator,
} from '../utils/messageHistoryRefreshCoordinator';
import { createCachedDiffCalculator, type DiffCalculator } from '../utils/messageTransforms';
import { createTranscriptScrollController } from '../utils/transcriptScrollController';
import {
  createHistoryLoadRunner,
  type HistoryLoadAttemptOutcome,
  type HistoryLoadResult,
} from '../utils/sessionHistoryLoadRunner';

import { normalizedToChatMessages } from './useChatMessages';

const EMPTY_MESSAGES: NormalizedMessage[] = [];
/**
 * Backoff for re-reading the persisted tail while it is not final yet: the
 * server marked it `historyRefreshing` (Antigravity background replay), the
 * request failed/was pending, or a just-completed run's live rows are not on
 * disk yet. Each entry is the wait before the next attempt.
 */
const HISTORY_FOLLOW_UP_DELAYS_MS = [1000, 2000, 4000, 8000, 16000, 30000];
/** A finished run's transcript usually lands within a few seconds. */
const RUN_COMPLETE_FOLLOW_UP_ATTEMPTS = 4;
const PERSISTABLE_LIVE_KINDS = new Set<NormalizedMessage['kind']>(['text', 'tool_use', 'thinking', 'stream_delta']);

/** Live rows the transcript should eventually own (prune removes them). */
function hasUnpersistedLiveRows(slot: SessionSlot | undefined): boolean {
  return Boolean(slot?.realtimeMessages.some((message) => PERSISTABLE_LIVE_KINDS.has(message.kind)));
}
/**
 * An empty first page for a session the index says has messages is retried
 * this many times before being accepted as a genuinely empty transcript.
 */
const SUSPECT_EMPTY_RETRIES = 2;

export type HistoryLoadError = Exclude<HistoryLoadResult, 'applied'>;

interface UseChatSessionStateArgs {
  isActive?: boolean;
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
  ws: WebSocket | null;
  sendMessage: (message: unknown) => boolean;
  externalMessageUpdate?: number;
  newSessionTrigger?: number;
  processingSessions?: SessionActivityMap;
  onSessionIdle?: MarkSessionIdle;
  resetStreamingState: () => void;
  /** When each session's `chat.subscribe` was last sent; guards stale idle acks. */
  statusCheckSentAtRef: MutableRefObject<Map<string, number>>;
  /** Highest live seq observed per session; sent as `lastSeq` on subscribe. */
  lastSeqRef: MutableRefObject<Map<string, number>>;
  sessionStore: SessionStore;
}

/* ------------------------------------------------------------------ */
/*  Helper: Convert a ChatMessage to a NormalizedMessage for the store */
/* ------------------------------------------------------------------ */

function chatMessageToNormalized(
  msg: ChatMessage,
  sessionId: string,
  provider: LLMProvider,
): NormalizedMessage | null {
  const id = `local_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const ts = msg.timestamp instanceof Date
    ? msg.timestamp.toISOString()
    : typeof msg.timestamp === 'number'
      ? new Date(msg.timestamp).toISOString()
      : String(msg.timestamp);
  const base = { id, sessionId, timestamp: ts, provider };

  if (msg.isToolUse) {
    return {
      ...base,
      kind: 'tool_use',
      toolName: msg.toolName,
      toolInput: msg.toolInput,
      toolId: msg.toolId || id,
    } as NormalizedMessage;
  }
  if (msg.isThinking) {
    return { ...base, kind: 'thinking', content: msg.content || '' } as NormalizedMessage;
  }
  if (msg.isInteractivePrompt) {
    return { ...base, kind: 'interactive_prompt', content: msg.content || '' } as NormalizedMessage;
  }
  if ((msg as any).isTaskNotification) {
    return {
      ...base,
      kind: 'task_notification',
      status: (msg as any).taskStatus || 'completed',
      summary: msg.content || '',
    } as NormalizedMessage;
  }
  if (msg.type === 'error') {
    return { ...base, kind: 'error', content: msg.content || '' } as NormalizedMessage;
  }
  return {
    ...base,
    kind: 'text',
    role: msg.type === 'user' ? 'user' : 'assistant',
    content: msg.content || '',
    // Keep attachment references on the local echo so the user bubble shows
    // its images immediately, before the server-backed copy replaces it.
    images: Array.isArray(msg.images) && msg.images.length > 0 ? msg.images : undefined,
  } as NormalizedMessage;
}

/* ------------------------------------------------------------------ */
/*  Hook                                                              */
/* ------------------------------------------------------------------ */

export function useChatSessionState({
  isActive = true,
  selectedProject,
  selectedSession,
  ws,
  sendMessage,
  externalMessageUpdate,
  newSessionTrigger,
  processingSessions,
  onSessionIdle,
  resetStreamingState,
  statusCheckSentAtRef,
  lastSeqRef,
  sessionStore,
}: UseChatSessionStateArgs) {
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(selectedSession?.id || null);
  const [isLoadingSessionMessages, setIsLoadingSessionMessages] = useState(false);
  const [historyLoadError, setHistoryLoadError] = useState<HistoryLoadError | null>(null);
  const historyLoadRunnerRef = useRef<ReturnType<typeof createHistoryLoadRunner> | null>(null);
  if (!historyLoadRunnerRef.current) historyLoadRunnerRef.current = createHistoryLoadRunner();
  const historyRefetchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [isLoadingMoreMessages, setIsLoadingMoreMessages] = useState(false);
  const [hasMoreMessages, setHasMoreMessages] = useState(false);
  const [totalMessages, setTotalMessages] = useState(0);
  const [isUserScrolledUp, updateIsUserScrolledUp] = useState(false);
  const scrollControllerRef = useRef<ReturnType<typeof createTranscriptScrollController> | null>(null);
  const setIsUserScrolledUp = useCallback((reading: boolean) => {
    scrollControllerRef.current?.setReading(reading);
    updateIsUserScrolledUp(reading);
  }, []);
  const [tokenBudget, setTokenBudget] = useState<Record<string, unknown> | null>(null);
  const [allMessagesLoaded, setAllMessagesLoaded] = useState(false);
  const [isLoadingAllMessages, setIsLoadingAllMessages] = useState(false);
  const [loadAllJustFinished, setLoadAllJustFinished] = useState(false);
  const [showLoadAllOverlay, setShowLoadAllOverlay] = useState(false);
  const [viewHiddenCount, setViewHiddenCount] = useState(0);

  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const wasNearTopRef = useRef(false);
  const [searchTarget, setSearchTarget] = useState<{ timestamp?: string; uuid?: string; snippet?: string } | null>(null);
  const searchScrollActiveRef = useRef(false);
  const isLoadingMoreRef = useRef(false);
  const allMessagesLoadedRef = useRef(false);
  const topLoadLockRef = useRef(false);
  const messagesOffsetRef = useRef(0);
  const loadAllFinishedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadAllOverlayTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastLoadedSessionKeyRef = useRef<string | null>(null);
  /**
   * Last session we successfully issued `chat.subscribe` for on the current
   * websocket. Grok (and other file-backed providers) emit frequent
   * `session_upserted` events that rebuild `selectedProject`; those must not
   * re-subscribe or the activity indicator / permissions thrash every write.
   */
  const lastSubscribedSessionRef = useRef<{ sessionId: string; ws: WebSocket | null } | null>(null);
  /**
   * Tracks the last processed value from `useProjectsState.newSessionTrigger`.
   *
   * The trigger itself is intentionally increment-only and routed via:
   * useProjectsState -> AppContent -> MainContent -> ChatInterface -> this hook.
   * We compare values to ensure each explicit New Session click runs exactly one
   * reset pass in this local chat state domain.
   */
  const previousNewSessionTriggerRef = useRef(newSessionTrigger ?? 0);

  const createDiff = useMemo<DiffCalculator>(() => createCachedDiffCalculator(), []);

  useEffect(() => {
    const trigger = newSessionTrigger ?? 0;
    if (trigger === previousNewSessionTriggerRef.current) {
      return;
    }
    previousNewSessionTriggerRef.current = trigger;

    /**
     * Consumer-side reset for explicit New Session intent.
     *
     * Why this is essential:
     * - Chat keeps local state that is not fully derived from `selectedSession`:
     *   `currentSessionId`, `pendingUserMessage`, streaming/status flags, message
     *   pagination/scroll bookkeeping, and provider-specific sessionStorage keys.
     * - If the user clicks New Session while already on the same route with no
     *   selected session, parent state updates can be idempotent and this local
     *   state would otherwise persist, making the click appear to "do nothing".
     *
     * What this reset guarantees:
     * - A deterministic clean draft state on every New Session click.
     * - No dependence on route/tab/session-object identity changes.
     * - No coupling to unrelated external update signals.
     */
    resetStreamingState();
    setIsUserScrolledUp(false);
    setCurrentSessionId(null);
    setPendingUserMessage(null);
    messagesOffsetRef.current = 0;
    setHasMoreMessages(false);
    setTotalMessages(0);
    
    setTokenBudget(null);
    setAllMessagesLoaded(false);
    allMessagesLoadedRef.current = false;
    setIsLoadingAllMessages(false);
    setLoadAllJustFinished(false);
    setShowLoadAllOverlay(false);
    setViewHiddenCount(0);
    setSearchTarget(null);
    wasNearTopRef.current = false;
    searchScrollActiveRef.current = false;
    topLoadLockRef.current = false;
    lastLoadedSessionKeyRef.current = null;
    lastSubscribedSessionRef.current = null;
    historyLoadRunnerRef.current?.cancel();
    setIsLoadingSessionMessages(false);
    setHistoryLoadError(null);

    if (loadAllOverlayTimerRef.current) {
      clearTimeout(loadAllOverlayTimerRef.current);
      loadAllOverlayTimerRef.current = null;
    }
    if (loadAllFinishedTimerRef.current) {
      clearTimeout(loadAllFinishedTimerRef.current);
      loadAllFinishedTimerRef.current = null;
    }
  }, [newSessionTrigger, onSessionIdle, resetStreamingState, setIsUserScrolledUp]);

  /* ---------------------------------------------------------------- */
  /*  Derive processing state for the viewed session                  */
  /* ---------------------------------------------------------------- */

  const activeSessionId = selectedSession?.id || currentSessionId || null;

  // The activity indicator always reflects the latest status of the session
  // being viewed — never stale local UI state from the last time it was
  // open. Session ids are concrete before any send, so no pending
  // placeholder entry exists anymore.
  const sessionActivity = (activeSessionId && processingSessions?.get(activeSessionId)) || null;
  // Shell activity is shown on the composer badge, but it is not a Chatbar
  // run: treating it as `isProcessing` blocked history reloads and locked
  // the pane on an empty transcript while the TUI was still open.
  const isProcessing = sessionActivity !== null && sessionActivity.source !== 'shell';
  const canAbortSession = isProcessing && sessionActivity.canInterrupt;

  // Ref mirror so effects can read the latest map without re-running on
  // every activity transition.
  const processingSessionsRef = useRef(processingSessions);
  processingSessionsRef.current = processingSessions;

  // Live rows are only pruned by server writes, which happen for the viewed
  // session. Bound a background session's rows once it has no run in flight:
  // when its run settles off-screen, or when the user navigates away from it.
  const trimCandidatesRef = useRef<{ processing: Set<string>; active: string | null }>({
    processing: new Set(),
    active: null,
  });
  useEffect(() => {
    const previous = trimCandidatesRef.current;
    const processingNow = new Set(processingSessions?.keys() ?? []);
    const candidates = new Set<string>();
    for (const sessionId of previous.processing) {
      if (!processingNow.has(sessionId)) candidates.add(sessionId);
    }
    if (previous.active && previous.active !== activeSessionId) candidates.add(previous.active);
    trimCandidatesRef.current = { processing: processingNow, active: activeSessionId };
    for (const sessionId of candidates) {
      if (sessionId !== activeSessionId && !processingNow.has(sessionId)) {
        sessionStore.trimSettledRealtime(sessionId);
      }
    }
  }, [processingSessions, activeSessionId, sessionStore]);

  /* ---------------------------------------------------------------- */
  /*  Coalesced, visibility-gated persisted-history refresh           */
  /* ---------------------------------------------------------------- */

  // Ref mirror so the (stable) coordinator callbacks always see the session
  // currently in view without re-creating the coordinator.
  const activeSessionIdRef = useRef<string | null>(activeSessionId);
  activeSessionIdRef.current = activeSessionId;

  /**
   * "Visible" means the browser tab is shown AND the chat pane itself is not
   * CSS-hidden (MainContent keeps ChatInterface mounted inside a
   * `display: none` wrapper while another main tab is active, which makes the
   * scroll container's offsetParent null). A missing container (empty state /
   * first load) does not count as hidden.
   */
  const isChatPaneVisible = useCallback(() => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
      return false;
    }
    const container = scrollContainerRef.current;
    if (container && container.offsetParent === null) {
      return false;
    }
    return true;
  }, []);

  const canRefreshSessionNow = useCallback((sessionId: string) => (
    isChatPaneVisible() && activeSessionIdRef.current === sessionId
  ), [isChatPaneVisible]);

  // The executor lives in a ref so the coordinator (created once) always calls
  // the latest closure over sessionStore and the pagination setters.
  const latestRefreshExecutorRef = useRef<(sessionId: string) => Promise<boolean | void>>(
    async () => true,
  );
  // Outcome of the last executed latest refresh per session, read by the
  // follow-up retry loop (the coordinator itself only reports completion).
  const lastLatestRefreshRef = useRef(new Map<string, LatestHistoryRefreshResult>());
  const followUpLatestHistoryRef = useRef<(sessionId: string) => void>(() => {});
  latestRefreshExecutorRef.current = async (sessionId: string) => {
    const result = await sessionStore.refreshLatestFromServer(sessionId, {
      limit: SESSION_MESSAGES_PAGE_SIZE,
      canRequest: () => canRefreshSessionNow(sessionId),
    });
    lastLatestRefreshRef.current.set(sessionId, result);
    const slot = result.slot;
    if (slot && activeSessionIdRef.current === sessionId && result.applied) {
      setHasMoreMessages(slot.hasMore);
      setTotalMessages(slot.total);
      messagesOffsetRef.current = slot.offset;
      if (slot.tokenUsage) setTokenBudget(slot.tokenUsage as Record<string, unknown>);
      // Any trigger (external update, activation) can land on the server's
      // last-good cache; keep re-reading until the background refresh lands.
      if (slot.historyRefreshing && !historyRefetchTimerRef.current) {
        followUpLatestHistoryRef.current(sessionId);
      }
    }
    // `deferred` means the pane went hidden mid-request: keep the session
    // dirty so the next flush (visibility/activation) retries.
    return !result.deferred;
  };

  const refreshCoordinatorRef = useRef<MessageHistoryRefreshCoordinator | null>(null);
  if (!refreshCoordinatorRef.current) {
    refreshCoordinatorRef.current = createMessageHistoryRefreshCoordinator(
      (sessionId) => latestRefreshExecutorRef.current(sessionId),
      (sessionId) => canRefreshSessionNow(sessionId),
    );
  }

  /**
   * Single entry point for every automatic history refresh trigger (stale
   * re-activation, external update / websocket reconnect). Visible sessions
   * fetch one bounded latest page; hidden/inactive ones are marked dirty and
   * flushed when they become visible again.
   */
  const requestLatestMessages = useCallback((sessionId: string, allowNetwork = true) => (
    refreshCoordinatorRef.current?.request(sessionId, allowNetwork) ?? Promise.resolve()
  ), []);

  // Reconcile ownership on surface changes, and periodically while a
  // hidden Chat run is keeping Shell waiting. A missed completion frame
  // must not leave that handoff stuck. Subscribe also replays missed events.
  useEffect(() => {
    const sessionId = selectedSession?.id;
    if (!sessionId || !ws) return;
    const reconcile = () => {
      statusCheckSentAtRef.current.set(sessionId, Date.now());
      sendMessage({
        type: 'chat.subscribe',
        sessions: [{ sessionId, lastSeq: lastSeqRef.current.get(sessionId) ?? 0 }],
      });
    };
    reconcile();
    if (isActive || !isProcessing) return;
    const timer = window.setInterval(reconcile, 5000);
    return () => window.clearInterval(timer);
  }, [isActive, isProcessing, selectedSession?.id, ws, sendMessage, statusCheckSentAtRef, lastSeqRef]);

  // Shell can update the provider transcript without a file-watcher event.
  // Refresh the bounded tail on return, preserving the draft and scroll state.
  const wasActiveRef = useRef(isActive);
  useEffect(() => {
    const returning = isActive && !wasActiveRef.current;
    wasActiveRef.current = isActive;
    if (!activeSessionId) return;
    if (returning) {
      void requestLatestMessages(activeSessionId, !isProcessing).catch(error => {
        console.error('Error refreshing messages on Chat activation:', error);
      });
    } else if (isActive && !isProcessing) {
      void refreshCoordinatorRef.current?.flushPending(activeSessionId);
    }
  }, [isActive, activeSessionId, isProcessing, requestLatestMessages]);

  // Flush dirty sessions when the browser tab becomes visible again.
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const onVisibilityChange = () => {
      if (document.visibilityState !== 'visible') return;
      const sessionId = activeSessionIdRef.current;
      if (sessionId) {
        void refreshCoordinatorRef.current?.flushPending(sessionId);
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, []);

  /* ---------------------------------------------------------------- */
  /*  Derive chatMessages from the store                              */
  /* ---------------------------------------------------------------- */
  const [pendingUserMessage, setPendingUserMessage] = useState<ChatMessage | null>(null);
  const flushedPendingUserMessageRef = useRef<ChatMessage | null>(null);

  // Tell the store which session we're viewing so it only re-renders for this one
  const prevActiveForStoreRef = useRef<string | null>(null);
  if (activeSessionId !== prevActiveForStoreRef.current) {
    prevActiveForStoreRef.current = activeSessionId;
    sessionStore.setActiveSession(activeSessionId);
  }

  useEffect(() => {
    if (!pendingUserMessage) {
      flushedPendingUserMessageRef.current = null;
      return;
    }

    if (!activeSessionId) {
      return;
    }

    if (flushedPendingUserMessageRef.current === pendingUserMessage) {
      return;
    }

    const prov = (localStorage.getItem('selected-provider') as LLMProvider) || 'claude';
    const normalized = chatMessageToNormalized(pendingUserMessage, activeSessionId, prov);
    if (normalized) {
      sessionStore.appendRealtime(activeSessionId, normalized);
    }

    flushedPendingUserMessageRef.current = pendingUserMessage;
    setPendingUserMessage(null);
  }, [activeSessionId, pendingUserMessage, sessionStore]);

  const storeMessages = activeSessionId ? sessionStore.getMessages(activeSessionId) : EMPTY_MESSAGES;
  // Persisted rows loaded so far — the same unit as `totalMessages`, unlike the
  // rendered row count (tool results merge into their calls, groups collapse).
  const loadedHistoryCount = activeSessionId
    ? sessionStore.getSessionSlot(activeSessionId)?.serverMessages.length ?? 0
    : 0;

  // Reset viewHiddenCount when store messages change
  const prevStoreLenRef = useRef(0);
  if (storeMessages.length !== prevStoreLenRef.current) {
    prevStoreLenRef.current = storeMessages.length;
    if (viewHiddenCount > 0) setViewHiddenCount(0);
  }

  const chatMessages = useMemo(() => {
    const all = normalizedToChatMessages(storeMessages);
    // Show pending user message when no session data exists yet (new session, pre-backend-response)
    if (pendingUserMessage && all.length === 0) {
      return [pendingUserMessage];
    }
    if (viewHiddenCount > 0 && viewHiddenCount < all.length) return all.slice(0, -viewHiddenCount);
    return all;
  }, [storeMessages, viewHiddenCount, pendingUserMessage]);

  /* ---------------------------------------------------------------- */
  /*  addMessage / clearMessages / rewindMessages                     */
  /* ---------------------------------------------------------------- */

  const addMessage = useCallback((msg: ChatMessage, targetSessionId = activeSessionId, targetProvider?: LLMProvider) => {
    if (!targetSessionId) {
      // No session yet — show as pending until the backend creates one
      setPendingUserMessage(msg);
      return;
    }
    const prov = targetProvider || (localStorage.getItem('selected-provider') as LLMProvider) || 'claude';
    const normalized = chatMessageToNormalized(msg, targetSessionId, prov);
    if (normalized) {
      sessionStore.appendRealtime(targetSessionId, normalized);
    }
  }, [activeSessionId, sessionStore]);

  const clearMessages = useCallback(() => {
    if (!activeSessionId) return;
    sessionStore.clearRealtime(activeSessionId);
  }, [activeSessionId, sessionStore]);

  const rewindMessages = useCallback((count: number) => setViewHiddenCount(count), []);

  const scrollToBottom = useCallback(() => {
    scrollControllerRef.current?.jumpToBottom();
  }, []);

  // Jumping to the latest message must not discard already loaded history.
  const scrollToBottomAndReset = scrollToBottom;

  const isNearBottom = useCallback(() => {
    const container = scrollContainerRef.current;
    return Boolean(container && container.scrollHeight - container.scrollTop - container.clientHeight <= 2);
  }, []);

  const loadOlderMessages = useCallback(
    async (container: HTMLDivElement) => {
      if (!container || isLoadingMoreRef.current || isLoadingMoreMessages) return false;
      if (allMessagesLoadedRef.current) return false;
      if (!hasMoreMessages || !selectedSession || !selectedProject) return false;

      isLoadingMoreRef.current = true;
      const requestSessionId = selectedSession.id;
      const previousRows = sessionStore.getMessages(requestSessionId);
      setIsLoadingMoreMessages(true);

      try {
        const slot = await sessionStore.fetchMore(selectedSession.id, {
          limit: SESSION_MESSAGES_PAGE_SIZE,
        });
        if (activeSessionIdRef.current !== requestSessionId || !slot) return false;
        if (sessionStore.getMessages(requestSessionId) === previousRows || slot.serverMessages.length === 0) {
          if (!slot.hasMore) {
            setHasMoreMessages(false);
            allMessagesLoadedRef.current = true;
            setAllMessagesLoaded(true);
            if (loadAllOverlayTimerRef.current) {
              clearTimeout(loadAllOverlayTimerRef.current);
              loadAllOverlayTimerRef.current = null;
            }
            setShowLoadAllOverlay(false);
          }
          return false;
        }

        setHasMoreMessages(slot.hasMore);
        setTotalMessages(slot.total);
        if (!slot.hasMore) {
          allMessagesLoadedRef.current = true;
          setAllMessagesLoaded(true);
          if (loadAllOverlayTimerRef.current) {
            clearTimeout(loadAllOverlayTimerRef.current);
            loadAllOverlayTimerRef.current = null;
          }
          setShowLoadAllOverlay(false);
        }
        return true;
      } finally {
        if (activeSessionIdRef.current === requestSessionId) {
          isLoadingMoreRef.current = false;
          setIsLoadingMoreMessages(false);
        }
      }
    },
    [hasMoreMessages, isLoadingMoreMessages, selectedProject, selectedSession, sessionStore],
  );

  /**
   * `programmatic` scrolls are the controller's own anchoring corrections /
   * follow writes. They may update the top-load lock but never start a fetch
   * or show the Load-all prompt: a correction landing near the top used to
   * chain another older-page request with no user movement.
   */
  const handleScroll = useCallback(async (programmatic = false) => {
    const container = scrollContainerRef.current;
    if (!container) return;

    const scrolledNearTop = container.scrollTop < 100;

    // "Load all" prompt: appear (with fade-in) when the user reaches the top
    if (programmatic) {
      if (!scrolledNearTop) wasNearTopRef.current = false;
    } else if (scrolledNearTop && hasMoreMessages && !allMessagesLoadedRef.current) {
      if (!wasNearTopRef.current) {
        wasNearTopRef.current = true;
        if (loadAllOverlayTimerRef.current) clearTimeout(loadAllOverlayTimerRef.current);

        setShowLoadAllOverlay(true);
        loadAllOverlayTimerRef.current = setTimeout(() => {
          setShowLoadAllOverlay(false);
          loadAllOverlayTimerRef.current = null;
        }, 2500);
      }
    } else if (!scrolledNearTop) {
      wasNearTopRef.current = false;
    }

    if (!allMessagesLoadedRef.current) {
      if (!scrolledNearTop) { topLoadLockRef.current = false; return; }
      if (topLoadLockRef.current) {
        if (container.scrollTop > 20) topLoadLockRef.current = false;
        return;
      }
      if (programmatic) return;
      const didLoad = await loadOlderMessages(container);
      if (didLoad) topLoadLockRef.current = true;
    }
  }, [hasMoreMessages, loadOlderMessages]);

  // Reset scroll/pagination state on session change
  useEffect(() => {
    searchScrollActiveRef.current = false;
    setSearchTarget(null);
    topLoadLockRef.current = false;
    wasNearTopRef.current = false;
    setIsUserScrolledUp(false);
  }, [selectedProject?.projectId, selectedSession?.id, setIsUserScrolledUp]);

  // Latest-value mirrors so the load effect only re-runs for session identity
  // and socket changes. Callback identities (resetStreamingState follows the
  // provider, which syncs one render after opening another provider's
  // session) used to re-run the effect mid-fetch and cancel its own load.
  const resetStreamingStateRef = useRef(resetStreamingState);
  resetStreamingStateRef.current = resetStreamingState;
  const sendMessageRef = useRef(sendMessage);
  sendMessageRef.current = sendMessage;
  const currentSessionIdRef = useRef(currentSessionId);
  currentSessionIdRef.current = currentSessionId;
  const expectedMessageCountRef = useRef<number | undefined>(selectedSession?.messageCount);
  expectedMessageCountRef.current = selectedSession?.messageCount;

  const clearHistoryRefetchTimer = useCallback(() => {
    if (historyRefetchTimerRef.current) {
      clearTimeout(historyRefetchTimerRef.current);
      historyRefetchTimerRef.current = null;
    }
  }, []);

  /**
   * Re-reads the persisted tail through the coordinated refresh path until it
   * is final, with backoff: while the server reports `historyRefreshing`, the
   * request failed / was pending / could not be stitched, or (after a run)
   * live rows are still waiting for the transcript to catch up. A deferred
   * (hidden-pane) refresh stops the loop — the coordinator keeps it dirty and
   * flushes it on visibility. Pagination state is synced by the executor.
   */
  const followUpLatestHistory = useCallback((
    sessionId: string,
    options: { immediate?: boolean; awaitLiveRows?: boolean } = {},
  ) => {
    clearHistoryRefetchTimer();
    const maxAttempts = options.awaitLiveRows
      ? RUN_COMPLETE_FOLLOW_UP_ATTEMPTS
      : HISTORY_FOLLOW_UP_DELAYS_MS.length;

    const run = async (attempt: number) => {
      if (activeSessionIdRef.current !== sessionId) {
        // Not in view: mark dirty so it refreshes when shown.
        void requestLatestMessages(sessionId, false);
        return;
      }
      lastLatestRefreshRef.current.delete(sessionId);
      try {
        await requestLatestMessages(sessionId);
      } catch (error) {
        console.error('Error refreshing latest messages:', error);
      }
      if (activeSessionIdRef.current !== sessionId) return;
      const result = lastLatestRefreshRef.current.get(sessionId);
      if (!result || result.deferred) return;
      const slot = sessionStore.getSessionSlot(sessionId);
      const needsRetry = Boolean(
        result.failed
        || result.pending
        || result.unbridged
        || slot?.historyRefreshing
        || (options.awaitLiveRows && hasUnpersistedLiveRows(slot)),
      );
      // The executor may have started its own follow-up; this loop owns it.
      clearHistoryRefetchTimer();
      if (needsRetry) schedule(attempt + 1);
    };

    const schedule = (attempt: number) => {
      if (attempt >= maxAttempts) return;
      historyRefetchTimerRef.current = setTimeout(() => {
        historyRefetchTimerRef.current = null;
        void run(attempt);
      }, HISTORY_FOLLOW_UP_DELAYS_MS[attempt]);
    };

    if (options.immediate) void run(0);
    else schedule(0);
  }, [clearHistoryRefetchTimer, requestLatestMessages, sessionStore]);
  followUpLatestHistoryRef.current = followUpLatestHistory;

  /**
   * Run-complete hook for the realtime handler: sync the viewed conversation
   * with the now-persisted transcript (hasMore/total/offset included) and keep
   * retrying briefly while the provider is still writing it.
   */
  const refreshAfterRunComplete = useCallback((sessionId: string) => {
    followUpLatestHistory(sessionId, { immediate: true, awaitLiveRows: true });
  }, [followUpLatestHistory]);

  /**
   * First load for a session entering view. Revisiting a cached session keeps
   * its already-loaded older history and stitches the refreshed tail on (no
   * collapse to a fresh 20-row page); a first visit fetches the newest page.
   * Errors and not-yet-persisted history retry with backoff while this load
   * is current; the flags and pagination are always applied when it settles.
   */
  const startInitialHistoryLoad = useCallback((sessionId: string) => {
    const runner = historyLoadRunnerRef.current!;
    clearHistoryRefetchTimer();
    setHistoryLoadError(null);
    setIsLoadingSessionMessages(true);

    const attempt = async (attemptIndex: number): Promise<HistoryLoadAttemptOutcome> => {
      const cachedRows = sessionStore.getSessionSlot(sessionId)?.serverMessages.length ?? 0;
      if (cachedRows > 0) {
        const result = await sessionStore.refreshLatestFromServer(sessionId, {
          limit: SESSION_MESSAGES_PAGE_SIZE,
        });
        if (result.failed) return 'error';
        if (result.pending) return 'pending';
        if (!result.unbridged) return 'applied';
        // The tail could not be stitched onto the cache: fall back to a
        // fresh newest page rather than showing a stale transcript.
      }
      const { slot, outcome } = await sessionStore.fetchFromServerDetailed(sessionId, {
        limit: SESSION_MESSAGES_PAGE_SIZE,
        offset: 0,
      });
      if (outcome === 'superseded') return 'applied';
      if (
        outcome === 'applied'
        && slot.serverMessages.length === 0
        && !slot.hasMore
        && (expectedMessageCountRef.current ?? 0) > 0
        && attemptIndex < SUSPECT_EMPTY_RETRIES
      ) {
        // The index says this session has messages; an empty page right
        // after creation/indexing is usually a transcript still being written.
        return 'error';
      }
      return outcome;
    };

    const onDone = (result: HistoryLoadResult) => {
      if (activeSessionIdRef.current !== sessionId) return;
      const slot = sessionStore.getSessionSlot(sessionId);
      if (slot) {
        setHasMoreMessages(slot.hasMore);
        setTotalMessages(slot.total);
        messagesOffsetRef.current = slot.offset;
        if (slot.tokenUsage) setTokenBudget(slot.tokenUsage as Record<string, unknown>);
      }
      setIsLoadingSessionMessages(false);
      const hasRows = (slot?.merged.length ?? 0) > 0;
      setHistoryLoadError(result === 'applied' || hasRows ? null : result);
      if (result === 'applied' && slot?.historyRefreshing) {
        // Rows are the server's last-good cache; re-read with backoff until
        // the background refresh lands (tail merge, no flash).
        followUpLatestHistory(sessionId);
      }
    };

    runner.start(sessionId, attempt, onDone);
  }, [clearHistoryRefetchTimer, followUpLatestHistory, sessionStore]);

  const retryHistoryLoad = useCallback(() => {
    const sessionId = activeSessionIdRef.current;
    if (sessionId) startInitialHistoryLoad(sessionId);
  }, [startInitialHistoryLoad]);

  useEffect(() => () => {
    historyLoadRunnerRef.current?.cancel();
    clearHistoryRefetchTimer();
  }, [clearHistoryRefetchTimer]);

  // Main session loading effect — store-based
  useEffect(() => {
    const projectId = selectedProject?.projectId ?? null;
    const runner = historyLoadRunnerRef.current!;

    if (!selectedSession || !projectId) {
      // A freshly created session can be mid-run before the router has a
      // canonical selectedSession (the URL effect synthesizes one on the
      // next render). Keep the active view intact instead of wiping it.
      const current = currentSessionIdRef.current;
      if (current && processingSessionsRef.current?.has(current)) {
        return;
      }

      runner.cancel();
      clearHistoryRefetchTimer();
      resetStreamingStateRef.current();
      setCurrentSessionId(null);
      messagesOffsetRef.current = 0;
      setHasMoreMessages(false);
      setTotalMessages(0);
      setTokenBudget(null);
      setIsLoadingSessionMessages(false);
      setHistoryLoadError(null);
      lastLoadedSessionKeyRef.current = null;
      lastSubscribedSessionRef.current = null;
      return;
    }

    const selectedSessionId = selectedSession.id;
    const sessionKey = `${selectedSessionId}:${projectId}`;

    const subscribeToSelectedSession = (force = false) => {
      if (!ws) {
        return;
      }

      const last = lastSubscribedSessionRef.current;
      if (
        !force
        && last
        && last.sessionId === selectedSessionId
        && last.ws === ws
      ) {
        return;
      }

      lastSubscribedSessionRef.current = { sessionId: selectedSessionId, ws };
      statusCheckSentAtRef.current.set(selectedSessionId, Date.now());
      sendMessageRef.current({
        type: 'chat.subscribe',
        sessions: [{
          sessionId: selectedSessionId,
          lastSeq: lastSeqRef.current.get(selectedSessionId) ?? 0,
        }],
      });
    };

    const alreadyLoaded = lastLoadedSessionKeyRef.current === sessionKey && sessionStore.has(selectedSessionId);

    // Same conversation already in view: keep pagination/scroll intact.
    // Only re-subscribe when the socket changes, and only soft-refresh when
    // the cache is stale. Re-running a full load here used to thrash Grok
    // sessions because every file-watcher `session_upserted` rebuilt the
    // selected project object and re-entered this effect. An initial load
    // still in flight is left to finish (it is not tied to this effect run).
    if (alreadyLoaded) {
      subscribeToSelectedSession(false);
      if (runner.inFlightKey === selectedSessionId) return;
      const viewedActivity = processingSessionsRef.current?.get(selectedSessionId);
      if (viewedActivity?.source !== 'chat') {
        if (sessionStore.isStale(selectedSessionId)) {
          // Coalesced bounded tail refresh; the executor syncs hasMore/total/
          // tokenBudget once the page is stitched in. Hidden panes are marked
          // dirty instead of fetching.
          void requestLatestMessages(selectedSessionId);
        } else {
          // Fresh cache, but a refresh may have been deferred while hidden.
          void refreshCoordinatorRef.current?.flushPending(selectedSessionId);
        }
      }
      return;
    }

    const previousSessionId = currentSessionIdRef.current;
    const sessionChanged = previousSessionId !== null && previousSessionId !== selectedSessionId;
    if (sessionChanged) {
      resetStreamingStateRef.current();
    }

    // Reset pagination/scroll state only when actually switching conversations.
    // A cached revisit starts from the cached pagination so older history
    // already loaded stays visible and scroll-loading continues from it.
    const cachedSlot = sessionStore.getSessionSlot(selectedSessionId);
    const hasCachedHistory = (cachedSlot?.serverMessages.length ?? 0) > 0;
    isLoadingMoreRef.current = false;
    setIsLoadingMoreMessages(false);
    messagesOffsetRef.current = hasCachedHistory ? cachedSlot!.offset : 0;
    setHasMoreMessages(hasCachedHistory ? cachedSlot!.hasMore : false);
    setTotalMessages(hasCachedHistory ? cachedSlot!.total : 0);
    setAllMessagesLoaded(false);
    allMessagesLoadedRef.current = false;
    setIsLoadingAllMessages(false);
    setLoadAllJustFinished(false);
    setShowLoadAllOverlay(false);
    setViewHiddenCount(0);
    wasNearTopRef.current = false;
    if (loadAllOverlayTimerRef.current) clearTimeout(loadAllOverlayTimerRef.current);
    if (loadAllFinishedTimerRef.current) clearTimeout(loadAllFinishedTimerRef.current);

    if (sessionChanged) {
      setTokenBudget(null);
    }

    setCurrentSessionId(selectedSessionId);

    // Subscribe to the session's live run (if any): the ack reconciles the
    // processing indicator, re-attaches a mid-flight stream to this socket,
    // and replays any live events missed since `lastSeq`. Recording the send
    // time lets the ack handler discard idle acks that a newer request has
    // since outdated.
    subscribeToSelectedSession(true);

    lastLoadedSessionKeyRef.current = sessionKey;

    // The full initial page load supersedes any refresh deferred while hidden.
    refreshCoordinatorRef.current?.discardPending(selectedSessionId);

    // Fetch from server → store updates → chatMessages re-derives automatically.
    // Deliberately no cleanup: the runner's token (superseded only by another
    // load or a deselect above) decides validity, so effect re-runs caused by
    // unrelated dependency changes can no longer strand the loading flag.
    startInitialHistoryLoad(selectedSessionId);
  }, [
    clearHistoryRefetchTimer,
    requestLatestMessages,
    selectedProject?.projectId,
    selectedSession?.id,
    startInitialHistoryLoad,
    statusCheckSentAtRef,
    lastSeqRef,
    ws,
    sessionStore,
  ]);

  // Refresh signals must not follow rebuilt project/session object identities.
  // The coordinator gates network requests by visibility; the scroll controller
  // alone decides whether resulting content should follow the bottom.
  const refreshSessionId = selectedSession?.id;
  const refreshProjectId = selectedProject?.projectId;
  useEffect(() => {
    if (!externalMessageUpdate || !refreshSessionId || !refreshProjectId || isProcessing) return;
    void requestLatestMessages(refreshSessionId).catch(error => {
      console.error('Error reloading messages from external update:', error);
    });
  }, [externalMessageUpdate, refreshSessionId, refreshProjectId, isProcessing, requestLatestMessages]);

  // Flush a deferred refresh when the CSS-hidden chat pane becomes visible
  // again (MainContent flips the wrapper from `hidden` to `block` with no
  // React signal reaching this hook). The observer fires with
  // isIntersecting=true the moment the scroll container regains layout.
  const hasRenderedMessages = chatMessages.length > 0;
  useEffect(() => {
    if (!activeSessionId || typeof IntersectionObserver === 'undefined') return;
    const container = scrollContainerRef.current;
    if (!container) return;

    const sessionId = activeSessionId;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        void refreshCoordinatorRef.current?.flushPending(sessionId);
      }
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [activeSessionId, hasRenderedMessages]);

  const searchSession = selectedSession as Record<string, unknown> | null;
  const searchSnippet = searchSession?.__searchTargetSnippet;
  const searchTimestamp = searchSession?.__searchTargetTimestamp;

  // Search navigation target: object refreshes are not new navigation requests.
  useEffect(() => {
    const targetSnippet = searchSnippet;
    const targetTimestamp = searchTimestamp;
    if (typeof targetSnippet === 'string' && targetSnippet) {
      searchScrollActiveRef.current = true;
      setSearchTarget({
        snippet: targetSnippet,
        timestamp: typeof targetTimestamp === 'string' ? targetTimestamp : undefined,
      });
    }
  }, [activeSessionId, searchSnippet, searchTimestamp]);

  // Scroll to search target
  useEffect(() => {
    if (!searchTarget || chatMessages.length === 0 || isLoadingSessionMessages) return;

    const target = searchTarget;
    const controller = scrollControllerRef.current;
    controller?.interrupt();
    const revision = controller?.revision;
    const requestSessionId = activeSessionId;
    let cancelled = false;
    const isCurrent = () => !cancelled && activeSessionIdRef.current === requestSessionId
      && scrollControllerRef.current === controller && controller?.revision === revision;
    const finish = () => { searchScrollActiveRef.current = false; setSearchTarget(null); };

    const scrollToTarget = async () => {
      if (!allMessagesLoadedRef.current && selectedSession && selectedProject) {
          try {
            // Load all messages into the store for search navigation
            const slot = await sessionStore.fetchFromServer(selectedSession.id, {
              limit: null,
              offset: 0,
            });
            if (!isCurrent()) return;
            if (slot) {
              setHasMoreMessages(false);
              setTotalMessages(slot.total);
              messagesOffsetRef.current = slot.total;
              setAllMessagesLoaded(true);
              allMessagesLoadedRef.current = true;
              await new Promise(resolve => setTimeout(resolve, 300));
            }
          } catch {
            // Fall through and scroll in current messages
          }
      }
      if (!isCurrent()) { if (!cancelled) finish(); return; }

      const findAndScroll = (retriesLeft: number) => {
        if (!isCurrent()) { if (!cancelled) finish(); return; }
        const container = scrollContainerRef.current;
        if (!container) return;

        let targetElement: Element | null = null;

        if (target.snippet) {
          const cleanSnippet = target.snippet.replace(/^\.{3}/, '').replace(/\.{3}$/, '').trim();
          const searchPhrase = cleanSnippet.slice(0, 80).toLowerCase().trim();
          if (searchPhrase.length >= 10) {
            const messageElements = container.querySelectorAll('.chat-message');
            for (const el of messageElements) {
              const text = (el.textContent || '').toLowerCase();
              if (text.includes(searchPhrase)) { targetElement = el; break; }
            }
          }
        }

        if (!targetElement && target.timestamp) {
          const targetDate = new Date(target.timestamp).getTime();
          const messageElements = container.querySelectorAll('[data-message-timestamp]');
          let closestDiff = Infinity;
          for (const el of messageElements) {
            const ts = el.getAttribute('data-message-timestamp');
            if (!ts) continue;
            const diff = Math.abs(new Date(ts).getTime() - targetDate);
            if (diff < closestDiff) { closestDiff = diff; targetElement = el; }
          }
        }

        if (targetElement) {
          targetElement.scrollIntoView({ block: 'center', behavior: 'auto' });
          controller?.capture();
          targetElement.classList.add('search-highlight-flash');
          setTimeout(() => targetElement?.classList.remove('search-highlight-flash'), 4000);
          finish();
        } else if (retriesLeft > 0) {
          setTimeout(() => findAndScroll(retriesLeft - 1), 200);
        } else {
          finish();
        }
      };

      setTimeout(() => findAndScroll(15), 150);
    };

    void scrollToTarget();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSessionId, chatMessages.length, isLoadingSessionMessages, searchTarget]);

  // Initial token usage fetch for providers with file-backed usage data.
  useEffect(() => {
    if (!selectedProject || !selectedSession?.id) {
      setTokenBudget(null);
      return;
    }
    let cancelled = false;
    const requestSessionId = selectedSession.id;
    const fetchInitialTokenUsage = async () => {
      try {
        // The backend resolves the provider from the indexed session row.
        const url = `/api/projects/${selectedProject.projectId}/sessions/${requestSessionId}/token-usage`;
        const response = await authenticatedFetch(url);
        if (cancelled) return;
        if (response.ok) {
          const budget = await response.json();
          if (!cancelled) setTokenBudget(budget);
        } else {
          setTokenBudget(null);
        }
      } catch (error) {
        if (!cancelled) {
          console.error('Failed to fetch initial token usage:', error);
        }
      }
    };
    fetchInitialTokenUsage();

    return () => {
      cancelled = true;
    };
  }, [selectedProject, selectedSession?.id]);

  // Every row renders: LazyMessageRow keeps off-screen rows cheap. The old
  // tail-anchored visibleMessageCount window cut rows from the top whenever a
  // refresh replaced the last row (its key changed, so "appended" read as 0).
  const visibleMessages = chatMessages;

  const handleScrollRef = useRef(handleScroll);
  handleScrollRef.current = handleScroll;

  // One controller owns follow intent, user input, and geometry correction.
  // It also classifies each scroll event (own write vs user) before the
  // history-loading logic sees it.
  useLayoutEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    const controller = createTranscriptScrollController(container, (reading) => {
      updateIsUserScrolledUp(reading);
    }, () => searchScrollActiveRef.current, () => {
      searchScrollActiveRef.current = false;
      setSearchTarget(null);
    }, (programmatic) => {
      void handleScrollRef.current(programmatic);
    });
    scrollControllerRef.current = controller;
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(controller.reconcile);
    observer?.observe(container);
    const content = container.querySelector('[data-transcript-content]');
    if (content) observer?.observe(content);
    controller.reconcile();
    return () => {
      observer?.disconnect();
      controller.dispose();
      scrollControllerRef.current = null;
    };
  }, [activeSessionId, selectedProject?.projectId]);

  // Includes in-place thinking/tool updates for every provider, not only text
  // length changes on the final message. ResizeObserver covers later layout.
  useLayoutEffect(() => {
    scrollControllerRef.current?.reconcile();
  });

  /**
   * Pull further pages while the transcript is too short to scroll.
   *
   * `handleScroll` is the only thing that fetches older pages, and it only runs
   * on a real scroll event — which a pane with no overflow never produces. One
   * page of messages usually overflows, but not always: consecutive tool calls
   * collapse into a single grouped row, so a whole 20-message page can render
   * as two lines. The transcript then sits at "Showing 20 of 452 messages —
   * scroll up to load more" with no way to scroll and no way to load, which
   * reads as history that loaded a little and then stopped.
   *
   * Each pass loads exactly one more page and re-runs when the resulting
   * messages land, so it stops as soon as the pane overflows (or the server
   * says there is nothing left).
   */
  useEffect(() => {
    if (isLoadingSessionMessages || isLoadingMoreMessages || isLoadingAllMessages) return;
    if (!hasMoreMessages || allMessagesLoaded || allMessagesLoadedRef.current) return;
    if (isLoadingMoreRef.current) return;

    const container = scrollContainerRef.current;
    if (!container) return;

    // Measure after paint: mid-render the rows for the page that just landed
    // may not have been laid out yet, and an unlaid-out pane always looks
    // unscrollable.
    const frame = requestAnimationFrame(() => {
      const current = scrollContainerRef.current;
      if (!current || current.scrollHeight > current.clientHeight) return;
      void loadOlderMessages(current);
    });
    return () => cancelAnimationFrame(frame);
  }, [
    allMessagesLoaded,
    chatMessages.length,
    hasMoreMessages,
    isLoadingAllMessages,
    isLoadingMoreMessages,
    isLoadingSessionMessages,
    loadOlderMessages,
  ]);

  // "Load all" overlay visibility is driven by scroll-to-top in handleScroll;
  // timers are cleared on session change via the reset effect above.

  const loadAllMessages = useCallback(async () => {
    if (!selectedSession || !selectedProject) return;
    if (isLoadingAllMessages) return;
    const requestSessionId = selectedSession.id;
    allMessagesLoadedRef.current = true;
    isLoadingMoreRef.current = true;
    setIsLoadingAllMessages(true);
    setShowLoadAllOverlay(true);
    if (loadAllOverlayTimerRef.current) {
      clearTimeout(loadAllOverlayTimerRef.current);
      loadAllOverlayTimerRef.current = null;
    }

    try {
      const slot = await sessionStore.fetchFromServer(requestSessionId, {
        limit: null,
        offset: 0,
      });

      if (activeSessionIdRef.current !== requestSessionId) return;

      if (slot) {
        setHasMoreMessages(false);
        setTotalMessages(slot.total);
        messagesOffsetRef.current = slot.total;
        setAllMessagesLoaded(true);

        setLoadAllJustFinished(true);
        if (loadAllFinishedTimerRef.current) clearTimeout(loadAllFinishedTimerRef.current);
        loadAllFinishedTimerRef.current = setTimeout(() => {
          setLoadAllJustFinished(false);
          setShowLoadAllOverlay(false);
          loadAllFinishedTimerRef.current = null;
        }, 2500);
      } else {
        allMessagesLoadedRef.current = false;
        setShowLoadAllOverlay(false);
      }
    } catch (error) {
      if (activeSessionIdRef.current !== requestSessionId) return;
      console.error('Error loading all messages:', error);
      allMessagesLoadedRef.current = false;
      setShowLoadAllOverlay(false);
    } finally {
      if (activeSessionIdRef.current === requestSessionId) {
        isLoadingMoreRef.current = false;
        setIsLoadingAllMessages(false);
      }
    }
  }, [selectedSession, selectedProject, isLoadingAllMessages, sessionStore]);

  return {
    chatMessages,
    addMessage,
    clearMessages,
    rewindMessages,
    sessionActivity,
    isProcessing,
    canAbortSession,
    currentSessionId,
    setCurrentSessionId,
    isLoadingSessionMessages,
    historyLoadError,
    retryHistoryLoad,
    loadedHistoryCount,
    isLoadingMoreMessages,
    hasMoreMessages,
    totalMessages,
    isUserScrolledUp,
    setIsUserScrolledUp,
    tokenBudget,
    setTokenBudget,
    visibleMessages,
    loadAllMessages,
    allMessagesLoaded,
    isLoadingAllMessages,
    loadAllJustFinished,
    showLoadAllOverlay,
    createDiff,
    scrollContainerRef,
    scrollToBottom,
    scrollToBottomAndReset,
    isNearBottom,
    handleScroll,
    requestLatestMessages,
    refreshAfterRunComplete,
  };
}
