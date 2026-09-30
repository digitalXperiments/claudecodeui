import assert from 'node:assert/strict';
import test from 'node:test';

import {
  LOCAL_SEND_ACK_GUARD_MS,
  shouldIgnoreIdle,
  shouldIgnoreShellTakeover,
} from './sessionActivityGuards';

const now = 1_000_000;

test('a fresh local send ignores an idle subscribe ack sent after it', () => {
  // chat.send at now-40, chat.subscribe at now-20 (after the send), ack now.
  const entry = { source: 'chat' as const, startedAt: now - 40, localSendAt: now - 40 };
  assert.equal(shouldIgnoreIdle(entry, { ifStartedBefore: now - 20, fromSubscribeAck: true }, now), true);
  // Without a recorded subscribe time the ack is still advisory.
  assert.equal(shouldIgnoreIdle(entry, { fromSubscribeAck: true }, now), true);
});

test('terminal idles always clear, even right after a local send', () => {
  const entry = { source: 'chat' as const, startedAt: now - 40, localSendAt: now - 40 };
  assert.equal(shouldIgnoreIdle(entry, undefined, now), false);
});

test('an old local send no longer shields against idle acks', () => {
  const sentAt = now - LOCAL_SEND_ACK_GUARD_MS - 1;
  const entry = { source: 'chat' as const, startedAt: sentAt, localSendAt: sentAt };
  assert.equal(shouldIgnoreIdle(entry, { ifStartedBefore: now - 10, fromSubscribeAck: true }, now), false);
});

test('entries without a local send keep the ifStartedBefore rule', () => {
  const entry = { source: 'chat' as const, startedAt: now - 5 };
  assert.equal(shouldIgnoreIdle(entry, { ifStartedBefore: now - 10, fromSubscribeAck: true }, now), true);
  assert.equal(shouldIgnoreIdle(entry, { ifStartedBefore: now, fromSubscribeAck: true }, now), false);
});

test('a Shell ack cannot take over a fresh local chat send', () => {
  const entry = { source: 'chat' as const, startedAt: now - 40, localSendAt: now - 40 };
  assert.equal(shouldIgnoreShellTakeover(entry, 'shell', now), true);
  assert.equal(shouldIgnoreShellTakeover(entry, 'chat', now), false);
  assert.equal(shouldIgnoreShellTakeover({ source: 'shell', startedAt: now - 40 }, 'shell', now), false);
  assert.equal(shouldIgnoreShellTakeover(undefined, 'shell', now), false);
});
