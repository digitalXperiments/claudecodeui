import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chmod, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { makeScratchDir } from './shared/scratch.js';
import { mcpCatalogService } from './modules/providers/services/mcp-catalog.service.js';
import {
  disposeAntigravitySessions,
  disposeOpenCodeSessions,
  handleAcpFsRequest,
  spawnAntigravity,
  spawnOpenCode,
  updateAcpPermissionMode,
} from './opencode-cli.js';

/**
 * Fake ACP agent (no network, no Antigravity binary). On a prompt it replays the scenario file
 * (permission requests and fs requests, one at a time), records every response it got, then ends the turn.
 */
const FAKE_AGENT = `
const fs = require('node:fs');
const readline = require('node:readline');
const capturePath = process.env.AGY_FAKE_CAPTURE;
const scenario = process.env.AGY_FAKE_SCENARIO ? JSON.parse(fs.readFileSync(process.env.AGY_FAKE_SCENARIO, 'utf8')) : [];
const capture = {
  env: {
    GEMINI_HOME: process.env.GEMINI_HOME ?? null,
    AGY_ACP_DISABLE_WORKSPACE_TRUST: process.env.AGY_ACP_DISABLE_WORKSPACE_TRUST ?? null,
    CLOUDCLI_SESSION_ID: process.env.CLOUDCLI_SESSION_ID ?? null,
    CLOUDCLI_BOT_GATEWAY_BINDING_SECRET: process.env.CLOUDCLI_BOT_GATEWAY_BINDING_SECRET ?? null,
  },
  mcpServers: [], configOptions: [], responses: [],
};
const write = () => fs.writeFileSync(capturePath, JSON.stringify(capture));
write();
const send = (payload) => process.stdout.write(JSON.stringify(payload) + '\\n');
const notify = (update) => send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'agy-fake-1', update } });
let nextId = 7000;
const waiting = new Map();
let promptId = null;
let cursor = 0;

const step = () => {
  if (cursor >= scenario.length) {
    notify({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'done' } });
    send({ jsonrpc: '2.0', id: promptId, result: { stopReason: 'end_turn' } });
    return;
  }
  const item = scenario[cursor++];
  const id = nextId++;
  waiting.set(id, item);
  if (item.type === 'fs') {
    send({ jsonrpc: '2.0', id, method: item.method, params: { sessionId: 'agy-fake-1', ...item.params } });
  } else {
    send({ jsonrpc: '2.0', id, method: 'session/request_permission', params: {
      sessionId: 'agy-fake-1', toolCall: item.toolCall,
      options: item.options || [
        { optionId: 'allow_always', kind: 'allow_always', name: 'Allow Always' },
        { optionId: 'allow', kind: 'allow_once', name: 'Allow' },
        { optionId: 'deny', kind: 'reject_once', name: 'Deny' },
      ],
    } });
  }
};

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.id !== undefined && msg.method === undefined && waiting.has(msg.id)) {
    const item = waiting.get(msg.id);
    waiting.delete(msg.id);
    capture.responses.push({ name: item.name, result: msg.result ?? null, error: msg.error ?? null });
    write();
    step();
    return;
  }
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentCapabilities: {} } });
    return;
  }
  if (msg.method === 'session/new' || msg.method === 'session/load') {
    capture.mcpServers = msg.params?.mcpServers ?? [];
    write();
    send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'agy-fake-1', configOptions: [
      { id: 'mode', category: 'mode', type: 'select', currentValue: 'default', options: ['default', 'auto_edit', 'yolo'].map((value) => ({ value, name: value })) },
    ] } });
    return;
  }
  if (msg.method === 'session/set_config_option') {
    capture.configOptions.push({ configId: msg.params.configId, value: msg.params.value });
    write();
    send({ jsonrpc: '2.0', id: msg.id, result: { configOptions: [] } });
    return;
  }
  if (msg.method === 'session/prompt') {
    promptId = msg.id;
    cursor = 0;
    step();
  }
});
`;

const GATEWAY = 'cloudcli-tool-gateway';
const OPTION_IDS = (response) => response?.result?.outcome?.optionId ?? response?.result?.outcome?.outcome ?? null;

const createWriter = (messages) => ({
  userId: null,
  sessionId: null,
  send(message) { messages.push(message); },
  setSessionId(sessionId) { this.sessionId = sessionId; },
});

