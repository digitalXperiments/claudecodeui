/**
 * Session-keyed message store.
 *
 * Holds per-session state in a Map keyed by sessionId.
 * Session switch = change activeSessionId pointer. No clearing. Old data stays.
 * WebSocket handler = store.appendRealtime(msg.sessionId, msg). One line.
 * No localStorage for messages. Backend JSONL is the source of truth.
 */

import { useCallback, useMemo, useRef, useState } from 'react';

import { authenticatedFetch } from '../utils/api';
import type { LLMProvider } from '../types/app';

import { computeMerged, reconcileRealtimeWithServer } from './sessionStoreMerge';
import {
  buildSessionMessagesUrl,
  carryOverRowIdentity,
  hasReachedCachedTailTimeBoundary,
  isHistoryResponsePending,
  isHistoryResponseRefreshing,
  mergeLatestServerPage,
  mergeOlderServerPage,
  mergeOlderServerPageWithoutDuplicates,
  planLatestPageBridge,
  resolveLatestPagePagination,
  resolveOlderPageOffset,
  SESSION_MESSAGES_PAGE_SIZE,
} from './sessionMessagePagination';
import type { SessionMessagesRequestOptions } from './sessionMessagePagination';

// ─── NormalizedMessage (mirrors server/adapters/types.js) ────────────────────

export type MessageKind =
  | 'text'
  | 'tool_use'
  | 'tool_result'
  | 'thinking'
  | 'stream_delta'
  | 'stream_end'
  | 'error'
  | 'complete'
  | 'status'
  | 'permission_request'
  | 'permission_cancelled'
  | 'session_created'
  | 'interactive_prompt'
  | 'task_notification';

export interface NormalizedMessage {
  id: string;
  /** Stable UI identity while a live buffer id is reused for later bursts. */
  renderId?: string;
  sessionId: string;
  timestamp: string;
  provider: LLMProvider;
  kind: MessageKind;
  /**
   * Per-run monotonic sequence number assigned by the backend to live
   * websocket events. Used to compute `lastSeq` for `chat.subscribe` replay;
   * REST history messages do not carry it.
   */
  seq?: number;

  // kind-specific fields (flat for simplicity)
  role?: 'user' | 'assistant';
  content?: string;
  /**
   * Mirrors optional transcript metadata from the server.
   *
   * These fields are currently used by Claude history normalization so local
   * slash commands, local stdout, and compact summaries do not disappear when
   * the session store hydrates from REST history.
   */
  displayText?: string;
  commandName?: string;
  commandMessage?: string;
  commandArgs?: string;
  isLocalCommand?: boolean;
  isLocalCommandStdout?: boolean;
  isCompactSummary?: boolean;
  images?: Array<{ path?: string; data?: string; name?: string }>;
  toolName?: string;
  toolInput?: unknown;
  toolId?: string;
  toolResult?: { content: string; isError: boolean; toolUseResult?: unknown } | null;
  isError?: boolean;
  text?: string;
  tokens?: number;
  canInterrupt?: boolean;
  tokenBudget?: unknown;
  requestId?: string;
  input?: unknown;
  context?: unknown;
  newSessionId?: string;
  status?: string;
  summary?: string;
  exitCode?: number;
  actualSessionId?: string;
  parentToolUseId?: string;
  subagentTools?: unknown[];
  isFinal?: boolean;
  // Cursor-specific ordering
  sequence?: number;
  rowid?: number;
}

// ─── Per-session slot ────────────────────────────────────────────────────────

export type SessionStatus = 'idle' | 'loading' | 'streaming' | 'error';

export interface SessionSlot {
  serverMessages: NormalizedMessage[];
  realtimeMessages: NormalizedMessage[];
  merged: NormalizedMessage[];
  /** @internal Cache-invalidation refs for computeMerged */
  _lastServerRef: NormalizedMessage[];
  _lastRealtimeRef: NormalizedMessage[];
  /**
   * @internal Monotonic ticket per server fetch (fetch/refresh/fetchMore) and
   * the ticket of the last response applied. Concurrent fetches for the same
   * session can resolve out of order — e.g. the `complete` refresh racing the
   * watcher-triggered refresh right as a queued message is flushed — and a
   * stale response applied last would wind `serverMessages` back to a
   * transcript that no longer matches what the user already saw.
   */
  _fetchSeq: number;
  _appliedFetchSeq: number;
  status: SessionStatus;
  fetchedAt: number;
  total: number;
  hasMore: boolean;
  offset: number;
  tokenUsage: unknown;
  /**
   * The server said the persisted history is not available yet (e.g. an
   * Antigravity conversation that has not been written/replayed). An empty
   * page in this state is not a real empty transcript.
   */
  historyPending: boolean;
  /** Rows are the server's last-good cache while it refreshes in background. */
  historyRefreshing: boolean;
}

