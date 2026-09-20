import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';

import { authenticatedFetch } from '../../../utils/api';
import type { MarkSessionIdle, SessionActivityMap } from '../../../hooks/useSessionProtection';
import type { Project, ProjectSession, LLMProvider } from '../../../types/app';
import type { SessionStore, NormalizedMessage } from '../../../stores/useSessionStore';
import { SESSION_MESSAGES_PAGE_SIZE } from '../../../stores/sessionMessagePagination';
import type { ChatMessage } from '../types/types';
import {
  createMessageHistoryRefreshCoordinator,
  type MessageHistoryRefreshCoordinator,
} from '../utils/messageHistoryRefreshCoordinator';
import { createCachedDiffCalculator, type DiffCalculator } from '../utils/messageTransforms';
import { getIntrinsicMessageKey } from '../utils/messageKeys';
import { createTranscriptScrollController } from '../utils/transcriptScrollController';

import { normalizedToChatMessages } from './useChatMessages';

const INITIAL_VISIBLE_MESSAGES = 100;
const EMPTY_MESSAGES: NormalizedMessage[] = [];

interface UseChatSessionStateArgs {
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
  const [visibleMessageCount, setVisibleMessageCount] = useState(INITIAL_VISIBLE_MESSAGES);
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
    setVisibleMessageCount(INITIAL_VISIBLE_MESSAGES);
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
  latestRefreshExecutorRef.current = async (sessionId: string) => {
    const result = await sessionStore.refreshLatestFromServer(sessionId, {
      limit: SESSION_MESSAGES_PAGE_SIZE,
      canRequest: () => canRefreshSessionNow(sessionId),
    });
    const slot = result.slot;
    if (slot && activeSessionIdRef.current === sessionId && result.applied) {
      setHasMoreMessages(slot.hasMore);
      setTotalMessages(slot.total);
      messagesOffsetRef.current = slot.offset;
      if (slot.tokenUsage) setTokenBudget(slot.tokenUsage as Record<string, unknown>);
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
        setVisibleMessageCount((prev) => prev + SESSION_MESSAGES_PAGE_SIZE);
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

  const handleScroll = useCallback(async () => {
    const container = scrollContainerRef.current;
    if (!container) return;

    const scrolledNearTop = container.scrollTop < 100;

    // "Load all" prompt: appear (with fade-in) when the user reaches the top
    if (scrolledNearTop && hasMoreMessages && !allMessagesLoadedRef.current) {
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
      const didLoad = await loadOlderMessages(container);
      if (didLoad) topLoadLockRef.current = true;
    }
  }, [hasMoreMessages, loadOlderMessages]);

  // Reset scroll/pagination state on session change
  useEffect(() => {
    if (!searchScrollActiveRef.current) {
      setVisibleMessageCount(INITIAL_VISIBLE_MESSAGES);
    }
    searchScrollActiveRef.current = false;
    setSearchTarget(null);
    topLoadLockRef.current = false;
    wasNearTopRef.current = false;
    setIsUserScrolledUp(false);
  }, [selectedProject?.projectId, selectedSession?.id, setIsUserScrolledUp]);

  // Main session loading effect — store-based
  useEffect(() => {
    const projectId = selectedProject?.projectId ?? null;

    if (!selectedSession || !projectId) {
      // A freshly created session can be mid-run before the router has a
      // canonical selectedSession (the URL effect synthesizes one on the
      // next render). Keep the active view intact instead of wiping it.
      if (currentSessionId && processingSessionsRef.current?.has(currentSessionId)) {
        return;
      }

      resetStreamingState();
      setCurrentSessionId(null);
      messagesOffsetRef.current = 0;
      setHasMoreMessages(false);
      setTotalMessages(0);
      setTokenBudget(null);
      setIsLoadingSessionMessages(false);
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
      sendMessage({
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
    // selected project object and re-entered this effect.
    if (alreadyLoaded) {
      subscribeToSelectedSession(false);
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

    const sessionChanged = currentSessionId !== null && currentSessionId !== selectedSessionId;
    if (sessionChanged) {
      resetStreamingState();
    }

    // Reset pagination/scroll state only when actually switching conversations
    isLoadingMoreRef.current = false;
    setIsLoadingMoreMessages(false);
    messagesOffsetRef.current = 0;
    setHasMoreMessages(false);
    setTotalMessages(0);
    setVisibleMessageCount(INITIAL_VISIBLE_MESSAGES);
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

    // Fetch from server → store updates → chatMessages re-derives automatically
    // `cancelled` scopes the loading flag to *this* effect run so a superseded
    // request can never leave the spinner stuck: `activeSessionIdRef` alone
    // isn't enough, since it can churn (e.g. Studio's session bootstrap briefly
    // nulling `selectedSession`) between this fetch starting and settling.
    let cancelled = false;
    setIsLoadingSessionMessages(true);
    sessionStore.fetchFromServer(selectedSessionId, {
      limit: SESSION_MESSAGES_PAGE_SIZE,
      offset: 0,
    }).then(slot => {
      if (cancelled) return;
      if (activeSessionIdRef.current === selectedSessionId && slot) {
        setHasMoreMessages(slot.hasMore);
        setTotalMessages(slot.total);
        if (slot.tokenUsage) setTokenBudget(slot.tokenUsage as Record<string, unknown>);
      }
      setIsLoadingSessionMessages(false);
    }).catch(() => {
      if (!cancelled) setIsLoadingSessionMessages(false);
    });
    return () => {
      cancelled = true;
    };
  }, [
    resetStreamingState,
    requestLatestMessages,
    selectedProject?.projectId,
    selectedSession?.id,
    sendMessage,
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
              setVisibleMessageCount(Infinity);
              setAllMessagesLoaded(true);
              allMessagesLoadedRef.current = true;
              await new Promise(resolve => setTimeout(resolve, 300));
            }
          } catch {
            // Fall through and scroll in current messages
          }
      }
      if (!isCurrent()) { if (!cancelled) finish(); return; }
      setVisibleMessageCount(Infinity);

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

  const previousWindowRef = useRef({ sessionId: activeSessionId, messages: chatMessages });
  const previousWindow = previousWindowRef.current;
  if (previousWindow.messages !== chatMessages || previousWindow.sessionId !== activeSessionId) {
    previousWindowRef.current = { sessionId: activeSessionId, messages: chatMessages };
    if (previousWindow.sessionId === activeSessionId && previousWindow.messages.length > 0) {
      const previousTail = previousWindow.messages[previousWindow.messages.length - 1];
      const tailKey = getIntrinsicMessageKey(previousTail);
      const tailIndex = chatMessages.findIndex(message => getIntrinsicMessageKey(message) === tailKey);
      const appended = tailIndex < 0 ? 0 : chatMessages.length - tailIndex - 1;
      if (tailKey && appended > 0) setVisibleMessageCount(count => count + appended);
    }
  }

  const visibleMessages = useMemo(() => {
    if (chatMessages.length <= visibleMessageCount) return chatMessages;
    return chatMessages.slice(-visibleMessageCount);
  }, [chatMessages, visibleMessageCount]);

  // One controller owns follow intent, user input, and geometry correction.
  useLayoutEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    const controller = createTranscriptScrollController(container, (reading) => {
      updateIsUserScrolledUp(reading);
    }, () => searchScrollActiveRef.current, () => {
      searchScrollActiveRef.current = false;
      setSearchTarget(null);
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

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    container.addEventListener('scroll', handleScroll);
    return () => container.removeEventListener('scroll', handleScroll);
  }, [handleScroll]);

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
        setVisibleMessageCount(Infinity);
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

  const loadEarlierMessages = useCallback(() => {
    setVisibleMessageCount((prev) => prev + 100);
  }, []);

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
    isLoadingMoreMessages,
    hasMoreMessages,
    totalMessages,
    isUserScrolledUp,
    setIsUserScrolledUp,
    tokenBudget,
    setTokenBudget,
    visibleMessageCount,
    visibleMessages,
    loadEarlierMessages,
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
  };
}
