import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildSessionMessagesUrl,
  findLatestPageOverlapLength,
  hasReachedCachedTailTimeBoundary,
  mergeLatestServerPage,
  mergeOlderServerPage,
  messagesRepresentSamePersistedRow,
  planLatestPageBridge,
  resolveLatestPagePagination,
  SESSION_MESSAGES_PAGE_SIZE,
} from './sessionMessagePagination';
import type { NormalizedMessage } from './useSessionStore';

let seq = 0;
const msg = (partial: Partial<NormalizedMessage> = {}): NormalizedMessage => {
  seq += 1;
  return {
    id: partial.id ?? `m${seq}`,
    sessionId: 's1',
    timestamp: partial.timestamp ?? new Date(1_700_000_000_000 + seq * 1000).toISOString(),
    provider: 'claude',
    kind: 'text',
    role: 'assistant',
    content: `content ${seq}`,
    ...partial,
  } as NormalizedMessage;
};

const ids = (messages: NormalizedMessage[]) => messages.map((m) => m.id);

/* ── buildSessionMessagesUrl ─────────────────────────────────────────────── */

test('buildSessionMessagesUrl always pairs a finite limit with an explicit offset', () => {
  assert.equal(
    buildSessionMessagesUrl('abc', { limit: SESSION_MESSAGES_PAGE_SIZE }),
    `/api/providers/sessions/abc/messages?limit=${SESSION_MESSAGES_PAGE_SIZE}&offset=0`,
  );
  assert.equal(
    buildSessionMessagesUrl('abc', { limit: 5, offset: 40 }),
    '/api/providers/sessions/abc/messages?limit=5&offset=40',
  );
});

test('buildSessionMessagesUrl omits pagination only for an explicit unbounded request', () => {
  assert.equal(buildSessionMessagesUrl('abc', { limit: null }), '/api/providers/sessions/abc/messages');
  assert.equal(buildSessionMessagesUrl('abc'), '/api/providers/sessions/abc/messages');
});

test('buildSessionMessagesUrl encodes the session id', () => {
  assert.equal(
    buildSessionMessagesUrl('a/b c', { limit: null }),
    '/api/providers/sessions/a%2Fb%20c/messages',
  );
});

/* ── messagesRepresentSamePersistedRow ───────────────────────────────────── */

test('same id always matches', () => {
  const a = msg({ id: 'x', content: 'one' });
  const b = msg({ id: 'x', content: 'two' });
  assert.equal(messagesRepresentSamePersistedRow(a, b), true);
});

test('regenerated ids fall back to stable transcript fields', () => {
  const ts = new Date(1_700_000_123_000).toISOString();
  const a = msg({ id: 'read-1', timestamp: ts, content: 'hello' });
  const b = msg({ id: 'read-2', timestamp: ts, content: 'hello' });
  assert.equal(messagesRepresentSamePersistedRow(a, b), true);
});

test('fallback matching ignores toolResult enrichment but not toolId', () => {
  const ts = new Date(1_700_000_123_000).toISOString();
  const base = {
    timestamp: ts,
    kind: 'tool_use' as const,
    role: undefined,
    toolName: 'Bash',
    toolInput: { command: 'ls' },
  };
  const a = msg({ ...base, id: 'r1', toolId: 't1', toolResult: null });
  const b = msg({ ...base, id: 'r2', toolId: 't1', toolResult: { content: 'done', isError: false } });
  const c = msg({ ...base, id: 'r3', toolId: 't2' });
  assert.equal(messagesRepresentSamePersistedRow(a, b), true);
  assert.equal(messagesRepresentSamePersistedRow(a, c), false);
});

test('different kind, timestamp, role, or provider never matches', () => {
  const ts = new Date(1_700_000_123_000).toISOString();
  const a = msg({ id: 'a', timestamp: ts, content: 'same' });
  assert.equal(messagesRepresentSamePersistedRow(a, msg({ id: 'b', timestamp: ts, content: 'same', kind: 'thinking' })), false);
  assert.equal(messagesRepresentSamePersistedRow(a, msg({ id: 'b', content: 'same' })), false);
  assert.equal(messagesRepresentSamePersistedRow(a, msg({ id: 'b', timestamp: ts, content: 'same', role: 'user' })), false);
});

/* ── findLatestPageOverlapLength / mergeLatestServerPage ─────────────────── */

test('finds the longest cached-suffix / latest-prefix overlap', () => {
  const shared = [msg(), msg(), msg()];
  const cached = [msg(), msg(), ...shared];
  const latest = [...shared, msg(), msg()];
  assert.equal(findLatestPageOverlapLength(cached, latest), 3);
});

test('no overlap returns 0 and mergeLatestServerPage retains the cache', () => {
  const cached = [msg(), msg()];
  const latest = [msg(), msg()];
  assert.equal(findLatestPageOverlapLength(cached, latest), 0);
  const merged = mergeLatestServerPage(cached, latest);
  assert.equal(merged.overlapLength, 0);
  assert.deepEqual(ids(merged.messages), ids(cached));
});

