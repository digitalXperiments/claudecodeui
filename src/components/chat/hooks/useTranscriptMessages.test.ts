import assert from 'node:assert/strict';
import test from 'node:test';

import type { NormalizedMessage } from '../../../stores/useSessionStore';
import type { ChatMessage } from '../types/types';

import { deriveTranscriptMessages } from './useTranscriptMessages';

const row = (id: string, role: 'user' | 'assistant', content: string): NormalizedMessage => ({
  id,
  sessionId: 's1',
  timestamp: new Date(1_000_000_000_000).toISOString(),
  provider: 'claude',
  kind: 'text',
  role,
  content,
});

test('store rows project to chat messages with stable identity across calls', () => {
  const rows = [row('a', 'user', 'hi'), row('b', 'assistant', 'hello')];
  const first = deriveTranscriptMessages(rows, null, 0);
  assert.deepEqual(first.map((message) => message.content), ['hi', 'hello']);
  // A new rows array that reuses the same row objects (a stream flush that
  // only touched another row) yields the same ChatMessage objects, which is
  // what lets the memoized transcript rows skip re-rendering.
  const second = deriveTranscriptMessages([...rows, row('c', 'assistant', 'more')], null, 0);
  assert.equal(second[0], first[0]);
  assert.equal(second[1], first[1]);
});

test('a pending user message shows only while the store is empty', () => {
  const pending: ChatMessage = { type: 'user', content: 'first message', timestamp: new Date() };
  assert.deepEqual(deriveTranscriptMessages([], pending, 0), [pending]);
  assert.equal(deriveTranscriptMessages([row('a', 'user', 'first message')], pending, 0)[0].content, 'first message');
  assert.notEqual(deriveTranscriptMessages([row('a', 'user', 'x')], pending, 0)[0], pending);
});

test('viewHiddenCount hides the newest rows but never everything', () => {
  const rows = [row('a', 'user', '1'), row('b', 'assistant', '2'), row('c', 'user', '3')];
  assert.deepEqual(deriveTranscriptMessages(rows, null, 1).map((message) => message.content), ['1', '2']);
  assert.equal(deriveTranscriptMessages(rows, null, 3).length, 3);
});
