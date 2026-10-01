// Grok bot runs enforced behind the Tool Gateway (options.botGatewayStrict).
//
// No real grok binary and no network: spawnGrok is driven against a fake `grok` executable on PATH
// that speaks the ACP subset grok-cli.js uses, records what it was started with, and fires scripted
// session/request_permission requests. HOME points at a scratch directory for the whole file, so
// the "user's" ~/.grok, ~/.cloudcli and catalog are fixtures.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import type { AddressInfo } from 'node:net';

import express from 'express';

import { isBotsRuntimeV2Enabled, updateAppFeatures } from '@/modules/app-features/index.js';
import { builtinDenylistReason } from '@/modules/bots/gate/builtin-tool-gate.js';
import {
  applyProviderGatewayRunOptions,
  botGatewayMcpRoutes,
  describeGatewayEnforcement,
  getBotGatewayMcpToken,
  getGatewayEnforcement,
  gatewaySessions,
} from '@/modules/bots/gateway/index.js';
import { closeConnection, initializeDatabase } from '@/modules/database/index.js';
import { buildRuntimeOptions, missionControlDb } from '@/modules/mission-control/index.js';
// The strict-run helpers are grok runtime internals and grok-cli.js lives outside the module tree; this
// test deliberately drives them directly, as the bots <-> grok contract under test.
/* eslint-disable boundaries/dependencies */
import {
  buildGrokPermissionOutcome,
  buildStrictAcpMcpServers,
  buildStrictGrokConfigToml,
  createStrictGrokHome,
  decideGrokToolPermission,
  findProjectMcpConfigs,
  mapGrokToolCallToGate,
  resolveGrokToolName,
  STRICT_GROK_STRIPPED_ENV,
  stripStrictGrokEnv,
} from '@/modules/providers/list/grok/grok-strict-run.js';
/* eslint-enable boundaries/dependencies */
import { makeScratchDir } from '@/shared/scratch.js';

// ---------------------------------------------------------------------------
// Sandbox: HOME, PATH and the fake grok

const scratch = await makeScratchDir('bots-grok-');
const fakeHome = path.join(scratch, 'home');
const sourceHome = path.join(fakeHome, '.grok');
const binDir = path.join(scratch, 'bin');
const projectDir = path.join(scratch, 'project');
fs.mkdirSync(fakeHome, { recursive: true });
fs.mkdirSync(binDir, { recursive: true });
fs.mkdirSync(projectDir, { recursive: true });

const savedEnv = { HOME: process.env.HOME, PATH: process.env.PATH, GROK_HOME: process.env.GROK_HOME };
process.env.HOME = fakeHome;
delete process.env.GROK_HOME;
process.env.PATH = `${binDir}${path.delimiter}${process.env.PATH ?? ''}`;

const FAKE_GROK = `#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const args = process.argv.slice(2);
if (args[0] !== 'agent') process.exit(0);
const logPath = process.env.FAKE_GROK_LOG;
const scenario = JSON.parse(process.env.FAKE_GROK_SCENARIO || '{}');
const home = process.env.GROK_HOME || '';
const read = (file) => { try { return fs.readFileSync(file, 'utf8'); } catch { return null; } };
const listing = (dir) => { try { return fs.readdirSync(dir).sort(); } catch { return null; } };
const mode = (file) => { try { return (fs.statSync(file).mode & 0o777).toString(8); } catch { return null; } };
const DEFAULT_OPTIONS = [
  { optionId: 'opt-always', kind: 'allow_always', name: 'Always allow' },
  { optionId: 'opt-once', kind: 'allow_once', name: 'Allow once' },
  { optionId: 'opt-reject', kind: 'reject_once', name: 'Reject' },
];
const state = {
  args,
  cwd: process.cwd(),
  home,
  env: Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(GROK_|CLOUDCLI_|XAI_)/.test(key))),
  homeFiles: listing(home),
  homeMode: mode(home),
  sessionsListing: listing(path.join(home, 'sessions')),
  config: read(path.join(home, 'config.toml')),
  auth: read(path.join(home, 'auth.json')),
  authMode: mode(path.join(home, 'auth.json')),
  sessionNew: null,
  permissions: [],
};
const flush = () => fs.writeFileSync(logPath, JSON.stringify(state));
flush();
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\\n');
const waiters = new Map();

async function prompt(message) {
  for (const [index, request] of (scenario.requests || []).entries()) {
    const id = 'perm-' + index;
    const answered = new Promise((resolve) => waiters.set(id, resolve));
    send({ id, method: 'session/request_permission', params: { sessionId: 'fake-session-1', toolCall: request.toolCall, options: request.options || DEFAULT_OPTIONS } });
    const reply = await answered;
    state.permissions.push({ toolCall: request.toolCall, reply: reply.result ?? reply.error });
    flush();
  }
  if (scenario.refreshAuth) fs.writeFileSync(path.join(home, 'auth.json'), '{"token":"rotated"}', { mode: 0o600 });
  if (scenario.writeSession) {
    const projectKey = path.join(home, 'sessions', encodeURIComponent(process.cwd()));
    fs.mkdirSync(path.join(projectKey, 'fake-session-1'), { recursive: true });
    fs.writeFileSync(path.join(projectKey, 'fake-session-1', 'chat_history.jsonl'), '{"type":"user"}\\n');
    fs.writeFileSync(path.join(projectKey, 'permission.toml'), '# grants written during the run\\n');
  }
  send({ id: message.id, result: { stopReason: 'end_turn' } });
}

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.method === undefined && message.id !== undefined) {
    waiters.get(message.id)?.(message);
    waiters.delete(message.id);
    return;
  }
  if (message.id === undefined) return;
  if (message.method === 'initialize') send({ id: message.id, result: { agentCapabilities: { loadSession: true } } });
  else if (message.method === 'session/new') {
    state.sessionNew = message.params;
    flush();
    send({ id: message.id, result: { sessionId: 'fake-session-1' } });
    send({ method: '_x.ai/mcp_initialized', params: { sessionId: 'fake-session-1' } });
    process.stderr.write('Fetched managed MCP gateway tool catalog\\n');
  } else if (message.method === 'session/prompt') void prompt(message);
  else send({ id: message.id, result: {} });
});
`;
fs.writeFileSync(path.join(binDir, 'grok'), FAKE_GROK, { mode: 0o755 });

