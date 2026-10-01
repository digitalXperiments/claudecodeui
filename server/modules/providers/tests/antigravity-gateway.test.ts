import assert from 'node:assert/strict';
import fs from 'node:fs';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';

import { makeScratchDir } from '@/shared/scratch.js';
import {
  ANTIGRAVITY_GATEWAY_MCP_NAME,
  antigravityGatewayPolicy,
  createAntigravityGatewayGuard,
  isAntigravityGatewayStrict,
  isToolApprovalRequest,
  mapAntigravityPermissionToGateCall,
  prepareAntigravityStrictHome,
  selectGatewayOnlyServers,
  type AntigravityGateFn,
} from '@/modules/providers/list/antigravity/antigravity-gateway.js';

const OPTIONS = [
  { optionId: 'allow_always', name: 'Allow Always', kind: 'allow_always' },
  { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
  { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
];

const request = (toolCall: Record<string, unknown>, options: unknown[] = OPTIONS) => ({ sessionId: 's', options, toolCall });

const ALLOW = { outcome: { outcome: 'selected', optionId: 'allow' } };
const DENY = { outcome: { outcome: 'selected', optionId: 'deny' } };
const CANCEL = { outcome: { outcome: 'cancelled' } };

function recordingGate(verdicts: Record<string, 'allow' | 'deny'> = {}) {
  const calls: Array<{ toolName: string; input: unknown }> = [];
  const gate: AntigravityGateFn = async (toolName, input) => {
    calls.push({ toolName, input });
    return verdicts[toolName] === 'deny' ? { behavior: 'deny', message: `no ${toolName}` } : { behavior: 'allow' };
  };
  return { gate, calls };
}

describe('mapAntigravityPermissionToGateCall', () => {
  it('maps the shell tool (title is the command line) to Bash {command}', () => {
    const mapped = mapAntigravityPermissionToGateCall(request({
      toolCallId: 'c1', title: 'ls -la', kind: 'execute', rawInput: { CommandLine: 'ls -la /tmp' },
    }));
    assert.deepEqual(mapped, { kind: 'gate', toolName: 'Bash', input: { command: 'ls -la /tmp' } });
  });

  it('falls back to the title, and reads rawInput that arrives as a JSON string', () => {
    assert.deepEqual(
      mapAntigravityPermissionToGateCall(request({ title: 'git status', kind: 'execute' })),
      { kind: 'gate', toolName: 'Bash', input: { command: 'git status' } },
    );
    assert.deepEqual(
      mapAntigravityPermissionToGateCall(request({ title: 'x', kind: 'execute', rawInput: '{"command_line":"echo hi"}' })),
      { kind: 'gate', toolName: 'Bash', input: { command: 'echo hi' } },
    );
  });

  it('maps file creation and edits to Write / Edit with the path from locations or the args', () => {
    const create = mapAntigravityPermissionToGateCall(request({
      title: 'Run client_create_file?', kind: 'edit', locations: [{ path: '/work/a.txt' }], rawInput: { target_file: '/ignored' },
    }));
    assert.deepEqual(create, { kind: 'gate', toolName: 'Write', input: { file_path: '/work/a.txt' }, writePath: '/work/a.txt' });
    const edit = mapAntigravityPermissionToGateCall(request({
      title: 'Run client_edit_file?', kind: 'edit', rawInput: { TargetFile: '/work/b.txt', code_content: 'x' },
    }));
    assert.deepEqual(edit, { kind: 'gate', toolName: 'Edit', input: { file_path: '/work/b.txt' }, writePath: '/work/b.txt' });
  });

  it('denies an edit or fetch whose target cannot be determined instead of guessing', () => {
    assert.equal(mapAntigravityPermissionToGateCall(request({ title: 'Run edit_file?', kind: 'edit', rawInput: {} })).kind, 'deny');
    assert.equal(mapAntigravityPermissionToGateCall(request({ title: 'Run read_url_content?', kind: 'fetch', rawInput: {} })).kind, 'deny');
    assert.equal(mapAntigravityPermissionToGateCall(request({ title: '', kind: 'execute' })).kind, 'deny');
  });

  it('maps web fetch and search', () => {
    assert.deepEqual(
      mapAntigravityPermissionToGateCall(request({ title: 'Run read_url_content?', kind: 'fetch', rawInput: { Url: 'https://example.com/a' } })),
      { kind: 'gate', toolName: 'WebFetch', input: { url: 'https://example.com/a' } },
    );
    assert.deepEqual(
      mapAntigravityPermissionToGateCall(request({ title: 'Run search_web?', kind: 'search', rawInput: { query: 'cats' } })),
      { kind: 'gate', toolName: 'WebSearch', input: { query: 'cats' } },
    );
  });

  it('maps MCP calls to mcp__server__tool, tolerating the - / _ spelling of the gateway name', () => {
    const gateway = mapAntigravityPermissionToGateCall(request({
      title: 'cloudcli-tool-gateway_bot__remember', kind: 'other',
      rawInput: { arguments: { text: 'hi' } }, _meta: { mcp: { server: 'cloudcli_tool_gateway', tool: 'bot__remember' }, is_mcp_tool_call: true },
    }));
    assert.deepEqual(gateway, { kind: 'gate', toolName: 'mcp__cloudcli-tool-gateway__bot__remember', input: { text: 'hi' } });
    const other = mapAntigravityPermissionToGateCall(request({
      title: 'obsidian_put', kind: 'other', _meta: { mcp: { server: 'obsidian', tool: 'put' } },
    }));
    assert.deepEqual(other, { kind: 'gate', toolName: 'mcp__obsidian__put', input: {} });
  });

  it('passes unclassified tools through under their own name', () => {
    assert.deepEqual(
      mapAntigravityPermissionToGateCall(request({ title: 'Run generate_image?', kind: 'other', rawInput: { prompt: 'a cat' } })),
      { kind: 'gate', toolName: 'generate_image', input: { prompt: 'a cat' } },
    );
  });

  it('cancels interaction prompts (workspace trust, ask_question): no kind and no allow/deny ids', () => {
    const trust = request(
      { toolCallId: 'interaction_1', title: 'Do you trust the authors of this workspace to execute automated agent hooks?' },
      [{ optionId: 'trust', name: 'Trust Workspace', kind: 'allow_once' }, { optionId: 'deny', name: "Don't Trust", kind: 'reject_once' }],
    );
    assert.equal(isToolApprovalRequest(trust), false);
    assert.equal(mapAntigravityPermissionToGateCall(trust).kind, 'cancel');
    assert.equal(isToolApprovalRequest(request({ title: 'ls', kind: 'execute' })), true);
  });
});

describe('createAntigravityGatewayGuard', () => {
  it('answers allow_once when the gate allows and never selects an always option', async () => {
    const { gate, calls } = recordingGate();
    const guard = createAntigravityGatewayGuard({ gate, workingDir: '/work' });
    const response = await guard.respondToPermission(request({ title: 'ls', kind: 'execute', rawInput: { CommandLine: 'ls' } }));
    assert.deepEqual(response, ALLOW);
    assert.deepEqual(calls, [{ toolName: 'Bash', input: { command: 'ls' } }]);
  });

  it('rejects when the gate denies, and when the gate throws', async () => {
    const denying = createAntigravityGatewayGuard({ gate: recordingGate({ Bash: 'deny' }).gate, workingDir: '/work' });
    assert.deepEqual(await denying.respondToPermission(request({ title: 'rm -rf /', kind: 'execute' })), DENY);
    const throwing = createAntigravityGatewayGuard({
      gate: async () => { throw new Error('boom'); },
      workingDir: '/work',
    });
    assert.deepEqual(await throwing.respondToPermission(request({ title: 'ls', kind: 'execute' })), DENY);
  });

  it('cancels when the request offers no reject option to select', async () => {
    const guard = createAntigravityGatewayGuard({ gate: recordingGate({ Bash: 'deny' }).gate, workingDir: '/work' });
    const onlyAllow = request({ title: 'ls', kind: 'execute' }, [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }]);
    // Not a tool-approval request (no reject option), so it is cancelled before the gate is consulted.
    assert.deepEqual(await guard.respondToPermission(onlyAllow), CANCEL);
  });

  it('cancels interaction prompts without consulting the gate', async () => {
    const { gate, calls } = recordingGate();
    const guard = createAntigravityGatewayGuard({ gate, workingDir: '/work' });
    const trust = request({ title: 'Trust this workspace?' }, [{ optionId: 'trust', kind: 'allow_once' }, { optionId: 'deny', kind: 'reject_once' }]);
    assert.deepEqual(await guard.respondToPermission(trust), CANCEL);
    assert.equal(calls.length, 0);
  });

  it('lets gateway MCP tools through (the gateway governs them) and denies other MCP servers via the gate', async () => {
    const real: AntigravityGateFn = async (toolName) => (toolName.startsWith('mcp__cloudcli-tool-gateway__')
      ? { behavior: 'allow' }
      : { behavior: 'deny', message: 'MCP tools must go through the tool gateway' });
    const guard = createAntigravityGatewayGuard({ gate: real, workingDir: '/work' });
    const gateway = request({ title: 'x', kind: 'other', _meta: { mcp: { server: 'cloudcli-tool-gateway', tool: 'bot__ping' } } });
    const other = request({ title: 'x', kind: 'other', _meta: { mcp: { server: 'obsidian', tool: 'put' } } });
    assert.deepEqual(await guard.respondToPermission(gateway), ALLOW);
    assert.deepEqual(await guard.respondToPermission(other), DENY);
    // Even with no built-in gate installed the gateway's own tools stay usable and everything else is denied.
    const noGate = createAntigravityGatewayGuard({ gate: null, workingDir: '/work' });
    assert.deepEqual(await noGate.respondToPermission(gateway), ALLOW);
    assert.deepEqual(await noGate.respondToPermission(request({ title: 'ls', kind: 'execute' })), DENY);
  });

  it('routes client file reads through the gate and passes an already-approved write exactly once', async () => {
    const { gate, calls } = recordingGate({ Read: 'deny' });
    const guard = createAntigravityGatewayGuard({ gate, workingDir: '/work' });
    assert.deepEqual(await guard.guardFs('fs/read_text_file', '/etc/passwd'), { allow: false, reason: 'no Read' });

    await guard.respondToPermission(request({ title: 'Run client_edit_file?', kind: 'edit', rawInput: { target_file: 'notes/a.txt' } }));
    const before = calls.length;
    assert.deepEqual(await guard.guardFs('fs/write_text_file', '/work/notes/a.txt'), { allow: true });
    assert.equal(calls.length, before, 'the approved write is not asked about twice');
    await guard.guardFs('fs/write_text_file', '/work/notes/a.txt');
    assert.deepEqual(calls.at(-1), { toolName: 'Write', input: { file_path: '/work/notes/a.txt' } }, 'a second write needs its own decision');
  });

  it('refuses an fs write that no permission step approved when the gate denies it', async () => {
    const guard = createAntigravityGatewayGuard({ gate: recordingGate({ Write: 'deny' }).gate, workingDir: '/work' });
    assert.deepEqual(await guard.guardFs('fs/write_text_file', '/work/x'), { allow: false, reason: 'no Write' });
  });
});

describe('selectGatewayOnlyServers', () => {
  const gateway = {
    name: ANTIGRAVITY_GATEWAY_MCP_NAME,
    transport: 'stdio',
    command: '/usr/bin/node',
    args: ['gateway.js'],
    env: { CLOUDCLI_BOT_GATEWAY_API_URL: 'http://127.0.0.1:3001/api/bot-gateway-mcp', CLOUDCLI_BOT_GATEWAY_MCP_TOKEN: 'tok' },
  };

  it('keeps only the gateway and stamps session id, lead id and the binding secret', () => {
    const selected = selectGatewayOnlyServers(
      [{ name: 'obsidian', transport: 'stdio', command: 'npx' }, gateway],
      { appSessionId: 'app-1', bindingSecret: 'sekret' },
    );
    assert.equal(selected.length, 1);
    assert.equal(selected[0].name, ANTIGRAVITY_GATEWAY_MCP_NAME);
    assert.deepEqual(selected[0].env, {
      CLOUDCLI_BOT_GATEWAY_API_URL: 'http://127.0.0.1:3001/api/bot-gateway-mcp',
      CLOUDCLI_BOT_GATEWAY_MCP_TOKEN: 'tok',
      CLOUDCLI_SESSION_ID: 'app-1',
      CLOUDCLI_LEAD_SESSION_ID: 'app-1',
      CLOUDCLI_BOT_GATEWAY_BINDING_SECRET: 'sekret',
    });
    assert.equal((gateway.env as Record<string, string>).CLOUDCLI_SESSION_ID, undefined, 'the catalog entry is not mutated');
  });

  it('fails closed without the gateway binding, a session id, or the secret', () => {
    assert.throws(() => selectGatewayOnlyServers([], { appSessionId: 'a', bindingSecret: 's' }), /required work-session MCP/);
    assert.throws(() => selectGatewayOnlyServers([gateway], { appSessionId: '', bindingSecret: 's' }), /appSessionId/);
    assert.throws(() => selectGatewayOnlyServers([gateway], { appSessionId: 'a', bindingSecret: '' }), /binding secret/);
    assert.throws(
      () => selectGatewayOnlyServers([{ name: ANTIGRAVITY_GATEWAY_MCP_NAME, transport: 'http', url: 'https://x' }], { appSessionId: 'a', bindingSecret: 's' }),
      /stdio/,
    );
  });
});

describe('policy and flags', () => {
  it('always asks and never auto-approves', () => {
    assert.deepEqual(antigravityGatewayPolicy(), { mode: 'default', autoApprove: false, env: {} });
    assert.equal(isAntigravityGatewayStrict({ botGatewayStrict: true }), true);
    assert.equal(isAntigravityGatewayStrict({ strictMcpSelection: true }), false);
    assert.equal(isAntigravityGatewayStrict(undefined), false);
  });
});

describe('prepareAntigravityStrictHome', () => {
  it('builds a relocated home with empty config, no trust file and symlinked credentials', async () => {
    const root = await makeScratchDir('agy-strict-home-');
    try {
      const env = { CLOUDCLI_ANTIGRAVITY_DIR: root } as NodeJS.ProcessEnv;
      const profileAcp = path.join(root, 'profile', 'antigravity-acp');
      fs.mkdirSync(path.join(profileAcp, 'conversations'), { recursive: true });
      fs.writeFileSync(path.join(profileAcp, 'acp_token.json'), '{"refresh_token":"secret"}');
      fs.writeFileSync(path.join(profileAcp, 'trusted_workspaces.json'), '{"trusted":["/work"],"untrusted":[]}');
      fs.mkdirSync(path.join(root, 'profile', 'config'), { recursive: true });
      fs.writeFileSync(path.join(root, 'profile', 'config', 'mcp_config.json'), '{"mcpServers":{"mine":{"command":"x"}}}');

      const first = prepareAntigravityStrictHome('app-session-1', env);
      assert.equal(first.env.GEMINI_HOME, first.home);
      assert.equal(first.env.AGY_ACP_DISABLE_WORKSPACE_TRUST, '0');
      assert.equal(path.dirname(first.home), path.join(root, 'profile', 'runs'));

      // No global MCP/hooks config and no workspace trust carried over.
      assert.deepEqual(fs.readdirSync(path.join(first.home, 'config')), []);
      assert.equal(fs.existsSync(path.join(first.home, 'antigravity-acp', 'trusted_workspaces.json')), false);
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(first.home, 'antigravity-acp', 'settings.json'), 'utf8')), { auth: { type: 'oauth-personal' } });

      // Credentials and history are symlinks into the shared profile (readable by the server, not by the agent's file tools).
      const token = path.join(first.home, 'antigravity-acp', 'acp_token.json');
      assert.equal(fs.lstatSync(token).isSymbolicLink(), true);
      assert.equal(fs.readFileSync(token, 'utf8'), '{"refresh_token":"secret"}');
      assert.equal(fs.realpathSync(token).startsWith(fs.realpathSync(first.home)), false, 'resolves outside the run home');
      assert.equal(fs.lstatSync(path.join(first.home, 'antigravity-acp', 'conversations')).isSymbolicLink(), true);
      assert.equal(fs.lstatSync(path.join(first.home, 'antigravity-acp', 'brain')).isSymbolicLink(), true, 'brain is created in the profile and linked');

      // Same key -> same home, idempotent; a different key -> a different home; leftovers are scrubbed.
      fs.writeFileSync(path.join(first.home, 'antigravity-acp', 'trusted_workspaces.json'), '{"trusted":["/work"]}');
      fs.writeFileSync(path.join(first.home, 'config', 'hooks.json'), '{}');
      const again = prepareAntigravityStrictHome('app-session-1', env);
      assert.equal(again.home, first.home);
      assert.equal(fs.existsSync(path.join(again.home, 'antigravity-acp', 'trusted_workspaces.json')), false);
      assert.deepEqual(fs.readdirSync(path.join(again.home, 'config')), []);
      assert.notEqual(prepareAntigravityStrictHome('app-session-2', env).home, first.home);
      assert.throws(() => prepareAntigravityStrictHome('  ', env), /run key/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('prunes run homes older than a day without touching the profile they link to', async () => {
    const root = await makeScratchDir('agy-strict-prune-');
    try {
      const env = { CLOUDCLI_ANTIGRAVITY_DIR: root } as NodeJS.ProcessEnv;
      const profileAcp = path.join(root, 'profile', 'antigravity-acp');
      fs.mkdirSync(profileAcp, { recursive: true });
      fs.writeFileSync(path.join(profileAcp, 'acp_token.json'), 'tok');
      const old = prepareAntigravityStrictHome('old-run', env);
      const longAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
      fs.utimesSync(old.home, longAgo, longAgo);
      const fresh = prepareAntigravityStrictHome('fresh-run', env);
      assert.equal(fs.existsSync(old.home), false);
      assert.equal(fs.existsSync(fresh.home), true);
      assert.equal(fs.readFileSync(path.join(profileAcp, 'acp_token.json'), 'utf8'), 'tok', 'the shared token survives the prune');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
