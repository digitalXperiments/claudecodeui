import assert from 'node:assert/strict';
import test from 'node:test';

import { CodexSessionsProvider } from '@/modules/providers/list/codex/codex-sessions.provider.js';

const provider = new CodexSessionsProvider();

test('completed Codex Bash commands include a successful tool result', () => {
  const [message] = provider.normalizeMessage({
    type: 'item',
    itemType: 'command_execution',
    uuid: 'command-success',
    command: 'printf ok',
    output: 'ok',
    exitCode: 0,
    status: 'completed',
  }, 'session-1');

  assert.deepEqual(message.toolResult, { content: 'ok', isError: false });
});

test('failed Codex Bash commands include an error tool result', () => {
  const [message] = provider.normalizeMessage({
    type: 'item',
    itemType: 'command_execution',
    uuid: 'command-failure',
    command: 'exit 2',
    output: 'command failed',
    exitCode: 2,
    status: 'failed',
  }, 'session-1');

  assert.deepEqual(message.toolResult, { content: 'command failed', isError: true });
});

test('completed Codex file changes include a successful tool result', () => {
  const changes = [{ path: 'src/index.ts', kind: 'update' }];
  const [message] = provider.normalizeMessage({
    type: 'item',
    itemType: 'file_change',
    uuid: 'file-success',
    changes,
    status: 'completed',
  }, 'session-1');

  assert.deepEqual(message.toolResult, {
    content: JSON.stringify(changes),
    isError: false,
  });
});

test('failed Codex file changes include an error tool result', () => {
  const changes = [{ path: 'src/index.ts', kind: 'update' }];
  const [message] = provider.normalizeMessage({
    type: 'item',
    itemType: 'file_change',
    uuid: 'file-failure',
    changes,
    status: 'failed',
  }, 'session-1');

  assert.deepEqual(message.toolResult, {
    content: JSON.stringify(changes),
    isError: true,
  });
});

test('completed Codex browser_snapshot MCP calls include their structured result', () => {
  const result = {
    content: [{ type: 'text', text: '- document "CloudCLI"' }],
  };
  const [message] = provider.normalizeMessage({
    type: 'item',
    itemType: 'mcp_tool_call',
    uuid: 'mcp-success',
    server: 'browser-use',
    tool: 'browser_snapshot',
    arguments: {},
    result,
    status: 'completed',
  }, 'session-1');

  assert.deepEqual(message.toolResult, {
    content: JSON.stringify(result),
    isError: false,
  });
});

test('failed Codex browser_snapshot MCP calls include their error', () => {
  const error = { message: 'Browser is not connected' };
  const [message] = provider.normalizeMessage({
    type: 'item',
    itemType: 'mcp_tool_call',
    uuid: 'mcp-failure',
    server: 'browser-use',
    tool: 'browser_snapshot',
    arguments: {},
    error,
    status: 'failed',
  }, 'session-1');

  assert.deepEqual(message.toolResult, {
    content: JSON.stringify(error),
    isError: true,
  });
});

test('nonterminal Codex tool calls do not include a tool result', () => {
  const messages = [
    provider.normalizeMessage({
      type: 'item',
      itemType: 'command_execution',
      uuid: 'command-running',
      command: 'sleep 1',
      status: 'in_progress',
    }, 'session-1')[0],
    provider.normalizeMessage({
      type: 'item',
      itemType: 'file_change',
      uuid: 'file-running',
      changes: [],
      status: 'inProgress',
    }, 'session-1')[0],
    provider.normalizeMessage({
      type: 'item',
      itemType: 'mcp_tool_call',
      uuid: 'mcp-running',
      tool: 'browser_snapshot',
      status: 'running',
    }, 'session-1')[0],
  ];

  for (const message of messages) {
    assert.equal(message.toolResult, undefined);
  }
});