/** How a single history request ended, for callers that retry. */
export type HistoryFetchOutcome = 'applied' | 'superseded' | 'pending' | 'error';

export type HistoryFetchResult = {
  slot: SessionSlot;
  outcome: HistoryFetchOutcome;
};

const EMPTY: NormalizedMessage[] = [];

export function createEmptySlot(): SessionSlot {
  return {
    serverMessages: EMPTY,
    realtimeMessages: EMPTY,
    merged: EMPTY,
    _lastServerRef: EMPTY,
    _lastRealtimeRef: EMPTY,
    status: 'idle',
    fetchedAt: 0,
    total: 0,
    hasMore: false,
    offset: 0,
    tokenUsage: null,
    historyPending: false,
    historyRefreshing: false,
    _fetchSeq: 0,
    _appliedFetchSeq: 0,
  };
}

/**
 * Recompute slot.merged only when the input arrays have actually changed
 * (by reference). Returns true if merged was recomputed.
 *
 * Every serverMessages write (latest refresh, first page, "Load all", older
 * page) funnels through here, so this is where realtime rows the transcript
 * now owns are pruned — previously only the latest refresh pruned, and the
 * other paths left live tool rows/replies rendered twice. Rows new to the
 * server list inherit the render identity of the live row they replace.
 */
export function recomputeMergedIfNeeded(slot: SessionSlot): boolean {
  if (slot.serverMessages === slot._lastServerRef && slot.realtimeMessages === slot._lastRealtimeRef) {
    return false;
  }
  if (slot.serverMessages !== slot._lastServerRef && slot.realtimeMessages.length > 0) {
    const previousIds = new Set(slot._lastServerRef.map((message) => message.id));
    const reconciled = reconcileRealtimeWithServer(
      slot.serverMessages,
      slot.realtimeMessages,
      (message) => !previousIds.has(message.id),
    );
    slot.serverMessages = reconciled.serverMessages;
    slot.realtimeMessages = reconciled.realtimeMessages;
  }
  slot._lastServerRef = slot.serverMessages;
  slot._lastRealtimeRef = slot.realtimeMessages;
  slot.merged = computeMerged(slot.serverMessages, slot.realtimeMessages);
  return true;
}

/**
 * Safety bound on live rows kept for a settled session that is not in view.
 * Realtime rows are uncapped while a run streams (dropping them lost output
 * not yet persisted) and normally leave once a server write owns them — but
 * that write only happens for the viewed session, so a background session's
 * rows would otherwise pile up across runs until it is opened again.
 */
export const MAX_SETTLED_REALTIME_MESSAGES = 5000;

/**
 * Drop the oldest live rows beyond `maxRows` from a settled slot. Callers
 * must only use this for sessions with no run in flight and not in view: the
 * dropped rows are persisted by then, and the slot is marked stale so the
 * next visit re-reads the transcript tail instead of trusting the cache.
 * Returns true when rows were dropped.
 */
export function trimSettledRealtimeRows(
  slot: SessionSlot,
  maxRows: number = MAX_SETTLED_REALTIME_MESSAGES,
): boolean {
  if (slot.realtimeMessages.length <= maxRows) return false;
  slot.realtimeMessages = maxRows > 0 ? slot.realtimeMessages.slice(-maxRows) : EMPTY;
  slot.fetchedAt = 0;
  recomputeMergedIfNeeded(slot);
  return true;
}

// ─── Bounded latest-page refresh ─────────────────────────────────────────────

export type SessionHistoryPage = {
  messages: NormalizedMessage[];
  total: number;
  hasMore: boolean;
  tokenUsage?: unknown;
  /** historyPending/retryable: the page is not the final transcript yet. */
  pending: boolean;
  /** historyRefreshing: rows are a last-good cache; refetch shortly. */
  refreshing: boolean;
};

export type CanRequestHistory = () => boolean;

export type LatestHistoryRefreshResult = {
  slot: SessionSlot;
  /** The fetched tail was stitched onto the cached suffix and applied. */
  applied: boolean;
  /** Slot state changed (messages and/or tokenUsage) — consumers re-rendered. */
  changed: boolean;
  /** canRequest() vetoed the network — the caller should retry when visible. */
  deferred: boolean;
  /** The request failed (network/HTTP); nothing was applied. */
  failed?: boolean;
  /** The server reported history as not yet available; nothing was applied. */
  pending?: boolean;
  /** The fetched tail could not be stitched onto the cached history. */
  unbridged?: boolean;
};

