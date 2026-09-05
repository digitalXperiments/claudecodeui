import assert from 'node:assert/strict';
import { chmod, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { makeScratchDir } from './shared/scratch.js';
import { resolveToolApproval } from './claude-sdk.js';
import { mcpCatalogService } from './modules/providers/services/mcp-catalog.service.js';
import {
  disposeAntigravitySessions,
  disposeKiloSessions,
  disposeOpenCodeSessions,
  getActiveOpenCodeSessions,
  resolveAntigravityPermissionPolicy,
  resolveKiloPermissionPolicy,
  resolveOpenCodePermissionPolicy,
  handleAcpFsRequest,
  resolveQwenPermissionPolicy,
  sliceTextByLines,
  spawnAntigravity,
  spawnQwenCode,
  spawnKilo,
  spawnOpenCode,
  toOpenCodeAcpMcpServers,
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
  kiloPermissionEnv: process.env.KILO_PERMISSION ?? null,
  leadSessionId: process.env.CLOUDCLI_LEAD_SESSION_ID ?? null,
  mcpServers: [],
  configOptions: [],
  prompts: [],
  permissionDecision: undefined,
};
if (process.argv.includes('models')) {
  process.stdout.write('kilo/stealth/claude-sonnet-4.6\\n');
  process.exit(0);
}
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
    capture.mcpServers = msg.params?.mcpServers ?? [];
    writeCapture();
    // OPENCODE_FAKE_MODES simulates a CLI whose default agent is named
    // differently (Kilo's "code" vs OpenCode's "build").
    const fakeModes = (process.env.OPENCODE_FAKE_MODES || '').split(',').map((v) => v.trim()).filter(Boolean);
    const configOptions = fakeModes.length
      ? [{ id: 'mode', category: 'mode', type: 'select', currentValue: fakeModes[0], options: fakeModes.map((v) => ({ value: v, name: v })) }]
      : [];
    send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'open-live-1', configOptions } });
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

  if (msg.method === 'session/set_model' || msg.method === 'session/set_mode') {
    capture.configOptions.push({ method: msg.method, value: msg.params.modelId || msg.params.modeId });
    writeCapture();
    send({ jsonrpc: '2.0', id: msg.id, result: {} });
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
  const kiloCommandPath = path.join(binDir, 'kilo');
  await writeFile(kiloCommandPath, '#!/bin/sh\nnode "$(dirname "$0")/opencode.cjs" "$@"\n', 'utf8');
  await chmod(kiloCommandPath, 0o755);
  const qwenCommandPath = path.join(binDir, 'qwen');
  await writeFile(qwenCommandPath, '#!/bin/sh\nnode "$(dirname "$0")/opencode.cjs" "$@"\n', 'utf8');
  await chmod(qwenCommandPath, 0o755);
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
  const previousFakeModes = process.env.OPENCODE_FAKE_MODES;
  const previousListEnabled = mcpCatalogService.listEnabledNames;
  const previousResolve = mcpCatalogService.resolveForProvider;

  try {
    // Isolate ACP tests from the developer's real catalog (this machine has
    // Obsidian bound to OpenCode). Individual tests override these stubs.
    mcpCatalogService.listEnabledNames = async () => [];
    mcpCatalogService.resolveForProvider = async () => [];
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
    disposeKiloSessions();
    if (previousPath === undefined) delete process.env[pathKey];
    else process.env[pathKey] = previousPath;
    if (previousPathExt === undefined) delete process.env[pathExtKey];
    else process.env[pathExtKey] = previousPathExt;
    if (previousArgsCapture === undefined) delete process.env.OPENCODE_ARGS_CAPTURE;
    else process.env.OPENCODE_ARGS_CAPTURE = previousArgsCapture;
    if (previousRejectedConfig === undefined) delete process.env.OPENCODE_REJECT_CONFIG_ID;
    else process.env.OPENCODE_REJECT_CONFIG_ID = previousRejectedConfig;
    if (previousFakeModes === undefined) delete process.env.OPENCODE_FAKE_MODES;
    else process.env.OPENCODE_FAKE_MODES = previousFakeModes;
    mcpCatalogService.listEnabledNames = previousListEnabled;
    mcpCatalogService.resolveForProvider = previousResolve;
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
    assert.deepEqual(capture.mcpServers, []);
  });
});

