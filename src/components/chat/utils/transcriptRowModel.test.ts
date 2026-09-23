import assert from 'node:assert/strict';
import test from 'node:test';

import type { ChatMessage } from '../types/types';

import { clearRowHeightCaches, getRowHeightCache, groupMemberHeightKey } from './rowHeightCache';
import { estimateMessageRowHeight } from './rowHeightEstimate';
import { groupConsecutiveTools } from './toolGrouping';
import { buildTranscriptRowModel, INITIAL_MOUNTED_TAIL_ROWS, PREPEND_MOUNTED_ROWS } from './transcriptRowModel';

const tool = (id: string): ChatMessage => ({
  type: 'assistant', id, timestamp: '2026-01-01T00:00:00Z', isToolUse: true, toolName: 'Read',
  toolId: id, toolResult: { content: 'ok', isError: false },
} as ChatMessage);
const text = (id: string, content = 'hello'): ChatMessage => ({
  type: 'assistant', id, timestamp: '2026-01-01T00:00:00Z', content,
} as ChatMessage);
const keyOf = (message: ChatMessage) => `k-${message.id}`;

function render(messages: ChatMessage[], previous?: ReturnType<typeof buildTranscriptRowModel>) {
  return buildTranscriptRowModel(
    groupConsecutiveTools(messages),
    keyOf,
    previous?.groupKeyByMember ?? new Map(),
    new Set(previous?.rows.map((row) => row.key) ?? []),
  );
}

test('a tool group keeps its key when an older page ending in the same tool is prepended', () => {
  const first = render([text('a'), tool('t2'), tool('t3'), text('b')]);
  const groupKey = first.rows[1].key;
  const next = render([text('z'), tool('t0'), tool('t1'), text('a'), tool('t2'), tool('t3'), text('b')], first);
  assert.equal(next.rows[3].key, groupKey);
  assert.notEqual(next.rows[1].key, groupKey);

  // Prepend that extends the group itself (older page ends with the same tool).
  const extended = render([tool('t1'), tool('t2'), tool('t3'), text('b')], render([tool('t2'), tool('t3'), text('b')]));
  assert.equal(extended.rows[0].key, 'tool-group-k-t2');
  assert.deepEqual(extended.rows[0].memberKeys, ['k-t1', 'k-t2', 'k-t3']);
  assert.deepEqual(extended.rows[0].heightKeys.slice(1), ['k-t1', 'k-t2', 'k-t3'].map(groupMemberHeightKey));
});

test('group keys stay unique when two groups remember the same key', () => {
  const first = render([tool('t1'), tool('t2')]);
  const split = render([tool('t1'), tool('t2'), text('x'), tool('t3'), tool('t4')], first);
  const keys = split.rows.map((row) => row.key);
  assert.equal(new Set(keys).size, keys.length);
});

test('first render mounts only the tail; a prepend mounts the rows nearest the reader', () => {
  const tail = Array.from({ length: 50 }, (_, i) => text(`n${i}`));
  const first = render(tail);
  assert.equal(first.rows.filter((row) => row.mountInitially).length, INITIAL_MOUNTED_TAIL_ROWS);

  const older = Array.from({ length: 1000 }, (_, i) => text(`o${i}`));
  const next = render([...older, ...tail], first);
  const mounted = next.rows.map((row, index) => (row.mountInitially ? index : -1)).filter((index) => index >= 0);
  assert.equal(mounted.length, PREPEND_MOUNTED_ROWS, 'Load all mounts a bounded band');
  assert.equal(mounted[0], 1000 - PREPEND_MOUNTED_ROWS);
  assert.equal(mounted[mounted.length - 1], 999);
});

test('measured heights survive a remount and a re-keyed group finds its members', () => {
  clearRowHeightCaches();
  const cache = getRowHeightCache('session-a');
  cache.set(['tool-group-k-t2', groupMemberHeightKey('k-t2'), groupMemberHeightKey('k-t3')], 137.5);
  // New component instance, same session scope.
  const again = getRowHeightCache('session-a');
  assert.equal(again.get(['tool-group-k-t2']), 137.5);
  assert.equal(again.get(['tool-group-k-t1', groupMemberHeightKey('k-t1'), groupMemberHeightKey('k-t2')]), 137.5);
  assert.equal(again.get(['k-t2']), undefined, 'single rows never read group heights');
  assert.equal(getRowHeightCache('session-b').get(['tool-group-k-t2']), undefined);
});

test('content-based estimates scale with the message instead of a flat 100px', () => {
  const short = estimateMessageRowHeight(text('s', 'ok'), null);
  const long = estimateMessageRowHeight(text('l', 'x'.repeat(2000)), null);
  const grouped = estimateMessageRowHeight(text('g', 'ok'), text('prev'));
  assert.ok(short < 100);
  assert.ok(long > 400);
  assert.ok(grouped < short, 'grouped rows omit the provider header');
  assert.ok(estimateMessageRowHeight(tool('t'), null) < 100);
});
