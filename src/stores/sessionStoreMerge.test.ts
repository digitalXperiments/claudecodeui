import assert from 'node:assert/strict';
import test from 'node:test';

import {
  computeMerged,
  dedupeAdjacentAssistantEchoes,
  pruneRealtimeSupersededByServer,
  reconcileRealtimeWithServer,
} from './sessionStoreMerge';
import {
  createEmptySlot,
  fetchSlotHistory,
  recomputeMergedIfNeeded,
  trimSettledRealtimeRows,
  type NormalizedMessage,
} from './useSessionStore';

let seq = 0;
const msg = (partial: Partial<NormalizedMessage> & Pick<NormalizedMessage, 'kind'>): NormalizedMessage => ({
  id: partial.id ?? `m${++seq}`,
  sessionId: 's1',
  timestamp: new Date(1_000_000_000_000 + seq * 1000).toISOString(),
  provider: 'kilo',
  ...partial,
});

const text = (role: 'user' | 'assistant', content: string, extra: Partial<NormalizedMessage> = {}) =>
  msg({ ...extra, kind: 'text', role, content });
const thinking = (content: string, extra: Partial<NormalizedMessage> = {}) =>
  msg({ ...extra, kind: 'thinking', content });
const streamEnd = () => msg({ kind: 'stream_end' });

test('prune drops the realtime thinking echo once the transcript owns it', () => {
  const server = [
    text('user', 'can you check if you can say hi to me'),
    thinking('The user is asking me to check if I can say hi.'),
    text('assistant', 'Hi'),
    streamEnd(),
  ];
  const realtime = [
    text('user', 'can you check if you can say hi to me', { id: 'local_u1' }),
    thinking('The user is asking me to check if I can say hi.', { id: 'thinking_s1_rt' }),
    text('assistant', 'Hi', { id: '__streaming_s1' }),
  ];

  assert.deepEqual(pruneRealtimeSupersededByServer(server, realtime), []);
});

test('prune matches a second-turn echo to its turn even while its optimistic user row is present', () => {
  // The dropped local_* user row must not count as a turn when the assistant
  // echo's ordinal is computed — it used to push the match one turn past the
  // real server turn and keep the duplicate alive.
  const server = [
    text('user', 'hi?'),
    thinking('first thought'),
    text('assistant', 'Hi'),
    streamEnd(),
    text('user', 'which model are you using?'),
    thinking('second thought'),
    text('assistant', 'kilo/kilo-auto/free'),
    streamEnd(),
  ];
  const realtime = [
    text('user', 'which model are you using?', { id: 'local_u2' }),
    thinking('second thought', { id: 'thinking_s1_rt2' }),
    text('assistant', 'kilo/kilo-auto/free', { id: '__streaming_s1' }),
  ];

  assert.deepEqual(pruneRealtimeSupersededByServer(server, realtime), []);
});

test('dedupe collapses thinking and text echoes across non-rendered stream_end rows', () => {
  // Merged order after a post-complete refresh: the realtime rows' frozen
  // timestamps land right at turn end, so the transcript's step-finish
  // (stream_end) sorts between each server row and its realtime echo.
  const merged = dedupeAdjacentAssistantEchoes([
    text('user', 'which model are you using?'),
    thinking('second thought', { id: 'srv_th' }),
    thinking('second thought', { id: 'rt_th' }),
    text('assistant', 'kilo/kilo-auto/free', { id: 'srv_t' }),
    streamEnd(),
    text('assistant', 'kilo/kilo-auto/free', { id: 'rt_t' }),
  ]);

  assert.deepEqual(
    merged.map((m) => `${m.kind}:${m.content ?? ''}`),
    [
      'text:which model are you using?',
      'thinking:second thought',
      'text:kilo/kilo-auto/free',
      'stream_end:',
    ],
  );
});

test('dedupe keeps distinct thinking bursts and different replies in one turn', () => {
  const merged = dedupeAdjacentAssistantEchoes([
    text('user', 'q'),
    thinking('thought A'),
    thinking('thought B'),
    text('assistant', 'answer one'),
    text('assistant', 'answer two'),
  ]);

  assert.equal(merged.filter((m) => m.kind === 'thinking').length, 2);
  assert.equal(merged.filter((m) => m.kind === 'text' && m.role === 'assistant').length, 2);
});