export type HistoryPageRequester = (
  sessionId: string,
  options: SessionMessagesRequestOptions,
) => Promise<SessionHistoryPage>;

async function requestSessionHistoryPage(
  sessionId: string,
  options: SessionMessagesRequestOptions,
): Promise<SessionHistoryPage> {
  const response = await authenticatedFetch(buildSessionMessagesUrl(sessionId, options));
  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  const body = await response.json();
  const data = body?.data ?? body;
  const messages: NormalizedMessage[] = Array.isArray(data.messages) ? data.messages : [];

  return {
    messages,
    total: typeof data.total === 'number' ? data.total : messages.length,
    hasMore: Boolean(data.hasMore),
    pending: isHistoryResponsePending(data),
    refreshing: isHistoryResponseRefreshing(data),
    ...(
      data && typeof data === 'object' && 'tokenUsage' in data
        ? { tokenUsage: data.tokenUsage }
        : {}
    ),
  };
}

function readMessageTime(m: NormalizedMessage): number | null {
  const time = Date.parse(m.timestamp);
  return Number.isFinite(time) ? time : null;
}

// Token usage is JSON response data, so compare its serialized value instead
// of treating each freshly parsed response object as a state change.
function hasEquivalentTokenUsage(left: unknown, right: unknown): boolean {
  return Object.is(left, right) || JSON.stringify(left) === JSON.stringify(right);
}

function olderPagePrecedesCachedHistory(
  olderMessages: NormalizedMessage[],
  cachedMessages: NormalizedMessage[],
): boolean {
  const olderNewest = olderMessages[olderMessages.length - 1];
  const cachedOldest = cachedMessages[0];
  if (!olderNewest || !cachedOldest) return true;

  const olderTime = readMessageTime(olderNewest);
  const cachedTime = readMessageTime(cachedOldest);
  return olderTime === null || cachedTime === null || olderTime <= cachedTime;
}

/**
 * Fetches and atomically applies a bounded persisted-tail reconciliation.
 * Every request is finite. Bridge discovery may use more than one bounded
 * chunk when a provider's `total` does not match the rows it pages over.
 *
 * Concurrency uses the store's `_fetchSeq`/`_appliedFetchSeq` ticket guard:
 * the ticket is taken before the first request and a stale ticket (a
 * later-started fetch already applied) discards the whole reconciliation
 * instead of winding the transcript back.
 */
