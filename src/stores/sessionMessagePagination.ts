/**
 * Pure tail-offset page-stitching helpers for the session store.
 *
 * The sessions endpoint pages the transcript from the tail (offset 0 = newest
 * page). These helpers let automatic refreshes fetch only the newest page and
 * reconcile it onto the already-cached suffix instead of re-downloading the
 * entire transcript. Kept hook-free so it can be unit-tested directly.
 */

import type { NormalizedMessage } from './useSessionStore';

/**
 * The single client-side page size for session history requests. This replaces
 * the old MESSAGES_PER_PAGE constant in useChatSessionState — keep exactly one.
 */
export const SESSION_MESSAGES_PAGE_SIZE = 20;

export type SessionMessagesRequestOptions = {
  limit?: number | null;
  offset?: number;
};

export type LatestPageMergeResult = {
  messages: NormalizedMessage[];
  overlapLength: number;
};

export type LatestPageBridgeRequest = {
  limit: number;
  offset: number;
};

export type LatestPagePagination = {
  offset: number;
  hasMore: boolean;
};

export type OlderPageMergeResult = {
  messages: NormalizedMessage[];
  overlapLength: number;
  prependedCount: number;
};

/**
 * Builds the unified session-history URL. A finite limit always carries an
 * explicit offset so automatic refreshes can never accidentally become an
 * unbounded transcript request.
 */
export function buildSessionMessagesUrl(
  sessionId: string,
  options: SessionMessagesRequestOptions = {},
): string {
  const params = new URLSearchParams();
  if (options.limit !== null && options.limit !== undefined) {
    params.set('limit', String(options.limit));
    params.set('offset', String(options.offset ?? 0));
  }

  const query = params.toString();
  const base = `/api/providers/sessions/${encodeURIComponent(sessionId)}/messages`;
  return query ? `${base}?${query}` : base;
}