test('refresh pipeline produces one thought and one reply for a kilo-style turn', () => {
  // The real flow prunes realtime against the refreshed transcript first
  // (position-independent), then merges — so even a turn fast enough to freeze
  // every realtime timestamp at turn end cannot stack duplicate bubbles.
  const server = [
    text('user', 'which model are you using?'),
    thinking('second thought', { id: 'srv_th' }),
    text('assistant', 'kilo/kilo-auto/free', { id: 'srv_t' }),
    streamEnd(),
  ];
  const realtime = [
    thinking('second thought', { id: 'rt_th' }),
    text('assistant', 'kilo/kilo-auto/free', { id: '__streaming_s1' }),
  ];

  const merged = computeMerged(server, pruneRealtimeSupersededByServer(server, realtime));
  assert.equal(merged.filter((m) => m.kind === 'thinking').length, 1);
  assert.equal(
    merged.filter((m) => m.kind === 'text' && m.role === 'assistant').length,
    1,
  );
});

test('computeMerged keeps realtime rows the transcript does not have yet', () => {
  const server = [text('user', 'q')];
  const realtime = [
    thinking('fresh thought', { id: 'rt_th' }),
    text('assistant', 'fresh answer', { id: '__streaming_s1' }),
  ];

  const merged = computeMerged(server, realtime);
  assert.equal(merged.filter((m) => m.kind === 'thinking').length, 1);
  assert.equal(
    merged.filter((m) => m.kind === 'text' && m.role === 'assistant').length,
    1,
  );
});

test('provider error survives a post-complete history refresh and dedupes when persisted', () => {
  const prompt = text('user', 'use the unsupported model', {
    id: 'srv_prompt',
    timestamp: '2026-09-23T10:00:00.000Z',
  });
  const error = msg({
    id: 'error_run_1',
    kind: 'error',
    content: 'model not supported with a ChatGPT account',
    timestamp: '2026-09-23T10:00:01.000Z',
    provider: 'codex',
    seq: 2,
  });

  // The provider transcript may initially contain only the prompt. A refresh
  // must keep the live error and place it after the failed turn's prompt.
  const firstRefresh = reconcileRealtimeWithServer([prompt], [error]);
  assert.deepEqual(firstRefresh.realtimeMessages.map((row) => row.id), [error.id]);
  assert.deepEqual(
    computeMerged(firstRefresh.serverMessages, firstRefresh.realtimeMessages).map((row) => row.id),
    [prompt.id, error.id],
  );

  // Providers that do persist errors return the same id from history; that
  // server copy replaces the live row without losing the bubble.
  const persistedError = { ...error, seq: undefined };
  const nextRefresh = reconcileRealtimeWithServer([prompt, persistedError], [error]);
  assert.deepEqual(nextRefresh.realtimeMessages, []);
  assert.deepEqual(
    computeMerged(nextRefresh.serverMessages, nextRefresh.realtimeMessages).map((row) => row.id),
    [prompt.id, error.id],
  );
});


test('live updates preserve provider transcript order despite non-monotonic timestamps', () => {
  const server = [
    text('user', 'question', { timestamp: '2026-01-01T00:00:03Z' }),
    text('assistant', 'answer', { timestamp: '2026-01-01T00:00:01Z' }),
  ];
  const live = text('assistant', 'next answer', { timestamp: '2026-01-01T00:00:04Z' });
  assert.deepEqual(computeMerged(server, [live]).map(row => row.id), [...server, live].map(row => row.id));
});

test('live socket order survives equal timestamps and clock corrections', () => {
  const server = [text('user', 'question', { timestamp: '2026-01-01T00:00:00Z' })];
  const live = [
    text('assistant', 'first', { timestamp: '2026-01-01T00:00:03Z' }),
    text('assistant', 'second', { timestamp: '2026-01-01T00:00:01Z' }),
    text('assistant', 'third', { timestamp: '2026-01-01T00:00:01Z' }),
  ];
  assert.deepEqual(computeMerged(server, live).map(row => row.id), [...server, ...live].map(row => row.id));
});