export async function refreshLatestSlotFromServer(
  sessionId: string,
  slot: SessionSlot,
  limit: number,
  canRequest: CanRequestHistory = () => true,
  request: HistoryPageRequester = requestSessionHistoryPage,
): Promise<Omit<LatestHistoryRefreshResult, 'slot'>> {
  if (!canRequest()) {
    return { applied: false, changed: false, deferred: true };
  }

  const fetchTicket = ++slot._fetchSeq;
  const previousServerMessages = slot.serverMessages;
  const previousTotal = slot.total;
  const previousHasMore = slot.hasMore;
  const latestPage = await request(sessionId, {
    limit,
    offset: 0,
  });

  // "Not persisted yet" is not an authoritative empty transcript: applying it
  // through the `!hasMore` branch below would wipe already-cached rows.
  if (latestPage.pending && latestPage.messages.length === 0) {
    slot.historyPending = true;
    return { applied: false, changed: false, deferred: false, pending: true };
  }

  let nextServerMessages: NormalizedMessage[] | null = null;
  let nextHasMore = previousHasMore;

  // A page with no older rows is the complete authoritative transcript. This
  // also removes cached rows after a provider-side truncation.
  if (!latestPage.hasMore) {
    nextServerMessages = latestPage.messages;
    nextHasMore = false;
  } else if (previousServerMessages.length === 0) {
    nextServerMessages = latestPage.messages;
    nextHasMore = true;
  } else {
    let fetchedWindow = latestPage.messages;
    let oldestFetchedPage = latestPage;
    let bridgeRowsFetched = 0;
    let reachedStartOfHistory = false;
    let mergedPage = mergeLatestServerPage(previousServerMessages, fetchedWindow);

    while (
      mergedPage.overlapLength === 0
      && !hasReachedCachedTailTimeBoundary(previousServerMessages, fetchedWindow)
    ) {
      const bridgeRequest = planLatestPageBridge(
        previousServerMessages,
        latestPage.messages,
        previousTotal,
        latestPage.total,
        bridgeRowsFetched,
      );
      if (!bridgeRequest) break;
      if (!canRequest()) {
        return { applied: false, changed: false, deferred: true };
      }
      // A later-started fetch already applied while we were bridging — its
      // transcript is fresher than anything this reconciliation could stitch.
      if (fetchTicket <= slot._appliedFetchSeq) {
        return { applied: false, changed: false, deferred: false };
      }

      const bridgePage = await request(sessionId, bridgeRequest);
      if (bridgePage.total !== latestPage.total) {
        console.warn(`[SessionStore] History changed while bridging ${sessionId}; retaining cached suffix.`);
        return { applied: false, changed: false, deferred: false, unbridged: true };
      }
      if (bridgePage.messages.length === 0) break;

      const bridgeMerge = mergeOlderServerPage(fetchedWindow, bridgePage.messages);
      if (
        bridgeMerge.overlapLength > 0
        || !olderPagePrecedesCachedHistory(bridgePage.messages, fetchedWindow)
      ) {
        console.warn(`[SessionStore] History shifted while bridging ${sessionId}; retaining cached suffix.`);
        return { applied: false, changed: false, deferred: false, unbridged: true };
      }

      fetchedWindow = bridgeMerge.messages;
      oldestFetchedPage = bridgePage;
      bridgeRowsFetched += bridgePage.messages.length;
      mergedPage = mergeLatestServerPage(previousServerMessages, fetchedWindow);

      if (!bridgePage.hasMore) {
        reachedStartOfHistory = true;
        break;
      }
    }

    if (reachedStartOfHistory) {
      nextServerMessages = fetchedWindow;
      nextHasMore = false;
    } else if (mergedPage.overlapLength > 0) {
      // An older page may have been prepended while this refresh was in
      // flight; stitch onto the current cache so those rows are kept.
      if (slot.serverMessages !== previousServerMessages) {
        const rebased = mergeLatestServerPage(slot.serverMessages, fetchedWindow);
        if (rebased.overlapLength > 0) mergedPage = rebased;
      }
      nextServerMessages = mergedPage.messages;
      nextHasMore = resolveLatestPagePagination(
        previousServerMessages.length,
        nextServerMessages.length,
        previousHasMore,
        oldestFetchedPage.hasMore,
      ).hasMore;
    }
  }

  // A later-started fetch already applied: applying this stale reconciliation
  // would erase rows the user has already seen (and re-prune realtime rows
  // against an outdated snapshot).
  if (fetchTicket <= slot._appliedFetchSeq) {
    return { applied: false, changed: false, deferred: false };
  }

  let changed = false;
  if (
    latestPage.tokenUsage !== undefined
    && !hasEquivalentTokenUsage(latestPage.tokenUsage, slot.tokenUsage)
  ) {
    slot.tokenUsage = latestPage.tokenUsage;
    changed = true;
  }

  if (!nextServerMessages) {
    console.warn(`[SessionStore] Could not bridge latest history for ${sessionId}; retaining cached suffix.`);
    return { applied: false, changed, deferred: false, unbridged: true };
  }

  slot._appliedFetchSeq = fetchTicket;
  slot.serverMessages = carryOverRowIdentity(slot.serverMessages, nextServerMessages);
  slot.total = latestPage.total;
  slot.offset = slot.serverMessages.length;
  slot.hasMore = nextHasMore;
  slot.historyPending = latestPage.pending;
  slot.historyRefreshing = latestPage.refreshing;
  // A pending/refreshing snapshot must not count as fresh cache.
  slot.fetchedAt = latestPage.pending || latestPage.refreshing ? 0 : Date.now();
  // Only drop realtime rows the server transcript now owns (done inside
  // recomputeMergedIfNeeded). A blind clear here caused the chat pane to flash
  // "Continue your conversation" after `complete` while JSONL /
  // provider_session_id indexing was still behind.
  recomputeMergedIfNeeded(slot);

  return { applied: true, changed: true, deferred: false };
}

/**
 * One history request applied to a slot (initial page, "Load all", search).
 * Reports how it ended so callers can retry failures and not-yet-persisted
 * history instead of treating them as an empty transcript.
 */
