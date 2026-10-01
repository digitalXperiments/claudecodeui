// Codex bot runs enforced behind the Tool Gateway (options.botGatewayStrict).
//
// The runtime side (queryCodex against a fake app-server) is covered by server/openai-codex-gateway.test.js;
// this file covers the bots <-> codex contract: the adapter, the options buildRuntimeOptions hands the
// runtime, the gateway route requiring the binding secret for codex, and the pure strict-run helpers.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import test from 'node:test';

import express from 'express';

import { isBotsRuntimeV2Enabled, updateAppFeatures } from '@/modules/app-features/index.js';
import { builtinDenylistReason } from '@/modules/bots/gate/builtin-tool-gate.js';
import {
  applyProviderGatewayRunOptions,
  botGatewayMcpRoutes,
  describeGatewayEnforcement,
  getBotGatewayMcpLaunchSpec,
  getBotGatewayMcpToken,
  getGatewayEnforcement,
  gatewaySessions,
} from '@/modules/bots/gateway/index.js';
import { closeConnection, initializeDatabase } from '@/modules/database/index.js';
import { buildRuntimeOptions, missionControlDb } from '@/modules/mission-control/index.js';
// The strict-run helpers are codex runtime internals and openai-codex.js lives outside the module tree; this
// test deliberately drives them directly, as the bots <-> codex contract under test.
/* eslint-disable boundaries/dependencies */
import {
  GATEWAY_FORWARDED_ENV,
  buildStrictCodexConfig,
  buildStrictCodexEnv,
  buildStrictRules,
  decideStrictApproval,
  fileChangeTargets,
  prepareStrictCodexHome,
  resolveStrictPolicy,
  strictAllowReadPaths,
  strictDenyReadPaths,
  strictUntrustedProjectPaths,
  unwrapShellCommand,
} from '@/modules/providers/list/codex/codex-gateway-strict.js';
/* eslint-enable boundaries/dependencies */
import { makeScratchDir } from '@/shared/scratch.js';

const GATEWAY = {
  command: '/usr/bin/node',
  args: ['/srv/bot-tool-gateway-mcp.js'],
  env: {
    CLOUDCLI_BOT_GATEWAY_API_URL: 'http://127.0.0.1:3001/api/bot-gateway-mcp',
    CLOUDCLI_BOT_GATEWAY_MCP_TOKEN: 'token-1',
  },
};