test('computeMerged drops live tool rows the transcript re-emits under a different id', () => {
  const server = [
    text('user', 'run ls', { id: 'srv_u' }),
    msg({ kind: 'tool_use', toolId: 'call_1', toolName: 'Bash', id: 'srv_tool' }),
    msg({ kind: 'tool_result', toolId: 'call_1', content: 'a b', id: 'srv_result' }),
  ];
  const live = [
    msg({ kind: 'tool_use', toolId: 'call_1', toolName: 'Bash', id: 'rt_tool' }),
    msg({ kind: 'tool_result', toolId: 'call_1', content: 'a b', id: 'rt_result' }),
    msg({ kind: 'tool_use', toolId: 'call_2', toolName: 'Bash', id: 'rt_tool2' }),
  ];
  assert.deepEqual(computeMerged(server, live).map((m) => m.id), ['srv_u', 'srv_tool', 'srv_result', 'rt_tool2']);
});

test('reconcile hands live render identity to the replacing server rows', () => {
  const server = [
    text('user', 'hi', { id: 'srv_u' }),
    text('assistant', 'hello', { id: 'srv_a' }),
    msg({ kind: 'tool_use', toolId: 't1', id: 'srv_tool', renderId: 'kept' }),
  ];
  const live = [
    text('user', 'hi', { id: 'local_u' }),
    text('assistant', 'hello', { id: '__streaming_s1', renderId: 'stream-row-s1-1' }),
    msg({ kind: 'tool_use', toolId: 't1', id: 'rt_tool' }),
  ];
  const result = reconcileRealtimeWithServer(server, live);
  assert.deepEqual(result.realtimeMessages, []);
  assert.deepEqual(result.serverMessages.map((m) => m.renderId), ['local_u', 'stream-row-s1-1', 'kept']);
  // Rows that were already rendered from the server keep their own keys.
  const untouched = reconcileRealtimeWithServer(server, live, () => false);
  assert.equal(untouched.serverMessages, server);
});

test('first-page / load-all history writes prune realtime rows too', async () => {
  const slot = createEmptySlot();
  slot.realtimeMessages = [
    text('user', 'hi', { id: 'local_u' }),
    msg({ kind: 'tool_use', toolId: 't9', id: 'rt_tool' }),
    text('assistant', 'still streaming', { id: '__streaming_s1', renderId: 'stream-row-s1-2' }),
  ];
  const persisted = [text('user', 'hi', { id: 'srv_u' }), msg({ kind: 'tool_use', toolId: 't9', id: 'srv_tool' })];
  const outcome = await fetchSlotHistory('s1', slot, { limit: null }, () => {}, async () => ({
    messages: persisted, total: 2, hasMore: false, pending: false, refreshing: false,
  }));
  assert.equal(outcome, 'applied');
  assert.deepEqual(slot.realtimeMessages.map((m) => m.id), ['__streaming_s1']);
  assert.deepEqual(slot.merged.map((m) => m.renderId ?? m.id), ['local_u', 'rt_tool', 'stream-row-s1-2']);
});