test('spawnKilo uses the Kilo ACP command, permission env, and provider identity', { concurrency: false }, async () => {
  await withFakeAgent('kilo-cli-acp-', async (tempRoot) => {
    const argsCapturePath = path.join(tempRoot, 'capture.json');
    process.env.OPENCODE_ARGS_CAPTURE = argsCapturePath;
    const messages = [];

    await spawnKilo('Hi', { cwd: tempRoot }, createWriter(messages));

    const sessionCreated = messages.find((message) => message.kind === 'session_created');
    const complete = messages.find((message) => message.kind === 'complete');
    const delta = messages.find((message) => message.kind === 'stream_delta');
    const capture = JSON.parse(await readFile(argsCapturePath, 'utf8'));

    assert.equal(sessionCreated?.provider, 'kilo');
    assert.equal(complete?.provider, 'kilo');
    assert.equal(delta?.provider, 'kilo');
    assert.deepEqual(capture.args, ['acp', '--cwd', tempRoot]);
    assert.equal(
      capture.kiloPermissionEnv,
      JSON.stringify({ edit: 'ask', bash: 'ask', webfetch: 'ask', external_directory: 'ask' }),
    );
  });
});

test('spawnKilo requests the `code` agent current Kilo releases advertise', { concurrency: false }, async () => {
  await withFakeAgent('kilo-cli-modes-', async (tempRoot) => {
    const argsCapturePath = path.join(tempRoot, 'capture.json');
    process.env.OPENCODE_ARGS_CAPTURE = argsCapturePath;
    // The mode list a current `kilo acp` advertises (7.4.x): no `build`.
    process.env.OPENCODE_FAKE_MODES = 'code,ask,debug,orchestrator,plan';

    await spawnKilo('Hi', { cwd: tempRoot }, createWriter([]));

    const capture = JSON.parse(await readFile(argsCapturePath, 'utf8'));
    assert.ok(capture.configOptions.some((option) => option.configId === 'mode' && option.value === 'code'));
  });
});