function serializedValue(value: unknown): string {
  if (value === undefined) return '';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Persisted IDs are preferred, but some provider readers (notably Codex)
 * generate fresh IDs on every read. The fallback uses stable transcript fields
 * and deliberately excludes enrichment such as toolResult, which may change
 * when the provider finishes writing a turn.
 */
export function messagesRepresentSamePersistedRow(
  first: NormalizedMessage,
  second: NormalizedMessage,
): boolean {
  if (first.id === second.id) return true;
  if (
    first.provider !== second.provider
    || first.kind !== second.kind
    || first.timestamp !== second.timestamp
    || first.role !== second.role
  ) {
    return false;
  }

  if (first.toolId || second.toolId) return first.toolId === second.toolId;
  if (first.rowid !== undefined || second.rowid !== undefined) return first.rowid === second.rowid;
  if (first.sequence !== undefined || second.sequence !== undefined) return first.sequence === second.sequence;

  return (
    (first.content ?? '') === (second.content ?? '')
    && (first.text ?? '') === (second.text ?? '')
    && (first.toolName ?? '') === (second.toolName ?? '')
    && (first.commandName ?? '') === (second.commandName ?? '')
    && (first.parentToolUseId ?? '') === (second.parentToolUseId ?? '')
    && serializedValue(first.toolInput) === serializedValue(second.toolInput)
  );
}

/** Returns the longest cached-suffix/latest-prefix overlap. */
export function findLatestPageOverlapLength(
  cachedMessages: NormalizedMessage[],
  latestMessages: NormalizedMessage[],
): number {
  const maximum = Math.min(cachedMessages.length, latestMessages.length);

  for (let length = maximum; length > 0; length--) {
    const cachedStart = cachedMessages.length - length;
    let matches = true;
    for (let index = 0; index < length; index++) {
      if (!messagesRepresentSamePersistedRow(cachedMessages[cachedStart + index], latestMessages[index])) {
        matches = false;
        break;
      }
    }
    if (matches) return length;
  }

  return 0;
}

/**
 * Plans the next finite bridge chunk when a single turn added at least one
 * complete latest page. The common case asks for exactly the reported missing
 * rows plus one anchor; later chunks handle provider totals that omit rows.
 */
export function planLatestPageBridge(
  cachedMessages: NormalizedMessage[],
  latestMessages: NormalizedMessage[],
  previousTotal: number,
  nextTotal: number,
  bridgeRowsFetched = 0,
): LatestPageBridgeRequest | null {
  if (
    cachedMessages.length === 0
    || latestMessages.length === 0
    || findLatestPageOverlapLength(cachedMessages, latestMessages) > 0
  ) {
    return null;
  }

  const addedCount = Math.max(0, nextTotal - previousTotal);
  const predictedMissingRows = Math.max(
    0,
    addedCount - latestMessages.length - bridgeRowsFetched,
  );
  const preferredLimit = bridgeRowsFetched === 0
    ? Math.max(1, predictedMissingRows + 1)
    : SESSION_MESSAGES_PAGE_SIZE;

  return {
    offset: latestMessages.length + bridgeRowsFetched,
    limit: preferredLimit,
  };
}

/**
 * Returns true once a backward bridge has reached the time range already
 * represented by the cached tail. This prevents a rewritten transcript with
 * no semantic ID overlap from walking backward through old history forever.
 */
export function hasReachedCachedTailTimeBoundary(
  cachedMessages: NormalizedMessage[],
  fetchedMessages: NormalizedMessage[],
): boolean {
  const cachedNewest = cachedMessages[cachedMessages.length - 1];
  const fetchedOldest = fetchedMessages[0];
  if (!cachedNewest || !fetchedOldest) return false;

  const cachedNewestTime = Date.parse(cachedNewest.timestamp);
  const fetchedOldestTime = Date.parse(fetchedOldest.timestamp);
  if (!Number.isFinite(cachedNewestTime) || !Number.isFinite(fetchedOldestTime)) {
    return false;
  }

  return fetchedOldestTime <= cachedNewestTime;
}

/**
 * Atomically replaces the overlapping cached tail with the latest persisted
 * window while retaining every already-loaded older row.
 */
export function mergeLatestServerPage(
  cachedMessages: NormalizedMessage[],
  latestMessages: NormalizedMessage[],
): LatestPageMergeResult {
  if (cachedMessages.length === 0) {
    return { messages: latestMessages, overlapLength: 0 };
  }
  if (latestMessages.length === 0) {
    return { messages: cachedMessages, overlapLength: 0 };
  }

  const overlapLength = findLatestPageOverlapLength(cachedMessages, latestMessages);
  if (overlapLength === 0) {
    return { messages: cachedMessages, overlapLength: 0 };
  }

  return {
    messages: [
      ...cachedMessages.slice(0, cachedMessages.length - overlapLength),
      ...latestMessages,
    ],
    overlapLength,
  };
}

/**
 * Reconciles a tail-offset older-page response with the cached suffix when the
 * transcript grew while that request was in flight. With no overlap the page
 * is treated as the normal immediately-preceding page.
 */
export function mergeOlderServerPage(
  cachedMessages: NormalizedMessage[],
  olderMessages: NormalizedMessage[],
): OlderPageMergeResult {
  const maximum = Math.min(cachedMessages.length, olderMessages.length);
  let overlapLength = 0;

  for (let length = maximum; length > 0; length--) {
    const olderStart = olderMessages.length - length;
    let matches = true;
    for (let index = 0; index < length; index++) {
      if (!messagesRepresentSamePersistedRow(olderMessages[olderStart + index], cachedMessages[index])) {
        matches = false;
        break;
      }
    }
    if (matches) {
      overlapLength = length;
      break;
    }
  }

  const prependedCount = olderMessages.length - overlapLength;
  return {
    messages: [
      ...olderMessages.slice(0, prependedCount),
      ...cachedMessages,
    ],
    overlapLength,
    prependedCount,
  };
}

/** Preserves the cached oldest-page boundary after a successful tail stitch. */
export function resolveLatestPagePagination(
  previousMessageCount: number,
  mergedMessageCount: number,
  previousHasMore: boolean,
  oldestFetchedPageHasMore: boolean,
): LatestPagePagination {
  return {
    offset: mergedMessageCount,
    hasMore: previousMessageCount === 0
      ? oldestFetchedPageHasMore
      : previousHasMore && oldestFetchedPageHasMore,
  };
}

/**
 * Cheap semantic signature for a persisted row. Mirrors the fields used by
 * `messagesRepresentSamePersistedRow` (minus the id), bounded so very long
 * tool output does not make hashing expensive.
 */
export function persistedRowSignature(message: NormalizedMessage): string {
  const content = message.content ?? message.text ?? '';
  return [
    message.provider,
    message.kind,
    message.timestamp,
    message.role ?? '',
    message.toolId ?? '',
    message.rowid ?? '',
    message.sequence ?? '',
    message.toolName ?? '',
    content.length,
    content.slice(0, 64),
    content.slice(-32),
  ].join('\u0001');
}

/**
 * Keeps React row identity stable across history re-reads.
 *
 * Some provider readers (notably Codex) mint fresh ids on every read, so a
 * refreshed tail or a "Load all" re-download would otherwise re-key — and
 * remount, losing measured heights and the scroll anchor — every row. For
 * each incoming row that does not share an id with a cached row, the cached
 * row's render identity is carried over via `renderId` when the two represent
 * the same persisted row. Rows that already match by id keep any renderId the
 * cached copy carried. Returns `nextMessages` itself when nothing changed.
 */
export function carryOverRowIdentity(
  previousMessages: NormalizedMessage[],
  nextMessages: NormalizedMessage[],
): NormalizedMessage[] {
  if (previousMessages.length === 0 || nextMessages.length === 0) return nextMessages;

  const byId = new Map<string, NormalizedMessage>();
  const bySignature = new Map<string, NormalizedMessage[]>();
  for (const message of previousMessages) {
    byId.set(message.id, message);
    const signature = persistedRowSignature(message);
    const queue = bySignature.get(signature);
    if (queue) queue.push(message);
    else bySignature.set(signature, [message]);
  }

  const claimed = new Set<NormalizedMessage>();
  let changed = false;
  const result = nextMessages.map((message) => {
    const sameId = byId.get(message.id);
    if (sameId) {
      claimed.add(sameId);
      if (sameId.renderId && !message.renderId) {
        changed = true;
        return { ...message, renderId: sameId.renderId };
      }
      return message;
    }
    if (message.renderId) return message;
    const queue = bySignature.get(persistedRowSignature(message));
    const previous = queue?.find((candidate) => (
      !claimed.has(candidate) && messagesRepresentSamePersistedRow(candidate, message)
    ));
    if (!previous) return message;
    claimed.add(previous);
    changed = true;
    return { ...message, renderId: previous.renderId ?? previous.id };
  });

  return changed ? result : nextMessages;
}

export type DriftAwareOlderPageResult = OlderPageMergeResult & {
  /** Rows of the page that were already cached (tail drift / concurrent refresh). */
  duplicateCount: number;
};

/**
 * Prepends an older tail-offset page onto the cached history without
 * duplicates. Offsets are counted from the newest row, so when turns persist
 * while the user reads older history the requested window shifts newer and
 * its newest rows are ones already cached. The contiguous overlap is handled
 * by `mergeOlderServerPage`; when the transcript is known to have changed
 * (`transcriptChanged`) any remaining already-cached rows are dropped too.
 */
export function mergeOlderServerPageWithoutDuplicates(
  cachedMessages: NormalizedMessage[],
  olderMessages: NormalizedMessage[],
  transcriptChanged: boolean,
): DriftAwareOlderPageResult {
  const merged = mergeOlderServerPage(cachedMessages, olderMessages);
  if (!transcriptChanged || merged.prependedCount === 0) {
    return { ...merged, duplicateCount: merged.overlapLength };
  }

  const cachedSignatures = new Set(cachedMessages.map(persistedRowSignature));
  const cachedIds = new Set(cachedMessages.map((message) => message.id));
  // After a large tail growth the shifted window can even contain rows newer
  // than the whole cache; those belong to the tail refresh, never the top.
  const cachedOldestTime = cachedMessages.length > 0 ? Date.parse(cachedMessages[0].timestamp) : Number.NaN;
  const prepended = olderMessages
    .slice(0, merged.prependedCount)
    .filter((message) => {
      if (cachedIds.has(message.id) || cachedSignatures.has(persistedRowSignature(message))) return false;
      const time = Date.parse(message.timestamp);
      return !Number.isFinite(time) || !Number.isFinite(cachedOldestTime) || time <= cachedOldestTime;
    });
  const duplicateCount = olderMessages.length - prepended.length;
  return {
    messages: prepended.length === merged.prependedCount
      ? merged.messages
      : [...prepended, ...cachedMessages],
    overlapLength: merged.overlapLength,
    prependedCount: prepended.length,
    duplicateCount,
  };
}

/** Next tail offset after an older page: never behind what is already cached. */
export function resolveOlderPageOffset(
  requestOffset: number,
  pageLength: number,
  mergedLength: number,
): number {
  return Math.max(requestOffset + pageLength, mergedLength);
}

/** Server hint that the (possibly empty) history response is not final yet. */
export function isHistoryResponsePending(data: unknown): boolean {
  if (!data || typeof data !== 'object') return false;
  const record = data as Record<string, unknown>;
  return Boolean(record.historyPending || record.retryable);
}

/** Server hint that the returned rows are a last-good cache being refreshed. */
export function isHistoryResponseRefreshing(data: unknown): boolean {
  if (!data || typeof data !== 'object') return false;
  return Boolean((data as Record<string, unknown>).historyRefreshing);
}