test('indexed merge keeps the mixed-case output (ids, local echoes, tools, turns)', () => {
  const server = [
    text('user', 'first', { id: 'srv_u1' }),
    text('assistant', 'same reply', { id: 'srv_a1' }),
    text('user', 'second', { id: 'srv_u2' }),
    msg({ kind: 'tool_use', toolId: 'c1', id: 'srv_tool1' }),
    msg({ kind: 'tool_result', toolId: 'c1', id: 'srv_res1' }),
    msg({ kind: 'tool_use', toolId: 'c2', id: 'srv_tool2', toolResult: { content: 'inline', isError: false } }),
    thinking('pondering', { id: 'srv_th' }),
    text('assistant', 'same reply', { id: 'srv_a2' }),
  ];
  const live = [
    text('user', 'second', { id: 'local_u2', timestamp: server[2].timestamp }),
    msg({ kind: 'tool_use', toolId: 'c1', id: 'rt_tool1' }),
    msg({ kind: 'tool_result', toolId: 'c1', id: 'rt_res1' }),
    msg({ kind: 'tool_result', toolId: 'c2', id: 'rt_res2' }),
    msg({ kind: 'tool_use', toolId: 'c3', id: 'rt_tool3' }),
    msg({ kind: 'tool_result', toolId: 'c3', id: 'rt_res3' }),
    thinking('pondering', { id: 'rt_th' }),
    text('assistant', 'same reply', { id: '__streaming_s1', renderId: 'stream-row-s1-9' }),
    msg({ kind: 'tool_use', id: 'srv_tool1', toolId: 'c1' }),
  ];

  assert.deepEqual(computeMerged(server, live).map((m) => m.id), [
    'srv_u1', 'srv_a1', 'srv_u2', 'srv_tool1', 'srv_res1', 'srv_tool2', 'srv_th', 'srv_a2',
    'rt_tool3', 'rt_res3', 'rt_th', '__streaming_s1',
  ]);
  const reconciled = reconcileRealtimeWithServer(server, live);
  // The second-turn assistant echo matches srv_a2 (its own turn), not srv_a1.
  assert.deepEqual(reconciled.realtimeMessages.map((m) => m.id), ['rt_tool3', 'rt_res3']);
  assert.equal(reconciled.serverMessages[7].renderId, 'stream-row-s1-9');
  assert.equal(reconciled.serverMessages[1].renderId, undefined);
});

test('merge of thousands of live tool rows against thousands of server rows stays linear', () => {
  const server: NormalizedMessage[] = [text('user', 'go', { id: 'srv_u' })];
  const live: NormalizedMessage[] = [];
  for (let i = 0; i < 1500; i++) {
    server.push(msg({ kind: 'tool_use', toolId: `srv_call_${i}`, id: `srv_tool_${i}` }));
    server.push(msg({ kind: 'tool_result', toolId: `srv_call_${i}`, id: `srv_res_${i}` }));
    // Half of the live rows are already persisted, half are still pending.
    const toolId = i % 2 === 0 ? `srv_call_${i}` : `live_call_${i}`;
    live.push(msg({ kind: 'tool_use', toolId, id: `rt_tool_${i}` }));
    live.push(msg({ kind: 'tool_result', toolId, id: `rt_res_${i}` }));
  }
  assert.equal(server.length, 3001);
  assert.equal(live.length, 3000);

  const started = performance.now();
  let merged: NormalizedMessage[] = [];
  // Several flushes against the same server array reuse its cached index.
  for (let flush = 9; flush >= 0; flush--) {
    merged = computeMerged(server, live.slice(0, live.length - flush));
  }
  const reconciled = reconcileRealtimeWithServer(server, live);
  const elapsed = performance.now() - started;

  assert.equal(merged.length, 3001 + 1500);
  assert.equal(reconciled.realtimeMessages.length, 1500);
  assert.ok(elapsed < 250, `merge took ${elapsed.toFixed(1)}ms`);
});

test('settled background trim drops only the oldest live rows beyond the cap', () => {
  const slot = createEmptySlot();
  slot.fetchedAt = Date.now();
  slot.realtimeMessages = Array.from({ length: 12 }, (_, i) => (
    msg({ kind: 'tool_use', toolId: `c${i}`, id: `rt_${i}` })
  ));
  recomputeMergedIfNeeded(slot);

  assert.equal(trimSettledRealtimeRows(slot, 20), false);
  assert.equal(slot.realtimeMessages.length, 12);

  assert.equal(trimSettledRealtimeRows(slot, 5), true);
  assert.deepEqual(slot.realtimeMessages.map((m) => m.id), ['rt_7', 'rt_8', 'rt_9', 'rt_10', 'rt_11']);
  assert.deepEqual(slot.merged.map((m) => m.id), ['rt_7', 'rt_8', 'rt_9', 'rt_10', 'rt_11']);
  // The next visit must re-read the transcript instead of trusting the cache.
  assert.equal(slot.fetchedAt, 0);
});
