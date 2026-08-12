import assert from 'node:assert/strict';
import { chmod, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { makeScratchDir } from './shared/scratch.js';
import { resolveToolApproval } from './claude-sdk.js';
import {
  disposeOpenCodeSessions,
  getActiveOpenCodeSessions,
  resolveOpenCodePermissionPolicy,
  spawnOpenCode,
} from './opencode-cli.js';

const findEnvKey = (name) =>
  Object.keys(process.env).find((key) => key.toLowerCase() === name.toLowerCase()) || name;

/**
 * A stand-in for `opencode acp`: speaks newline-delimited JSON-RPC 2.0 on
 * stdio, streams the same session/update shapes opencode 1.18.11 emits, and —
 * when the prompt says so — asks for permission the way the real agent does.
 */
async function createFakeOpenCodeAcpAgent(binDir) {
  // `.cjs` keeps the fixture CommonJS even when TMPDIR is inside this repo and
  // therefore inherits the root package's `type: module` setting.
  const scriptPath = path.join(binDir, 'opencode.cjs');
  await writeFile(scriptPath, `
const fs = require('node:fs');
const readline = require('node:readline');

const capturePath = process.env.OPENCODE_ARGS_CAPTURE;
const capture = {
  args: process.argv.slice(2),
  permissionEnv: process.env.OPENCODE_PERMISSION ?? null,
  configOptions: [],
  prompts: [],
  permissionDecision: undefined,
};
const writeCapture = () => {
  if (capturePath) fs.writeFileSync(capturePath, JSON.stringify(capture));
};
writeCapture();

const send = (payload) => process.stdout.write(JSON.stringify(payload) + '\\n');
const notify = (update) => send({
  jsonrpc: '2.0',
  method: 'session/update',
  params: { sessionId: 'open-live-1', update },
});

const pendingPrompts = new Map();
let permissionRequestId = 9000;

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);

  // A response to our own session/request_permission.
  if (msg.id !== undefined && msg.method === undefined && pendingPrompts.has(msg.id)) {
    const { promptId, allowed } = pendingPrompts.get(msg.id);
    pendingPrompts.delete(msg.id);
    capture.permissionDecision = msg.result?.outcome?.optionId ?? null;
    writeCapture();
    const granted = /once|always/.test(capture.permissionDecision || '');
    if (granted) {
      notify({ sessionUpdate: 'tool_call_update', toolCallId: 'call-1', status: 'completed', title: 'ls', content: [{ type: 'content', content: { type: 'text', text: 'granted-output' } }], rawOutput: { output: 'granted-output' } });
    }
    notify({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: granted ? 'ALLOWED' : 'DENIED' } });
    send({ jsonrpc: '2.0', id: promptId, result: { stopReason: 'end_turn' } });
    return;
  }

  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
    return;
  }

  if (msg.method === 'session/new' || msg.method === 'session/load') {
    capture.sessionMethods = (capture.sessionMethods || []).concat(msg.method);
    writeCapture();
    send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'open-live-1', configOptions: [] } });
    return;
  }

  if (msg.method === 'session/set_config_option') {
    capture.configOptions.push({ configId: msg.params.configId, value: msg.params.value });
    writeCapture();
    if (process.env.OPENCODE_REJECT_CONFIG_ID === msg.params.configId) {
      send({ jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: 'unsupported ' + msg.params.configId } });
      return;
    }
    send({ jsonrpc: '2.0', id: msg.id, result: { configOptions: [] } });
    return;
  }

  if (msg.method === 'session/prompt') {
    const text = msg.params.prompt.map((part) => part.text).join('');
    capture.prompts.push(text);
    writeCapture();

    // Simulate a mid-prompt process death (crash/OOM): die on the first
    // prompt, behave normally once the marker file exists.
    if (text.includes('CRASH_ONCE')) {
      const marker = process.env.OPENCODE_CRASH_MARKER;
      if (marker && !fs.existsSync(marker)) {
        fs.writeFileSync(marker, '1');
        process.exit(1);
      }
    }

    if (text.includes('NEEDS_PERMISSION')) {
      const requestId = permissionRequestId++;
      pendingPrompts.set(requestId, { promptId: msg.id });
      send({
        jsonrpc: '2.0',
        id: requestId,
        method: 'session/request_permission',
        params: {
          sessionId: 'open-live-1',
          toolCall: { toolCallId: 'call-1', title: 'ls /outside', kind: 'execute', status: 'pending', locations: [{ path: '/outside' }], rawInput: { command: 'ls /outside' } },
          options: [
            { optionId: 'once', kind: 'allow_once', name: 'Allow once' },
            { optionId: 'always', kind: 'allow_always', name: 'Always allow' },
            { optionId: 'reject', kind: 'reject_once', name: 'Reject' },
          ],
        },
      });
      return;
    }

    if (text.includes('NO_FINAL_TEXT')) {
      notify({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'work completed internally' } });
      send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
      return;
    }

    if (text.includes('previous turn ended without an assistant-facing answer')) {
      notify({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '{"summary":"final report"}' } });
      send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
      return;
    }

    notify({ sessionUpdate: 'tool_call', toolCallId: 'call-1', title: 'bash', kind: 'execute', status: 'pending', rawInput: { cwd: '/tmp' } });
    notify({ sessionUpdate: 'tool_call_update', toolCallId: 'call-1', status: 'in_progress', title: 'echo hi', rawInput: { command: 'echo hi' } });
    // Terminal updates are allowed to repeat rawInput; the runtime must still
    // emit the tool result rather than treating this as a duplicate tool_use.
    notify({ sessionUpdate: 'tool_call_update', toolCallId: 'call-1', status: 'completed', title: 'echo hi', rawInput: { command: 'echo hi' }, content: [{ type: 'content', content: { type: 'text', text: 'hi\\n' } }], rawOutput: { output: 'hi\\n' } });
    notify({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'assistant response' } });
    send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
    return;
  }
});
`, 'utf8');

  if (process.platform === 'win32') {
    await writeFile(path.join(binDir, 'opencode.cmd'), '@echo off\r\nnode "%~dp0opencode.cjs" %*\r\n', 'utf8');
    return;
  }

  const commandPath = path.join(binDir, 'opencode');
  await writeFile(commandPath, '#!/bin/sh\nnode "$(dirname "$0")/opencode.cjs" "$@"\n', 'utf8');
  await chmod(commandPath, 0o755);
}

/** Runs `body` with the fake agent first on PATH. */
async function withFakeAgent(prefix, body) {
  const tempRoot = await makeScratchDir(prefix);
  const pathKey = findEnvKey('PATH');
  const pathExtKey = findEnvKey('PATHEXT');
  const previousPath = process.env[pathKey];
  const previousPathExt = process.env[pathExtKey];
  const previousArgsCapture = process.env.OPENCODE_ARGS_CAPTURE;
  const previousRejectedConfig = process.env.OPENCODE_REJECT_CONFIG_ID;

  try {
    await createFakeOpenCodeAcpAgent(tempRoot);
    process.env[pathKey] = `${tempRoot}${path.delimiter}${previousPath || ''}`;
    if (process.platform === 'win32') {
      process.env[pathExtKey] = previousPathExt?.toUpperCase().includes('.CMD')
        ? previousPathExt
        : `.COM;.EXE;.BAT;.CMD${previousPathExt ? `;${previousPathExt}` : ''}`;
    }
    await body(tempRoot);
  } finally {
    disposeOpenCodeSessions();
    if (previousPath === undefined) delete process.env[pathKey];
    else process.env[pathKey] = previousPath;
    if (previousPathExt === undefined) delete process.env[pathExtKey];
    else process.env[pathExtKey] = previousPathExt;
    if (previousArgsCapture === undefined) delete process.env.OPENCODE_ARGS_CAPTURE;
    else process.env.OPENCODE_ARGS_CAPTURE = previousArgsCapture;
    if (previousRejectedConfig === undefined) delete process.env.OPENCODE_REJECT_CONFIG_ID;
    else process.env.OPENCODE_REJECT_CONFIG_ID = previousRejectedConfig;
    await rm(tempRoot, { recursive: true, force: true });
  }
}

const createWriter = (messages) => ({
  userId: null,
  sessionId: null,
  send(message) {
    messages.push(message);
  },
  setSessionId(sessionId) {
    this.sessionId = sessionId;
  },
});

test('spawnOpenCode streams ACP updates and emits session_created first', { concurrency: false }, async () => {
  await withFakeAgent('opencode-cli-acp-', async (tempRoot) => {
    const argsCapturePath = path.join(tempRoot, 'capture.json');
    process.env.OPENCODE_ARGS_CAPTURE = argsCapturePath;
    const messages = [];
    const writer = createWriter(messages);

    await spawnOpenCode('Hi', { cwd: tempRoot }, writer);

    const sessionCreatedIndex = messages.findIndex((message) => message.kind === 'session_created');
    const deltaIndex = messages.findIndex(
      (message) => message.kind === 'stream_delta' && message.content === 'assistant response',
    );
    const toolUse = messages.find((message) => message.kind === 'tool_use');
    const toolResult = messages.find((message) => message.kind === 'tool_result');

    assert.notEqual(sessionCreatedIndex, -1);
    assert.notEqual(deltaIndex, -1);
    assert.ok(sessionCreatedIndex < deltaIndex);
    assert.equal(messages[sessionCreatedIndex].newSessionId, 'open-live-1');
    assert.equal(writer.sessionId, 'open-live-1');
    // The tool keeps its real name even though later updates retitle themselves
    // with the command being run.
    assert.equal(toolUse?.toolName, 'bash');
    assert.deepEqual(toolUse?.toolInput, { command: 'echo hi' });
    // Exact bytes, including the trailing newline: trimming stream chunks is
    // what silently reflowed code blocks and JSON payloads.
    assert.equal(toolResult?.content, 'hi\n');
    assert.equal(messages.find((message) => message.kind === 'complete')?.sessionId, 'open-live-1');
    assert.equal(messages.some((message) => message.kind === 'error'), false);

    const capture = JSON.parse(await readFile(argsCapturePath, 'utf8'));
    assert.deepEqual(capture.args, ['acp', '--cwd', tempRoot]);
    // No permission mode requested → the relaying "ask" policy is the default.
    assert.equal(capture.permissionEnv, JSON.stringify({ edit: 'ask', bash: 'ask', webfetch: 'ask', external_directory: 'ask' }));
    assert.ok(capture.configOptions.some((option) => option.configId === 'mode' && option.value === 'build'));
  });
});

test('spawnOpenCode relays a permission request and applies the approval', { concurrency: false }, async () => {
  await withFakeAgent('opencode-cli-approve-', async (tempRoot) => {
    const argsCapturePath = path.join(tempRoot, 'capture.json');
    process.env.OPENCODE_ARGS_CAPTURE = argsCapturePath;
    const messages = [];
    const writer = {
      ...createWriter(messages),
      send(message) {
        messages.push(message);
        // Stand in for the chatbar / swarm permission broker.
        if (message.kind === 'permission_request') {
          setImmediate(() => resolveToolApproval(message.requestId, { allow: true }));
        }
      },
    };

    await spawnOpenCode('NEEDS_PERMISSION', { cwd: tempRoot, permissionMode: 'plan' }, writer);

    const request = messages.find((message) => message.kind === 'permission_request');
    assert.ok(request, 'the ACP permission ask must reach the client');
    assert.equal(request.toolName, 'ls /outside');
    assert.deepEqual(request.input, { command: 'ls /outside' });
    assert.ok(request.paths.includes('/outside'));

    const capture = JSON.parse(await readFile(argsCapturePath, 'utf8'));
    assert.equal(capture.permissionDecision, 'once');
    assert.ok(capture.configOptions.some((option) => option.configId === 'mode' && option.value === 'plan'));
    assert.ok(messages.some((message) => message.kind === 'stream_delta' && message.content === 'ALLOWED'));
  });
});

test('an unanswered unattended permission request is denied, not left hanging', { concurrency: false }, async () => {
  await withFakeAgent('opencode-cli-deny-', async (tempRoot) => {
    const argsCapturePath = path.join(tempRoot, 'capture.json');
    process.env.OPENCODE_ARGS_CAPTURE = argsCapturePath;
    const messages = [];

    await spawnOpenCode(
      'NEEDS_PERMISSION',
      { cwd: tempRoot, permissionMode: 'default', unattended: true, approvalTimeoutMs: 250 },
      createWriter(messages),
    );

    const capture = JSON.parse(await readFile(argsCapturePath, 'utf8'));
    assert.equal(capture.permissionDecision, 'reject');
    assert.ok(messages.some((message) => message.kind === 'stream_delta' && message.content === 'DENIED'));
    assert.ok(messages.some((message) => message.kind === 'complete'));
  });
});

test('bypassPermissions approves locally without troubling the client', { concurrency: false }, async () => {
  await withFakeAgent('opencode-cli-bypass-', async (tempRoot) => {
    const argsCapturePath = path.join(tempRoot, 'capture.json');
    process.env.OPENCODE_ARGS_CAPTURE = argsCapturePath;
    const messages = [];

    await spawnOpenCode(
      'NEEDS_PERMISSION',
      { cwd: tempRoot, permissionMode: 'bypassPermissions', unattended: true },
      createWriter(messages),
    );

    const capture = JSON.parse(await readFile(argsCapturePath, 'utf8'));
    assert.equal(capture.permissionDecision, 'once');
    // Nothing was asked of the user, and the user's own config stays in charge.
    assert.equal(messages.some((message) => message.kind === 'permission_request'), false);
    assert.equal(capture.permissionEnv, null);
  });
});

test('a mid-prompt ACP crash respawns once and resumes the same session', { concurrency: false }, async () => {
  await withFakeAgent('opencode-cli-crash-', async (tempRoot) => {
    const argsCapturePath = path.join(tempRoot, 'capture.json');
    process.env.OPENCODE_ARGS_CAPTURE = argsCapturePath;
    process.env.OPENCODE_CRASH_MARKER = path.join(tempRoot, 'crash.marker');
    try {
      const messages = [];
      await spawnOpenCode('CRASH_ONCE', { cwd: tempRoot }, createWriter(messages));

      assert.ok(
        messages.some((message) => message.kind === 'stream_delta' && message.content === 'assistant response'),
        'the retried prompt must stream the answer',
      );
      assert.equal(messages.some((message) => message.kind === 'error'), false);
      assert.equal(messages.find((message) => message.kind === 'complete')?.exitCode, 0);

      // The respawned child resumed the crashed child's session rather than
      // starting a fresh one.
      const capture = JSON.parse(await readFile(argsCapturePath, 'utf8'));
      assert.deepEqual(capture.sessionMethods, ['session/load']);
    } finally {
      delete process.env.OPENCODE_CRASH_MARKER;
    }
  });
});

test('unattended runs dispose their ACP child on completion', { concurrency: false }, async () => {
  await withFakeAgent('opencode-cli-dispose-', async (tempRoot) => {
    const messages = [];
    await spawnOpenCode('Hi', { cwd: tempRoot, unattended: true }, createWriter(messages));

    assert.ok(messages.some((message) => message.kind === 'complete'));
    // No idle 500MB child left behind for the 30-minute idle window.
    assert.deepEqual(getActiveOpenCodeSessions(), []);
  });
});

test('required OpenCode model configuration fails before prompting', { concurrency: false }, async () => {
  await withFakeAgent('opencode-cli-model-reject-', async (tempRoot) => {
    const argsCapturePath = path.join(tempRoot, 'capture.json');
    process.env.OPENCODE_ARGS_CAPTURE = argsCapturePath;
    process.env.OPENCODE_REJECT_CONFIG_ID = 'model';

    await assert.rejects(
      spawnOpenCode('must not run', { cwd: tempRoot, model: 'vendor/missing-model', unattended: true }, createWriter([])),
      /rejected required model=vendor\/missing-model: unsupported model/,
    );

    const capture = JSON.parse(await readFile(argsCapturePath, 'utf8'));
    assert.deepEqual(capture.prompts, []);
    assert.deepEqual(getActiveOpenCodeSessions(), []);
  });
});

test('required OpenCode mode configuration fails before prompting', { concurrency: false }, async () => {
  await withFakeAgent('opencode-cli-mode-reject-', async (tempRoot) => {
    const argsCapturePath = path.join(tempRoot, 'capture.json');
    process.env.OPENCODE_ARGS_CAPTURE = argsCapturePath;
    process.env.OPENCODE_REJECT_CONFIG_ID = 'mode';

    await assert.rejects(
      spawnOpenCode('must not run', { cwd: tempRoot, permissionMode: 'plan', unattended: true }, createWriter([])),
      /rejected required mode=plan: unsupported mode/,
    );

    const capture = JSON.parse(await readFile(argsCapturePath, 'utf8'));
    assert.deepEqual(capture.prompts, []);
    assert.deepEqual(getActiveOpenCodeSessions(), []);
  });
});

test('an unattended empty turn gets one same-session final-report nudge', { concurrency: false }, async () => {
  await withFakeAgent('opencode-cli-final-nudge-', async (tempRoot) => {
    const argsCapturePath = path.join(tempRoot, 'capture.json');
    process.env.OPENCODE_ARGS_CAPTURE = argsCapturePath;
    const messages = [];

    await spawnOpenCode('NO_FINAL_TEXT', { cwd: tempRoot, unattended: true }, createWriter(messages));

    const capture = JSON.parse(await readFile(argsCapturePath, 'utf8'));
    assert.equal(capture.prompts.length, 2);
    assert.equal(capture.prompts[0], 'NO_FINAL_TEXT');
    assert.match(capture.prompts[1], /previous turn ended without an assistant-facing answer/);
    assert.deepEqual(capture.sessionMethods, ['session/new']);
    assert.ok(messages.some(
      (message) => message.kind === 'stream_delta' && message.content === '{"summary":"final report"}',
    ));
    assert.equal(messages.filter((message) => message.kind === 'complete').length, 1);
    assert.deepEqual(getActiveOpenCodeSessions(), []);
  });
});

test('resolveOpenCodePermissionPolicy maps UI permission modes onto ACP controls', () => {
  const relayed = JSON.stringify({ edit: 'ask', bash: 'ask', webfetch: 'ask', external_directory: 'ask' });

  assert.deepEqual(resolveOpenCodePermissionPolicy('plan'), {
    mode: 'plan',
    autoApprove: false,
    env: { OPENCODE_PERMISSION: relayed },
  });
  assert.deepEqual(resolveOpenCodePermissionPolicy('auto'), { mode: 'build', autoApprove: true, env: {} });
  // Legacy alias kept so old persisted session values still work.
  assert.deepEqual(resolveOpenCodePermissionPolicy('bypassPermissions'), { mode: 'build', autoApprove: true, env: {} });
  assert.deepEqual(resolveOpenCodePermissionPolicy('acceptEdits'), {
    mode: 'build',
    autoApprove: false,
    env: { OPENCODE_PERMISSION: JSON.stringify({ edit: 'allow', bash: 'ask', webfetch: 'ask', external_directory: 'ask' }) },
  });
  assert.deepEqual(resolveOpenCodePermissionPolicy('default'), {
    mode: 'build',
    autoApprove: false,
    env: { OPENCODE_PERMISSION: relayed },
  });
});