test('mergeLatestServerPage replaces the overlapping tail atomically', () => {
  const older = [msg(), msg()];
  const overlapA = msg({ id: 'ov1' });
  const overlapB = msg({ id: 'ov2' });
  const cached = [...older, overlapA, overlapB];
  // Server re-read the same rows (enriched) plus two new ones.
  const latest = [
    { ...overlapA, toolResult: { content: 'enriched', isError: false } },
    overlapB,
    msg({ id: 'new1' }),
    msg({ id: 'new2' }),
  ];
  const merged = mergeLatestServerPage(cached, latest);
  assert.equal(merged.overlapLength, 2);
  assert.deepEqual(ids(merged.messages), [...ids(older), 'ov1', 'ov2', 'new1', 'new2']);
  // Overlapping rows come from the latest read (fresh enrichment wins).
  assert.deepEqual(
    (merged.messages[2] as NormalizedMessage).toolResult,
    { content: 'enriched', isError: false },
  );
});

test('mergeLatestServerPage with an empty cache adopts the latest page', () => {
  const latest = [msg(), msg()];
  const merged = mergeLatestServerPage([], latest);
  assert.deepEqual(ids(merged.messages), ids(latest));
});

/* ── planLatestPageBridge ────────────────────────────────────────────────── */

test('no bridge is planned when the pages already overlap', () => {
  const shared = msg();
  const cached = [msg(), shared];
  const latest = [shared, msg()];
  assert.equal(planLatestPageBridge(cached, latest, 2, 3), null);
});

test('first bridge chunk requests exactly the missing rows plus one anchor', () => {
  const cached = [msg(), msg()];
  const latest = Array.from({ length: SESSION_MESSAGES_PAGE_SIZE }, () => msg());
  // 30 rows were added; the latest page covered 20, so 10 are missing.
  const plan = planLatestPageBridge(cached, latest, 50, 80);
  assert.deepEqual(plan, { offset: SESSION_MESSAGES_PAGE_SIZE, limit: 11 });
});

test('later bridge chunks fall back to full pages past the fetched window', () => {
  const cached = [msg()];
  const latest = Array.from({ length: SESSION_MESSAGES_PAGE_SIZE }, () => msg());
  const plan = planLatestPageBridge(cached, latest, 50, 80, 11);
  assert.deepEqual(plan, {
    offset: SESSION_MESSAGES_PAGE_SIZE + 11,
    limit: SESSION_MESSAGES_PAGE_SIZE,
  });
});

test('bridge planning asks for at least one anchor row when totals shrank', () => {
  const cached = [msg()];
  const latest = [msg(), msg()];
  const plan = planLatestPageBridge(cached, latest, 100, 90);
  assert.deepEqual(plan, { offset: 2, limit: 1 });
});

test('no bridge without cached or latest rows', () => {
  assert.equal(planLatestPageBridge([], [msg()], 0, 1), null);
  assert.equal(planLatestPageBridge([msg()], [], 1, 2), null);
});

/* ── hasReachedCachedTailTimeBoundary ────────────────────────────────────── */

test('boundary reached once the fetched window overlaps the cached time range', () => {
  const cached = [msg({ timestamp: '2026-01-01T00:00:10.000Z' })];
  const fetchedPast = [msg({ timestamp: '2026-01-01T00:00:05.000Z' })];
  const fetchedFuture = [msg({ timestamp: '2026-01-01T00:00:20.000Z' })];
  assert.equal(hasReachedCachedTailTimeBoundary(cached, fetchedPast), true);
  assert.equal(hasReachedCachedTailTimeBoundary(cached, fetchedFuture), false);
});

test('boundary is not reached with unparseable timestamps or empty arrays', () => {
  assert.equal(hasReachedCachedTailTimeBoundary([], [msg()]), false);
  assert.equal(hasReachedCachedTailTimeBoundary([msg()], []), false);
  assert.equal(
    hasReachedCachedTailTimeBoundary(
      [msg({ timestamp: 'not-a-date' })],
      [msg({ timestamp: '2026-01-01T00:00:00.000Z' })],
    ),
    false,
  );
});

/* ── mergeOlderServerPage ────────────────────────────────────────────────── */

test('older page with no overlap prepends whole', () => {
  const cached = [msg(), msg()];
  const older = [msg({ id: 'o1' }), msg({ id: 'o2' })];
  const merged = mergeOlderServerPage(cached, older);
  assert.equal(merged.overlapLength, 0);
  assert.equal(merged.prependedCount, 2);
  assert.deepEqual(ids(merged.messages), ['o1', 'o2', ...ids(cached)]);
});

test('older page overlapping the cached head (transcript grew mid-flight) is deduped', () => {
  const shared = [msg({ id: 's1' }), msg({ id: 's2' })];
  const cached = [...shared, msg({ id: 'c1' })];
  const older = [msg({ id: 'o1' }), ...shared];
  const merged = mergeOlderServerPage(cached, older);
  assert.equal(merged.overlapLength, 2);
  assert.equal(merged.prependedCount, 1);
  assert.deepEqual(ids(merged.messages), ['o1', 's1', 's2', 'c1']);
});

/* ── resolveLatestPagePagination ─────────────────────────────────────────── */

test('tail stitch preserves the cached oldest-page boundary', () => {
  // Cache had older history; the newest fetched page also reports more.
  assert.deepEqual(resolveLatestPagePagination(40, 45, true, true), { offset: 45, hasMore: true });
  // Cache had already reached the start of history — a stitched tail cannot re-open it.
  assert.deepEqual(resolveLatestPagePagination(40, 45, false, true), { offset: 45, hasMore: false });
  // Cold cache adopts the fetched page's boundary.
  assert.deepEqual(resolveLatestPagePagination(0, 20, false, true), { offset: 20, hasMore: true });
});