export async function fetchSlotHistory(
  sessionId: string,
  slot: SessionSlot,
  opts: { limit?: number | null; offset?: number },
  onChange: () => void = () => {},
  request: HistoryPageRequester = requestSessionHistoryPage,
): Promise<HistoryFetchOutcome> {
  const fetchTicket = ++slot._fetchSeq;
  slot.status = 'loading';
  onChange();

  try {
    const page = await request(sessionId, { limit: opts.limit, offset: opts.offset ?? 0 });

    // A later-started fetch already applied: this response is stale.
    if (fetchTicket <= slot._appliedFetchSeq) return 'superseded';

    if (page.pending && page.messages.length === 0) {
      // Keep whatever is cached; the caller retries with backoff.
      slot.historyPending = true;
      slot.fetchedAt = 0;
      slot.status = 'idle';
      onChange();
      return 'pending';
    }

    slot._appliedFetchSeq = fetchTicket;
    slot.serverMessages = carryOverRowIdentity(slot.serverMessages, page.messages);
    slot.total = page.total;
    slot.hasMore = page.hasMore;
    slot.offset = (opts.offset ?? 0) + page.messages.length;
    slot.historyPending = page.pending;
    slot.historyRefreshing = page.refreshing;
    // A pending/refreshing snapshot must not count as fresh cache.
    slot.fetchedAt = page.pending || page.refreshing ? 0 : Date.now();
    slot.status = 'idle';
    recomputeMergedIfNeeded(slot);
    if (page.tokenUsage) slot.tokenUsage = page.tokenUsage;
    onChange();
    return page.pending ? 'pending' : 'applied';
  } catch (error) {
    console.error(`[SessionStore] fetch failed for ${sessionId}:`, error);
    // Don't clobber a newer fetch's result with a stale failure.
    if (fetchTicket > slot._appliedFetchSeq) {
      slot.status = 'error';
      onChange();
      return 'error';
    }
    return 'superseded';
  }
}

/**
 * Loads the next older page and prepends it to `slot.serverMessages`.
 *
 * Offsets count from the newest row, so turns persisted while the user reads
 * older history shift the requested window newer: the page is merged with
 * duplicate removal instead of a raw prepend, and `total` is kept current.
 * A page superseded by a later-started full fetch/refresh, or one lying
 * entirely inside the cache, is re-requested rather than looking like
 * "nothing older". Returns true when slot state changed.
 */
export async function fetchOlderSlotPage(
  sessionId: string,
  slot: SessionSlot,
  limit: number,
  request: HistoryPageRequester = requestSessionHistoryPage,
): Promise<boolean> {
  let changed = false;
  for (let attempt = 0; attempt < 3 && slot.hasMore; attempt++) {
    const fetchTicket = ++slot._fetchSeq;
    const requestOffset = slot.offset;
    const requestTotal = slot.total;

    let page: SessionHistoryPage;
    try {
      page = await request(sessionId, { limit, offset: requestOffset });
    } catch (error) {
      console.error(`[SessionStore] fetchMore failed for ${sessionId}:`, error);
      return changed;
    }

    // A later-started full fetch/refresh replaced serverMessages while this
    // page was in flight; its offset no longer describes the cache.
    if (fetchTicket <= slot._appliedFetchSeq) continue;

    const merge = mergeOlderServerPageWithoutDuplicates(
      slot.serverMessages,
      page.messages,
      page.total !== requestTotal,
    );
    slot.total = page.total;
    slot.hasMore = page.hasMore;
    slot.offset = resolveOlderPageOffset(requestOffset, page.messages.length, merge.messages.length);
    changed = true;

    if (merge.prependedCount > 0) {
      slot.serverMessages = merge.messages;
      recomputeMergedIfNeeded(slot);
      return true;
    }
    // Entire window was already cached (the tail grew by >= one page while
    // reading): step past it instead of reporting "no older messages".
    if (page.messages.length === 0) return changed;
  }
  return changed;
}

// ─── Stale threshold ─────────────────────────────────────────────────────────

const STALE_THRESHOLD_MS = 30_000;

// ─── Hook ────────────────────────────────────────────────────────────────────

