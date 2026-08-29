import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';

import {
  ensureExitPlanModeToolInput,
  extractPlanMarkdownFromToolInput,
  GrokSessionsProvider,
  readPlanMarkdownFromDir,
  resolveGrokHistoryPath,
} from '@/modules/providers/list/grok/grok-sessions.provider.js';

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

test('exit_plan_mode tool_call maps to ExitPlanMode (plan body hydrated by grok-cli)', () => {
  const out = provider.normalizeMessage(
    {
      sessionUpdate: 'tool_call',
      toolCallId: 'call-exit',
      title: 'exit_plan_mode',
      rawInput: {},
      _meta: { 'x.ai/tool': { name: 'exit_plan_mode' } },
    },
    'sid',
  );
  assert.equal(out[0].toolName, 'ExitPlanMode');
  assert.deepEqual(out[0].toolInput, {});
});

test('extractPlanMarkdownFromToolInput prefers string plan fields', () => {
  assert.equal(extractPlanMarkdownFromToolInput({ plan: '# Hello' }), '# Hello');
  assert.equal(extractPlanMarkdownFromToolInput({ planContent: 'body' }), 'body');
  assert.equal(extractPlanMarkdownFromToolInput({}), '');
  assert.equal(extractPlanMarkdownFromToolInput({ plan: { nested: true } }), '');
});

test('ensureExitPlanModeToolInput falls back to disk plan markdown', () => {
  assert.deepEqual(ensureExitPlanModeToolInput({}, '# From disk'), { plan: '# From disk' });
  assert.deepEqual(ensureExitPlanModeToolInput({ plan: '# Inline' }, '# From disk'), {
    plan: '# Inline',
  });
});

test('readPlanMarkdownFromDir returns plan.md contents', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cloudcli-plan-'));
  try {
    fs.writeFileSync(path.join(dir, 'plan.md'), '# Phase 0\n\nDo the thing.\n');
    assert.equal(readPlanMarkdownFromDir(dir), '# Phase 0\n\nDo the thing.\n');
    assert.equal(readPlanMarkdownFromDir(path.join(dir, 'missing')), '');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
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

test('resolveGrokHistoryPath prefers the indexed summary sibling over a reconstructed cwd', async () => {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'grok-history-path-'));
  try {
    const summaryPath = path.join(tempDirectory, 'summary.json');
    const historyPath = path.join(tempDirectory, 'chat_history.jsonl');
    await writeFile(summaryPath, '{}');
    await writeFile(historyPath, '');

    assert.equal(
      resolveGrokHistoryPath('/wrong/project', 'missing-id', summaryPath),
      historyPath,
    );
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

test('fetchHistory reads assistant turns stored as type=message', async () => {
  const previousGrokHome = process.env.GROK_HOME;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'grok-history-message-'));
  const projectPath = path.join(tempDirectory, 'project');
  const sessionId = 'grok-message-turn';
  process.env.GROK_HOME = tempDirectory;
  try {
    const sessionDir = path.join(tempDirectory, 'sessions', encodeURIComponent(projectPath), sessionId);
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      path.join(sessionDir, 'chat_history.jsonl'),
      `${JSON.stringify({
        type: 'user',
        content: [{ type: 'text', text: '<user_query>Hello</user_query>' }],
      })}\n${JSON.stringify({
        type: 'message',
        content: [{ type: 'text', text: 'From the TUI' }],
      })}\n`,
    );

    const result = await provider.fetchHistory(sessionId, {
      projectPath,
      providerSessionId: sessionId,
    });
    assert.equal(result.total, 2);
    assert.equal(result.messages[0]?.role, 'user');
    assert.equal(result.messages[1]?.role, 'assistant');
    assert.equal(result.messages[1]?.content, 'From the TUI');
  } finally {
    if (previousGrokHome === undefined) {
      delete process.env.GROK_HOME;
    } else {
      process.env.GROK_HOME = previousGrokHome;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
});