// eslint-disable-next-line boundaries/no-unknown -- grok-cli.js is the runtime under test and sits outside the module tree.
const grokCli = await import('../../../grok-cli.js');

// ---------------------------------------------------------------------------
// Fixtures

const ORIGINAL_GRANTS = '[grants]\nallow = ["git push --force"]\n';
const gatewayEntry = (provider = 'grok') => ({
  name: 'cloudcli-tool-gateway',
  scope: 'user',
  transport: 'stdio',
  command: '/usr/bin/gateway-proxy',
  args: ['proxy.js'],
  env: {
    CLOUDCLI_BOT_GATEWAY_API_URL: 'http://127.0.0.1:3001/api/bot-gateway-mcp',
    CLOUDCLI_BOT_GATEWAY_MCP_TOKEN: 'catalog-token-123',
  },
  bindings: { [provider]: { enabled: true } },
  updatedAt: '2026-10-01T00:00:00.000Z',
});

function writeCatalog(servers: Record<string, unknown>): void {
  const dir = path.join(fakeHome, '.cloudcli', 'mcp');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'catalog.json'), JSON.stringify({ version: 1, servers }));
}

function seedSourceGrokHome(): void {
  fs.rmSync(sourceHome, { recursive: true, force: true });
  fs.rmSync(path.join(fakeHome, '.cloudcli', 'grok-strict-runs'), { recursive: true, force: true });
  fs.rmSync(path.join(fakeHome, '.cloudcli', 'grok-runtime'), { recursive: true, force: true });
  const sessionsKey = path.join(sourceHome, 'sessions', encodeURIComponent(projectDir));
  fs.mkdirSync(sessionsKey, { recursive: true });
  fs.writeFileSync(path.join(sessionsKey, 'permission.toml'), ORIGINAL_GRANTS);
  fs.writeFileSync(path.join(sourceHome, 'config.toml'), [
    '[ui]',
    'permission_mode = "always-approve"',
    '[mcp_servers.Composio]',
    'url = "https://connect.composio.dev/mcp"',
    '[mcp_servers.obsidian]',
    'command = "node"',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(sourceHome, 'auth.json'), '{"token":"old"}', { mode: 0o600 });
  const anHourAgo = new Date(Date.now() - 3_600_000);
  fs.utimesSync(path.join(sourceHome, 'auth.json'), anHourAgo, anHourAgo);
  fs.writeFileSync(path.join(sourceHome, 'mcp_credentials.json'), '{"oauth":"mcp-secret"}');
  fs.writeFileSync(path.join(sourceHome, 'trusted_folders.toml'), '[trusted]\n');
  fs.writeFileSync(path.join(sourceHome, 'models_cache.json'), '{"models":[]}');
  writeCatalog({ 'cloudcli-tool-gateway': gatewayEntry(), mail: { ...gatewayEntry(), name: 'mail', command: '/usr/bin/mail-mcp' } });
}

type GateCall = { name: string; input: Record<string, unknown> };
type Verdict = { behavior: 'allow' } | { behavior: 'deny'; message: string };

/** Stand-in for createBuiltinToolGate: the real denylist plus a few scripted rules. */
function makeGate(rules: (name: string, input: Record<string, unknown>) => Verdict | null = () => null) {
  const calls: GateCall[] = [];
  const gate = async (name: string, input: unknown): Promise<Verdict> => {
    const args = (input ?? {}) as Record<string, unknown>;
    calls.push({ name, input: args });
    const scripted = rules(name, args);
    if (scripted) return scripted;
    if (name.startsWith('mcp__cloudcli-tool-gateway__')) return { behavior: 'allow' };
    if (name.startsWith('mcp__')) return { behavior: 'deny', message: 'MCP tools must go through the tool gateway.' };
    const denied = builtinDenylistReason(name, input, { workspaceRoot: projectDir, botHome: path.join(scratch, 'bot-home') });
    return denied ? { behavior: 'deny', message: `Blocked: ${denied}.` } : { behavior: 'allow' };
  };
  return { gate, calls };
}

interface FakeLog {
  args: string[];
  cwd: string;
  home: string;
  env: Record<string, string>;
  homeFiles: string[] | null;
  homeMode: string | null;
  sessionsListing: string[] | null;
  config: string | null;
  auth: string | null;
  authMode: string | null;
  sessionNew: { cwd: string; mcpServers: Array<{ name: string; type: string; command: string; env: Array<{ name: string; value: string }> }> } | null;
  permissions: Array<{ toolCall: Record<string, unknown>; reply: { outcome: { outcome: string; optionId?: string } } }>;
}

let runCounter = 0;
async function runGrok(scenario: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  runCounter += 1;
  const logPath = path.join(scratch, `fake-grok-${runCounter}.json`);
  process.env.FAKE_GROK_LOG = logPath;
  process.env.FAKE_GROK_SCENARIO = JSON.stringify(scenario);
  const messages: Array<Record<string, unknown>> = [];
  const ws = { send: (message: Record<string, unknown>) => { messages.push(message); }, userId: null };
  const options: Record<string, unknown> = {
    projectPath: projectDir,
    appSessionId: 'app-session-9',
    unattended: true,
    permissionMode: 'bypassPermissions',
    ...overrides,
  };
  let error: unknown = null;
  try {
    await grokCli.spawnGrok('do the thing', options as never, ws);
  } catch (caught) {
    error = caught;
  }
  const log = fs.existsSync(logPath) ? JSON.parse(fs.readFileSync(logPath, 'utf8')) as FakeLog : null;
  return { log, messages, error };
}

const bash = (command: string, extra: Record<string, unknown> = {}) => ({
  toolCall: { title: command, _meta: { 'x.ai/tool': { name: 'run_terminal_command' } }, rawInput: { command }, ...extra },
});
const outcomeOf = (log: FakeLog, index: number) => log.permissions[index]?.reply.outcome;

// ---------------------------------------------------------------------------
// Pure pieces

test('strict config: gated asks for every tool, never always-approve, no MCP servers, imports off', () => {
  const gated = buildStrictGrokConfigToml({ gated: true });
  assert.match(gated, /permission_mode = "default"/);
  assert.match(gated, /yolo = false/);
  assert.match(gated, /\[permission\]\nask = \["\*"\]/);
  assert.match(gated, /remember_tool_approvals = false/);
  assert.match(gated, /\[compat\.claude\]\nmcps = false/);
  assert.match(gated, /\[compat\.cursor\]\nmcps = false/);
  assert.match(gated, /\[managed_mcps\]\nenabled = false\ngateway_tools_enabled = false/);
  assert.match(gated, /use_leader = false/);
  assert.doesNotMatch(gated, /mcp_servers|always-approve|allow =/);

  const ungated = buildStrictGrokConfigToml({ gated: false, configPermissionMode: 'always-approve' });
  assert.doesNotMatch(ungated, /\[permission\]/);
  assert.match(ungated, /permission_mode = "always-approve"/);
  assert.match(ungated, /\[compat\.claude\]\nmcps = false/);
});

test('strict home: login only, private, never the user config / MCP credentials / trust / grants; cleanup deletes it', () => {
  seedSourceGrokHome();
  const root = path.join(scratch, 'strict-root');
  const home = createStrictGrokHome({ gated: true, sourceHome, root });
  try {
    assert.equal((fs.statSync(home.dir).mode & 0o777), 0o700);
    assert.deepEqual(fs.readdirSync(home.dir).sort(), ['auth.json', 'config.toml', 'models_cache.json', 'sessions']);
    assert.equal(fs.readFileSync(path.join(home.dir, 'auth.json'), 'utf8'), '{"token":"old"}');
    assert.equal((fs.statSync(path.join(home.dir, 'auth.json')).mode & 0o777), 0o600);
    assert.equal((fs.statSync(path.join(home.dir, 'config.toml')).mode & 0o777), 0o600);
    assert.deepEqual(fs.readdirSync(path.join(home.dir, 'sessions')), [], 'remembered grants are not visible');
    assert.doesNotMatch(fs.readFileSync(path.join(home.dir, 'config.toml'), 'utf8'), /Composio|obsidian|connect\.composio/);
  } finally {
    home.cleanup();
  }
  assert.equal(fs.existsSync(home.dir), false);
  home.cleanup(); // idempotent
});

test('strict home: sync-back writes a rotated login and transcripts, never grants, never resurrects a logout', () => {
  seedSourceGrokHome();
  const root = path.join(scratch, 'strict-root-sync');
  const home = createStrictGrokHome({ gated: true, sourceHome, root });
  const key = encodeURIComponent(projectDir);
  fs.writeFileSync(path.join(home.dir, 'auth.json'), '{"token":"rotated"}');
  fs.mkdirSync(path.join(home.dir, 'sessions', key, 's1'), { recursive: true });
  fs.writeFileSync(path.join(home.dir, 'sessions', key, 's1', 'chat_history.jsonl'), '{"turn":2}\n');
  fs.writeFileSync(path.join(home.dir, 'sessions', key, 'permission.toml'), '[grants]\nallow = ["rm -rf *"]\n');
  fs.writeFileSync(path.join(home.dir, 'sessions', key, 'prompt_history.jsonl'), '{}\n');
  // The forked session's transcript was pre-seeded with the prior turns.
  const seeded = path.join(sourceHome, 'sessions', key, 's1');
  fs.mkdirSync(seeded, { recursive: true });
  fs.writeFileSync(path.join(seeded, 'chat_history.jsonl'), '{"turn":1}\n');

  home.cleanup();

  assert.equal(fs.readFileSync(path.join(sourceHome, 'auth.json'), 'utf8'), '{"token":"rotated"}');
  assert.equal(fs.readFileSync(path.join(seeded, 'chat_history.jsonl'), 'utf8'), '{"turn":1}\n{"turn":2}\n');
  assert.equal(fs.readFileSync(path.join(sourceHome, 'sessions', key, 'permission.toml'), 'utf8'), ORIGINAL_GRANTS);
  assert.equal(fs.existsSync(path.join(sourceHome, 'sessions', key, 'prompt_history.jsonl')), false);

  // An explicit logout (login file gone from the real home) is not undone by a run copy.
  seedSourceGrokHome();
  const second = createStrictGrokHome({ gated: true, sourceHome, root });
  fs.writeFileSync(path.join(second.dir, 'auth.json'), '{"token":"rotated"}');
  fs.rmSync(path.join(sourceHome, 'auth.json'));
  second.cleanup();
  assert.equal(fs.existsSync(path.join(sourceHome, 'auth.json')), false);
});

test('strict home: leftovers from a crashed server are swept on the next run', () => {
  seedSourceGrokHome();
  const root = path.join(scratch, 'strict-root-sweep');
  fs.mkdirSync(path.join(root, 'run-stale'), { recursive: true });
  fs.writeFileSync(path.join(root, 'run-stale', 'auth.json'), 'leftover');
  const old = new Date(Date.now() - 24 * 3_600_000);
  fs.utimesSync(path.join(root, 'run-stale'), old, old);
  fs.mkdirSync(path.join(root, 'run-fresh'), { recursive: true });
  const home = createStrictGrokHome({ gated: true, sourceHome, root });
  try {
    assert.equal(fs.existsSync(path.join(root, 'run-stale')), false);
    assert.equal(fs.existsSync(path.join(root, 'run-fresh')), true, 'a recent directory could be a live run');
  } finally {
    home.cleanup();
  }
});

test('inherited overrides that could reopen MCP or trust are stripped from a strict child env', () => {
  const env: Record<string, string | undefined> = { PATH: '/bin', GROK_FOLDER_TRUST: '0', GROK_CONFIG: '{"x":1}', GROK_DEFAULT_PERMISSION_MODE: 'always-approve', KEEP: '1' };
  stripStrictGrokEnv(env);
  assert.deepEqual(env, { PATH: '/bin', KEEP: '1' });
  assert.ok(STRICT_GROK_STRIPPED_ENV.includes('GROK_FOLDER_TRUST'));
});

test('ACP mcpServers: only the gateway, stamped with session id and binding secret; fails closed without it', () => {
  const resolved: Parameters<typeof buildStrictAcpMcpServers>[0] = [
    { name: 'mail', transport: 'stdio', command: 'mail-mcp', env: { MAIL_TOKEN: 'm' } },
    {
      name: 'cloudcli-tool-gateway',
      transport: 'stdio',
      command: 'gw',
      args: ['a'],
      env: { CLOUDCLI_BOT_GATEWAY_API_URL: 'http://127.0.0.1:3001/api/bot-gateway-mcp', CLOUDCLI_BOT_GATEWAY_MCP_TOKEN: 'tok', CLOUDCLI_BOT_GATEWAY_BINDING_SECRET: 'stale' },
    },
  ];
  const servers = buildStrictAcpMcpServers(resolved, {
    spawnEnv: { CLOUDCLI_SESSION_ID: 'app-1', CLOUDCLI_LEAD_SESSION_ID: 'app-1', GROK_HOME: '/nope' },
    bindingSecret: 'fresh-secret',
  });
  assert.equal(servers.length, 1);
  const env = Object.fromEntries((servers[0].env as Array<{ name: string; value: string }>).map((entry) => [entry.name, entry.value]));
  assert.equal(servers[0].name, 'cloudcli-tool-gateway');
  assert.equal(servers[0].type, 'stdio');
  assert.deepEqual(env, {
    CLOUDCLI_BOT_GATEWAY_API_URL: 'http://127.0.0.1:3001/api/bot-gateway-mcp',
    CLOUDCLI_BOT_GATEWAY_MCP_TOKEN: 'tok',
    CLOUDCLI_LEAD_SESSION_ID: 'app-1',
    CLOUDCLI_SESSION_ID: 'app-1',
    CLOUDCLI_BOT_GATEWAY_BINDING_SECRET: 'fresh-secret',
  });
  assert.throws(() => buildStrictAcpMcpServers([resolved[0]], { spawnEnv: {} }), /refusing to run this bot without it/);
});

test('permission mapping: grok tool calls become the gate\'s tool names and inputs', () => {
  const call = (name: string | null, rawInput: unknown, extra: Record<string, unknown> = {}) => mapGrokToolCallToGate({
    ...(name ? { _meta: { 'x.ai/tool': { name } } } : {}),
    rawInput,
    ...extra,
  }, '/work');
  assert.deepEqual(call('run_terminal_command', { command: 'git status' }), {
    toolName: 'Bash', input: { command: 'git status', cwd: '/work' }, grokTool: 'run_terminal_command',
  });
  assert.equal(call('write', { file_path: '/work/a.txt', content: 'x' }).toolName, 'Write');
  const edit = call('search_replace', { file_path: '/work/a.txt', old_string: 'a', new_string: 'b' });
  assert.equal(edit.toolName, 'Edit');
  assert.equal(edit.input.file_path, '/work/a.txt');
  const read = call('read_file', { target_file: '/home/u/.claude.json' });
  assert.equal(read.toolName, 'Read');
  assert.equal(read.input.file_path, '/home/u/.claude.json');
  assert.equal(call('list_dir', { target_directory: '/work/src' }).input.path, '/work/src');
  assert.deepEqual(call('web_fetch', { url: 'https://x.test/a' }).input, { url: 'https://x.test/a' });
  assert.equal(call('web_search', { query: 'q' }).toolName, 'WebSearch');
  assert.equal(call('todo_write', { todos: [] }).toolName, 'TodoWrite');

  const gateway = call('use_tool', { tool_name: 'cloudcli-tool-gateway__bot__remember', tool_input: { content: 'x' } });
  assert.equal(gateway.toolName, 'mcp__cloudcli-tool-gateway__bot__remember');
  assert.deepEqual(gateway.input, { content: 'x' });
  assert.equal(call('use_tool', { tool_name: 'obsidian__obsidian_get_file', tool_input: {} }).toolName, 'mcp__obsidian__obsidian_get_file');
  assert.equal(call('use_tool', '{"tool_name":"mail__send","tool_input":{}}').toolName, 'mcp__mail__send', 'raw input may arrive as a JSON string');
  assert.equal(call('use_tool', {}).toolName, 'mcp__unknown');
  assert.equal(call('cloudcli-tool-gateway__bot__notify', {}).toolName, 'mcp__cloudcli-tool-gateway__bot__notify');
  const reported = mapGrokToolCallToGate({ _meta: { 'x.ai/tool': { name: 'bot__remember', server_name: 'cloudcli-tool-gateway' } }, rawInput: {} });
  assert.equal(reported.toolName, 'mcp__cloudcli-tool-gateway__bot__remember', 'an MCP tool reported as (server, name)');
  assert.equal(
    mapGrokToolCallToGate({ _meta: { 'x.ai/tool': { name: 'send', server_name: 'mail' } }, rawInput: {} }).toolName,
    'mcp__mail__send',
  );
  assert.equal(call('spawn_subagent', { prompt: 'p' }).toolName, 'spawn_subagent', 'unknown tools reach the gate under their own name');

  // No command extracted: the gate must see no command (it then escalates), never a guess from the title.
  assert.equal(call('run_terminal_command', {}, { title: 'ls' }).input.command, undefined);
});

test('a shell command line can never pass for the gateway: only the structured tool name is trusted', () => {
  const spoof = { title: 'cloudcli-tool-gateway__x && rm -rf /', kind: 'execute', rawInput: { command: 'rm -rf /' } };
  assert.equal(resolveGrokToolName(spoof), 'run_terminal_command');
  const mapped = mapGrokToolCallToGate(spoof);
  assert.equal(mapped.toolName, 'Bash');
  assert.equal(mapped.input.command, 'rm -rf /');
  // A bare identifier title is accepted only when there is no structured name and no ACP kind.
  assert.equal(resolveGrokToolName({ title: 'read_file' }), 'read_file');
  assert.equal(resolveGrokToolName({ title: 'echo hi && cat /etc/passwd' }), 'echo hi && cat /etc/passwd');
});

test('the gate decides: explicit allow only; deny, malformed verdicts and a throwing gate all deny', async () => {
  const toolCall = { _meta: { 'x.ai/tool': { name: 'write' } }, rawInput: { file_path: '/work/a' } };
  const allow = await decideGrokToolPermission(async () => ({ behavior: 'allow' }), toolCall);
  assert.equal(allow.allow, true);
  const deny = await decideGrokToolPermission(async () => ({ behavior: 'deny', message: 'nope' }), toolCall);
  assert.deepEqual([deny.allow, deny.message], [false, 'nope']);
  const odd = await decideGrokToolPermission((async () => ({ behavior: 'maybe' })) as never, toolCall);
  assert.equal(odd.allow, false);
  const boom = await decideGrokToolPermission(async () => { throw new Error('db down'); }, toolCall);
  assert.equal(boom.allow, false);
  assert.match(boom.message ?? '', /db down/);
});

test('permission outcome: allow only ever selects allow_once; a missing option denies; deny cancels when nothing to reject with', () => {
  const offered = [
    { optionId: 'a', kind: 'allow_always' },
    { optionId: 'b', kind: 'allow_once' },
    { optionId: 'c', kind: 'reject_once' },
  ];
  assert.deepEqual(buildGrokPermissionOutcome(offered, true), { outcome: { outcome: 'selected', optionId: 'b' } });
  assert.deepEqual(buildGrokPermissionOutcome(offered, false), { outcome: { outcome: 'selected', optionId: 'c' } });
  assert.deepEqual(
    buildGrokPermissionOutcome([{ optionId: 'a', kind: 'allow_always' }, { optionId: 'c', kind: 'reject_once' }], true),
    { outcome: { outcome: 'selected', optionId: 'c' } },
    'no allow_once offered: refuse rather than persist a grant',
  );
  assert.deepEqual(buildGrokPermissionOutcome([{ optionId: 'a', kind: 'allow_always' }], false), { outcome: { outcome: 'cancelled' } });
  assert.deepEqual(buildGrokPermissionOutcome(undefined, true), { outcome: { outcome: 'cancelled' } });
});

test('project MCP files between the working directory and the git root are reported', () => {
  const repo = path.join(scratch, 'repo');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'pkg', '.grok'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.mcp.json'), '{}');
  fs.writeFileSync(path.join(repo, 'pkg', '.grok', 'config.toml'), '[mcp_servers.x]\n');
  assert.deepEqual(findProjectMcpConfigs(path.join(repo, 'pkg')).map((file) => path.relative(repo, file)).sort(), ['.mcp.json', 'pkg/.grok/config.toml']);
  assert.deepEqual(findProjectMcpConfigs(projectDir), []);
});

// ---------------------------------------------------------------------------
// spawnGrok against the fake grok

test('strict gated run: only the gateway over ACP, isolated home, every ask answered by the gate', async () => {
  seedSourceGrokHome();
  const previousTrust = process.env.GROK_FOLDER_TRUST;
  process.env.GROK_FOLDER_TRUST = '0';
  const { gate, calls } = makeGate((name, input) => (
    name === 'Bash' && String(input.command).includes('rm -rf') ? { behavior: 'deny', message: 'destructive' } : null
  ));
  try {
    const { log, messages, error } = await runGrok({
      refreshAuth: true,
      writeSession: true,
      requests: [
        bash('git status'),
        bash('rm -rf /'),
        { toolCall: { _meta: { 'x.ai/tool': { name: 'use_tool' } }, rawInput: { tool_name: 'cloudcli-tool-gateway__bot__remember', tool_input: { content: 'x' } } } },
        { toolCall: { _meta: { 'x.ai/tool': { name: 'use_tool' } }, rawInput: { tool_name: 'obsidian__obsidian_get_file', tool_input: {} } } },
        { toolCall: { _meta: { 'x.ai/tool': { name: 'read_file' } }, rawInput: { target_file: path.join(fakeHome, '.claude.json') } } },
        { toolCall: { _meta: { 'x.ai/tool': { name: 'read_file' } }, rawInput: { target_file: path.join(projectDir, 'notes.md') } } },
        { toolCall: { title: 'cloudcli-tool-gateway__x && rm -rf /', kind: 'execute', rawInput: { command: 'rm -rf /' } } },
      ],
    }, {
      botGatewayStrict: true,
      strictMcpSelection: true,
      builtinToolGate: gate,
      botGatewaySecret: 'secret-xyz',
      mcpServers: ['cloudcli-tool-gateway', 'mail'],
    });

    assert.equal(error, null);
    assert.ok(log, 'the fake grok ran');
    const complete = messages.find((message) => message.kind === 'complete');
    assert.equal(complete?.exitCode, 0);

    // 1. Only the gateway, with this run's identity.
    const servers = log.sessionNew?.mcpServers ?? [];
    assert.deepEqual(servers.map((server) => server.name), ['cloudcli-tool-gateway']);
    assert.equal(servers[0].command, '/usr/bin/gateway-proxy');
    const gatewayEnv = Object.fromEntries(servers[0].env.map((entry) => [entry.name, entry.value]));
    assert.equal(gatewayEnv.CLOUDCLI_SESSION_ID, 'app-session-9');
    assert.equal(gatewayEnv.CLOUDCLI_LEAD_SESSION_ID, 'app-session-9');
    assert.equal(gatewayEnv.CLOUDCLI_BOT_GATEWAY_BINDING_SECRET, 'secret-xyz');
    assert.equal(gatewayEnv.CLOUDCLI_BOT_GATEWAY_API_URL, 'http://127.0.0.1:3001/api/bot-gateway-mcp');
    assert.equal(gatewayEnv.CLOUDCLI_BOT_GATEWAY_MCP_TOKEN, 'catalog-token-123');

    // 2. grok itself: no leader, no always-approve, every other MCP source off, nothing inherited that reopens them.
    assert.deepEqual(log.args.slice(0, 2), ['agent', '--no-leader']);
    assert.ok(!log.args.includes('--always-approve'), 'a bot run is never started in always-approve');
    assert.equal(log.args.at(-1), 'stdio');
    for (const key of ['GROK_CLAUDE_MCPS_ENABLED', 'GROK_CURSOR_MCPS_ENABLED', 'GROK_CODEX_MCPS_ENABLED', 'GROK_MANAGED_MCPS_ENABLED', 'GROK_MANAGED_MCP_GATEWAY_TOOLS_ENABLED']) {
      assert.equal(log.env[key], 'false', key);
    }
    assert.equal(log.env.GROK_FOLDER_TRUST, undefined, 'the inherited trust kill switch is dropped');
    assert.equal(log.env.CLOUDCLI_BOT_GATEWAY_BINDING_SECRET, undefined, 'the secret goes to the gateway child only');
    assert.equal(log.env.CLOUDCLI_SESSION_ID, 'app-session-9');

    // 3. A private, from-scratch home: login only.
    assert.ok(log.home.startsWith(path.join(fakeHome, '.cloudcli', 'grok-strict-runs') + path.sep));
    assert.equal(log.homeMode, '700');
    assert.deepEqual(log.homeFiles, ['auth.json', 'config.toml', 'models_cache.json', 'sessions']);
    assert.equal(log.authMode, '600');
    assert.equal(log.auth, '{"token":"old"}');
    assert.deepEqual(log.sessionsListing, [], 'remembered grants from the real home are invisible');
    assert.match(log.config ?? '', /ask = \["\*"\]/);
    assert.match(log.config ?? '', /\[compat\.claude\]\nmcps = false/);
    assert.match(log.config ?? '', /permission_mode = "default"/);
    assert.doesNotMatch(log.config ?? '', /mcp_servers|Composio|obsidian|always-approve/);

    // 4. Every ask went to the gate, with the mapped names.
    assert.deepEqual(calls.map((entry) => entry.name), [
      'Bash',
      'Bash',
      'mcp__cloudcli-tool-gateway__bot__remember',
      'mcp__obsidian__obsidian_get_file',
      'Read',
      'Read',
      'Bash',
    ]);
    assert.equal(calls[0].input.command, 'git status');
    assert.equal(calls[4].input.file_path, path.join(fakeHome, '.claude.json'));
    const verdicts = log.permissions.map((entry) => entry.reply.outcome);
    assert.deepEqual(verdicts.map((outcome) => outcome.optionId), [
      'opt-once', // git status
      'opt-reject', // rm -rf /
      'opt-once', // gateway tool
      'opt-reject', // another MCP server
      'opt-reject', // ~/.claude.json blocked by the real denylist
      'opt-once', // a file inside the project
      'opt-reject', // a command line posing as the gateway
    ]);
    assert.ok(!verdicts.some((outcome) => outcome.optionId === 'opt-always'), 'never an allow-always row');

    // 5. After the run: home gone, rotated login and transcript kept, grants untouched.
    assert.equal(fs.existsSync(log.home), false, 'the run home is deleted');
    assert.equal(fs.readFileSync(path.join(sourceHome, 'auth.json'), 'utf8'), '{"token":"rotated"}');
    const key = encodeURIComponent(fs.realpathSync(projectDir));
    assert.ok(
      fs.existsSync(path.join(sourceHome, 'sessions', key, 'fake-session-1', 'chat_history.jsonl'))
      || fs.existsSync(path.join(sourceHome, 'sessions', encodeURIComponent(log.cwd), 'fake-session-1', 'chat_history.jsonl')),
      'the transcript was written back to the real sessions folder',
    );
    assert.equal(fs.readFileSync(path.join(sourceHome, 'sessions', encodeURIComponent(projectDir), 'permission.toml'), 'utf8'), ORIGINAL_GRANTS);
    assert.equal(fs.readFileSync(path.join(sourceHome, 'config.toml'), 'utf8').includes('Composio'), true, 'the user config is untouched');
    assert.deepEqual(grokCli.getActiveGrokSessions(), [], 'the strict child is not kept for reuse');
  } finally {
    if (previousTrust === undefined) delete process.env.GROK_FOLDER_TRUST;
    else process.env.GROK_FOLDER_TRUST = previousTrust;
  }
});

test('a gated run refuses a live switch to bypass', async () => {
  seedSourceGrokHome();
  let switched: unknown = 'not called';
  const { gate } = makeGate((name) => {
    if (name === 'Bash') {
      void grokCli.updateGrokPermissionMode('fake-session-1', 'bypassPermissions', 'app-session-9').then((value: boolean) => { switched = value; });
    }
    return null;
  });
  const { error } = await runGrok({ requests: [bash('git status')] }, {
    botGatewayStrict: true,
    builtinToolGate: gate,
    mcpServers: ['cloudcli-tool-gateway'],
  });
  assert.equal(error, null);
  assert.equal(switched, false);
});

test('strict run without the built-in gate is MCP-isolated but keeps the requested permission mode (advisory)', async () => {
  seedSourceGrokHome();
  const { log, error } = await runGrok({ requests: [bash('ls')] }, {
    botGatewayStrict: true,
    botGatewaySecret: 'secret-xyz',
    mcpServers: ['cloudcli-tool-gateway'],
  });
  assert.equal(error, null);
  assert.ok(log);
  assert.deepEqual(log.sessionNew?.mcpServers.map((server) => server.name), ['cloudcli-tool-gateway']);
  assert.ok(log.args.includes('--always-approve'), 'no gate installed, so the requested bypass mode stands');
  assert.doesNotMatch(log.config ?? '', /\[permission\]/);
  assert.match(log.config ?? '', /\[compat\.claude\]\nmcps = false/);
  assert.equal(outcomeOf(log, 0)?.optionId, 'opt-once', 'bypass answers asks itself');
  assert.equal(fs.existsSync(log.home), false);
});

test('strict run fails closed when the gateway is not registered for grok', async () => {
  seedSourceGrokHome();
  writeCatalog({ mail: { ...gatewayEntry(), name: 'mail' }, 'cloudcli-tool-gateway': gatewayEntry('claude') });
  const { gate } = makeGate();
  const { log, messages, error } = await runGrok({}, {
    botGatewayStrict: true,
    builtinToolGate: gate,
    mcpServers: ['cloudcli-tool-gateway', 'mail'],
  });
  assert.match(String((error as Error)?.message), /refusing to run this bot without it/);
  assert.equal(log, null, 'grok was never started');
  assert.ok(messages.some((message) => message.kind === 'error' && /not registered for grok/.test(String(message.content))));
  const root = path.join(fakeHome, '.cloudcli', 'grok-strict-runs');
  assert.deepEqual(fs.existsSync(root) ? fs.readdirSync(root) : [], [], 'no run home is left behind');
});

test('flag off: unchanged — managed home, requested servers, always-approve, and the gate is never consulted', async () => {
  seedSourceGrokHome();
  const { gate, calls } = makeGate();
  const { log, error } = await runGrok({ requests: [bash('git status')] }, {
    // No botGatewayStrict: a stray builtinToolGate must be inert.
    builtinToolGate: gate,
    botGatewaySecret: 'secret-xyz',
    mcpServers: ['mail'],
  });
  assert.equal(error, null);
  assert.ok(log);
  assert.ok(log.args.includes('--always-approve'));
  assert.ok(!log.args.includes('--no-leader'));
  assert.deepEqual(log.sessionNew?.mcpServers.map((server) => server.name), ['mail']);
  assert.ok(log.home.startsWith(path.join(fakeHome, '.cloudcli', 'grok-runtime') + path.sep), log.home);
  assert.equal(log.env.GROK_CLAUDE_MCPS_ENABLED, undefined);
  assert.match(log.config ?? '', /Composio/, 'the managed home still overlays the user config');
  assert.equal(calls.length, 0);
  assert.equal(outcomeOf(log, 0)?.optionId, 'opt-once');
  assert.equal(fs.existsSync(log.home), true, 'managed homes are shared and kept');
  assert.equal(grokCli.getActiveGrokSessions().length > 0, true, 'the child is kept for reuse as before');
  grokCli.closeAllGrokSessions();
});

// ---------------------------------------------------------------------------
// Adapter, run options and the gateway route

async function withDatabase(run: (botId: string) => void | Promise<void>): Promise<void> {
  const previousDb = process.env.DATABASE_PATH;
  const previousBots = process.env.CLOUDCLI_BOTS_HOME;
  const dbScratch = await makeScratchDir('bots-grok-db-');
  closeConnection();
  process.env.DATABASE_PATH = path.join(dbScratch, 'auth.db');
  process.env.CLOUDCLI_BOTS_HOME = path.join(dbScratch, 'bots');
  await initializeDatabase();
  try {
    const bot = missionControlDb.createSection({ title: 'Grok bot', produce_prompt: 'Triage the inbox' });
    await run(bot.section_id);
  } finally {
    gatewaySessions.clearForTests();
    closeConnection();
    if (previousDb === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDb;
    if (previousBots === undefined) delete process.env.CLOUDCLI_BOTS_HOME;
    else process.env.CLOUDCLI_BOTS_HOME = previousBots;
    fs.rmSync(dbScratch, { recursive: true, force: true });
  }
}

test('grok adapter: enforced only with the built-in gate; run options never leave always-approve', () => {
  assert.equal(getGatewayEnforcement('grok'), 'advisory');
  assert.equal(getGatewayEnforcement('grok', { builtinToolGate: false }), 'advisory');
  assert.equal(getGatewayEnforcement('grok', { builtinToolGate: true }), 'enforced');
  assert.match(describeGatewayEnforcement('grok', { builtinToolGate: true }), /every built-in tool call is decided by the gate/);
  assert.match(describeGatewayEnforcement('grok'), /not gated/);

  const options: Record<string, unknown> = { permissionMode: 'bypassPermissions' };
  applyProviderGatewayRunOptions('grok', options);
  assert.equal(options.permissionMode, 'default');
  const other: Record<string, unknown> = { permissionMode: 'bypassPermissions' };
  applyProviderGatewayRunOptions('cursor', other);
  assert.equal(other.permissionMode, 'bypassPermissions', 'only grok is touched here');
});

test('buildRuntimeOptions: a gateway-bound grok run is strict and non-bypass; flag off is unchanged', async () => {
  await withDatabase((botId) => {
    const section = { ...missionControlDb.getSection(botId)!, provider: 'grok' as const, permission_mode: 'bypassPermissions' };
    assert.equal(isBotsRuntimeV2Enabled(), false);
    const off = buildRuntimeOptions(section, ['mail']);
    assert.deepEqual(off.mcpServers, ['mail']);
    assert.equal(off.permissionMode, 'bypassPermissions');
    assert.equal(off.botGatewayStrict, undefined);

    updateAppFeatures({ botsRuntimeV2: true });
    const on = buildRuntimeOptions(section, ['mail']);
    assert.deepEqual(on.mcpServers, ['cloudcli-tool-gateway']);
    assert.equal(on.botGatewayStrict, true);
    assert.equal(on.strictMcpSelection, true);
    assert.equal(on.permissionMode, 'default');
  });
});

test('the gateway route requires the binding secret for grok runs', async () => {
  await withDatabase(async (botId) => {
    const grokBinding = gatewaySessions.bind('grok-session', { botId, servers: [], provider: 'grok' });
    const codexBinding = gatewaySessions.bind('cursor-session', { botId, servers: [], provider: 'cursor' });
    assert.equal(grokBinding.secretRequired, true);
    assert.equal(codexBinding.secretRequired, false, 'a provider that cannot stamp it still does not need it');

    const app = express();
    app.use(express.json());
    app.use('/api/bot-gateway-mcp', botGatewayMcpRoutes);
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/bot-gateway-mcp`;
    const post = (session: string, secret: string | null) => fetch(`${base}/tools/call`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${getBotGatewayMcpToken()}`,
        'x-bot-gateway-session-id': session,
        ...(secret ? { 'x-bot-gateway-binding-secret': secret } : {}),
      },
      body: JSON.stringify({}),
    });
    try {
      assert.equal((await post('grok-session', null)).status, 401, 'no secret');
      assert.equal((await post('grok-session', 'wrong')).status, 401, 'wrong secret');
      assert.equal((await post('grok-session', grokBinding.secret)).status, 400, 'right secret reaches the handler (name is required)');
      assert.equal((await post('cursor-session', null)).status, 400);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

test.after(() => {
  grokCli.closeAllGrokSessions();
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  fs.rmSync(scratch, { recursive: true, force: true });
});
