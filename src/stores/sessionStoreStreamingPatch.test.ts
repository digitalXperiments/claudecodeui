import assert from 'node:assert/strict';
import test from 'node:test';

import { computeMerged, mergeOrderedMessages } from './sessionStoreMerge';
import { createEmptySlot, recomputeMergedIfNeeded, type NormalizedMessage } from './useSessionStore';

let seq = 0;
const at = (offset: number) => new Date(1_000_000_000_000 + offset * 1000).toISOString();
const msg = (partial: Partial<NormalizedMessage> & Pick<NormalizedMessage, 'kind'>): NormalizedMessage => ({
  id: partial.id ?? `m${++seq}`,
  sessionId: 's1',
  timestamp: at(++seq),
  provider: 'claude',
  ...partial,
});

const replaceAt = (rows: NormalizedMessage[], index: number, row: NormalizedMessage) => {
  const next = [...rows];
  next[index] = row;
  return next;
};

test('a stream flush patches the growing row in place and equals the full merge', () => {
  const slot = createEmptySlot();
  slot.serverMessages = [
    msg({ kind: 'text', role: 'user', content: 'hi' }),
    msg({ kind: 'text', role: 'assistant', content: 'earlier reply' }),
  ];
  const stream = msg({ id: '__streaming_s1', kind: 'stream_delta', content: 'Hel' });
  slot.realtimeMessages = [msg({ id: 'local_1', kind: 'text', role: 'user', content: 'next' }), stream];
  recomputeMergedIfNeeded(slot);
  const before = slot.merged;

  for (const content of ['Hello', 'Hello wor', 'Hello world']) {
    const index = slot.realtimeMessages.length - 1;
    slot.realtimeMessages = replaceAt(slot.realtimeMessages, index, { ...slot.realtimeMessages[index], content });
    assert.equal(recomputeMergedIfNeeded(slot), true);
    assert.deepEqual(slot.merged, computeMerged(slot.serverMessages, slot.realtimeMessages));
    assert.equal(slot.merged[slot.merged.length - 1].content, content);
  }
  assert.notEqual(slot.merged, before, 'merged is a new array so subscribers see the change');
  assert.equal(slot.merged[0], before[0], 'unchanged rows keep their identity');
});

test('a thinking flush after an identical thinking row falls back to the full merge (dedupe)', () => {
  const slot = createEmptySlot();
  slot.serverMessages = [msg({ kind: 'text', role: 'user', content: 'q' }), msg({ kind: 'thinking', content: 'same' })];
  const live = msg({ id: '__thinking_stream_s1', kind: 'thinking', content: 'sam' });
  slot.realtimeMessages = [live];
  recomputeMergedIfNeeded(slot);
  slot.realtimeMessages = [{ ...live, content: 'same' }];
  recomputeMergedIfNeeded(slot);
  assert.deepEqual(slot.merged, computeMerged(slot.serverMessages, slot.realtimeMessages));
  assert.equal(slot.merged.filter((row) => row.kind === 'thinking').length, 1);
});

test('structural realtime changes take the full merge path', () => {
  const slot = createEmptySlot();
  slot.serverMessages = [msg({ kind: 'text', role: 'user', content: 'q' })];
  const stream = msg({ id: '__streaming_s1', kind: 'stream_delta', content: 'a' });
  slot.realtimeMessages = [stream];
  recomputeMergedIfNeeded(slot);
  // Finalize (kind change) + an appended tool row in the same batch.
  slot.realtimeMessages = [{ ...stream, kind: 'text', role: 'assistant' }, msg({ kind: 'tool_use', toolId: 't1', toolName: 'Bash' })];
  recomputeMergedIfNeeded(slot);
  assert.deepEqual(slot.merged, computeMerged(slot.serverMessages, slot.realtimeMessages));
});

test('ordered merge interleaves by timestamp with cached sort keys', () => {
  const server = [
    { id: 'a', sessionId: 's', provider: 'claude', kind: 'text', timestamp: at(10) },
    { id: 'b', sessionId: 's', provider: 'claude', kind: 'text', timestamp: at(30) },
    { id: 'bad', sessionId: 's', provider: 'claude', kind: 'text', timestamp: 'not a date' },
  ] as NormalizedMessage[];
  const live = [
    { id: 'x', sessionId: 's', provider: 'claude', kind: 'text', timestamp: at(20) },
    { id: 'y', sessionId: 's', provider: 'claude', kind: 'text', timestamp: at(40) },
  ] as NormalizedMessage[];
  assert.deepEqual(mergeOrderedMessages(server, live).map((row) => row.id), ['a', 'x', 'b', 'bad', 'y']);
  // Same server array again (cached keys) gives the same order.
  assert.deepEqual(mergeOrderedMessages(server, live).map((row) => row.id), ['a', 'x', 'b', 'bad', 'y']);
});
