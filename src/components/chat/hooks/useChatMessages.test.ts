import assert from 'node:assert/strict';
import test from 'node:test';

import type { NormalizedMessage } from '../../../stores/useSessionStore';
import { getIntrinsicMessageKey } from '../utils/messageKeys';

import { normalizedToChatMessages } from './useChatMessages';

const row = (overrides: Partial<NormalizedMessage> = {}): NormalizedMessage => ({
  id: 'a', sessionId: 's', provider: 'claude', timestamp: '2026-01-01T00:00:00Z', kind: 'text', role: 'assistant', content: 'hello', ...overrides,
});

test('unchanged history keeps object identity during streaming and prepends', () => {
  const history = row();
  const stream = row({ id: 'live', kind: 'stream_delta', content: 'hi' });
  const first = normalizedToChatMessages([history, stream]);
  const next = normalizedToChatMessages([row({ id: 'older' }), history, {...stream, content: 'hi there'}]);
  assert.equal(first[0], next[1]);
  assert.notEqual(first[1], next[2]);
  assert.equal(next[2].content, 'hi there');
});

test('tool result arrival invalidates only the affected projected tool row', () => {
  const tool = row({kind:'tool_use', toolId:'t', toolName:'Read'});
  const text = row({id:'text'});
  const first = normalizedToChatMessages([tool, text]);
  const next = normalizedToChatMessages([tool, text, row({kind:'tool_result',toolId:'t',content:'done'})]);
  assert.notEqual(first[0], next[0]);
  assert.equal(next[0].toolResult?.content, 'done');
  assert.equal(first[1], next[1]);
});

test('stream completion and buffer reuse do not change React row identity', () => {
  const live = row({id:'__streaming_s',renderId:'stable',kind:'stream_delta'});
  const finalized = {...live, id:'text_s_final',kind:'text' as const};
  const before = normalizedToChatMessages([live])[0];
  const after = normalizedToChatMessages([finalized])[0];
  assert.equal(getIntrinsicMessageKey(before), getIntrinsicMessageKey(after));
});

test('missing tool result content cannot crash the transcript', () => {
  const result = normalizedToChatMessages([row({kind:'tool_use',toolId:'t'}), row({kind:'tool_result',toolId:'t',content:undefined})]);
  assert.equal(result[0].toolResult?.content, '');
});
