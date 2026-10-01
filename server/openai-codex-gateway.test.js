// Enforced Tool Gateway runs for Codex (options.botGatewayStrict).
//
// No real codex binary and no network: queryCodex is driven against a fake `codex app-server` child
// (JSONL JSON-RPC on stdio) that records how it was spawned and fires scripted approval requests.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import test from 'node:test';

import { flattenConfigOverrides } from './codex-app-server.js';
import { __setCodexTestOverrides, queryCodex } from './openai-codex.js';

const SCRATCH_ROOT = path.resolve('tmp', 'cloudcli');
fs.mkdirSync(SCRATCH_ROOT, { recursive: true });
const SCRATCH = fs.mkdtempSync(path.join(SCRATCH_ROOT, 'codex-gateway-'));
const REAL_CODEX_HOME = path.join(SCRATCH, 'real-codex');
const HOMES_ROOT = path.join(SCRATCH, 'managed-homes');
const WORKDIR = path.join(SCRATCH, 'work');
fs.mkdirSync(REAL_CODEX_HOME, { recursive: true });
fs.mkdirSync(WORKDIR, { recursive: true });
fs.writeFileSync(path.join(REAL_CODEX_HOME, 'auth.json'), '{"tokens":"fixture"}');
fs.writeFileSync(path.join(REAL_CODEX_HOME, 'config.toml'), '[mcp_servers.user_server]\ncommand = "should-never-load"\n');

process.env.CODEX_HOME = REAL_CODEX_HOME;
process.env.CLOUDCLI_CODEX_BOT_HOMES = HOMES_ROOT;
process.env.CLOUDCLI_WARM_CODEX_SESSIONS = '0';

