/**
 * Pure merge/dedupe pipeline for the session store (useSessionStore).
 *
 * Server rows come from the provider transcript (REST history); realtime rows
 * come from the live websocket stream. After a run completes, the refreshed
 * transcript contains the same turn the stream already showed, so this module
 * decides which realtime rows the server now owns (prune) and collapses
 * remaining adjacent echoes (dedupe). Kept hook-free so it can be unit-tested
 * directly.
 */

import type { NormalizedMessage } from './useSessionStore';

const LOCAL_USER_DEDUPE_WINDOW_MS = 5 * 60 * 1000;
const LOCAL_USER_DEDUPE_CLOCK_SKEW_MS = 10_000;

function userTextFingerprint(m: NormalizedMessage): string | null {
  if (m.kind !== 'text' || m.role !== 'user') return null;
  const t = (m.content || '').trim();
  return t.length > 0 ? t : null;
}

function readMessageTime(m: NormalizedMessage): number | null {
  const time = Date.parse(m.timestamp);
  return Number.isFinite(time) ? time : null;
}

function compareMessagesChronologically(a: NormalizedMessage, b: NormalizedMessage): number {
  const timeA = readMessageTime(a) ?? 0;
  const timeB = readMessageTime(b) ?? 0;
  if (timeA !== timeB) {
    return timeA - timeB;
  }
  return 0;
}

/** Merge ordered sources without re-sorting either provider history or socket order. */
export function mergeOrderedMessages(
  server: NormalizedMessage[], realtime: NormalizedMessage[],
): NormalizedMessage[] {
  const merged: NormalizedMessage[] = [];
  let next = 0;
  for (const message of realtime) {
    while (next < server.length && compareMessagesChronologically(server[next], message) <= 0) {
      merged.push(server[next++]);
    }
    merged.push(message);
  }
  merged.push(...server.slice(next));
  return merged;
}

// ─── Server-side lookup index ────────────────────────────────────────────────
//
// Every merge used to linearly scan the server rows once per live row (tool
// rows by toolId, optimistic user rows by text, assistant echoes by turn), so
// a long tool-heavy run cost O(live × server) on every append and 100ms stream
// flush. The index below turns each lookup into a hash hit. Server arrays are
// never mutated in place (every write replaces the array), so the index is
// cached per array reference and only rebuilt when serverMessages changes.

type TimedServerRow = { index: number; time: number | null };

type ServerMessageIndex = {
  /** Last index per id (a later duplicate wins, as the old Map build did). */
  indexById: Map<string, number>;
  /** First persisted `tool_use` per toolId. */
  toolUseByToolId: Map<string, number>;
  /** First `tool_result` (or `tool_use` carrying an inline result) per toolId. */
  toolResultOwnerByToolId: Map<string, number>;
  /** User text rows by trimmed text, in server order. */
  userRowsByText: Map<string, TimedServerRow[]>;
  /** Server indices of every user text row (turn starts), ascending. */
  userTurnStarts: number[];
  /** `kind\0content` → ascending indices of echo-capable rows (built lazily). */
  contentEchoes: Map<string, number[]> | null;
};

const serverIndexCache = new WeakMap<NormalizedMessage[], ServerMessageIndex>();

function getServerIndex(serverMessages: NormalizedMessage[]): ServerMessageIndex {
  const cached = serverIndexCache.get(serverMessages);
  if (cached) return cached;

  const index: ServerMessageIndex = {
    indexById: new Map(),
    toolUseByToolId: new Map(),
    toolResultOwnerByToolId: new Map(),
    userRowsByText: new Map(),
    userTurnStarts: [],
    contentEchoes: null,
  };
  serverMessages.forEach((message, position) => {
    index.indexById.set(message.id, position);
    if (message.kind === 'text' && message.role === 'user') {
      index.userTurnStarts.push(position);
    }
    const userText = userTextFingerprint(message);
    if (userText) {
      const rows = index.userRowsByText.get(userText);
      const row = { index: position, time: readMessageTime(message) };
      if (rows) rows.push(row);
      else index.userRowsByText.set(userText, [row]);
    }
    if (message.toolId) {
      if (message.kind === 'tool_use' && !index.toolUseByToolId.has(message.toolId)) {
        index.toolUseByToolId.set(message.toolId, position);
      }
      if (
        (message.kind === 'tool_result' || (message.kind === 'tool_use' && Boolean(message.toolResult)))
        && !index.toolResultOwnerByToolId.has(message.toolId)
      ) {
        index.toolResultOwnerByToolId.set(message.toolId, position);
      }
    }
  });
  serverIndexCache.set(serverMessages, index);
  return index;
}

