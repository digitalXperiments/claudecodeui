import assert from 'node:assert/strict';
import test from 'node:test';

import {
  carryOverRowIdentity,
  isHistoryResponsePending,
  mergeOlderServerPageWithoutDuplicates,
  resolveOlderPageOffset,
} from './sessionMessagePagination';
import {
  createEmptySlot,
  fetchOlderSlotPage,
  fetchSlotHistory,
  refreshLatestSlotFromServer,
  type HistoryPageRequester,
  type NormalizedMessage,
  type SessionHistoryPage,
} from './useSessionStore';

const row = (index: number, overrides: Partial<NormalizedMessage> = {}): NormalizedMessage => ({
  id: `r${index}`,
  sessionId: 's1',
  provider: 'claude',
  kind: 'text',
  role: index % 2 === 0 ? 'user' : 'assistant',
  timestamp: new Date(1_700_000_000_000 + index * 1000).toISOString(),
  content: `row ${index}`,
  ...overrides,
});

/** Tail-offset paging over a mutable transcript, like the sessions endpoint. */
function fakeServer(initialCount: number, options: { randomIds?: boolean } = {}) {
  const rows = Array.from({ length: initialCount }, (_, index) => row(index));
  let reads = 0;
  const flags: Partial<SessionHistoryPage> = {};
  const request: HistoryPageRequester = async (_sessionId, { limit, offset = 0 }) => {
    reads++;
    const total = rows.length;
    const end = total - offset;
    const start = limit == null ? 0 : Math.max(0, end - limit);
    const messages = rows.slice(Math.max(0, start), Math.max(0, end)).map((message) => (
      options.randomIds ? { ...message, id: `rand-${reads}-${message.id}` } : message
    ));
    return { messages, total, hasMore: start > 0, pending: false, refreshing: false, ...flags };
  };
  return {
    rows,
    request,
    flags,
    append: (count: number) => {
      const base = rows.length;
      for (let index = 0; index < count; index++) rows.push(row(base + index));
    },
    get reads() { return reads; },
  };
}

const contents = (messages: NormalizedMessage[]) => messages.map((message) => message.content);
const assertContiguous = (messages: NormalizedMessage[]) => {
  const indexes = messages.map((message) => Number(String(message.content).slice(4)));
  for (let index = 1; index < indexes.length; index++) {
    assert.equal(indexes[index], indexes[index - 1] + 1, `gap or duplicate at ${index}: ${indexes.join(',')}`);
  }
};

test('fetchMore merges older pages without duplicates when the tail grows between pages', async () => {
  const server = fakeServer(100);
  const slot = createEmptySlot();
  assert.equal(await fetchSlotHistory('s1', slot, { limit: 20, offset: 0 }, undefined, server.request), 'applied');
  assert.deepEqual(contents(slot.serverMessages).slice(0, 1), ['row 80']);

  server.append(7); // new turns persisted while reading older history
  await fetchOlderSlotPage('s1', slot, 20, server.request);
  assertContiguous(slot.serverMessages);
  assert.equal(slot.serverMessages[0].content, 'row 67');
  assert.equal(slot.total, 107);

  await fetchOlderSlotPage('s1', slot, 20, server.request);
  assertContiguous(slot.serverMessages);
  assert.equal(slot.serverMessages[0].content, 'row 47');
});

test('fetchMore steps past a page that lies entirely inside the cache', async () => {
  const server = fakeServer(100);
  const slot = createEmptySlot();
  await fetchSlotHistory('s1', slot, { limit: 20, offset: 0 }, undefined, server.request);
  server.append(25); // more than one page persisted while reading
  const changed = await fetchOlderSlotPage('s1', slot, 20, server.request);
  assert.equal(changed, true);
  assertContiguous(slot.serverMessages);
  assert.ok(Number(String(slot.serverMessages[0].content).slice(4)) < 80, 'older rows were loaded');
  assert.equal(slot.hasMore, true);
});