async function withAgents(prefix, body) {
  const root = await makeScratchDir(prefix);
  const saved = {
    path: process.env.PATH,
    agyPath: process.env.ANTIGRAVITY_ACP_PATH,
    agyDir: process.env.CLOUDCLI_ANTIGRAVITY_DIR,
    capture: process.env.AGY_FAKE_CAPTURE,
    scenario: process.env.AGY_FAKE_SCENARIO,
    list: mcpCatalogService.listEnabledNames,
    resolve: mcpCatalogService.resolveForProvider,
  };
  try {
    await writeFile(path.join(root, 'fake-agent.cjs'), FAKE_AGENT, 'utf8');
    for (const name of ['agy_acp_server', 'opencode']) {
      const bin = path.join(root, name);
      await writeFile(bin, '#!/bin/sh\nnode "$(dirname "$0")/fake-agent.cjs" "$@"\n', 'utf8');
      await chmod(bin, 0o755);
    }
    process.env.PATH = `${root}${path.delimiter}${saved.path || ''}`;
    process.env.ANTIGRAVITY_ACP_PATH = path.join(root, 'agy_acp_server');
    // The private profile (and its run homes) live under the scratch root, never under ~/.cloudcli.
    process.env.CLOUDCLI_ANTIGRAVITY_DIR = path.join(root, 'agy');
    process.env.AGY_FAKE_CAPTURE = path.join(root, 'capture.json');
    mcpCatalogService.listEnabledNames = async () => [];
    mcpCatalogService.resolveForProvider = async () => [];
    await body(root);
  } finally {
    disposeAntigravitySessions();
    disposeOpenCodeSessions();
    process.env.PATH = saved.path;
    for (const [key, value] of [['ANTIGRAVITY_ACP_PATH', saved.agyPath], ['CLOUDCLI_ANTIGRAVITY_DIR', saved.agyDir], ['AGY_FAKE_CAPTURE', saved.capture], ['AGY_FAKE_SCENARIO', saved.scenario]]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    mcpCatalogService.listEnabledNames = saved.list;
    mcpCatalogService.resolveForProvider = saved.resolve;
    await rm(root, { recursive: true, force: true });
  }
}

const readCapture = async (root) => JSON.parse(await readFile(path.join(root, 'capture.json'), 'utf8'));

async function setScenario(root, items) {
  const file = path.join(root, 'scenario.json');
  await writeFile(file, JSON.stringify(items), 'utf8');
  process.env.AGY_FAKE_SCENARIO = file;
}

const gatewayConnection = {
  name: GATEWAY,
  transport: 'stdio',
  command: process.execPath,
  args: ['gateway.js'],
  env: { CLOUDCLI_BOT_GATEWAY_API_URL: 'http://127.0.0.1:3001/api/bot-gateway-mcp', CLOUDCLI_BOT_GATEWAY_MCP_TOKEN: 'tok' },
};

function stubCatalog({ enabled = [GATEWAY, 'obsidian'], bound = [GATEWAY, 'obsidian'] } = {}) {
  mcpCatalogService.listEnabledNames = async (provider) => {
    assert.equal(provider, 'antigravity');
    return enabled;
  };
  mcpCatalogService.resolveForProvider = async (provider, names) => {
    assert.equal(provider, 'antigravity');
    return names.filter((name) => bound.includes(name)).map((name) => (
      name === GATEWAY ? { ...gatewayConnection } : { name, transport: 'stdio', command: 'npx', args: ['obsidian-mcp'] }
    ));
  };
}

function recordingGate() {
  const calls = [];
  const gate = async (toolName, input) => {
    calls.push({ toolName, input });
    if (toolName === 'Bash' && String(input.command).includes('forbidden')) return { behavior: 'deny', message: 'Blocked: forbidden' };
    if ((toolName === 'Read' || toolName === 'Write') && String(input.file_path).includes('/blocked/')) return { behavior: 'deny', message: 'Blocked: protected path' };
    if (toolName.startsWith('mcp__') && !toolName.startsWith(`mcp__${GATEWAY}__`)) return { behavior: 'deny', message: 'MCP tools must go through the tool gateway' };
    return { behavior: 'allow' };
  };
  return { gate, calls };
}

const strictOptions = (root, gate, extra = {}) => ({
  cwd: root,
  appSessionId: 'bot-app-session-1',
  permissionMode: 'bypassPermissions',
  unattended: true,
  botGatewayStrict: true,
  strictMcpSelection: true,
  mcpServers: [GATEWAY, 'obsidian'],
  botGatewaySecret: 'binding-secret-xyz',
  builtinToolGate: gate,
  ...extra,
});

const SCENARIO = [
  { name: 'shell-ok', toolCall: { toolCallId: 't1', title: 'ls -la', kind: 'execute', rawInput: { CommandLine: 'ls -la' } } },
  { name: 'shell-denied', toolCall: { toolCallId: 't2', title: 'cat forbidden.txt', kind: 'execute', rawInput: { CommandLine: 'cat forbidden.txt' } } },
  { name: 'edit', toolCall: { toolCallId: 't3', title: 'Run client_edit_file?', kind: 'edit', locations: [{ path: '/work/a.txt' }], rawInput: { target_file: '/work/a.txt' } } },
  { name: 'fetch', toolCall: { toolCallId: 't4', title: 'Run read_url_content?', kind: 'fetch', rawInput: { Url: 'https://example.com' } } },
  { name: 'gateway-mcp', toolCall: { toolCallId: 't5', title: 'cloudcli-tool-gateway_bot__ping', kind: 'other', rawInput: { arguments: {} }, _meta: { mcp: { server: GATEWAY, tool: 'bot__ping' } } } },
  { name: 'other-mcp', toolCall: { toolCallId: 't6', title: 'obsidian_put', kind: 'other', rawInput: { arguments: {} }, _meta: { mcp: { server: 'obsidian', tool: 'put' } } } },
  {
    name: 'trust',
    toolCall: { toolCallId: 'interaction_1', title: 'Do you trust the authors of this workspace to execute automated agent hooks?' },
    options: [{ optionId: 'trust', kind: 'allow_once', name: 'Trust Workspace' }, { optionId: 'deny', kind: 'reject_once', name: "Don't Trust" }],
  },
  { name: 'fs-read-ok', type: 'fs', method: 'fs/read_text_file', params: { path: 'ok.txt' } },
  { name: 'fs-read-blocked', type: 'fs', method: 'fs/read_text_file', params: { path: '/blocked/secret.txt' } },
  { name: 'fs-write-unapproved', type: 'fs', method: 'fs/write_text_file', params: { path: '/blocked/x.txt', content: 'x' } },
];

test('gateway-bound Antigravity run: only the stamped gateway, ask mode, every permission decided by the gate', { concurrency: false }, async () => {
  await withAgents('agy-gateway-run-', async (root) => {
    fs.writeFileSync(path.join(root, 'ok.txt'), 'hello');
    stubCatalog();
    await setScenario(root, SCENARIO);
    const { gate, calls } = recordingGate();
    const messages = [];

    await spawnAntigravity('Do the thing', strictOptions(root, gate), createWriter(messages));
    const capture = await readCapture(root);

    // 1. Only the gateway, with the run's identity stamped on it.
    assert.deepEqual(capture.mcpServers.map((server) => server.name), [GATEWAY]);
    const env = Object.fromEntries(capture.mcpServers[0].env.map((entry) => [entry.name, entry.value]));
    assert.equal(env.CLOUDCLI_SESSION_ID, 'bot-app-session-1');
    assert.equal(env.CLOUDCLI_LEAD_SESSION_ID, 'bot-app-session-1');
    assert.equal(env.CLOUDCLI_BOT_GATEWAY_BINDING_SECRET, 'binding-secret-xyz');
    assert.equal(env.CLOUDCLI_BOT_GATEWAY_MCP_TOKEN, 'tok');
    assert.match(env.CLOUDCLI_BOT_GATEWAY_API_URL, /bot-gateway-mcp$/);
    // The secret never reaches the ACP child's own environment (the agent's shell inherits that).
    assert.equal(capture.env.CLOUDCLI_BOT_GATEWAY_BINDING_SECRET, null);
    assert.equal(capture.env.CLOUDCLI_SESSION_ID, 'bot-app-session-1');

    // 2. Relocated GEMINI_HOME with no global config and no trust, workspace trust env forced off.
    const home = capture.env.GEMINI_HOME;
    assert.equal(path.dirname(home), path.join(root, 'agy', 'profile', 'runs'));
    assert.deepEqual(fs.readdirSync(path.join(home, 'config')), []);
    assert.equal(capture.env.AGY_ACP_DISABLE_WORKSPACE_TRUST, '0');

    // 3. Session mode is `default` even though bypassPermissions was requested; yolo is never set.
    assert.ok(capture.configOptions.some((option) => option.configId === 'mode' && option.value === 'default'));
    assert.equal(capture.configOptions.some((option) => option.value === 'yolo' || option.value === 'auto_edit'), false);

    // 4. Each request was mapped to the gate in the Claude shape.
    // (The gateway's own tool call is allowed without a built-in decision: the gateway applies the Action Gate itself.)
    assert.deepEqual(calls.map((call) => call.toolName), [
      'Bash', 'Bash', 'Edit', 'WebFetch', 'mcp__obsidian__put', 'Read', 'Read', 'Write',
    ]);
    assert.deepEqual(calls[0].input, { command: 'ls -la' });
    assert.deepEqual(calls[2].input, { file_path: '/work/a.txt' });
    assert.deepEqual(calls[3].input, { url: 'https://example.com' });

    // 5. Decisions: allowed -> allow_once only, denied -> reject, interaction prompt -> cancelled.
    const byName = Object.fromEntries(capture.responses.map((response) => [response.name, response]));
    assert.equal(OPTION_IDS(byName['shell-ok']), 'allow');
    assert.equal(OPTION_IDS(byName['shell-denied']), 'deny');
    assert.equal(OPTION_IDS(byName.edit), 'allow');
    assert.equal(OPTION_IDS(byName.fetch), 'allow');
    assert.equal(OPTION_IDS(byName['gateway-mcp']), 'allow');
    assert.equal(OPTION_IDS(byName['other-mcp']), 'deny');
    assert.equal(OPTION_IDS(byName.trust), 'cancelled');
    for (const response of capture.responses) {
      assert.notEqual(OPTION_IDS(response), 'allow_always', `${response.name} must never be answered with an always option`);
    }

    // 6. Client file requests: the read goes through the gate, a blocked one errors, the approved edit's write passes once.
    assert.equal(byName['fs-read-ok'].result?.content, 'hello');
    assert.match(byName['fs-read-blocked'].error?.message ?? '', /Permission denied: Blocked: protected path/);
    assert.match(byName['fs-write-unapproved'].error?.message ?? '', /Permission denied/);

    // No human permission prompt was raised: the gate decided everything.
    assert.equal(messages.some((message) => message.kind === 'permission_request'), false);
    assert.ok(messages.some((message) => message.kind === 'complete'));
  });
});

test('gateway-bound run: an approved edit may write once through the client fs method', { concurrency: false }, async () => {
  await withAgents('agy-gateway-fs-', async (root) => {
    stubCatalog();
    const target = path.join(root, 'out.txt');
    await setScenario(root, [
      { name: 'edit', toolCall: { toolCallId: 't1', title: 'Run client_create_file?', kind: 'edit', locations: [{ path: target }], rawInput: { target_file: target } } },
      { name: 'write', type: 'fs', method: 'fs/write_text_file', params: { path: target, content: 'written' } },
    ]);
    const { gate, calls } = recordingGate();
    await spawnAntigravity('Write it', strictOptions(root, gate), createWriter([]));
    assert.equal(fs.readFileSync(target, 'utf8'), 'written');
    assert.deepEqual(calls.map((call) => call.toolName), ['Write'], 'one decision for the edit, none repeated for its write');
  });
});

test('gateway-bound run without a built-in gate denies every built-in action but keeps the gateway usable', { concurrency: false }, async () => {
  await withAgents('agy-gateway-nogate-', async (root) => {
    stubCatalog();
    await setScenario(root, SCENARIO.slice(0, 5));
    await spawnAntigravity('x', strictOptions(root, undefined), createWriter([]));
    const capture = await readCapture(root);
    const decisions = Object.fromEntries(capture.responses.map((response) => [response.name, OPTION_IDS(response)]));
    assert.deepEqual(decisions, { 'shell-ok': 'deny', 'shell-denied': 'deny', edit: 'deny', fetch: 'deny', 'gateway-mcp': 'allow' });
  });
});

test('gateway-bound run fails closed without the binding secret, an appSessionId, or the bound gateway', { concurrency: false }, async () => {
  await withAgents('agy-gateway-closed-', async (root) => {
    const { gate } = recordingGate();
    stubCatalog();
    await assert.rejects(spawnAntigravity('x', strictOptions(root, gate, { botGatewaySecret: undefined }), createWriter([])), /binding secret/);
    await assert.rejects(spawnAntigravity('x', strictOptions(root, gate, { appSessionId: undefined }), createWriter([])), /run key|appSessionId/);
    stubCatalog({ bound: ['obsidian'] });
    await assert.rejects(spawnAntigravity('x', strictOptions(root, gate), createWriter([])), /required work-session MCP/);
  });
});

test('a live switch to bypass is refused for a gateway-bound run', { concurrency: false }, async () => {
  await withAgents('agy-gateway-live-', async (root) => {
    stubCatalog();
    await setScenario(root, []);
    const { gate } = recordingGate();
    await spawnAntigravity('x', strictOptions(root, gate), createWriter([]));
    assert.equal(await updateAcpPermissionMode('antigravity', 'agy-fake-1', 'bypassPermissions', 'bot-app-session-1'), false);
  });
});

test('flag off (no botGatewayStrict): behaviour is unchanged and the gateway is not attached to ordinary chats', { concurrency: false }, async () => {
  await withAgents('agy-gateway-off-', async (root) => {
    stubCatalog();
    await setScenario(root, [SCENARIO[0]]);
    const messages = [];
    await spawnAntigravity('hi', {
      cwd: root, appSessionId: 'chat-1', permissionMode: 'bypassPermissions', unattended: true,
    }, createWriter(messages));
    const capture = await readCapture(root);
    // Catalog servers still attach, but the gateway (meaningless without a bound bot run) does not.
    assert.deepEqual(capture.mcpServers.map((server) => server.name), ['obsidian']);
    assert.ok(capture.configOptions.some((option) => option.configId === 'mode' && option.value === 'yolo'));
    // yolo -> the runtime auto-approves locally (allow_once), no gate involved.
    assert.equal(OPTION_IDS(capture.responses[0]), 'allow');
    assert.equal(capture.env.GEMINI_HOME, path.join(root, 'agy', 'profile'));
    assert.equal(fs.existsSync(path.join(root, 'agy', 'profile', 'runs')), false);
  });
});

test('flag off: an explicitly requested gateway under strictMcpSelection still attaches as before', { concurrency: false }, async () => {
  await withAgents('agy-gateway-explicit-', async (root) => {
    stubCatalog();
    await setScenario(root, []);
    await spawnAntigravity('hi', { cwd: root, appSessionId: 'chat-2', strictMcpSelection: true, mcpServers: [GATEWAY] }, createWriter([]));
    const capture = await readCapture(root);
    assert.deepEqual(capture.mcpServers.map((server) => server.name), [GATEWAY]);
    const env = Object.fromEntries(capture.mcpServers[0].env.map((entry) => [entry.name, entry.value]));
    assert.equal(env.CLOUDCLI_BOT_GATEWAY_BINDING_SECRET, undefined, 'no secret is stamped outside gateway-bound runs');
  });
});

test('opencode is unaffected by the gateway options (still the relayed-permission path)', { concurrency: false }, async () => {
  await withAgents('agy-gateway-opencode-', async (root) => {
    const { gate, calls } = recordingGate();
    await setScenario(root, [SCENARIO[0]]);
    mcpCatalogService.listEnabledNames = async (provider) => {
      assert.equal(provider, 'opencode');
      return [];
    };
    await spawnOpenCode('hi', {
      cwd: root, appSessionId: 'oc-1', permissionMode: 'bypassPermissions', unattended: true,
      botGatewayStrict: true, builtinToolGate: gate, botGatewaySecret: 'nope',
    }, createWriter([]));
    const capture = await readCapture(root);
    assert.equal(calls.length, 0, 'opencode never consults the built-in gate');
    assert.equal(capture.env.GEMINI_HOME, null);
    assert.equal(OPTION_IDS(capture.responses[0]), 'allow', 'bypassPermissions still auto-approves on opencode');
  });
});

test('handleAcpFsRequest without a guard is unchanged', async () => {
  const root = await makeScratchDir('agy-fs-plain-');
  try {
    fs.writeFileSync(path.join(root, 'a.txt'), 'plain');
    const replies = [];
    const rpc = { respond: (id, result) => replies.push({ id, result }), respondError: (id, message) => replies.push({ id, error: message }) };
    await handleAcpFsRequest(rpc, { id: 1, method: 'fs/read_text_file', params: { path: 'a.txt' } }, root, {});
    assert.deepEqual(replies, [{ id: 1, result: { content: 'plain' } }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
