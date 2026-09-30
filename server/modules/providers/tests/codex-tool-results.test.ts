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

test('app-server userMessage items are not turned into tool rows', async () => {
  const { appServerItemToLegacy } = await import('@/modules/providers/list/codex/codex-app-server-items.js');
  assert.equal(
    appServerItemToLegacy({ type: 'userMessage', id: 'user-1', content: [{ type: 'text', text: 'hi' }] }),
    null,
  );
  // Unknown items and search/plan items carry their status through.
  const legacyStatus = (item: Record<string, unknown>) =>
    (appServerItemToLegacy(item) as { status?: unknown } | null)?.status;
  assert.equal(legacyStatus({ type: 'webSearch', id: 'w', query: 'q', status: 'completed' }), 'completed');
  assert.equal(legacyStatus({ type: 'imageView', id: 'i', status: 'failed' }), 'failed');
});

test('known non-tool Codex items normalize to nothing', () => {
  for (const itemType of ['userMessage', 'agentMessage', 'contextCompaction', 'enteredReviewMode', 'exitedReviewMode']) {
    const messages = provider.normalizeMessage({
      type: 'item',
      itemType,
      uuid: `${itemType}-1`,
      item: { type: itemType, id: `${itemType}-1`, clientId: 'c' },
    }, 'session-1');
    assert.deepEqual(messages, [], itemType);
  }
});

test('unknown Codex items render as completed tool rows instead of staying Running', () => {
  const [completed] = provider.normalizeMessage({
    type: 'item',
    itemType: 'imageView',
    uuid: 'image-1',
    item: { type: 'imageView', id: 'image-1', path: '/tmp/x.png' },
  }, 'session-1');
  assert.equal(completed.kind, 'tool_use');
  assert.deepEqual(completed.toolResult, { content: '', isError: false });

  const [failed] = provider.normalizeMessage({
    type: 'item',
    itemType: 'imageView',
    uuid: 'image-2',
    status: 'failed',
    item: { type: 'imageView', id: 'image-2' },
  }, 'session-1');
  assert.equal(failed.toolResult?.isError, true);
});

test('Codex web_search and todo_list items complete with a tool result', () => {
  const [search] = provider.normalizeMessage({
    type: 'item',
    itemType: 'web_search',
    uuid: 'search-1',
    query: 'codex app-server',
  }, 'session-1');
  assert.deepEqual(search.toolResult, { content: '', isError: false });

  const [todo] = provider.normalizeMessage({
    type: 'item',
    itemType: 'todo_list',
    uuid: 'todo-1',
    items: [{ text: 'step', completed: false }],
    status: 'completed',
  }, 'session-1');
  assert.deepEqual(todo.toolResult, { content: '', isError: false });

  const [runningSearch] = provider.normalizeMessage({
    type: 'item',
    itemType: 'web_search',
    uuid: 'search-2',
    query: 'q',
    status: 'inProgress',
  }, 'session-1');
  assert.equal(runningSearch.toolResult, undefined);
});

test('Codex file_change toolInput exposes normalized changes and a file_path summary', () => {
  const [fromArray] = provider.normalizeMessage({
    type: 'item',
    itemType: 'file_change',
    uuid: 'file-array',
    changes: [
      { path: 'src/a.ts', kind: { type: 'update', move_path: null }, diff: '@@ -1 +1 @@' },
      { path: 'src/b.ts', kind: 'add', diff: 'new' },
    ],
    status: 'completed',
  }, 'session-1');
  assert.deepEqual(fromArray.toolInput, {
    changes: [
      { path: 'src/a.ts', kind: 'update', diff: '@@ -1 +1 @@' },
      { path: 'src/b.ts', kind: 'add', diff: 'new' },
    ],
    file_path: 'src/a.ts, src/b.ts',
  });

  const [fromMap] = provider.normalizeMessage({
    type: 'item',
    itemType: 'file_change',
    uuid: 'file-map',
    changes: {
      '/repo/x.ts': { type: 'update', unified_diff: '@@', move_path: null },
      '/repo/y.ts': { type: 'add', content: 'hello' },
    },
    status: 'completed',
  }, 'session-1');
  assert.deepEqual(fromMap.toolInput, {
    changes: [
      { path: '/repo/x.ts', kind: 'update', diff: '@@' },
      { path: '/repo/y.ts', kind: 'add', diff: 'hello' },
    ],
    file_path: '/repo/x.ts, /repo/y.ts',
  });
});