test.after(() => {
  fs.rmSync(SCRATCH, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Fake `codex app-server`

let threadSeq = 0;

function createFakeChild({ script } = {}) {
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.killed = false;
  child.requests = [];
  child.responses = new Map();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.home = null;
  child.homeSnapshot = null;

  const send = (message) => {
    if (!child.stdout.destroyed && !child.stdout.writableEnded) child.stdout.write(`${JSON.stringify(message)}\n`);
  };
  child.send = send;
  let requestSeq = 900;
  /** Sends a server request (an approval) and resolves with the client's response. */
  child.ask = async (method, params) => {
    const id = ++requestSeq;
    send({ id, method, params });
    const deadline = Date.now() + 5000;
    while (!child.responses.has(id)) {
      if (Date.now() > deadline) throw new Error(`no response to ${method}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    return child.responses.get(id);
  };

  const terminate = (code, signal) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.exitCode = code;
    child.signalCode = signal;
    setImmediate(() => {
      child.stdout.end();
      child.stderr.end();
      child.emit('exit', code, signal);
      setImmediate(() => child.emit('close', code, signal));
    });
  };
  child.kill = (signal = 'SIGTERM') => {
    child.killed = true;
    terminate(null, signal);
    return true;
  };

  const handle = (message) => {
    if (message.method === undefined && message.id !== undefined) {
      child.responses.set(message.id, message.result);
      return;
    }
    if (message.id === undefined) return;
    child.requests.push(message);
    const reply = (result) => send({ id: message.id, result });
    const { method, params = {} } = message;
    if (method === 'initialize') reply({});
    else if (method === 'thread/start') reply({ thread: { id: `thread-gw-${++threadSeq}` } });
    else if (method === 'thread/resume') reply({ thread: { id: params.threadId } });
    else if (method === 'turn/start') {
      const turnId = `${params.threadId}-turn-1`;
      reply({ turn: { id: turnId } });
      setImmediate(async () => {
        try {
          // The managed home exists while the app-server runs; snapshot what is in it.
          if (child.home && fs.existsSync(child.home)) {
            child.homeSnapshot = {
              entries: fs.readdirSync(child.home).sort(),
              rules: fs.existsSync(path.join(child.home, 'rules', 'default.rules'))
                ? fs.readFileSync(path.join(child.home, 'rules', 'default.rules'), 'utf8')
                : null,
              authIsLink: fs.lstatSync(path.join(child.home, 'auth.json'), { throwIfNoEntry: false })?.isSymbolicLink() ?? false,
            };
          }
          await script?.(child, params.threadId, turnId);
        } finally {
          send({ method: 'turn/completed', params: { threadId: params.threadId, turn: { id: turnId, status: 'completed' } } });
        }
      });
    } else reply({});
  };

  let buffer = '';
  child.stdin = new Writable({
    write(chunk, _encoding, callback) {
      buffer += chunk.toString();
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.trim()) handle(JSON.parse(line));
      }
      callback();
    },
  });
  return child;
}

function createWriter() {
  return {
    isWebSocketWriter: true,
    messages: [],
    send(message) {
      this.messages.push(message);
    },
    setSessionId() {},
    count(kind) {
      return this.messages.filter((m) => m.kind === kind).length;
    },
  };
}

const GATEWAY = {
  command: '/usr/bin/node',
  args: ['/srv/cloudcli/bot-tool-gateway-mcp.js'],
  env: {
    CLOUDCLI_BOT_GATEWAY_API_URL: 'http://127.0.0.1:3001/api/bot-gateway-mcp',
    CLOUDCLI_BOT_GATEWAY_MCP_TOKEN: 'mcp-token-xyz',
  },
};

async function withFakeCodex(fn, { script } = {}) {
  const spawned = [];
  __setCodexTestOverrides({
    spawn: (command, args, options) => {
      const child = createFakeChild({ script });
      child.spawnArgs = args;
      child.spawnEnv = options?.env || {};
      child.spawnCwd = options?.cwd;
      child.home = options?.env?.CODEX_HOME && options.env.CODEX_HOME !== REAL_CODEX_HOME ? options.env.CODEX_HOME : null;
      spawned.push(child);
      return child;
    },
    resolveResumeModel: async (_id, model) => model || 'gpt-test',
    getProviderModels: async () => ({ models: { OPTIONS: [{ value: 'gpt-test' }] } }),
    loadManagedObsidianCodexRuntime: () => null,
    authStamp: () => 1,
    isProviderInstalled: async () => true,
  });
  try {
    await fn(spawned);
  } finally {
    __setCodexTestOverrides({});
  }
}

function strictOptions(extra = {}) {
  const gateCalls = [];
  return {
    gateCalls,
    options: {
      cwd: WORKDIR,
      appSessionId: 'app-session-gw-1',
      permissionMode: 'bypassPermissions',
      unattended: true,
      botGatewayStrict: true,
      botGatewaySecret: 'binding-secret-abc',
      codexGatewayMcp: GATEWAY,
      builtinToolGate: async (toolName, input) => {
        gateCalls.push({ toolName, input });
        return /forbidden/.test(JSON.stringify(input))
          ? { behavior: 'deny', message: 'Blocked by test gate' }
          : { behavior: 'allow' };
      },
      ...extra,
    },
  };
}

function configOverrides(child) {
  const overrides = [];
  for (let i = 0; i < child.spawnArgs.length; i += 1) {
    if (child.spawnArgs[i] === '--config') overrides.push(child.spawnArgs[i + 1]);
  }
  return overrides;
}

// ---------------------------------------------------------------------------

test('strict run: gateway is the only MCP server, env stamped, secret kept off argv, managed home swept', async () => {
  const { options } = strictOptions();
  await withFakeCodex(async (spawned) => {
    const writer = createWriter();
    await queryCodex('do the work', options, writer);
    assert.equal(writer.count('error'), 0);
    assert.equal(spawned.length, 1);
    const child = spawned[0];
    const overrides = configOverrides(child);

    const mcpOverrides = overrides.filter((entry) => entry.startsWith('mcp_servers'));
    assert.ok(mcpOverrides.length > 0);
    assert.ok(
      mcpOverrides.every((entry) => entry.startsWith('mcp_servers.cloudcli-tool-gateway.')),
      `only the gateway server is configured, got ${mcpOverrides.join(' | ')}`,
    );
    assert.ok(!overrides.some((entry) => entry.includes('obsidian')), 'no managed Obsidian MCP is injected');
    assert.ok(overrides.includes('mcp_servers.cloudcli-tool-gateway.command="/usr/bin/node"'));
    assert.ok(overrides.includes('mcp_servers.cloudcli-tool-gateway.env.CLOUDCLI_SESSION_ID="app-session-gw-1"'));
    assert.ok(overrides.includes('mcp_servers.cloudcli-tool-gateway.env.CLOUDCLI_BOT_GATEWAY_API_URL="http://127.0.0.1:3001/api/bot-gateway-mcp"'));
    assert.ok(overrides.includes('mcp_servers.cloudcli-tool-gateway.env_vars=["CLOUDCLI_BOT_GATEWAY_BINDING_SECRET", "CLOUDCLI_BOT_GATEWAY_MCP_TOKEN"]'));
    assert.ok(overrides.includes('mcp_servers.cloudcli-tool-gateway.default_tools_approval_mode="approve"'));

    // Secrets are forwarded by name from the process env, never written on a command line.
    const argv = child.spawnArgs.join('\n');
    assert.ok(!argv.includes('binding-secret-abc'));
    assert.ok(!argv.includes('mcp-token-xyz'));
    assert.equal(child.spawnEnv.CLOUDCLI_BOT_GATEWAY_BINDING_SECRET, 'binding-secret-abc');
    assert.equal(child.spawnEnv.CLOUDCLI_BOT_GATEWAY_MCP_TOKEN, 'mcp-token-xyz');
    assert.equal(child.spawnEnv.CLOUDCLI_SESSION_ID, 'app-session-gw-1');

    // Built-in escape hatches that bypass approvals are off, and the project layer is untrusted.
    for (const feature of ['apps', 'plugins', 'browser_use', 'computer_use', 'view_image', 'multi_agent', 'hooks', 'shell_snapshot']) {
      assert.ok(overrides.includes(`features.${feature}=false`), `features.${feature} disabled`);
    }
    assert.ok(overrides.includes('web_search="disabled"'));
    assert.ok(overrides.some((entry) => entry.startsWith('projects={') && entry.includes(`"${WORKDIR}" = {trust_level = "untrusted"}`)));
    assert.ok(overrides.some((entry) => entry.startsWith('shell_environment_policy.exclude=') && entry.includes('CLOUDCLI_*')));

    // Managed CODEX_HOME: no user config.toml, only rules + the login link; removed after the run.
    assert.ok(child.home?.startsWith(HOMES_ROOT), 'run uses a managed CODEX_HOME');
    assert.notEqual(child.spawnEnv.CODEX_HOME, REAL_CODEX_HOME);
    assert.deepEqual(child.homeSnapshot.entries, ['auth.json', 'rules']);
    assert.equal(child.homeSnapshot.authIsLink, true);
    assert.match(child.homeSnapshot.rules, /decision="prompt"/);
    assert.equal(fs.existsSync(child.home), false, 'managed home deleted when the run ends');
    assert.ok(fs.existsSync(path.join(REAL_CODEX_HOME, 'auth.json')), 'the real login is untouched');
  });
});

test('strict run: always workspace-write profile + untrusted/user approvals, whatever the bot permission mode', async () => {
  for (const permissionMode of ['bypassPermissions', 'acceptEdits', 'auto', 'default']) {
    const { options } = strictOptions({ permissionMode });
    await withFakeCodex(async (spawned) => {
      await queryCodex('go', options, createWriter());
      const [thread, turn] = [
        spawned[0].requests.find((r) => r.method === 'thread/start').params,
        spawned[0].requests.find((r) => r.method === 'turn/start').params,
      ];
      for (const params of [thread, turn]) {
        assert.equal(params.approvalPolicy, 'untrusted', permissionMode);
        assert.equal(params.approvalsReviewer, 'user', permissionMode);
      }
      assert.equal(thread.permissions, 'cloudcli_bot_gate');
      assert.equal(thread.sandbox, undefined, 'a named profile replaces the sandbox mode');
      const overrides = configOverrides(spawned[0]);
      assert.ok(overrides.includes('permissions.cloudcli_bot_gate.extends=":workspace"'));
      assert.ok(overrides.includes('default_permissions="cloudcli_bot_gate"'));
      assert.ok(!overrides.some((entry) => entry.startsWith('approval_policy=')));
    });
  }
  const { options } = strictOptions({ permissionMode: 'plan' });
  await withFakeCodex(async (spawned) => {
    await queryCodex('go', options, createWriter());
    assert.ok(configOverrides(spawned[0]).includes('permissions.cloudcli_bot_gate.extends=":read-only"'));
  });
});

test('strict run: credential directories are denied at the sandbox, the working directory stays usable', async () => {
  const { options } = strictOptions();
  await withFakeCodex(async (spawned) => {
    await queryCodex('go', options, createWriter());
    const entry = configOverrides(spawned[0]).find((line) => line.startsWith('permissions.cloudcli_bot_gate.filesystem='));
    assert.ok(entry);
    for (const dir of ['.codex', '.claude', '.claude.json', '.cloudcli', '.ssh', '.aws']) {
      assert.ok(entry.includes(`${path.join(os.homedir(), dir)}" = "deny"`), `${dir} denied`);
    }
    assert.ok(entry.includes(`"${REAL_CODEX_HOME}" = "deny"`), 'the real CODEX_HOME is denied');
    assert.ok(entry.includes(`"${WORKDIR}" = "write"`), 'cwd re-allowed (more specific entry wins)');
  });
});

test('approvals: every command / patch request is answered by the built-in gate, deny declines', async () => {
  const { options, gateCalls } = strictOptions();
  const answers = {};
  await withFakeCodex(async () => {
    await queryCodex('go', options, createWriter());
  }, {
    script: async (child, threadId) => {
      const base = { threadId, turnId: 't1' };
      answers.allowShell = await child.ask('item/commandExecution/requestApproval', {
        ...base, itemId: 'i1', command: "/bin/zsh -lc 'ls -la'", cwd: WORKDIR,
      });
      answers.denyShell = await child.ask('item/commandExecution/requestApproval', {
        ...base, itemId: 'i2', command: "/bin/zsh -lc 'cat forbidden.txt'", cwd: WORKDIR,
      });
      answers.legacyAllow = await child.ask('execCommandApproval', {
        conversationId: threadId, callId: 'c1', command: ['bash', '-lc', 'echo hi'], cwd: WORKDIR,
      });
      answers.legacyDeny = await child.ask('execCommandApproval', {
        conversationId: threadId, callId: 'c2', command: ['rm', '-rf', 'forbidden'], cwd: WORKDIR,
      });
      child.send({
        method: 'item/started',
        params: {
          ...base,
          item: {
            type: 'fileChange',
            id: 'fc1',
            status: 'inProgress',
            changes: [
              { path: path.join(WORKDIR, 'new.txt'), kind: { type: 'add' }, diff: '+x' },
              { path: path.join(WORKDIR, 'old.txt'), kind: { type: 'update', move_path: path.join(WORKDIR, 'renamed.txt') }, diff: '-a\n+b' },
            ],
          },
        },
      });
      answers.patchAllow = await child.ask('item/fileChange/requestApproval', { ...base, itemId: 'fc1' });
      child.send({
        method: 'item/started',
        params: { ...base, item: { type: 'fileChange', id: 'fc2', status: 'inProgress', changes: [{ path: path.join(WORKDIR, 'forbidden.txt'), kind: { type: 'delete' }, diff: '' }] } },
      });
      answers.patchDeny = await child.ask('item/fileChange/requestApproval', { ...base, itemId: 'fc2' });
      answers.patchUnknown = await child.ask('item/fileChange/requestApproval', { ...base, itemId: 'never-seen' });
      answers.legacyPatch = await child.ask('applyPatchApproval', {
        conversationId: threadId, callId: 'p1', fileChanges: { [path.join(WORKDIR, 'legacy.txt')]: { type: 'add', content: 'x' } },
      });
      answers.network = await child.ask('item/commandExecution/requestApproval', {
        ...base, itemId: 'n1', command: 'curl https://example.invalid', cwd: WORKDIR,
        networkApprovalContext: { host: 'example.invalid', protocol: 'https' },
      });
    },
  });

  assert.deepEqual(answers.allowShell, { decision: 'accept' }, 'never acceptForSession / amendment');
  assert.deepEqual(answers.denyShell, { decision: 'decline' });
  assert.deepEqual(answers.legacyAllow, { decision: 'approved' });
  assert.deepEqual(answers.legacyDeny, { decision: 'denied' });
  assert.deepEqual(answers.patchAllow, { decision: 'accept' });
  assert.deepEqual(answers.patchDeny, { decision: 'decline' });
  assert.deepEqual(answers.patchUnknown, { decision: 'decline' }, 'a patch with no known target fails closed');
  assert.deepEqual(answers.legacyPatch, { decision: 'approved' });
  assert.deepEqual(answers.network, { decision: 'accept' });

  const bash = gateCalls.filter((call) => call.toolName === 'Bash').map((call) => call.input.command);
  assert.deepEqual(bash, ['ls -la', 'cat forbidden.txt', 'echo hi', 'rm -rf forbidden'], 'the shell wrapper is unwrapped');
  const writes = gateCalls.filter((call) => call.toolName === 'Write' || call.toolName === 'Edit');
  assert.deepEqual(
    writes.map((call) => [call.toolName, path.basename(call.input.file_path)]),
    [
      ['Write', 'new.txt'], ['Edit', 'old.txt'], ['Write', 'renamed.txt'],
      ['Edit', 'forbidden.txt'],
      ['Write', 'legacy.txt'],
    ],
  );
  assert.deepEqual(
    gateCalls.filter((call) => call.toolName === 'WebFetch').map((call) => call.input.url),
    ['https://example.invalid'],
  );
});

test('approvals: a throwing gate declines; capability grants and unknown requests are never auto-approved', async () => {
  const { options } = strictOptions({
    builtinToolGate: async () => {
      throw new Error('gate exploded');
    },
  });
  const answers = {};
  await withFakeCodex(async () => {
    await queryCodex('go', options, createWriter());
  }, {
    script: async (child, threadId) => {
      const base = { threadId, turnId: 't1' };
      answers.throwing = await child.ask('item/commandExecution/requestApproval', { ...base, itemId: 'i1', command: 'ls', cwd: WORKDIR });
      answers.permissions = await child.ask('item/permissions/requestApproval', {
        ...base, itemId: 'p1', cwd: WORKDIR, permissions: { fileSystem: { write: ['/etc'] } },
      });
      answers.elicitation = await child.ask('mcpServer/elicitation/request', { ...base, serverName: 'x' });
      answers.dynamic = await child.ask('item/tool/call', { ...base, tool: 'anything', arguments: {}, callId: 'd1' });
    },
  });
  assert.deepEqual(answers.throwing, { decision: 'decline' });
  assert.deepEqual(answers.permissions, { permissions: {}, scope: 'turn', strictAutoReview: false }, 'no broader sandbox permissions');
  assert.deepEqual(answers.elicitation, { action: 'decline' });
  assert.equal(answers.dynamic.success, false);
});

test('strict run without a gate still never auto-approves (unattended approval times out into a decline)', async () => {
  const { options } = strictOptions({ builtinToolGate: undefined, approvalTimeoutMs: 40 });
  let answer;
  await withFakeCodex(async () => {
    await queryCodex('go', options, createWriter());
  }, {
    script: async (child, threadId) => {
      answer = await child.ask('item/commandExecution/requestApproval', {
        threadId, turnId: 't1', itemId: 'i1', command: 'ls', cwd: WORKDIR,
      });
    },
  });
  assert.deepEqual(answer, { decision: 'decline' });
});

test('strict run fails closed when the gateway spec, session or binding secret is missing', async () => {
  for (const [label, extra] of [
    ['launch spec', { codexGatewayMcp: undefined }],
    ['binding secret', { botGatewaySecret: undefined }],
    ['session id', { appSessionId: undefined }],
  ]) {
    const { options } = strictOptions(extra);
    await withFakeCodex(async (spawned) => {
      const writer = createWriter();
      await queryCodex('go', options, writer);
      assert.equal(spawned.length, 0, `${label}: nothing is spawned`);
      assert.equal(writer.count('error'), 1, label);
    });
  }
  assert.equal(fs.existsSync(HOMES_ROOT) ? fs.readdirSync(HOMES_ROOT).length : 0, 0, 'no managed homes are leaked');
});

test('flag off (no botGatewayStrict): the existing Codex launch is unchanged', async () => {
  await withFakeCodex(async (spawned) => {
    await queryCodex('go', {
      cwd: WORKDIR, appSessionId: 'app-session-plain', permissionMode: 'default',
      // These must be inert without the strict flag.
      codexGatewayMcp: GATEWAY, botGatewaySecret: 'binding-secret-abc', builtinToolGate: async () => ({ behavior: 'allow' }),
    }, createWriter());
    const child = spawned[0];
    const overrides = configOverrides(child);
    assert.deepEqual(overrides, [], 'no per-run config');
    assert.equal(child.spawnEnv.CODEX_HOME, REAL_CODEX_HOME, 'the operator CODEX_HOME is used as-is');
    assert.equal(child.spawnEnv.CLOUDCLI_BOT_GATEWAY_BINDING_SECRET, undefined);
    assert.equal(child.spawnEnv.CLOUDCLI_SESSION_ID, 'app-session-plain');
    const thread = child.requests.find((r) => r.method === 'thread/start').params;
    assert.equal(thread.sandbox, 'workspace-write');
    assert.equal(thread.permissions, undefined);
    assert.equal(thread.approvalPolicy, 'untrusted');
    assert.equal(child.home, null);
  });
});

// ---------------------------------------------------------------------------

test('flattenConfigOverrides keeps quoted path keys inside one inline table (codex splits dotted keys on every dot)', () => {
  const flat = flattenConfigOverrides({
    permissions: { p: { extends: ':workspace', filesystem: { '/Users/x/.codex': 'deny', '/tmp/a b': 'write' } } },
    plain: { nested: { key: 1 } },
    list: ['a', 'b'],
  });
  assert.deepEqual(flat, [
    'permissions.p.extends=":workspace"',
    'permissions.p.filesystem={"/Users/x/.codex" = "deny", "/tmp/a b" = "write"}',
    'plain.nested.key=1',
    'list=["a", "b"]',
  ]);
});
