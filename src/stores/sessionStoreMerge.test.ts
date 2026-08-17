import assert from 'node:assert/strict';
import test from 'node:test';

import {
  computeMerged,
  dedupeAdjacentAssistantEchoes,
  pruneRealtimeSupersededByServer,
} from './sessionStoreMerge';
import type { NormalizedMessage } from './useSessionStore';

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