function contentEchoKey(kind: string, content: string): string {
  return `${kind}\u0000${content}`;
}

function getContentEchoes(
  serverMessages: NormalizedMessage[],
  index: ServerMessageIndex,
): Map<string, number[]> {
  if (index.contentEchoes) return index.contentEchoes;
  const echoes = new Map<string, number[]>();
  serverMessages.forEach((message, position) => {
    if (message.kind === 'text' && message.role !== 'assistant') return;
    const content = (message.content || '').trim();
    if (!content) return;
    const key = contentEchoKey(message.kind, content);
    const positions = echoes.get(key);
    if (positions) positions.push(position);
    else echoes.set(key, [position]);
  });
  index.contentEchoes = echoes;
  return echoes;
}

/** First element of an ascending array strictly greater than `value`. */
function upperBound(values: ArrayLike<number>, value: number): number {
  let lo = 0;
  let hi = values.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (values[mid] > value) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/**
 * The first server user row carrying `localMessage`'s text inside its send
 * window, or -1. Optimistic `local_*` rows use this to find their echo.
 */
function findServerEchoIndexForLocalUser(
  localMessage: NormalizedMessage,
  index: ServerMessageIndex,
): number {
  const localText = userTextFingerprint(localMessage);
  const localTime = readMessageTime(localMessage);
  if (!localText || localTime === null) return -1;
  const rows = index.userRowsByText.get(localText);
  if (!rows) return -1;
  for (const row of rows) {
    if (
      row.time !== null
      && row.time >= localTime - LOCAL_USER_DEDUPE_CLOCK_SKEW_MS
      && row.time - localTime <= LOCAL_USER_DEDUPE_WINDOW_MS
    ) {
      return row.index;
    }
  }
  return -1;
}

/**
 * Builds a lookup for how many user turns precede a message in the
 * chronologically merged view of server + realtime rows. Used to match a
 * realtime row to the correct turn on disk when several turns share identical
 * assistant text. The merged view is sorted once per reconciliation (it used
 * to be re-sorted for every live row).
 */
function createUserTurnOrdinalLookup(
  serverMessages: NormalizedMessage[],
  realtimeMessages: NormalizedMessage[],
): (message: NormalizedMessage) => number {
  const sorted = [...serverMessages, ...realtimeMessages].sort(compareMessagesChronologically);
  const sortKeys = new Float64Array(sorted.length);
  const usersBefore = new Int32Array(sorted.length + 1);
  const firstPositionById = new Map<string, number>();
  sorted.forEach((candidate, position) => {
    sortKeys[position] = readMessageTime(candidate) ?? 0;
    usersBefore[position + 1] = usersBefore[position]
      + (candidate.kind === 'text' && candidate.role === 'user' ? 1 : 0);
    if (!firstPositionById.has(candidate.id)) firstPositionById.set(candidate.id, position);
  });

  return (message) => {
    // Walk order: stop at the message itself, or at the first dated row that
    // is newer than it (undated rows sort as time 0 and never stop the walk).
    let stop = firstPositionById.get(message.id) ?? sorted.length;
    const messageTime = readMessageTime(message);
    if (messageTime !== null) {
      let newer = upperBound(sortKeys, messageTime);
      while (newer < sorted.length && readMessageTime(sorted[newer]) === null) newer++;
      stop = Math.min(stop, newer);
    }
    return Math.max(0, usersBefore[stop] - 1);
  };
}

/**
 * The server row that already carries `message`'s content in the same user
 * turn, or -1. Works for any content kind whose echo looks identical on disk
 * and on the wire: assistant `text` (finalized stream slot) and `thinking`
 * (providers like Kilo/OpenCode persist reasoning parts).
 */
function findContentEchoInSameTurnOnServer(
  message: NormalizedMessage,
  serverMessages: NormalizedMessage[],
  index: ServerMessageIndex,
  turnOrdinalOf: (message: NormalizedMessage) => number,
): number {
  const content = (message.content || '').trim();
  if (!content) {
    return -1;
  }

  const turnOrdinal = turnOrdinalOf(message);
  const start = index.userTurnStarts[turnOrdinal];
  if (start === undefined) {
    return -1;
  }
  const end = index.userTurnStarts[turnOrdinal + 1] ?? serverMessages.length;

  const positions = getContentEchoes(serverMessages, index).get(contentEchoKey(message.kind, content));
  if (!positions) return -1;
  const first = positions[upperBound(positions, start)];
  return first !== undefined && first < end ? first : -1;
}

/**
 * The server row owning a live tool row with the same toolId: a persisted
 * `tool_use` for a live `tool_use`, and a persisted `tool_result` (or a
 * `tool_use` carrying its inline result) for a live `tool_result`.
 */
function findServerToolRow(
  message: NormalizedMessage,
  index: ServerMessageIndex,
): number {
  if (!message.toolId) return -1;
  if (message.kind === 'tool_use') {
    return index.toolUseByToolId.get(message.toolId) ?? -1;
  }
  if (message.kind === 'tool_result') {
    return index.toolResultOwnerByToolId.get(message.toolId) ?? -1;
  }
  return -1;
}

/**
 * The rendered-position row before `index`: `stream_end` rows come from the
 * transcript's step-finish parts and render as nothing, but they sort between
 * a persisted assistant row and its realtime echo (the stream slot's frozen
 * timestamp lands right at turn end) — treating them as adjacency-breakers
 * would defeat every echo collapse below.
 */
function findRenderedRowIndexBefore(out: NormalizedMessage[]): number {
  for (let index = out.length - 1; index >= 0; index--) {
    if (out[index].kind !== 'stream_end') {
      return index;
    }
  }
  return -1;
}

/**
 * After `finalizeStreaming`, the client holds synthetic assistant rows while
 * the sessions API soon returns the same reply with a different id. Those sit
 * back-to-back in merged order and look like duplicate bubbles until
 * `refreshFromServer` clears realtime. Collapse same-content assistant rows:
 * stream_delta → text, text → text, and thinking → thinking (Kilo/OpenCode
 * persist the reasoning the stream already showed).
 */
export function dedupeAdjacentAssistantEchoes(merged: NormalizedMessage[]): NormalizedMessage[] {
  const out: NormalizedMessage[] = [];
  for (const m of merged) {
    const prevIndex = findRenderedRowIndexBefore(out);
    if (prevIndex >= 0) {
      const prev = out[prevIndex];
      if (prev.kind === 'stream_delta' && m.kind === 'text' && m.role === 'assistant') {
        const ps = (prev.content || '').trim();
        const ms = (m.content || '').trim();
        if (ps.length > 0 && ps === ms) {
          out[prevIndex] = m;
          continue;
        }
      }
      if (
        prev.kind === 'text'
        && m.kind === 'text'
        && prev.role === 'assistant'
        && m.role === 'assistant'
      ) {
        const ms = (m.content || '').trim();
        if (ms.length > 0 && ms === (prev.content || '').trim()) {
          continue;
        }
      }
      if (prev.kind === 'thinking' && m.kind === 'thinking') {
        const ms = (m.content || '').trim();
        if (ms.length > 0 && ms === (prev.content || '').trim()) {
          continue;
        }
      }
    }
    out.push(m);
  }
  return out;
}

export type RealtimeServerReconciliation = {
  serverMessages: NormalizedMessage[];
  realtimeMessages: NormalizedMessage[];
};

/**
 * After a server write, drop only the realtime rows the persisted transcript
 * already owns. Anything not yet on disk (common right after `complete`, while
 * JSONL indexing lags) stays in `realtimeMessages` so the chat pane never
 * flashes the empty "Continue your conversation" state.
 *
 * A dropped live row hands its render identity (`renderId`, else its id) to
 * the server row that replaced it, so React keeps the DOM node — and the
 * scroll anchor — instead of remounting a `local_*` / `stream-row-*` row as a
 * freshly keyed persisted row. Only server rows in `isNewServerRow` (default:
 * all) without their own renderId receive it, so already-rendered rows keep
 * their keys. Returns the input arrays themselves when nothing changed.
 */
export function reconcileRealtimeWithServer(
  serverMessages: NormalizedMessage[],
  realtimeMessages: NormalizedMessage[],
  isNewServerRow: (message: NormalizedMessage) => boolean = () => true,
): RealtimeServerReconciliation {
  if (realtimeMessages.length === 0 || serverMessages.length === 0) {
    return { serverMessages, realtimeMessages };
  }

  const serverIndex = getServerIndex(serverMessages);
  const matches = new Map<NormalizedMessage, number>();

  // Pass 1: id matches and optimistic user echoes. These must leave the array
  // BEFORE the turn-ordinal matching below — a dropped `local_*` user row
  // still counts as a turn when it stays in the reference array, which pushed
  // later-turn assistant rows one ordinal past their real server turn and
  // kept their echo alive as a duplicate bubble.
  const survivors = realtimeMessages.filter((message) => {
    const sameId = serverIndex.indexById.get(message.id);
    if (sameId !== undefined) {
      matches.set(message, sameId);
      return false;
    }
    if (message.id.startsWith('local_')) {
      const echo = findServerEchoIndexForLocalUser(message, serverIndex);
      if (echo >= 0) {
        matches.set(message, echo);
        return false;
      }
    }
    return true;
  });

  // Pass 2: content/tool echoes, matched against the surviving realtime rows only.
  let turnOrdinalOf: ((message: NormalizedMessage) => number) | null = null;
  const remaining = survivors.filter((message) => {
    let match = -1;
    if (
      message.kind === 'stream_delta'
      || message.id === `__streaming_${message.sessionId}`
      || (message.kind === 'text' && message.role === 'assistant')
      || message.kind === 'thinking'
    ) {
      turnOrdinalOf ??= createUserTurnOrdinalLookup(serverMessages, survivors);
      match = findContentEchoInSameTurnOnServer(message, serverMessages, serverIndex, turnOrdinalOf);
    } else if (message.kind === 'text' && message.role === 'user') {
      match = findServerEchoIndexForLocalUser(message, serverIndex);
    } else if (message.kind === 'tool_use' || message.kind === 'tool_result') {
      match = findServerToolRow(message, serverIndex);
    }
    if (match < 0) return true;
    matches.set(message, match);
    return false;
  });

  if (remaining.length === realtimeMessages.length) {
    return { serverMessages, realtimeMessages };
  }

  let nextServer = serverMessages;
  const claimed = new Set<number>();
  for (const [live, index] of matches) {
    const serverRow = nextServer[index];
    // Results render inside their tool_use row; they have no identity to hand over.
    if (live.kind === 'tool_result') continue;
    if (claimed.has(index) || serverRow.renderId || !isNewServerRow(serverRow)) continue;
    claimed.add(index);
    const identity = live.renderId ?? live.id;
    if (identity === serverRow.id) continue;
    if (nextServer === serverMessages) nextServer = [...serverMessages];
    nextServer[index] = { ...serverRow, renderId: identity };
  }

  return { serverMessages: nextServer, realtimeMessages: remaining };
}

export function pruneRealtimeSupersededByServer(
  serverMessages: NormalizedMessage[],
  realtimeMessages: NormalizedMessage[],
): NormalizedMessage[] {
  return reconcileRealtimeWithServer(serverMessages, realtimeMessages).realtimeMessages;
}

/**
 * Compute merged messages: server + realtime, deduped by id and adjacent
 * assistant echo (same trimmed text), so finalized stream rows do not stack
 * on top of the persisted copy before realtime is cleared.
 */
export function computeMerged(server: NormalizedMessage[], realtime: NormalizedMessage[]): NormalizedMessage[] {
  if (realtime.length === 0) {
    return dedupeAdjacentAssistantEchoes(server);
  }
  if (server.length === 0) {
    return dedupeAdjacentAssistantEchoes(realtime);
  }

  const serverIndex = getServerIndex(server);
  const extra = realtime.filter((message) => {
    if (serverIndex.indexById.has(message.id)) {
      return false;
    }
    // Optimistic user rows use `local_*` ids; once the same text exists on the
    // server-backed copy from the same send window, drop the realtime echo to
    // avoid duplicate bubbles without hiding repeated prompts from history.
    if (message.id.startsWith('local_')) {
      if (findServerEchoIndexForLocalUser(message, serverIndex) >= 0) {
        return false;
      }
    }
    // Live tool rows are re-emitted by the transcript under a different id;
    // the toolId is the shared key (otherwise tool rows render twice).
    if ((message.kind === 'tool_use' || message.kind === 'tool_result') && findServerToolRow(message, serverIndex) >= 0) {
      return false;
    }
    return true;
  });

  if (extra.length === 0) {
    return dedupeAdjacentAssistantEchoes(server);
  }

  // Interleave by timestamp so live rows stay with their turn instead of
  // piling up at the bottom after every refresh.
  return dedupeAdjacentAssistantEchoes(
    mergeOrderedMessages(server, extra),
  );
}
