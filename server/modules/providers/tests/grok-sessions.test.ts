import assert from 'node:assert/strict';
import test from 'node:test';

import { GrokSessionsProvider } from '@/modules/providers/list/grok/grok-sessions.provider.js';

// Grok runs over the Agent Client Protocol (`grok agent stdio`), which streams
// `session/update` notifications discriminated by `sessionUpdate`. These tests
// lock in the live normalization added when Grok moved off the old headless
// `--output-format streaming-json` path (which could only ever emit
// text/thought — no tool events).

const provider = new GrokSessionsProvider();

test('ACP agent_message_chunk normalizes to a stream_delta', () => {
  const out = provider.normalizeMessage(
    { sessionUpdate: 'agent_message_chunk', content: { text: 'Hello' } },
    'sid',
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, 'stream_delta');
  assert.equal(out[0].content, 'Hello');
  assert.equal(out[0].provider, 'grok');
});

test('ACP agent_thought_chunk normalizes to thinking', () => {
  const out = provider.normalizeMessage(
    { sessionUpdate: 'agent_thought_chunk', content: { text: 'pondering' } },
    'sid',
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, 'thinking');
  assert.equal(out[0].content, 'pondering');
});

test('ACP tool_call surfaces a tool_use card with name, input and id', () => {
  const out = provider.normalizeMessage(
    {
      sessionUpdate: 'tool_call',
      toolCallId: 'call-1',
      title: 'Read',
      rawInput: { file_path: '/tmp/x.ts' },
    },
    'sid',
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, 'tool_use');
  assert.equal(out[0].toolName, 'Read');
  assert.equal(out[0].toolId, 'call-1');
  assert.deepEqual(out[0].toolInput, { file_path: '/tmp/x.ts' });
});

test('terminal tool_call_update surfaces a tool_result stitched by toolId', () => {
  const out = provider.normalizeMessage(
    {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call-1',
      status: 'completed',
      rawOutput: 'file contents',
    },
    'sid',
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, 'tool_result');
  assert.equal(out[0].toolId, 'call-1');
  assert.equal(out[0].content, 'file contents');
  assert.equal(out[0].isError, false);
});

test('terminal tool_call_update reads object rawOutput (tagged-enum wrapper)', () => {
  const out = provider.normalizeMessage(
    {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call-ld',
      status: 'completed',
      rawOutput: { type: 'ListDir', Content: { content: '- a.ts\n- b.ts' } },
    },
    'sid',
  );
  assert.equal(out[0].kind, 'tool_result');
  assert.equal(out[0].content, '- a.ts\n- b.ts');
});

test('terminal tool_call_update extracts a body from diff content parts', () => {
  const out = provider.normalizeMessage(
    {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call-3',
      status: 'completed',
      content: [{ type: 'diff', path: '/tmp/x.ts', newText: 'hello' }],
    },
    'sid',
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, 'tool_result');
  assert.match(String(out[0].content), /\/tmp\/x\.ts/);
  assert.match(String(out[0].content), /hello/);
});

test('terminal tool_call_update reads nested content.text output parts', () => {
  const out = provider.normalizeMessage(
    {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call-4',
      status: 'completed',
      content: [{ type: 'content', content: { text: 'file listing here' } }],
    },
    'sid',
  );
  assert.equal(out[0].content, 'file listing here');
});

test('failed tool_call_update marks the result as an error', () => {
  const out = provider.normalizeMessage(
    { sessionUpdate: 'tool_call_update', toolCallId: 'call-2', status: 'failed', rawOutput: 'boom' },
    'sid',
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, 'tool_result');
  assert.equal(out[0].isError, true);
});

test('intermediate tool_call_update (in_progress) produces no chat row', () => {
  const out = provider.normalizeMessage(
    { sessionUpdate: 'tool_call_update', toolCallId: 'call-1', status: 'in_progress' },
    'sid',
  );
  assert.equal(out.length, 0);
});

test('non-content ACP updates (plan, turn_completed, commands) are dropped', () => {
  for (const kind of ['plan', 'turn_completed', 'available_commands_update', 'user_message_chunk']) {
    assert.deepEqual(provider.normalizeMessage({ sessionUpdate: kind }, 'sid'), []);
  }
});

test('legacy streaming-json text/thought shapes still normalize (back-compat)', () => {
  assert.equal(provider.normalizeMessage({ type: 'text', data: 'hi' }, 'sid')[0].kind, 'stream_delta');
  assert.equal(provider.normalizeMessage({ type: 'thought', data: 'hm' }, 'sid')[0].kind, 'thinking');
});