async function withDatabase(run: (botId: string) => void | Promise<void>): Promise<void> {
  const previousDb = process.env.DATABASE_PATH;
  const previousBots = process.env.CLOUDCLI_BOTS_HOME;
  const scratch = await makeScratchDir('bots-codex-');
  closeConnection();
  process.env.DATABASE_PATH = path.join(scratch, 'auth.db');
  process.env.CLOUDCLI_BOTS_HOME = path.join(scratch, 'bots');
  await initializeDatabase();
  try {
    const bot = missionControlDb.createSection({ title: 'Codex bot', produce_prompt: 'Triage the inbox' });
    await run(bot.section_id);
  } finally {
    gatewaySessions.clearForTests();
    closeConnection();
    if (previousDb === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDb;
    if (previousBots === undefined) delete process.env.CLOUDCLI_BOTS_HOME;
    else process.env.CLOUDCLI_BOTS_HOME = previousBots;
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Adapter and run options

test('codex adapter: enforced only with the built-in gate; applyRunOptions hands the runtime the gateway launch spec', () => {
  assert.equal(getGatewayEnforcement('codex'), 'advisory');
  assert.equal(getGatewayEnforcement('codex', { builtinToolGate: false }), 'advisory');
  assert.equal(getGatewayEnforcement('codex', { builtinToolGate: true }), 'enforced');
  assert.match(describeGatewayEnforcement('codex', { builtinToolGate: true }), /managed CODEX_HOME/);
  assert.match(describeGatewayEnforcement('codex'), /not gated/);

  const options: Record<string, unknown> = { permissionMode: 'bypassPermissions' };
  applyProviderGatewayRunOptions('codex', options);
  assert.equal(options.botGatewayStrict, true);
  assert.equal(options.strictMcpSelection, true);
  const spec = options.codexGatewayMcp as ReturnType<typeof getBotGatewayMcpLaunchSpec>;
  assert.equal(typeof spec.command, 'string');
  assert.ok(spec.args.length > 0);
  assert.match(spec.env.CLOUDCLI_BOT_GATEWAY_API_URL, /\/api\/bot-gateway-mcp$/);
  assert.ok(spec.env.CLOUDCLI_BOT_GATEWAY_MCP_TOKEN.length >= 32);
  // The runtime, not the adapter, maps the permission mode (never bypass on a gateway-bound run).
  assert.equal(options.permissionMode, 'bypassPermissions');
});

test('buildRuntimeOptions: a gateway-bound codex run is strict; flag off is unchanged', async () => {
  await withDatabase((botId) => {
    const section = { ...missionControlDb.getSection(botId)!, provider: 'codex' as const, permission_mode: 'bypassPermissions' };
    assert.equal(isBotsRuntimeV2Enabled(), false);
    const off = buildRuntimeOptions(section, ['mail']);
    assert.deepEqual(off.mcpServers, ['mail']);
    assert.equal(off.botGatewayStrict, undefined);
    assert.equal(off.codexGatewayMcp, undefined);

    updateAppFeatures({ botsRuntimeV2: true });
    const on = buildRuntimeOptions(section, ['mail']);
    assert.deepEqual(on.mcpServers, ['cloudcli-tool-gateway']);
    assert.equal(on.botGatewayStrict, true);
    assert.equal(on.strictMcpSelection, true);
    assert.ok(on.codexGatewayMcp);
  });
});

// ---------------------------------------------------------------------------
// Gateway route

test('the gateway route requires the binding secret for codex runs', async () => {
  await withDatabase(async (botId) => {
    const binding = gatewaySessions.bind('codex-session', { botId, servers: [], provider: 'codex' });
    const cursorBinding = gatewaySessions.bind('cursor-session', { botId, servers: [], provider: 'cursor' });
    assert.equal(binding.secretRequired, true);
    assert.equal(cursorBinding.secretRequired, false, 'a provider that cannot stamp it still does not need it');

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
      assert.equal((await post('codex-session', null)).status, 401, 'no secret');
      assert.equal((await post('codex-session', 'wrong')).status, 401, 'wrong secret');
      assert.equal((await post('codex-session', binding.secret)).status, 400, 'right secret reaches the handler (name is required)');
      assert.equal((await post('cursor-session', null)).status, 400);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

// ---------------------------------------------------------------------------
// Strict config snapshot

test('buildStrictCodexConfig: only the gateway server, env stamped, secrets forwarded by name', () => {
  const config = buildStrictCodexConfig({
    gateway: GATEWAY,
    appSessionId: 'sess-42',
    policy: resolveStrictPolicy('bypassPermissions'),
    cwd: '/work/project',
    denyReadPaths: ['/home/u/.codex', '/home/u/.cloudcli'],
    allowReadPaths: ['/home/u/.codex/packages'],
  });

  assert.deepEqual(Object.keys(config.mcp_servers), ['cloudcli-tool-gateway']);
  assert.deepEqual(config.mcp_servers['cloudcli-tool-gateway'], {
    command: '/usr/bin/node',
    args: ['/srv/bot-tool-gateway-mcp.js'],
    env: {
      CLOUDCLI_SESSION_ID: 'sess-42',
      CLOUDCLI_BOT_GATEWAY_API_URL: 'http://127.0.0.1:3001/api/bot-gateway-mcp',
    },
    env_vars: ['CLOUDCLI_BOT_GATEWAY_BINDING_SECRET', 'CLOUDCLI_BOT_GATEWAY_MCP_TOKEN'],
    default_tools_approval_mode: 'approve',
    startup_timeout_sec: 60,
    tool_timeout_sec: 2100,
  });
  assert.equal(config.default_permissions, 'cloudcli_bot_gate');
  assert.deepEqual(config.permissions.cloudcli_bot_gate, {
    extends: ':workspace',
    filesystem: {
      '/home/u/.codex': 'deny',
      '/home/u/.cloudcli': 'deny',
      '/home/u/.codex/packages': 'read',
      '/work/project': 'write',
    },
  });
  assert.equal(config.approvals_reviewer, 'user');
  assert.equal('approval_policy' in config, false, 'codex rejects approval_policy="untrusted" in config; the thread carries it');
  assert.equal(config.web_search, 'disabled');
  assert.equal(config.features.apps, false);
  assert.equal(config.features.shell_snapshot, false, 'the snapshot re-exports the whole server env into shells');
  assert.equal(config.projects['/work/project'].trust_level, 'untrusted');
  assert.equal(config.projects['/'].trust_level, 'untrusted');
  assert.deepEqual(config.shell_environment_policy.exclude.slice(0, 2), ['CLOUDCLI_*', 'CODEX_HOME']);
  assert.equal(config.shell_environment_policy.ignore_default_excludes, false);

  assert.deepEqual(resolveStrictPolicy('plan'), { baseProfile: ':read-only', approvalPolicy: 'untrusted', approvalsReviewer: 'user' });
  assert.equal(resolveStrictPolicy('bypassPermissions').baseProfile, ':workspace');
  const planConfig = buildStrictCodexConfig({
    gateway: GATEWAY, appSessionId: 's', policy: resolveStrictPolicy('plan'), cwd: '/work/project', denyReadPaths: [],
  });
  assert.equal(planConfig.permissions.cloudcli_bot_gate.filesystem['/work/project'], 'read', 'read-only profile never grants write');
});

test('buildStrictCodexEnv: gateway credentials and the managed home, nothing inherited that could speak for a session', () => {
  const env = buildStrictCodexEnv({
    baseEnv: { PATH: '/bin', CLOUDCLI_BOT_GATEWAY_BINDING_SECRET: 'inherited', CLOUDCLI_SESSION_ID: 'inherited', KEEP: '1' },
    home: '/managed/home',
    appSessionId: 'sess-42',
    bindingSecret: 'secret-42',
    gateway: GATEWAY,
  });
  assert.equal(env.CODEX_HOME, '/managed/home');
  assert.equal(env.CLOUDCLI_SESSION_ID, 'sess-42');
  assert.equal(env.CLOUDCLI_BOT_GATEWAY_BINDING_SECRET, 'secret-42');
  assert.equal(env.CLOUDCLI_BOT_GATEWAY_MCP_TOKEN, 'token-1');
  assert.equal(env.KEEP, '1');
  for (const name of GATEWAY_FORWARDED_ENV) assert.ok(name in env, `${name} is on the app-server env so env_vars can forward it`);
});

test('strict deny list covers the credential stores the gate protects; the codex binary stays readable', () => {
  const denied = strictDenyReadPaths({ home: '/home/u', codexHome: '/custom/codex' });
  for (const entry of ['.codex', '.claude', '.claude.json', '.grok', '.cursor', '.config', '.cloudcli', '.ssh', '.aws']) {
    assert.ok(denied.includes(path.join('/home/u', entry)), entry);
  }
  assert.ok(denied.includes('/custom/codex'));

  const allowed = strictAllowReadPaths({
    launcherCommand: '/home/u/.local/bin/codex',
    denyReadPaths: ['/home/u/.codex'],
  });
  assert.ok(allowed.includes('/home/u/.local/bin/codex'));
  assert.deepEqual(strictAllowReadPaths({ launcherCommand: 'codex' }), [], 'a bare command name has nothing to allow');
});

test('strictUntrustedProjectPaths pins the cwd, its ancestors and the main checkout of a linked worktree', async () => {
  const scratch = await makeScratchDir('bots-codex-trust-');
  try {
    const main = path.join(scratch, 'main');
    const worktree = path.join(scratch, 'elsewhere', 'wt');
    fs.mkdirSync(path.join(main, '.git', 'worktrees', 'wt'), { recursive: true });
    fs.mkdirSync(path.join(worktree, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(worktree, '.git'), `gitdir: ${path.join(main, '.git', 'worktrees', 'wt')}\n`);
    const paths = strictUntrustedProjectPaths(path.join(worktree, 'sub'));
    assert.ok(paths.includes(path.join(worktree, 'sub')));
    assert.ok(paths.includes(worktree));
    assert.ok(paths.includes(path.resolve(main)), 'the trust key for a linked worktree is the main checkout');
    assert.ok(paths.includes('/'));
    assert.deepEqual(strictUntrustedProjectPaths(''), []);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test('the force-prompt rules cover the programs Codex treats as known safe', () => {
  const rules = buildStrictRules();
  assert.match(rules, /^prefix_rule\(pattern=\[\[/m);
  for (const program of ['cat', 'ls', 'grep', 'sed', 'find', 'git', 'env']) {
    assert.ok(rules.includes(`"${program}"`), program);
  }
  assert.match(rules, /decision="prompt"/);
  assert.doesNotMatch(rules, /decision="allow"/);
});

// ---------------------------------------------------------------------------
// Managed home

test('prepareStrictCodexHome: login linked in, nothing else of the user config, rotated login written back, home removed', async () => {
  const scratch = await makeScratchDir('bots-codex-home-');
  try {
    const realHome = path.join(scratch, 'real');
    fs.mkdirSync(realHome, { recursive: true });
    fs.writeFileSync(path.join(realHome, 'auth.json'), '{"refresh":"old"}', { mode: 0o600 });
    fs.writeFileSync(path.join(realHome, 'config.toml'), '[mcp_servers.leak]\ncommand = "x"\n');

    // Untouched login: the link stays a link and the real file is not rewritten.
    const first = prepareStrictCodexHome({ root: path.join(scratch, 'homes'), appSessionId: 'sess/../1', authHome: realHome });
    assert.ok(first.home.startsWith(path.join(scratch, 'homes')));
    assert.ok(!path.basename(first.home).includes('..'), 'the session id cannot escape the root');
    assert.deepEqual(fs.readdirSync(first.home).sort(), ['auth.json', 'rules']);
    assert.ok(fs.lstatSync(path.join(first.home, 'auth.json')).isSymbolicLink());
    assert.equal(fs.readFileSync(path.join(first.home, 'auth.json'), 'utf8'), '{"refresh":"old"}');
    first.cleanup();
    assert.equal(fs.existsSync(first.home), false);
    assert.equal(fs.readFileSync(path.join(realHome, 'auth.json'), 'utf8'), '{"refresh":"old"}');

    // Codex replaced the link with a fresh file (atomic refresh): the newer login goes back.
    const second = prepareStrictCodexHome({ root: path.join(scratch, 'homes'), appSessionId: 'sess-2', authHome: realHome });
    fs.rmSync(path.join(second.home, 'auth.json'));
    fs.writeFileSync(path.join(second.home, 'auth.json'), '{"refresh":"rotated"}', { mode: 0o600 });
    second.cleanup();
    second.cleanup();
    assert.equal(fs.readFileSync(path.join(realHome, 'auth.json'), 'utf8'), '{"refresh":"rotated"}');
    assert.equal((fs.statSync(path.join(realHome, 'auth.json')).mode & 0o777).toString(8), '600');
    assert.deepEqual(fs.readdirSync(realHome).sort(), ['auth.json', 'config.toml'], 'no staging files left behind');
    assert.equal(fs.existsSync(second.home), false);

    // No login at all: no link, no failure.
    const bare = prepareStrictCodexHome({ root: path.join(scratch, 'homes'), appSessionId: 'sess-3', authHome: path.join(scratch, 'nowhere') });
    assert.deepEqual(fs.readdirSync(bare.home), ['rules']);
    bare.cleanup();
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Approval mapping

test('unwrapShellCommand unwraps the shell wrapper only when it parses cleanly', () => {
  assert.equal(unwrapShellCommand("/bin/zsh -lc 'cat /etc/hosts'"), 'cat /etc/hosts');
  assert.equal(unwrapShellCommand('/bin/bash -lc "python3 -c \\"print(1)\\""'), 'python3 -c "print(1)"');
  assert.equal(unwrapShellCommand("zsh -c 'echo it'\\''s'"), "echo it's");
  assert.equal(unwrapShellCommand('ls -la'), 'ls -la', 'a plain command is untouched');
  assert.equal(unwrapShellCommand("/bin/zsh -lc 'ls' ; rm -rf /"), "/bin/zsh -lc 'ls' ; rm -rf /", 'trailing text means the quoting did not close: keep it whole');
  assert.equal(unwrapShellCommand('sh -c "a" "b"'), 'sh -c "a" "b"');
  // The unwrapped script is what the gate's denylist sees.
  const scope = { workspaceRoot: '/work', botHome: '/botshome' };
  assert.ok(builtinDenylistReason('Bash', { command: unwrapShellCommand("/bin/zsh -lc 'cat ~/.claude.json'") }, scope));
  assert.equal(builtinDenylistReason('Bash', { command: unwrapShellCommand("/bin/zsh -lc 'ls -la'") }, scope), null);
});

test('decideStrictApproval maps requests onto the gate tool names and fails closed', async () => {
  const calls: Array<[string, unknown]> = [];
  const gate = async (toolName: string, input: unknown) => {
    calls.push([toolName, input]);
    return JSON.stringify(input).includes('deny-me')
      ? { behavior: 'deny' as const, message: 'nope' }
      : { behavior: 'allow' as const };
  };
  const decide = (method: string, params: Record<string, unknown>, tracked?: Map<string, unknown>) =>
    decideStrictApproval({ method, params, gate, fileChangeItems: tracked, cwd: '/work' });

  assert.deepEqual(await decide('item/commandExecution/requestApproval', { command: "/bin/zsh -lc 'ls'", cwd: '/w2' }), { allow: true });
  assert.deepEqual(calls.at(-1), ['Bash', { command: 'ls', cwd: '/w2' }]);
  assert.deepEqual(await decide('item/commandExecution/requestApproval', { command: 'deny-me', cwd: '/w2' }), { allow: false, message: 'nope' });
  assert.equal((await decide('item/commandExecution/requestApproval', { command: '   ' })).allow, false, 'no command text');
  assert.equal((await decide('item/commandExecution/requestApproval', { kind: 'writeStdin', command: null })).allow, false);

  assert.deepEqual(await decide('execCommandApproval', { command: ['bash', '-lc', 'echo hi'] }), { allow: true });
  assert.deepEqual(calls.at(-1), ['Bash', { command: 'echo hi', cwd: '/work' }]);

  // Extra permissions a command asks for are gated as reads, writes and network.
  await decide('item/commandExecution/requestApproval', {
    command: 'make', additionalPermissions: { fileSystem: { read: ['/r'], write: ['/w'] }, network: { enabled: true } },
  });
  assert.deepEqual(calls.slice(-4).map(([tool]) => tool), ['Bash', 'Read', 'Write', 'WebFetch']);

  // File changes: add -> Write, update/delete -> Edit, a move also writes the destination.
  const tracked = new Map<string, unknown>([['fc', [
    { path: '/work/a', kind: { type: 'add' } },
    { path: '/work/b', kind: { type: 'update', move_path: '/work/c' } },
    { path: '/work/d', kind: { type: 'delete' } },
  ]]]);
  assert.deepEqual(await decide('item/fileChange/requestApproval', { itemId: 'fc' }, tracked), { allow: true });
  assert.deepEqual(calls.slice(-4).map(([tool, input]) => [tool, (input as { file_path: string }).file_path]), [
    ['Write', '/work/a'], ['Edit', '/work/b'], ['Write', '/work/c'], ['Edit', '/work/d'],
  ]);
  assert.equal((await decide('item/fileChange/requestApproval', { itemId: 'unknown' }, tracked)).allow, false);
  assert.equal((await decide('item/fileChange/requestApproval', { itemId: 'unknown', grantRoot: '/work' }, tracked)).allow, true, 'grantRoot is itself a target');
  assert.deepEqual(calls.at(-1), ['Write', { file_path: '/work' }]);
  assert.equal((await decide('applyPatchApproval', { fileChanges: { '/work/x': { type: 'update', move_path: null } } })).allow, true);
  assert.deepEqual(calls.at(-1), ['Edit', { file_path: '/work/x' }]);

  // Network approvals go to the gate as a fetch of the host.
  assert.deepEqual(await decide('item/commandExecution/requestApproval', { networkApprovalContext: { host: 'h.example', protocol: 'https' } }), { allow: true });
  assert.deepEqual(calls.at(-1), ['WebFetch', { url: 'https://h.example' }]);

  // Anything else is denied, and a throwing gate denies.
  assert.equal((await decide('item/permissions/requestApproval', {})).allow, false);
  assert.equal((await decideStrictApproval({
    method: 'item/commandExecution/requestApproval',
    params: { command: 'ls' },
    gate: async () => { throw new Error('boom'); },
    fileChangeItems: undefined,
    cwd: '/work',
  })).allow, false);

  assert.deepEqual(fileChangeTargets({ changes: [], legacyChanges: undefined, grantRoot: undefined }), []);
});

test('prepareStrictCodexHome sweeps managed homes left behind by a crashed run, and only old ones', async () => {
  const scratch = await makeScratchDir('bots-codex-sweep-');
  try {
    const root = path.join(scratch, 'homes');
    const stale = path.join(root, 'old-run-1');
    const fresh = path.join(root, 'new-run-2');
    fs.mkdirSync(stale, { recursive: true });
    fs.mkdirSync(fresh, { recursive: true });
    const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);
    fs.utimesSync(stale, twoDaysAgo, twoDaysAgo);
    const home = prepareStrictCodexHome({ root, appSessionId: 's', authHome: path.join(scratch, 'none') });
    assert.equal(fs.existsSync(stale), false);
    assert.equal(fs.existsSync(fresh), true);
    home.cleanup();
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