test('fetchMore superseded by a later full fetch retries against the new cache', async () => {
  const server = fakeServer(60);
  const slot = createEmptySlot();
  await fetchSlotHistory('s1', slot, { limit: 20, offset: 0 }, undefined, server.request);
  let interleaved = false;
  const racingRequest: HistoryPageRequester = async (sessionId, options) => {
    const page = await server.request(sessionId, options);
    if (!interleaved && options.offset === 20) {
      interleaved = true;
      // A full refresh starts and applies while the older page is in flight.
      await fetchSlotHistory('s1', slot, { limit: 20, offset: 0 }, undefined, server.request);
    }
    return page;
  };
  await fetchOlderSlotPage('s1', slot, 20, racingRequest);
  assertContiguous(slot.serverMessages);
  assert.equal(slot.serverMessages.length, 40, 'the retried page was applied, not dropped');
});

test('pending (not yet persisted) history is reported and never wipes cached rows', async () => {
  const server = fakeServer(30);
  const slot = createEmptySlot();
  await fetchSlotHistory('s1', slot, { limit: 20, offset: 0 }, undefined, server.request);
  const cached = slot.serverMessages;

  Object.assign(server.flags, { pending: true });
  const emptyPending: HistoryPageRequester = async () => ({ messages: [], total: 0, hasMore: false, pending: true, refreshing: false });
  assert.equal(await fetchSlotHistory('s1', slot, { limit: 20, offset: 0 }, undefined, emptyPending), 'pending');
  assert.equal(slot.serverMessages, cached);
  assert.equal(slot.fetchedAt, 0, 'pending history is never fresh cache');

  const refresh = await refreshLatestSlotFromServer('s1', slot, 20, () => true, emptyPending);
  assert.equal(refresh.pending, true);
  assert.equal(slot.serverMessages, cached);
});

test('failed fetches report error without clobbering a newer result', async () => {
  const slot = createEmptySlot();
  const failing: HistoryPageRequester = async () => { throw new Error('HTTP 502'); };
  const originalError = console.error;
  console.error = () => {};
  try {
    assert.equal(await fetchSlotHistory('s1', slot, { limit: 20 }, undefined, failing), 'error');
  } finally {
    console.error = originalError;
  }
  assert.equal(slot.status, 'error');
});

test('historyPending / retryable server flags are both honoured', () => {
  assert.equal(isHistoryResponsePending({ historyPending: true }), true);
  assert.equal(isHistoryResponsePending({ retryable: true }), true);
  assert.equal(isHistoryResponsePending({ historyRefreshing: true }), false);
  assert.equal(isHistoryResponsePending(null), false);
});

test('re-reads that mint fresh ids keep render identity (no remount on refresh / load all)', async () => {
  const server = fakeServer(40, { randomIds: true });
  const slot = createEmptySlot();
  await fetchSlotHistory('s1', slot, { limit: 20, offset: 0 }, undefined, server.request);
  const firstKeys = slot.serverMessages.map((message) => message.renderId ?? message.id);

  await refreshLatestSlotFromServer('s1', slot, 20, () => true, server.request);
  assert.deepEqual(slot.serverMessages.map((message) => message.renderId ?? message.id), firstKeys);

  await fetchSlotHistory('s1', slot, { limit: null }, undefined, server.request);
  const tailKeys = slot.serverMessages.slice(-20).map((message) => message.renderId ?? message.id);
  assert.deepEqual(tailKeys, firstKeys);
});

test('carryOverRowIdentity leaves unrelated rows and same-id rows alone', () => {
  const previous = [row(1), row(2, { renderId: 'kept' })];
  const next = [row(1), row(2), row(3)];
  const result = carryOverRowIdentity(previous, next);
  assert.equal(result[0], next[0]);
  assert.equal(result[1].renderId, 'kept');
  assert.equal(result[2], next[2]);
});

test('drift-aware older merge only filters when the transcript changed', () => {
  const cached = [row(10), row(11)];
  const repeated = [row(8), row(9, { id: 'x' }), row(12, { id: 'y' })];
  const unchanged = mergeOlderServerPageWithoutDuplicates(cached, [row(8), row(9)], false);
  assert.equal(unchanged.prependedCount, 2);
  const drifted = mergeOlderServerPageWithoutDuplicates(cached, [row(9), row(10, { id: 'dup' })], true);
  assert.deepEqual(contents(drifted.messages), ['row 9', 'row 10', 'row 11']);
  assert.equal(repeated.length, 3);
  assert.equal(resolveOlderPageOffset(20, 20, 33), 40);
  assert.equal(resolveOlderPageOffset(20, 20, 47), 47);
});