test('a CLI that names its default agent differently gets an advertised fallback mode', { concurrency: false }, async () => {
  await withFakeAgent('kilo-cli-mode-fallback-', async (tempRoot) => {
    const argsCapturePath = path.join(tempRoot, 'capture.json');
    process.env.OPENCODE_ARGS_CAPTURE = argsCapturePath;
    // Older Kilo builds exposed OpenCode's `build` agent instead of `code`.
    process.env.OPENCODE_FAKE_MODES = 'build,plan';

    await spawnKilo('Hi', { cwd: tempRoot }, createWriter([]));

    const capture = JSON.parse(await readFile(argsCapturePath, 'utf8'));
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

test('unattended plan auto-approves inspect bash without asking the client', { concurrency: false }, async () => {
  await withFakeAgent('opencode-cli-plan-unattended-', async (tempRoot) => {
    const argsCapturePath = path.join(tempRoot, 'capture.json');
    process.env.OPENCODE_ARGS_CAPTURE = argsCapturePath;
    const messages = [];

    await spawnOpenCode(
      'NEEDS_PERMISSION',
      { cwd: tempRoot, permissionMode: 'plan', unattended: true },
      createWriter(messages),
    );

    const capture = JSON.parse(await readFile(argsCapturePath, 'utf8'));
    assert.equal(capture.permissionDecision, 'once');
    assert.equal(messages.some((message) => message.kind === 'permission_request'), false);
    assert.ok(capture.configOptions.some((option) => option.configId === 'mode' && option.value === 'plan'));
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

test('resolveKiloPermissionPolicy maps UI permission modes onto Kilo ACP controls', () => {
  const relayed = JSON.stringify({ edit: 'ask', bash: 'ask', webfetch: 'ask', external_directory: 'ask' });

  assert.deepEqual(resolveKiloPermissionPolicy('plan'), {
    mode: 'plan',
    autoApprove: false,
    env: { KILO_PERMISSION: relayed },
  });
  // Kilo's full-access default agent is `code` (OpenCode's is `build`).
  assert.deepEqual(resolveKiloPermissionPolicy('auto'), { mode: 'code', autoApprove: true, env: {} });
  assert.deepEqual(resolveKiloPermissionPolicy('bypassPermissions'), { mode: 'code', autoApprove: true, env: {} });
  assert.deepEqual(resolveKiloPermissionPolicy('acceptEdits'), {
    mode: 'code',
    autoApprove: false,
    env: { KILO_PERMISSION: JSON.stringify({ edit: 'allow', bash: 'ask', webfetch: 'ask', external_directory: 'ask' }) },
  });
  assert.deepEqual(resolveKiloPermissionPolicy('default'), {
    mode: 'code',
    autoApprove: false,
    env: { KILO_PERMISSION: relayed },
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

test('spawnQwenCode uses the official qwen --acp entry point and ACP model control', { concurrency: false }, async () => {
  await withFakeAgent('qwencode-cli-acp-', async (tempRoot) => {
    const argsCapturePath = path.join(tempRoot, 'qwen-capture.json');
    process.env.OPENCODE_ARGS_CAPTURE = argsCapturePath;
    const messages = [];
    await spawnQwenCode('Hi', { cwd: tempRoot, model: 'qwen3-coder-plus', permissionMode: 'bypassPermissions', unattended: true }, createWriter(messages));
    const capture = JSON.parse(await readFile(argsCapturePath, 'utf8'));
    assert.deepEqual(capture.args, ['--acp']);
    assert.ok(capture.configOptions.some((option) => option.method === 'session/set_model'));
    assert.equal(messages.find((message) => message.kind === 'complete')?.provider, 'qwencode');
  });
});

test('resolveQwenPermissionPolicy maps bypass to yolo and keeps plan interactive', () => {
  assert.equal(resolveQwenPermissionPolicy('bypassPermissions').mode, 'yolo');
  assert.equal(resolveQwenPermissionPolicy('plan').autoApprove, false);
});

test('resolveAntigravityPermissionPolicy maps onto yolo / auto_edit / default only', () => {
  assert.deepEqual(resolveAntigravityPermissionPolicy('bypassPermissions'), { mode: 'yolo', autoApprove: true, env: {} });
  assert.deepEqual(resolveAntigravityPermissionPolicy('auto'), { mode: 'yolo', autoApprove: true, env: {} });
  assert.deepEqual(resolveAntigravityPermissionPolicy('acceptEdits'), { mode: 'auto_edit', autoApprove: false, env: {} });
  assert.deepEqual(resolveAntigravityPermissionPolicy('default'), { mode: 'default', autoApprove: false, env: {} });
  // Antigravity has no read-only agent, so `plan` must not claim one: it stays
  // on the ask-everything mode rather than silently becoming a write mode.
  assert.deepEqual(resolveAntigravityPermissionPolicy('plan'), { mode: 'default', autoApprove: false, env: {} });
});

test('spawnAntigravity runs the resolved binary with no acp subcommand', { concurrency: false }, async () => {
  await withFakeAgent('antigravity-cli-acp-', async (tempRoot) => {
    // The managed runtime is a binary path, not a PATH command — point the
    // explicit override at the fake agent the way Settings would.
    const binaryPath = path.join(tempRoot, 'agy_acp_server');
    await writeFile(binaryPath, '#!/bin/sh\nnode "$(dirname "$0")/opencode.cjs" "$@"\n', 'utf8');
    await chmod(binaryPath, 0o755);

    const argsCapturePath = path.join(tempRoot, 'antigravity-capture.json');
    const previousOverride = process.env.ANTIGRAVITY_ACP_PATH;
    process.env.ANTIGRAVITY_ACP_PATH = binaryPath;
    process.env.OPENCODE_ARGS_CAPTURE = argsCapturePath;
    try {
      const messages = [];
      await spawnAntigravity('Hi', { cwd: tempRoot, permissionMode: 'bypassPermissions', unattended: true }, createWriter(messages));
      const capture = JSON.parse(await readFile(argsCapturePath, 'utf8'));
      // No `acp` subcommand and no `--cwd`: the ACP server IS the entry point.
      assert.deepEqual(capture.args, []);
      assert.ok(capture.configOptions.some((option) => option.configId === 'mode' && option.value === 'yolo'));
      assert.equal(messages.find((message) => message.kind === 'complete')?.provider, 'antigravity');
    } finally {
      disposeAntigravitySessions();
      if (previousOverride === undefined) delete process.env.ANTIGRAVITY_ACP_PATH;
      else process.env.ANTIGRAVITY_ACP_PATH = previousOverride;
    }
  });
});

test('spawnAntigravity reports an invalid binary override instead of falling back to PATH', { concurrency: false }, async () => {
  await withFakeAgent('antigravity-bad-override-', async (tempRoot) => {
    const previousOverride = process.env.ANTIGRAVITY_ACP_PATH;
    process.env.ANTIGRAVITY_ACP_PATH = path.join(tempRoot, 'does-not-exist');
    try {
      const messages = [];
      await assert.rejects(
        spawnAntigravity('Hi', { cwd: tempRoot, permissionMode: 'default', unattended: true }, createWriter(messages)),
        /is not an executable file/,
      );
    } finally {
      disposeAntigravitySessions();
      if (previousOverride === undefined) delete process.env.ANTIGRAVITY_ACP_PATH;
      else process.env.ANTIGRAVITY_ACP_PATH = previousOverride;
    }
  });
});

test('toOpenCodeAcpMcpServers converts stdio without a type tag and stamps the lead session', () => {
  const converted = toOpenCodeAcpMcpServers([
    {
      name: 'cloudcli-agent-relay',
      transport: 'stdio',
      command: 'node',
      args: ['relay.js'],
      env: { CLOUDCLI_AGENT_RELAY_MCP_TOKEN: 'tok' },
    },
    {
      name: 'remote-tools',
      transport: 'http',
      url: 'https://example.com/mcp',
      headers: { Authorization: 'Bearer x' },
    },
  ], { CLOUDCLI_LEAD_SESSION_ID: 'sess-lead-1' });

  assert.deepEqual(converted, [
    {
      name: 'cloudcli-agent-relay',
      command: 'node',
      args: ['relay.js'],
      env: [
        { name: 'CLOUDCLI_AGENT_RELAY_MCP_TOKEN', value: 'tok' },
        { name: 'CLOUDCLI_LEAD_SESSION_ID', value: 'sess-lead-1' },
      ],
    },
    {
      name: 'remote-tools',
      type: 'http',
      url: 'https://example.com/mcp',
      headers: [{ name: 'Authorization', value: 'Bearer x' }],
    },
  ]);
  assert.equal('type' in converted[0], false);
});

test('OpenCode lead sessions attach catalog MCP including Agent Relay', { concurrency: false }, async () => {
  await withFakeAgent('opencode-cli-lead-mcp-', async (tempRoot) => {
    const argsCapturePath = path.join(tempRoot, 'capture.json');
    process.env.OPENCODE_ARGS_CAPTURE = argsCapturePath;
    mcpCatalogService.listEnabledNames = async (provider) => {
      assert.equal(provider, 'opencode');
      return ['cloudcli-agent-relay', 'obsidian'];
    };
    mcpCatalogService.resolveForProvider = async (provider, names) => {
      assert.equal(provider, 'opencode');
      const wanted = new Set(names);
      return [
        wanted.has('cloudcli-agent-relay') ? {
          name: 'cloudcli-agent-relay',
          transport: 'stdio',
          command: 'node',
          args: ['relay.js'],
          env: { CLOUDCLI_AGENT_RELAY_MCP_TOKEN: 'tok' },
        } : null,
        wanted.has('obsidian') ? {
          name: 'obsidian',
          transport: 'stdio',
          command: 'npx',
          args: ['obsidian-mcp'],
        } : null,
      ].filter(Boolean);
    };

    await spawnOpenCode('Hi', { cwd: tempRoot, appSessionId: 'app-lead-1' }, createWriter([]));

    const capture = JSON.parse(await readFile(argsCapturePath, 'utf8'));
    assert.equal(capture.leadSessionId, 'app-lead-1');
    assert.equal(capture.mcpServers.length, 2);
    assert.equal(capture.mcpServers[0].name, 'cloudcli-agent-relay');
    assert.equal('type' in capture.mcpServers[0], false);
    assert.ok(capture.mcpServers[0].env.some((entry) => entry.name === 'CLOUDCLI_LEAD_SESSION_ID' && entry.value === 'app-lead-1'));
    assert.equal(capture.mcpServers[1].name, 'obsidian');
  });
});

test('OpenCode relay workers attach opt-in MCP and never inherit Agent Relay', { concurrency: false }, async () => {
  await withFakeAgent('opencode-cli-worker-mcp-', async (tempRoot) => {
    const argsCapturePath = path.join(tempRoot, 'capture.json');
    process.env.OPENCODE_ARGS_CAPTURE = argsCapturePath;
    mcpCatalogService.listEnabledNames = async () => {
      throw new Error('relay workers must not inherit the OpenCode lead catalog');
    };
    mcpCatalogService.resolveForProvider = async (provider, names) => {
      assert.equal(provider, 'opencode');
      assert.deepEqual(names, ['obsidian']);
      return [{ name: 'obsidian', transport: 'stdio', command: 'npx', args: ['obsidian-mcp'] }];
    };

    await spawnOpenCode(
      'Hi',
      {
        cwd: tempRoot,
        relayWorker: true,
        mcpServers: ['cloudcli-agent-relay', 'obsidian'],
        appSessionId: 'worker-session',
      },
      createWriter([]),
    );

    const capture = JSON.parse(await readFile(argsCapturePath, 'utf8'));
    assert.deepEqual(capture.mcpServers.map((server) => server.name), ['obsidian']);
  });
});

test('Kilo ACP sessions do not auto-attach the OpenCode catalog', { concurrency: false }, async () => {
  await withFakeAgent('kilo-cli-no-opencode-catalog-', async (tempRoot) => {
    const argsCapturePath = path.join(tempRoot, 'capture.json');
    process.env.OPENCODE_ARGS_CAPTURE = argsCapturePath;
    mcpCatalogService.listEnabledNames = async () => {
      throw new Error('kilo must not load the OpenCode catalog');
    };

    await spawnKilo('Hi', { cwd: tempRoot }, createWriter([]));

    const capture = JSON.parse(await readFile(argsCapturePath, 'utf8'));
    assert.deepEqual(capture.mcpServers, []);
  });
});

test('ACP fs/read_text_file answers the agent instead of leaving its tool pending', { concurrency: false }, async () => {
  // Antigravity's client_view_file / client_edit_file run through these; an
  // unanswered request hangs the tool and then the whole session/prompt.
  const tempRoot = await makeScratchDir('acp-fs-read-');
  try {
    const target = path.join(tempRoot, 'sample.txt');
    await writeFile(target, 'one\ntwo\nthree\n', 'utf8');

    const sent = [];
    const rpc = {
      respond: (id, result) => sent.push({ id, result }),
      respondError: (id, message) => sent.push({ id, error: message }),
    };

    await handleAcpFsRequest(rpc, { id: 1, method: 'fs/read_text_file', params: { path: target } }, tempRoot);
    assert.deepEqual(sent.at(-1), { id: 1, result: { content: 'one\ntwo\nthree\n' } });

    // `line` is 1-based and `limit` counts lines.
    await handleAcpFsRequest(
      rpc,
      { id: 2, method: 'fs/read_text_file', params: { path: target, line: 2, limit: 1 } },
      tempRoot,
    );
    assert.deepEqual(sent.at(-1), { id: 2, result: { content: 'two' } });

    // A relative path resolves against the session cwd rather than failing.
    await handleAcpFsRequest(rpc, { id: 3, method: 'fs/read_text_file', params: { path: 'sample.txt' } }, tempRoot);
    assert.equal(sent.at(-1).result.content, 'one\ntwo\nthree\n');

    // A missing file must come back as an ERROR, never as silence.
    await handleAcpFsRequest(
      rpc,
      { id: 4, method: 'fs/read_text_file', params: { path: path.join(tempRoot, 'nope.txt') } },
      tempRoot,
    );
    assert.match(sent.at(-1).error, /ENOENT/);

    // Same for a malformed request.
    await handleAcpFsRequest(rpc, { id: 5, method: 'fs/read_text_file', params: {} }, tempRoot);
    assert.match(sent.at(-1).error, /missing a "path"/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('ACP fs/write_text_file writes the file and replies null', { concurrency: false }, async () => {
  const tempRoot = await makeScratchDir('acp-fs-write-');
  try {
    const sent = [];
    const rpc = {
      respond: (id, result) => sent.push({ id, result }),
      respondError: (id, message) => sent.push({ id, error: message }),
    };

    // A write into a directory the agent has not created yet must still land.
    const target = path.join(tempRoot, 'nested', 'out.txt');
    await handleAcpFsRequest(
      rpc,
      { id: 1, method: 'fs/write_text_file', params: { path: target, content: 'hello' } },
      tempRoot,
    );

    assert.deepEqual(sent.at(-1), { id: 1, result: null });
    assert.equal(await readFile(target, 'utf8'), 'hello');
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('ACP fs/write_text_file rejects writes in plan mode', { concurrency: false }, async () => {
  const tempRoot = await makeScratchDir('acp-fs-plan-');
  try {
    const sent = [];
    const rpc = {
      respond: (id, result) => sent.push({ id, result }),
      respondError: (id, message) => sent.push({ id, error: message }),
    };

    const target = path.join(tempRoot, 'refused.txt');
    await handleAcpFsRequest(
      rpc,
      { id: 2, method: 'fs/write_text_file', params: { path: target, content: 'should not write' } },
      tempRoot,
      { permissionMode: 'plan' },
    );

    assert.match(sent.at(-1).error, /plan mode/i);
    await assert.rejects(readFile(target, 'utf8'));
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('sliceTextByLines returns the whole text when no window is asked for', () => {
  assert.equal(sliceTextByLines('a\nb', undefined, undefined), 'a\nb');
  assert.equal(sliceTextByLines('a\nb\nc', 2, undefined), 'b\nc');
  assert.equal(sliceTextByLines('a\nb\nc', undefined, 2), 'a\nb');
});