export function useSessionStore() {
  const storeRef = useRef(new Map<string, SessionSlot>());
  const nextStreamRowRef = useRef(0);
  const activeSessionIdRef = useRef<string | null>(null);
  // Bump to force re-render — only when the active session's data changes.
  // Session ids are stable for the whole conversation lifetime (the backend
  // allocates them before the first send), so slots are keyed directly with
  // no alias/redirect indirection.
  const [, setTick] = useState(0);
  const notify = useCallback((sessionId: string) => {
    if (sessionId === activeSessionIdRef.current) {
      setTick(n => n + 1);
    }
  }, []);

  const setActiveSession = useCallback((sessionId: string | null) => {
    activeSessionIdRef.current = sessionId;
  }, []);

  const getSlot = useCallback((sessionId: string): SessionSlot => {
    const store = storeRef.current;
    if (!store.has(sessionId)) {
      store.set(sessionId, createEmptySlot());
    }
    return store.get(sessionId)!;
  }, []);

  const has = useCallback((sessionId: string) => {
    return storeRef.current.has(sessionId);
  }, []);

  /**
   * Fetch messages from the provider sessions endpoint and populate serverMessages.
   *
   * Provider and project metadata are resolved server-side from `sessionId`.
   * The endpoint returns the standard `{ success, data }` envelope. The
   * detailed variant reports how the request ended so the chat view can retry
   * failures and not-yet-persisted history instead of showing an empty chat.
   */
  const fetchFromServerDetailed = useCallback(async (
    sessionId: string,
    opts: {
      limit?: number | null;
      offset?: number;
    } = {},
  ): Promise<HistoryFetchResult> => {
    const slot = getSlot(sessionId);
    const outcome = await fetchSlotHistory(sessionId, slot, opts, () => notify(sessionId));
    return { slot, outcome };
  }, [getSlot, notify]);

  const fetchFromServer = useCallback(async (
    sessionId: string,
    opts: {
      limit?: number | null;
      offset?: number;
    } = {},
  ) => (await fetchFromServerDetailed(sessionId, opts)).slot, [fetchFromServerDetailed]);

  /**
   * Load the next older (paginated) page and prepend it to serverMessages.
   *
   * Offsets count from the newest row, so turns persisted while the user reads
   * older history shift the requested window newer: the page is merged with
   * duplicate removal instead of a raw prepend, and `total` is kept current.
   * A page superseded by a newer full fetch/refresh is re-requested against
   * the new cache rather than silently looking like "nothing older".
   */
  const fetchMore = useCallback(async (
    sessionId: string,
    opts: {
      limit?: number;
    } = {},
  ) => {
    const slot = getSlot(sessionId);
    const changed = await fetchOlderSlotPage(sessionId, slot, opts.limit ?? SESSION_MESSAGES_PAGE_SIZE);
    if (changed) notify(sessionId);
    return slot;
  }, [getSlot, notify]);

  /**
   * Append a realtime (WebSocket) message to the correct session slot.
   * This works regardless of which session is actively viewed.
   */
  const appendRealtime = useCallback((sessionId: string, msg: NormalizedMessage) => {
    const slot = getSlot(sessionId);
    const normalizedMessage =
      msg.sessionId === sessionId
        ? msg
        : { ...msg, sessionId };
    // No cap while streaming: dropping the oldest live rows on long runs
    // silently lost output that was not persisted yet. Rows leave once a
    // server write owns them (recomputeMergedIfNeeded), e.g. the run-complete
    // latest refresh; settled background sessions are bounded separately
    // (trimSettledRealtime). Merging stays O(live + server) via the cached
    // server index in sessionStoreMerge.
    slot.realtimeMessages = [...slot.realtimeMessages, normalizedMessage];
    recomputeMergedIfNeeded(slot);
    notify(sessionId);
  }, [getSlot, notify]);

  /**
   * Append multiple realtime messages at once (batch).
   */
  const appendRealtimeBatch = useCallback((sessionId: string, msgs: NormalizedMessage[]) => {
    if (msgs.length === 0) return;
    const slot = getSlot(sessionId);
    const normalizedMessages = msgs.map((msg) =>
      msg.sessionId === sessionId
        ? msg
        : { ...msg, sessionId },
    );
    slot.realtimeMessages = [...slot.realtimeMessages, ...normalizedMessages];
    recomputeMergedIfNeeded(slot);
    notify(sessionId);
  }, [getSlot, notify]);

  /**
   * Re-sync serverMessages with the persisted transcript.
   *
   * This used to re-download the ENTIRE transcript (no limit/offset) on every
   * automatic refresh — megabytes per completed turn on long sessions. It now
   * fetches only the newest page and stitches it onto the cached suffix via
   * the bounded tail reconciliation, preserving pagination state. Explicit
   * "Load all" still goes through `fetchFromServer(limit: null)`.
   */
  const refreshFromServer = useCallback(async (
    sessionId: string,
  ) => {
    const slot = getSlot(sessionId);
    try {
      const result = await refreshLatestSlotFromServer(
        sessionId,
        slot,
        SESSION_MESSAGES_PAGE_SIZE,
      );
      if (result.changed) notify(sessionId);
    } catch (error) {
      console.error(`[SessionStore] refresh failed for ${sessionId}:`, error);
    }
  }, [getSlot, notify]);

  /**
   * Refreshes only the persisted tail and stitches it onto the contiguous
   * cached suffix. Large turns request a small offset bridge rather than the
   * whole transcript, and the final state is applied atomically. `canRequest`
   * is consulted before every network request so hidden/inactive panes can
   * defer instead of fetching.
   */
  const refreshLatestFromServer = useCallback(async (
    sessionId: string,
    opts: {
      limit?: number;
      canRequest?: CanRequestHistory;
    } = {},
  ): Promise<LatestHistoryRefreshResult> => {
    const slot = getSlot(sessionId);
    try {
      const result = await refreshLatestSlotFromServer(
        sessionId,
        slot,
        opts.limit ?? SESSION_MESSAGES_PAGE_SIZE,
        opts.canRequest,
      );
      if (result.changed) notify(sessionId);
      return { slot, ...result };
    } catch (error) {
      console.error(`[SessionStore] latest refresh failed for ${sessionId}:`, error);
      return { slot, applied: false, changed: false, deferred: false, failed: true };
    }
  }, [getSlot, notify]);

  /**
   * Update session status.
   */
  const setStatus = useCallback((sessionId: string, status: SessionStatus) => {
    const slot = getSlot(sessionId);
    slot.status = status;
    notify(sessionId);
  }, [getSlot, notify]);

  /**
   * Check if a session's data is stale (>30s old).
   */
  const isStale = useCallback((sessionId: string) => {
    const slot = storeRef.current.get(sessionId);
    if (!slot) return true;
    return Date.now() - slot.fetchedAt > STALE_THRESHOLD_MS;
  }, []);

  /**
   * Update or create a streaming message (accumulated text so far).
   * Uses a well-known ID so subsequent calls replace the same message.
   * Timestamp is frozen on first create so the bubble clock does not tick every flush.
   * Finalize keeps the same id (no remount); the next stream renames the prior
   * finalized row only when a new stream_delta needs the well-known slot again.
   */
  const updateStreaming = useCallback((sessionId: string, accumulatedText: string, msgProvider: LLMProvider) => {
    const slot = getSlot(sessionId);
    const streamId = `__streaming_${sessionId}`;
    let idx = slot.realtimeMessages.findIndex(m => m.id === streamId);

    // Previous stream was finalized while keeping the well-known id — mint a
    // permanent id for that row so React can keep its DOM, then open a fresh slot.
    if (idx >= 0 && slot.realtimeMessages[idx].kind !== 'stream_delta') {
      const prev = slot.realtimeMessages[idx];
      slot.realtimeMessages = [...slot.realtimeMessages];
      slot.realtimeMessages[idx] = {
        ...prev,
        id: `text_${sessionId}_${Date.now().toString(36)}`,
      };
      idx = -1;
    }

    if (idx >= 0) {
      const existing = slot.realtimeMessages[idx];
      slot.realtimeMessages = [...slot.realtimeMessages];
      slot.realtimeMessages[idx] = {
        ...existing,
        content: accumulatedText,
        provider: msgProvider,
        // preserve id + timestamp across flushes
      };
    } else {
      slot.realtimeMessages = [
        ...slot.realtimeMessages,
        {
          id: streamId,
          renderId: `stream-row-${sessionId}-${++nextStreamRowRef.current}`,
          sessionId,
          timestamp: new Date().toISOString(),
          provider: msgProvider,
          kind: 'stream_delta',
          content: accumulatedText,
        },
      ];
    }
    recomputeMergedIfNeeded(slot);
    notify(sessionId);
  }, [getSlot, notify]);

  /**
   * Finalize streaming: convert the streaming message to a regular text message.
   * Keeps the same id so MessageComponent does not remount on stream end.
   */
  const finalizeStreaming = useCallback((sessionId: string) => {
    const slot = storeRef.current.get(sessionId);
    if (!slot) return;
    const streamId = `__streaming_${sessionId}`;
    const idx = slot.realtimeMessages.findIndex(m => m.id === streamId);
    if (idx >= 0) {
      const stream = slot.realtimeMessages[idx];
      slot.realtimeMessages = [...slot.realtimeMessages];
      slot.realtimeMessages[idx] = {
        ...stream,
        kind: 'text',
        role: 'assistant',
      };
      recomputeMergedIfNeeded(slot);
      notify(sessionId);
    }
  }, [notify]);

  /**
   * Mirrors updateStreaming, but for a live `thinking` burst instead of the
   * assistant reply text. Providers that stream reasoning token-by-token
   * (Grok's `thought` events, Kimi ACP's `agent_thought_chunk`) emit one
   * NormalizedMessage per token with no accumulation of their own - without
   * this, every single token would render as its own separate "Thought for a
   * few seconds" block instead of one growing block per reasoning burst.
   */
  const updateThinkingStream = useCallback((sessionId: string, accumulatedText: string, msgProvider: LLMProvider) => {
    const slot = getSlot(sessionId);
    const streamId = `__thinking_stream_${sessionId}`;
    let idx = slot.realtimeMessages.findIndex(m => m.id === streamId);

    if (idx >= 0 && slot.realtimeMessages[idx].kind !== 'thinking') {
      const prev = slot.realtimeMessages[idx];
      slot.realtimeMessages = [...slot.realtimeMessages];
      slot.realtimeMessages[idx] = {
        ...prev,
        id: `thinking_${sessionId}_${Date.now().toString(36)}`,
      };
      idx = -1;
    }

    if (idx >= 0) {
      const existing = slot.realtimeMessages[idx];
      slot.realtimeMessages = [...slot.realtimeMessages];
      slot.realtimeMessages[idx] = {
        ...existing,
        content: accumulatedText,
        provider: msgProvider,
      };
    } else {
      slot.realtimeMessages = [
        ...slot.realtimeMessages,
        {
          id: streamId,
          renderId: `stream-row-${sessionId}-${++nextStreamRowRef.current}`,
          sessionId,
          timestamp: new Date().toISOString(),
          provider: msgProvider,
          kind: 'thinking',
          content: accumulatedText,
        },
      ];
    }
    recomputeMergedIfNeeded(slot);
    notify(sessionId);
  }, [getSlot, notify]);

  /**
   * Finalize a live thinking burst: give the well-known streaming id a
   * permanent unique one so a subsequent burst (e.g. after the next tool
   * call) starts a fresh block instead of continuing to grow this one.
   * Thinking blocks are usually collapsed, so the remount cost is acceptable.
   */
  const finalizeThinkingStream = useCallback((sessionId: string) => {
    const slot = storeRef.current.get(sessionId);
    if (!slot) return;
    const streamId = `__thinking_stream_${sessionId}`;
    const idx = slot.realtimeMessages.findIndex(m => m.id === streamId);
    if (idx >= 0) {
      const stream = slot.realtimeMessages[idx];
      slot.realtimeMessages = [...slot.realtimeMessages];
      slot.realtimeMessages[idx] = {
        ...stream,
        id: `thinking_${sessionId}_${Date.now().toString(36)}`,
      };
      recomputeMergedIfNeeded(slot);
      notify(sessionId);
    }
  }, [notify]);

  /**
   * Clear realtime messages for a session (e.g., after stream completes and server fetch catches up).
   */
  const clearRealtime = useCallback((sessionId: string) => {
    const slot = storeRef.current.get(sessionId);
    if (slot) {
      slot.realtimeMessages = [];
      recomputeMergedIfNeeded(slot);
      notify(sessionId);
    }
  }, [notify]);

  /**
   * Bound a settled background session's live rows (see
   * MAX_SETTLED_REALTIME_MESSAGES). The caller guarantees no run is in flight
   * for `sessionId`; the viewed session is never trimmed here — its rows are
   * pruned by the post-run refresh instead.
   */
  const trimSettledRealtime = useCallback((sessionId: string, maxRows?: number) => {
    if (sessionId === activeSessionIdRef.current) return false;
    const slot = storeRef.current.get(sessionId);
    if (!slot) return false;
    return trimSettledRealtimeRows(slot, maxRows);
  }, []);

  /**
   * Get merged messages for a session (for rendering).
   */
  const getMessages = useCallback((sessionId: string): NormalizedMessage[] => {
    return storeRef.current.get(sessionId)?.merged ?? [];
  }, []);

  /**
   * Get session slot (for status, pagination info, etc.).
   */
  const getSessionSlot = useCallback((sessionId: string): SessionSlot | undefined => {
    return storeRef.current.get(sessionId);
  }, []);

  return useMemo(() => ({
    getSlot,
    has,
    fetchFromServer,
    fetchFromServerDetailed,
    fetchMore,
    appendRealtime,
    appendRealtimeBatch,
    refreshFromServer,
    refreshLatestFromServer,
    setActiveSession,
    setStatus,
    isStale,
    updateStreaming,
    finalizeStreaming,
    updateThinkingStream,
    finalizeThinkingStream,
    clearRealtime,
    trimSettledRealtime,
    getMessages,
    getSessionSlot,
  }), [
    getSlot, has, fetchFromServer, fetchFromServerDetailed, fetchMore,
    appendRealtime, appendRealtimeBatch, refreshFromServer, refreshLatestFromServer,
    setActiveSession, setStatus, isStale, updateStreaming, finalizeStreaming,
    updateThinkingStream, finalizeThinkingStream,
    clearRealtime, trimSettledRealtime, getMessages, getSessionSlot,
  ]);
}

export type SessionStore = ReturnType<typeof useSessionStore>;
