import test from 'node:test';
import assert from 'node:assert/strict';

import type { BotThreadMessage } from '../../../../types/botRuntime';

import {
  groupThreadByDay, makeOptimisticMessage, mergeOptimistic, oldestCursor, shouldSendOnKey, threadAlignment,
} from './thread';

const NOW = Date.parse('2026-10-01T12:00:00');

function message(id: string, role: BotThreadMessage['role'], body: string, iso: string, channel = 'inapp'): BotThreadMessage {
  return { message_id: id, bot_id: 'b', role, body, channel, meta: {}, created_at: iso };
}

test('Enter sends, Shift+Enter and IME composition do not, blanks never send', () => {
  assert.equal(shouldSendOnKey({ key: 'Enter', shiftKey: false }, 'hi'), true);
  assert.equal(shouldSendOnKey({ key: 'Enter', shiftKey: true }, 'hi'), false);
  assert.equal(shouldSendOnKey({ key: 'Enter', shiftKey: false, isComposing: true }, 'hi'), false);
  assert.equal(shouldSendOnKey({ key: 'Enter', shiftKey: false }, '   \n'), false);
  assert.equal(shouldSendOnKey({ key: 'a', shiftKey: false }, 'hi'), false);
});

test('makeOptimisticMessage builds an operator in-app message', () => {
  const optimistic = makeOptimisticMessage('b', 'hello', NOW, 'n1');
  assert.equal(optimistic.message_id, 'optimistic-n1');
  assert.equal(optimistic.role, 'operator');
  assert.equal(optimistic.channel, 'inapp');
  assert.equal(optimistic.optimistic, true);
  assert.equal(optimistic.created_at, new Date(NOW).toISOString());
});

test('mergeOptimistic appends pending messages and drops ones the server already echoed', () => {
  const pending = makeOptimisticMessage('b', 'hello', NOW, '1');
  const confirmed = [message('m1', 'bot', 'hey', new Date(NOW - 60_000).toISOString())];
  const pendingOnly = mergeOptimistic(confirmed, [pending]);
  assert.deepEqual(pendingOnly.map((m) => m.message_id), ['m1', 'optimistic-1']);

  const echoed = [...confirmed, message('m2', 'operator', 'hello', new Date(NOW + 500).toISOString())];
  assert.deepEqual(mergeOptimistic(echoed, [pending]).map((m) => m.message_id), ['m1', 'm2']);
});

test('mergeOptimistic matches each echo to one optimistic message only', () => {
  const first = makeOptimisticMessage('b', 'ok', NOW, '1');
  const second = makeOptimisticMessage('b', 'ok', NOW + 1000, '2');
  const echoed = [message('m1', 'operator', 'ok', new Date(NOW + 200).toISOString())];
  assert.deepEqual(mergeOptimistic(echoed, [first, second]).map((m) => m.message_id), ['m1', 'optimistic-2']);
});

test('mergeOptimistic ignores an old identical message well before the send', () => {
  const pending = makeOptimisticMessage('b', 'ok', NOW, '1');
  const old = [message('m0', 'operator', 'ok', new Date(NOW - 3_600_000).toISOString())];
  assert.deepEqual(mergeOptimistic(old, [pending]).map((m) => m.message_id), ['m0', 'optimistic-1']);
});

test('oldestCursor is the first message timestamp', () => {
  assert.equal(oldestCursor([]), null);
  assert.equal(oldestCursor([message('a', 'bot', 'x', '2026-10-01T09:00:00Z'), message('b', 'bot', 'y', '2026-10-01T10:00:00Z')]), '2026-10-01T09:00:00Z');
});

test('groupThreadByDay labels Today and Yesterday and splits on day change', () => {
  const entries = [
    message('a', 'bot', 'old', new Date(NOW - 3 * 86_400_000).toISOString()),
    message('b', 'operator', 'yday', new Date(NOW - 86_400_000).toISOString()),
    message('c', 'bot', 'today 1', new Date(NOW - 3_600_000).toISOString()),
    message('d', 'operator', 'today 2', new Date(NOW - 60_000).toISOString()),
  ];
  const groups = groupThreadByDay(entries, NOW);
  assert.equal(groups.length, 3);
  assert.equal(groups[1].label, 'Yesterday');
  assert.equal(groups[2].label, 'Today');
  assert.deepEqual(groups[2].entries.map((e) => e.message_id), ['c', 'd']);
  assert.deepEqual(groupThreadByDay([], NOW), []);
});

test('threadAlignment places operator right, bot left, system centred', () => {
  assert.equal(threadAlignment('operator'), 'right');
  assert.equal(threadAlignment('bot'), 'left');
  assert.equal(threadAlignment('system'), 'center');
});
