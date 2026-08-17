import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { QwenCodeSessionsProvider, parseQwenMetadata } from '@/modules/providers/list/qwencode/qwencode-sessions.provider.js';

describe('Qwen Code provider', () => {
  it('normalizes ACP chunks and terminal tool updates without losing tool results', () => {
    const provider = new QwenCodeSessionsProvider();
    assert.equal(provider.normalizeMessage({ sessionUpdate: 'agent_message_chunk', content: { text: 'hello' } }, 's1')[0]?.kind, 'stream_delta');
    assert.equal(provider.normalizeMessage({ sessionUpdate: 'tool_call_update', status: 'completed', rawInput: { command: 'echo hi' }, rawOutput: 'hi', toolCallId: 't1' }, 's1')[0]?.kind, 'tool_result');
    assert.equal(provider.normalizeMessage({ sessionUpdate: 'tool_call_update', rawInput: { command: 'echo hi' }, title: 'shell', toolCallId: 't1' }, 's1')[0]?.kind, 'tool_use');
  });

  it('reads native cwd/session/title metadata from Qwen JSONL records', () => {
    assert.deepEqual(parseQwenMetadata([
      { type: 'user', sessionId: 'q1', cwd: '/workspace/demo', message: { parts: [{ text: 'Fix it' }] } },
      { type: 'system', subtype: 'custom_title', systemPayload: { customTitle: 'Fix it' } },
    ], 'fallback'), {
      sessionId: 'q1', projectPath: '/workspace/demo', title: 'Fix it',
    });
  });
});
