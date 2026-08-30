import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { OmpSessionsProvider } from '@/modules/providers/list/omp/omp-sessions.provider.js';
import {
  buildOmpTokenUsageFromStats,
  readOmpSessionTokenUsage,
} from '@/modules/providers/list/omp/omp-token-usage.js';

test('Oh My Pi normalizes tool progress, completion, and assistant errors', () => {
  const provider = new OmpSessionsProvider();

  const progress = provider.normalizeMessage({
    type: 'tool_execution_update',
    toolCallId: 'tool-1',
    toolName: 'bash',
    partialResult: { content: [{ type: 'text', text: 'partial output' }] },
  }, 'session-1');
  assert.equal(progress[0]?.kind, 'tool_result');
  assert.equal(progress[0]?.content, 'partial output');
  assert.equal(progress[0]?.toolId, 'tool-1');
  assert.equal(progress[0]?.isError, false);

  const error = provider.normalizeMessage({
    type: 'message_update',
    assistantMessageEvent: {
      type: 'error',
      reason: 'error',
      error: { errorMessage: 'provider unavailable' },
    },
  }, 'session-1');
  assert.deepEqual(error.map((message) => ({ kind: message.kind, content: message.content })), [
    { kind: 'error', content: 'provider unavailable' },
  ]);
});

test('Oh My Pi history uses the provider id and paginates renderable messages with tool results attached', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'omp-sessions-'));
  const sessionDirectory = path.join(root, '--workspace-demo--');
  const sessionFile = path.join(sessionDirectory, '2026-01-01T00-00-00-000Z_native-1.jsonl');
  try {
    await mkdir(sessionDirectory, { recursive: true });
    await writeFile(sessionFile, [
      JSON.stringify({ type: 'session', id: 'native-1', cwd: '/workspace/demo' }),
      JSON.stringify({
        type: 'message',
        id: 'user-1',
        timestamp: '2026-01-01T00:00:01.000Z',
        message: { role: 'user', content: 'Inspect the project' },
      }),
      JSON.stringify({
        type: 'message',
        id: 'assistant-1',
        timestamp: '2026-01-01T00:00:02.000Z',
        message: {
          role: 'assistant',
          content: [{ type: 'toolCall', id: 'tool-1', name: 'ls', arguments: { path: '.' } }],
        },
      }),
      JSON.stringify({
        type: 'message',
        id: 'result-1',
        timestamp: '2026-01-01T00:00:03.000Z',
        message: {
          role: 'toolResult',
          toolCallId: 'tool-1',
          toolName: 'ls',
          content: [{ type: 'text', text: 'README.md' }],
        },
      }),
      JSON.stringify({
        type: 'message',
        id: 'assistant-2',
        timestamp: '2026-01-01T00:00:04.000Z',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'The project contains README.md.' }],
        },
      }),
    ].join('\n'));

    const provider = new OmpSessionsProvider(root);
    const history = await provider.fetchHistory('app-session-id', {
      providerSessionId: 'native-1',
      limit: 2,
      offset: 0,
    });

    assert.equal(history.total, 3);
    assert.equal(history.messages.length, 2);
    assert.equal(history.messages.some((message) => message.kind === 'tool_result'), false);
    const tool = history.messages.find((message) => message.kind === 'tool_use');
    assert.equal(tool?.toolResult?.content, 'README.md');
    assert.equal(history.messages.at(-1)?.content, 'The project contains README.md.');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Oh My Pi token usage maps live RPC stats into the CloudCLI token shape', () => {
  const usage = buildOmpTokenUsageFromStats({
    model: 'gpt-test',
    tokens: { input: 100, output: 25, cacheRead: 10, cacheWrite: 5, total: 140 },
    contextUsage: { tokens: 115, contextWindow: 2000 },
  });

  assert.equal(usage?.provider, 'omp');
  assert.equal(usage?.used, 115);
  assert.equal(usage?.total, 2000);
  assert.equal(usage?.cumulativeUsed, 140);
  assert.deepEqual(usage?.breakdown, { input: 115, output: 25 });
});

test('Oh My Pi token usage reads assistant and compaction usage from session JSONL', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'omp-token-usage-'));
  const sessionFile = path.join(directory, 'session.jsonl');
  try {
    await writeFile(sessionFile, [
      JSON.stringify({
        type: 'message',
        message: {
          role: 'assistant',
          model: 'gpt-test',
          usage: { input: 80, output: 20, cacheRead: 4, cacheWrite: 2, totalTokens: 106 },
        },
      }),
      JSON.stringify({
        type: 'compaction',
        usage: { input: 10, output: 5, cacheRead: 1, cacheWrite: 0, totalTokens: 16 },
      }),
    ].join('\n'));

    const usage = readOmpSessionTokenUsage(sessionFile);
    assert.equal(usage.model, 'gpt-test');
    assert.equal(usage.lastTurnInputTokens, 80);
    assert.equal(usage.cumulativeUsed, 122);
    assert.equal(usage.billedInputTokens, 97);
    assert.equal(usage.billedOutputTokens, 25);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
