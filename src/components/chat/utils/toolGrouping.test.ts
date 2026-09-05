import assert from 'node:assert/strict';
import test from 'node:test';

import type { ChatMessage } from '../types/types';

import { groupConsecutiveTools, isToolGroupItem } from './toolGrouping';

function tool(
  toolName: string,
  timestamp: number,
  overrides: Partial<ChatMessage> = {},
): ChatMessage {
  return {
    type: 'assistant',
    timestamp,
    isToolUse: true,
    toolName,
    toolInput: { command: `${toolName}-${timestamp}` },
    toolResult: { content: 'ok', isError: false },
    ...overrides,
  };
}

test('groups completed shell aliases under one canonical compact Bash group', () => {
  const grouped = groupConsecutiveTools([
    tool('bash', 1),
    tool('shell', 2),
    tool('shell_command', 3),
  ]);

  assert.equal(grouped.length, 1);
  assert.equal(isToolGroupItem(grouped[0]), true);
  if (!isToolGroupItem(grouped[0])) return;
  assert.equal(grouped[0].toolName, 'Bash');
  assert.deepEqual(grouped[0].messages.map((message) => message.toolName), [
    'bash',
    'shell',
    'shell_command',
  ]);
});

test('keeps running and failed tools out of collapsed groups so their state stays visible', () => {
  const messages = [
    tool('exec', 1, { toolResult: null }),
    tool('exec', 2, { toolResult: { content: 'boom', isError: true } }),
    tool('exec', 3),
    tool('exec', 4),
  ];
  const grouped = groupConsecutiveTools(messages);

  assert.equal(grouped.length, 3);
  assert.equal(grouped[0], messages[0]);
  assert.equal(grouped[1], messages[1]);
  assert.equal(isToolGroupItem(grouped[2]), true);
});

test('hidden reasoning does not split an otherwise consecutive tool group', () => {
  const hiddenReasoning: ChatMessage = {
    type: 'assistant',
    timestamp: 2,
    isThinking: true,
    content: 'internal',
  };
  const grouped = groupConsecutiveTools([
    tool('exec', 1),
    hiddenReasoning,
    tool('exec', 3),
  ], false);

  assert.equal(grouped.length, 1);
  assert.equal(isToolGroupItem(grouped[0]), true);
});
