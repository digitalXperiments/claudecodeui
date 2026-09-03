import assert from 'node:assert/strict';
import test from 'node:test';

import { buildCursorCliInvocation } from './cursor-cli.js';

test('buildCursorCliInvocation maps bypassPermissions to -f and keeps prompt flags', () => {
  const { args, extraEnv } = buildCursorCliInvocation({
    command: 'fix tests',
    resolvedModel: 'composer-1',
    permissionMode: 'bypassPermissions',
  });
  assert.equal(args.includes('-f'), true);
  assert.equal(args.includes('-p'), true);
  assert.equal(args.includes('--model'), true);
  assert.equal(args.includes('--output-format'), true);
  assert.deepEqual(extraEnv, {});
});

test('buildCursorCliInvocation does not drop empty disallowedTools', () => {
  const { extraEnv, args } = buildCursorCliInvocation({
    command: 'hello',
    toolsSettings: { disallowedTools: [], skipPermissions: false },
  });
  assert.equal(extraEnv.CLOUDCLI_DISALLOWED_TOOLS, '');
  const prompt = args[args.indexOf('-p') + 1];
  assert.equal(prompt.includes('disallowedTools'), false);
});

test('buildCursorCliInvocation passes disallowed tools via env and prompt suffix', () => {
  const { extraEnv, args, disallowedTools } = buildCursorCliInvocation({
    command: 'implement the task',
    toolsSettings: {
      disallowedTools: ['Task', 'Agent', 'Task'],
      allowedTools: ['Read'],
    },
  });
  assert.deepEqual(disallowedTools, ['Task', 'Agent']);
  assert.equal(extraEnv.CLOUDCLI_DISALLOWED_TOOLS, 'Task,Agent');
  assert.equal(extraEnv.CLOUDCLI_ALLOWED_TOOLS, 'Read');
  const prompt = args[args.indexOf('-p') + 1];
  assert.match(prompt, /implement the task/);
  assert.match(prompt, /disallowedTools/);
  assert.match(prompt, /Task, Agent/);
  assert.equal(args.includes('--disallowedTools'), false);
});

test('buildCursorCliInvocation stamps relay worker env without a no-mcp flag', () => {
  const { extraEnv, args, relayWorker } = buildCursorCliInvocation({
    command: 'worker job',
    relayWorker: true,
    mcpServers: ['obsidian', '  '],
    toolsSettings: { disallowedTools: ['Task'] },
  });
  assert.equal(relayWorker, true);
  assert.equal(extraEnv.CLOUDCLI_RELAY_WORKER, '1');
  assert.equal(extraEnv.CLOUDCLI_MCP_SERVERS, 'obsidian');
  assert.equal(args.includes('--approve-mcps'), false);
  assert.equal(args.some((arg) => /mcp/i.test(String(arg))), false);
});
