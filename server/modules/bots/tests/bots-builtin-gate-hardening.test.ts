import assert from 'node:assert/strict';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { classifyPermissionRequest } from '@/modules/permissions/index.js';
import {
  builtinDenylistReason,
  builtinEscalationReason,
  createBuiltinToolGate,
  protectedSegmentsReason,
  setAutoReviewer,
  setGateHumanPollInterval,
} from '@/modules/bots/gate/index.js';
import { botGateDecisionsDb } from '@/modules/bots/index.js';
import { closeConnection, initializeDatabase } from '@/modules/database/index.js';
import { interruptsService } from '@/modules/interrupt-queue/index.js';
import { missionControlDb } from '@/modules/mission-control/index.js';
import { makeScratchDir } from '@/shared/scratch.js';

const home = os.homedir();
const botHome = path.join(home, '.cloudcli', 'bots', 'b1', 'home');
const scratchRoot = await makeScratchDir('bots-gate-hardening-');
const workspace = path.join(scratchRoot, 'project');
mkdirSync(path.join(workspace, 'src'), { recursive: true });
const scope = { workspaceRoot: workspace, botHome };

const bash = (command: string, cwd?: string) => ({ command, ...(cwd ? { cwd } : {}) });

function verdictOf(tool: string, input: Record<string, unknown>): 'deny' | 'escalate' | 'pass' {
  if (builtinDenylistReason(tool, input, scope)) return 'deny';
  if (builtinEscalationReason(tool, input, scope)) return 'escalate';
  return 'pass';
}

test.after(async () => {
  await rm(scratchRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Items 1+2: the reported attack commands

test('reported attacks: shell reads of copied / symlinked logins are hard-denied', () => {
  const attacks: Array<[string, string | undefined]> = [
    ['cat "$GROK_HOME/auth.json"', undefined],
    ['cd ~ && cat .cloudcli/grok-strict-runs/run-x/auth.json', undefined],
    ['cat ../../grok-strict-runs/run-x/auth.json', undefined],
    ['cat ../../grok-strict-runs/run-x/auth.json', botHome],
    ['cat "$GEMINI_HOME/antigravity-acp/acp_token.json"', undefined],
  ];
  for (const [command, cwd] of attacks) {
    assert.equal(verdictOf('Bash', bash(command, cwd)), 'deny', `${command} must be denied`);
  }
});

test('hard deny: protected names in every spelling (bare, relative, quoted, after cd, obfuscated)', () => {
  const denied = [
    // path segments, any form
    'cat .cloudcli/auth.db', 'ls .grok', 'ls .codex/', 'cat .gemini/oauth_creds.json', 'cat .claude/settings.json',
    'cat .claude.json', 'ls .cursor', 'cat .docker/config.json', 'cat .ssh/id_rsa', 'ls .aws', 'ls .azure', 'ls .kube',
    'ls .gnupg', 'cat .netrc', 'cat .git-credentials', 'cat .zsh_history', 'cat .bash_history',
    'ls Library/Keychains', 'ls "Library/Application Support"', 'ls Library/Application\\ Support/Google',
    // absolute and tilde
    `cat ${home}/.grok/auth.json`, 'cat ~/.codex/auth.json', 'cat ~/.gemini/antigravity-acp/acp_token.json',
    'ls ~/.ssh', 'cat ~/.aws/credentials', 'ls ~/Library/Keychains', 'ls ~/Library/Application\\ Support',
    // after cd, quoted, nested in a shell payload, other tools
    'cd ~/.grok && cat auth.json', 'cd "$PWD/.ssh"', 'cat "~/.grok/auth.json"', "cat '.codex/auth.json'",
    'sh -c "cat .grok/auth.json"', 'bash -lc "cat ~/.codex/auth.json"', 'eval "cat .ssh/id_rsa"',
    'python3 -c "open(\'.grok/auth.json\').read()"', 'node -e "require(\'fs\').readFileSync(\'.codex/auth.json\')"',
    // credential filenames anywhere
    'cat auth.json', 'cat sub/acp_token.json', 'cat ./oauth_creds.json', 'cat credentials.json', 'cat mcp_credentials.json',
    'cat server.pem', 'cat keys/id_rsa', 'cat keys/id_rsa.pub', 'cat id_ed25519', 'cat id_ed25519_work', 'cp x /tmp/cert.pem',
    // obfuscation: quote splicing, backslash, case, globbing, braces
    'cat .gr""ok/auth.json', "cat .gr''ok/x", 'cat .gr\\ok/x', 'cat .GROK/x', 'cat .Ssh/id_rsa', 'cat ~/.gr*k/auth.json',
    'cat ./a/../.codex/x', 'cat ~/{.grok,.codex}/auth.json', 'cat au""th.json',
    // env var references
    'echo $HOME', 'echo ${HOME}', 'cat $HOME/x', 'ls "$HOME"', 'echo $GROK_HOME', 'echo ${GROK_HOME}', 'echo $CODEX_HOME',
    'echo $GEMINI_HOME', 'echo $CLOUDCLI_API_TOKEN', 'echo ${CLOUDCLI_BOT_GATEWAY_BINDING_SECRET}', 'echo $XDG_CONFIG_HOME',
    'echo $XDG_DATA_HOME/x', 'echo ${!HOME}', 'echo "$(echo $HOME)"', 'echo `echo $GROK_HOME`', 'x=$(printenv HOME)',
    "sh -c 'cat $HOME/x'", 'cat <<EOF\n$HOME\nEOF',
    'cat <<EOF\n$(cat ~/.ssh/id_rsa)\nEOF',
  ];
  for (const command of denied) {
    assert.equal(verdictOf('Bash', bash(command)), 'deny', `${JSON.stringify(command)} must be hard-denied`);
  }
});

test('hard deny: process listings that print another process\'s environment', () => {
  for (const command of ['ps eww 1234', 'ps auxe', 'ps axeww', 'ps -p 1 eww', 'ps -E', 'ps -p 1 -E', 'ps e | head', 'echo x; ps eww $PPID']) {
    assert.equal(verdictOf('Bash', bash(command)), 'deny', `${command} must be denied`);
  }
  for (const command of ['ps -ef | grep node', 'ps aux | grep node', 'ps -p 123 -o comm', 'ps -o pid,etime']) {
    assert.notEqual(verdictOf('Bash', bash(command)), 'deny', `${command} is an ordinary listing`);
  }
});

test('hard deny: file tools on protected names, anywhere, any tool', () => {
  const denied: Array<[string, Record<string, unknown>]> = [
    ['Read', { file_path: path.join(home, '.grok', 'auth.json') }],
    ['Read', { file_path: '~/.codex/auth.json' }],
    ['Read', { file_path: '~/.gemini/antigravity-acp/acp_token.json' }],
    ['view_file', { file_path: path.join(home, '.docker', 'config.json') }],
    ['Read', { file_path: path.join(home, 'Library', 'Application Support', 'x') }],
    ['Read', { file_path: path.join(home, 'Library', 'Keychains', 'login.keychain-db') }],
    ['Read', { file_path: path.join(home, '.zsh_history') }],
    ['Read', { file_path: path.join(workspace, 'auth.json') }],
    ['Read', { file_path: path.join(workspace, '.ssh', 'id_rsa') }],
    ['Read', { file_path: path.join(workspace, 'certs', 'server.pem') }],
    ['Read', { file_path: 'deploy/id_ed25519' }],
    ['Write', { file_path: path.join(workspace, '.claude', 'settings.json'), content: 'x' }],
    ['Edit', { file_path: path.join(home, '.cloudcli', 'grok-strict-runs', 'run-x', 'auth.json') }],
    ['Glob', { pattern: '**/.ssh/*' }],
    ['Glob', { pattern: '**/auth.json' }],
    ['Glob', { pattern: `${home}/.grok/*` }],
    ['Glob', { pattern: '~/.codex/**' }],
    ['Grep', { pattern: 'token', path: path.join(home, '.codex') }],
    ['Grep', { pattern: 'token', glob: '**/.aws/**' }],
    ['Grep', { pattern: 'x', glob: '*.pem' }],
    ['Read', { file_path: '$HOME/.grok/auth.json' }],
    ['Read', { file_path: '${GROK_HOME}/auth.json' }],
    ['WebFetch', { url: `file://${home}/.grok/auth.json`, prompt: 'x' }],
    ['Read', { file_path: path.join(botHome, '..', '..', 'auth.json') }],
  ];
  for (const [tool, input] of denied) {
    assert.equal(verdictOf(tool, input), 'deny', `${tool} ${JSON.stringify(input)} must be hard-denied`);
  }
});

test('hard deny: a workspace symlink into a protected store is judged by where it points', () => {
  const fakeHome = path.join(scratchRoot, 'fake-home');
  mkdirSync(path.join(fakeHome, '.grok'), { recursive: true });
  writeFileSync(path.join(fakeHome, '.grok', 'notes.txt'), 'x');
  symlinkSync(path.join(fakeHome, '.grok'), path.join(workspace, 'innocent'));
  assert.equal(verdictOf('Read', { file_path: path.join(workspace, 'innocent', 'notes.txt') }), 'deny');
  assert.equal(verdictOf('Bash', bash('cat innocent/notes.txt')), 'deny');
  // `link/..` goes where the shell goes, not to the lexical parent.
  symlinkSync(path.join(fakeHome, '.grok'), path.join(workspace, 'src', 'deep'));
  assert.notEqual(verdictOf('Bash', bash('cat src/deep/../x')), 'pass');
});

test('the bot home subtree is exempt from the name rules, and only that subtree', () => {
  assert.equal(verdictOf('Read', { file_path: path.join(botHome, 'notes.md') }), 'pass');
  assert.equal(verdictOf('Write', { file_path: path.join(botHome, 'skills', 'a.md'), content: 'x' }), 'pass');
  assert.equal(verdictOf('Read', { file_path: path.join(botHome, 'browser-profile', 'auth.json') }), 'pass');
  assert.equal(verdictOf('Bash', bash(`cat ${botHome}/notes.md`)), 'pass');
  assert.equal(verdictOf('Bash', bash(`ls ${botHome.replace(home, '~')}/skills`)), 'pass');
  assert.equal(verdictOf('Bash', bash('ls skills', botHome)), 'pass');
  assert.equal(verdictOf('Glob', { pattern: `${botHome}/**/*.md` }), 'pass');
  // Siblings and parents of the bot home are not the bot's own.
  assert.equal(verdictOf('Read', { file_path: path.join(home, '.cloudcli', 'bots', 'b2', 'home', 'notes.md') }), 'deny');
  assert.equal(verdictOf('Read', { file_path: path.join(home, '.cloudcli', 'bots', 'b1', 'x.md') }), 'deny');
  assert.equal(verdictOf('Bash', bash(`cat ${botHome}/../../b2/home/notes.md`)), 'deny');
  assert.equal(verdictOf('Bash', bash(`cat ${botHome}/sub/../../../../auth.db`)), 'deny');
  assert.equal(verdictOf('Bash', bash(`cat ${botHome}/x/../../../../.ssh/id_rsa`)), 'deny');
  assert.equal(verdictOf('Bash', bash(`cat ${botHome}/x/../../..`)), 'deny');
});

test('protectedSegmentsReason: the complete protected list, case-insensitive', () => {
  for (const name of [
    '.cloudcli', '.grok', '.codex', '.gemini', '.claude', '.claude.json', '.cursor', '.docker', '.ssh', '.aws', '.azure',
    '.kube', '.gnupg', '.netrc', '.git-credentials', '.zsh_history', '.bash_history', 'auth.json', 'acp_token.json',
    'oauth_creds.json', 'credentials.json', 'mcp_credentials.json', 'x.pem', 'id_rsa', 'id_rsa.pub', 'id_ed25519', 'id_ed25519.pub',
  ]) {
    assert.ok(protectedSegmentsReason(['a', name, 'b']), `${name} must be protected`);
    assert.ok(protectedSegmentsReason([name.toUpperCase()]), `${name} must be protected in upper case`);
  }
  assert.ok(protectedSegmentsReason(['Library', 'Keychains']));
  assert.ok(protectedSegmentsReason(['Library', 'Application Support']));
  for (const fine of ['src', 'README.md', 'my.codex.notes', 'claude.md', 'oauth.ts', 'credentials-helper.ts', 'authors.json', 'Library']) {
    assert.equal(protectedSegmentsReason([fine]), null, `${fine} is not protected`);
  }
});

// ---------------------------------------------------------------------------
// Escalation: never auto-approved when it cannot be proven local

test('escalate: absolute / tilde paths, "..", cd, other variables and substitutions are never auto-approved', () => {
  const escalated: Array<[string, string | undefined]> = [
    ['cat /etc/hosts', undefined], ['ls /', undefined], ['ls ~', undefined], ['ls ~/Documents', undefined],
    ['cat ~/notes.txt', undefined], ['cat ~root/x', undefined], ['ls /Users', undefined], ['grep -r token /var/log', undefined],
    ['cat ../notes.md', undefined], ['ls ../..', undefined], ['cat src/../../x', undefined], ['cat a/../../b', undefined],
    ['cd .. && ls', undefined], ['cd /etc && cat hosts', undefined], ['cd ~ && ls', undefined], ['cd /usr/local && ls', undefined],
    ['cd', undefined], ['cd -', undefined], ['cd $X', undefined], ['pushd /etc', undefined], ['popd', undefined],
    ['cd nonexistent-dir && cat ../x', undefined],
    ['echo $FOO', undefined], ['cat ${DIR}/x', undefined], ['ls "$PWD"', undefined], ['echo $PATH', undefined],
    ['echo $USER', undefined], ['cat $(echo x)', undefined], ['cat `echo x`', undefined], ["echo $'\\x2e'grok", undefined],
    ['diff <(ls) <(ls src)', undefined], ['cat $(printf "/etc/pas%s" swd)', undefined],
    ['cat ../*', undefined], ['cat src/../../*', undefined],
    ['cat src/*/../../..', undefined],
    ['curl -o /Users/x/out https://example.com', undefined], ['git -C ../other status', undefined], ['ls --color=/etc', undefined],
    ['ls -I/etc', undefined], ['FOO=/etc/passwd cat $FOO', undefined],
    ['ls', '/etc'], ['ls', home], ['cat x', path.dirname(workspace)],
    // a `<<` inside quotes would make the classifier skip the next line
    ['echo "<<EOF"\ncat src/a.ts', undefined],
  ];
  for (const [command, cwd] of escalated) {
    assert.equal(verdictOf('Bash', bash(command, cwd)), 'escalate', `${JSON.stringify(command)} (cwd ${cwd}) must escalate, not pass`);
  }
  // `~/*` is expanded against the real home folder: a hard deny when a match is a database / credential file
  // (a developer's home often holds one), a question otherwise. Never allowed.
  assert.notEqual(verdictOf('Bash', bash('cat ~/*')), 'pass');
  assert.notEqual(verdictOf('Bash', bash('cat /etc/*')), 'pass'); // /etc/aliases.db on macOS
});

test('escalate: reads outside the workspace, bot home and temp (Read, view_file, Glob, Grep)', () => {
  const outside: Array<[string, Record<string, unknown>]> = [
    ['Read', { file_path: '/etc/hosts' }],
    ['Read', { file_path: path.join(home, 'Documents', 'plan.md') }],
    ['Read', { file_path: '~/notes.md' }],
    ['Read', { file_path: '../secret-notes.md' }],
    ['view_file', { file_path: '/Users/someone/else.txt' }],
    ['Glob', { pattern: '/etc/*' }],
    ['Glob', { pattern: '../**/*.md' }],
    ['Glob', { pattern: 'src/**/../../*' }],
    ['Glob', { pattern: '*', path: '/var' }],
    ['Grep', { pattern: 'x', path: path.join(home, 'Documents') }],
    ['Grep', { pattern: 'x', glob: '../*.md' }],
    ['Read', { file_path: '$SOMEWHERE/x' }],
    ['Read', { file_path: '~someone/x' }],
    ['WebFetch', { url: 'file:///etc/hosts', prompt: 'x' }],
  ];
  for (const [tool, input] of outside) {
    assert.equal(verdictOf(tool, input), 'escalate', `${tool} ${JSON.stringify(input)} must escalate`);
  }
});

test('pass: ordinary work inside the workspace, bot home and temp is not made noisy', () => {
  const tmp = path.join(os.tmpdir(), 'cloudcli-scratch-file.txt');
  const passes: Array<[string, Record<string, unknown>]> = [
    ['Bash', bash('git status')], ['Bash', bash('git diff --stat')], ['Bash', bash('npm test')], ['Bash', bash('ls -la')],
    ['Bash', bash('ls src')], ['Bash', bash('cat package.json | head -5')], ['Bash', bash('rg -n foo src --glob "*.ts"')],
    ['Bash', bash('grep -rn "TODO" src/*.ts')], ['Bash', bash('node --version')], ['Bash', bash('cat ./src/../package.json')],
    ['Bash', bash('mkdir -p out && cd out && ls')], ['Bash', bash(`cat ${workspace}/src/a.ts`)],
    ['Bash', bash('curl -s https://example.com/api -o /dev/null')], ['Bash', bash('echo done > /dev/null 2>&1')],
    ['Bash', bash(`cat ${tmp}`)], ['Bash', bash('cat /tmp/x.log')], ['Bash', bash('/bin/ls src')], ['Bash', bash('/usr/bin/git status')],
    ['Bash', bash('echo "price is 5$"')], ['Bash', bash("awk '{print $1}' src/a.ts")], ['Bash', bash('echo $?')],
    ['Bash', bash('git commit -m "fix: typo"')], ['Bash', bash('echo $(pwd)')], ['Bash', bash('echo `date +%F`')],
    ['Bash', bash('git commit -m "$(cat <<\'EOF\'\nfix: don\'t crash on empty input\n\nBody line (with parens).\nEOF\n)"')],
    ['Bash', bash('cat > src/new.ts <<\'EOF\'\nconst docs = "see .claude and ~/.ssh in the README";\nEOF')],
    ['Bash', bash('cd src && ls ..')],
    ['Read', { file_path: path.join(workspace, 'src', 'a.ts') }], ['Read', { file_path: 'src/a.ts' }], ['Read', { file_path: tmp }],
    ['Read', { file_path: path.join(botHome, 'notes.md') }], ['Glob', { pattern: 'src/**/*.ts' }],
    ['Glob', { pattern: '**/*.md', path: workspace }], ['Grep', { pattern: 'auth.json handling', path: 'src' }],
    ['Grep', { pattern: 'TODO', glob: '*.ts' }], ['Write', { file_path: path.join(workspace, 'src', 'x.ts'), content: 'x' }],
  ];
  for (const [tool, input] of passes) {
    assert.equal(verdictOf(tool, input), 'pass', `${tool} ${JSON.stringify(input)} should pass the strict checks`);
  }
});

// ---------------------------------------------------------------------------
// The gate itself: classifier approve is no longer the last word

async function withGate(
  run: (env: { botId: string; gate: ReturnType<typeof createBuiltinToolGate>; setTainted: (value: boolean) => void }) => Promise<void>,
): Promise<void> {
  const previousDb = process.env.DATABASE_PATH;
  const dir = await makeScratchDir('bots-gate-hardening-db-');
  closeConnection();
  process.env.DATABASE_PATH = path.join(dir, 'auth.db');
  await initializeDatabase();
  interruptsService.configureBotGateResolver(null);
  setAutoReviewer(async () => {
    throw new Error('real reviewer must not run in tests');
  });
  try {
    const bot = missionControlDb.createSection({ title: 'Hardening bot', produce_prompt: 'Go' });
    let tainted = false;
    const gate = createBuiltinToolGate({
      botId: bot.section_id,
      workspaceRoot: workspace,
      botHome,
      tainted: () => tainted,
      approvalTimeoutMs: 40,
    });
    await run({ botId: bot.section_id, gate, setTainted: (value) => { tainted = value; } });
  } finally {
    setAutoReviewer(null);
    setGateHumanPollInterval(null);
    interruptsService.configureBotGateResolver(null);
    closeConnection();
    if (previousDb === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDb;
    await rm(dir, { recursive: true, force: true });
  }
}

test('gate: the exact reported attacks are never allowed (denied outright, no approval row asked)', async () => {
  await withGate(async ({ botId, gate }) => {
    for (const command of [
      'cat "$GROK_HOME/auth.json"',
      'cd ~ && cat .cloudcli/grok-strict-runs/run-x/auth.json',
      'cat ../../grok-strict-runs/run-x/auth.json',
      'cat "$GEMINI_HOME/antigravity-acp/acp_token.json"',
    ]) {
      const decision = await gate('Bash', { command });
      assert.equal(decision.behavior, 'deny', command);
    }
    const rows = botGateDecisionsDb.listForBot(botId).filter((row) => row.server === 'builtin');
    assert.equal(rows.length, 4);
    for (const row of rows) assert.deepEqual([row.decision, row.decided_by, row.outcome], ['deny', 'denylist', 'denied']);
  });
});

test('gate: reads outside the workspace run without a question; shell paths the gate cannot prove still go to a human', async () => {
  await withGate(async ({ botId, gate }) => {
    for (const [tool, input] of [
      ['Read', { file_path: '/etc/hosts' }],
      ['view_file', { file_path: path.join(home, 'Documents', 'x.md') }],
      ['Glob', { pattern: '/etc/*' }],
      ['Grep', { pattern: 'x', path: path.join(home, 'Documents') }],
      ['Bash', { command: 'cat /etc/hosts' }],
      ['Bash', { command: 'ls ~' }],
      ['Bash', { command: 'cat ../x' }],
    ] as Array<[string, Record<string, unknown>]>) {
      assert.deepEqual(await gate(tool, input), { behavior: 'allow' }, `${tool} ${JSON.stringify(input)} is a plain read`);
    }
    assert.equal(botGateDecisionsDb.listForBot(botId).length, 0, 'allowed reads leave no decision rows');
    for (const [tool, input] of [
      ['Bash', { command: 'cd /etc && ls' }],
      ['Bash', { command: 'echo $FOO' }],
    ] as Array<[string, Record<string, unknown>]>) {
      const decision = await gate(tool, input);
      assert.equal(decision.behavior, 'deny', `${tool} ${JSON.stringify(input)} must not be auto-approved`);
    }
    const rows = botGateDecisionsDb.listForBot(botId).filter((row) => row.server === 'builtin');
    assert.equal(rows.length, 2, 'both asked the Action Gate');
    for (const row of rows) assert.deepEqual([row.decision, row.outcome], ['ask', 'expired']);
    assert.deepEqual(await gate('Read', { file_path: path.join(workspace, 'src', 'a.ts') }), { behavior: 'allow' });
    assert.deepEqual(await gate('Bash', { command: 'git status' }), { behavior: 'allow' });
  });
});

test('gate: a tainted run auto-approves only pure reads inside the workspace and bot home', async () => {
  await withGate(async ({ botId, gate, setTainted }) => {
    assert.deepEqual(await gate('Bash', { command: 'npm test' }), { behavior: 'allow' }, 'clean run: classifier approval stands');
    assert.deepEqual(await gate('Bash', { command: 'mkdir -p out' }), { behavior: 'allow' });
    setTainted(true);
    for (const command of ['git status', 'cat src/a.ts | head -5', 'ls -la src', 'rg -n foo src']) {
      assert.deepEqual(await gate('Bash', { command }), { behavior: 'allow' }, `${command} is a pure read`);
    }
    assert.equal(botGateDecisionsDb.listForBot(botId).length, 0, 'pure reads need no decision row');
    for (const command of ['npm test', 'mkdir -p out', 'touch src/x.ts', 'git commit -m x', 'echo hi > src/out.txt', 'node --test']) {
      const decision = await gate('Bash', { command });
      assert.equal(decision.behavior, 'deny', `${command} must not run unattended in a tainted run`);
    }
    const rows = botGateDecisionsDb.listForBot(botId).filter((row) => row.server === 'builtin');
    assert.equal(rows.length, 6);
    for (const row of rows) assert.equal(row.decision, 'ask');
    setTainted(false);
    assert.deepEqual(await gate('Bash', { command: 'npm test' }), { behavior: 'allow' }, 'taint is read per call');
  });
});

test('gate: Codex-style calls carry their cwd, and a side effect from an outside cwd is escalated', async () => {
  await withGate(async ({ gate }) => {
    assert.deepEqual(await gate('Bash', { command: 'git status', cwd: workspace }), { behavior: 'allow' });
    assert.deepEqual(await gate('Bash', { command: 'ls', cwd: botHome }), { behavior: 'allow' });
    assert.deepEqual(await gate('Bash', { command: 'ls', cwd: '/etc' }), { behavior: 'allow' }, 'listing names outside is a plain read');
    assert.equal((await gate('Bash', { command: 'touch x', cwd: '/etc' })).behavior, 'deny', 'a side effect from an outside cwd still asks');
    assert.equal((await gate('Bash', { command: 'cat auth.json', cwd: botHome })).behavior, 'deny');
  });
});

test('non-bot callers are untouched: the shared classifier still approves what the strict gate escalates', () => {
  // Relay workers and other seats use the classifier directly; the strict behaviour lives in the bot gate only.
  const approve = (input: Parameters<typeof classifyPermissionRequest>[0]) => classifyPermissionRequest(input).tier;
  assert.equal(approve({ seatKind: 'worker', workspaceRoot: workspace, toolName: 'Read', paths: ['/etc/hosts'], cwd: workspace }), 'approve');
  assert.equal(approve({ seatKind: 'worker', workspaceRoot: workspace, toolName: 'Bash', command: 'cat /etc/hosts', cwd: workspace }), 'approve');
  assert.equal(approve({ seatKind: 'worker', workspaceRoot: workspace, toolName: 'Bash', command: 'echo $FOO', cwd: workspace }), 'approve');
  assert.equal(verdictOf('Read', { file_path: '/etc/hosts' }), 'escalate', 'while the strict guard still flags the same read (the gate lets a read through)');
  assert.equal(verdictOf('Bash', bash('echo $FOO')), 'escalate');
});

test('jq and awk environment dumps are denied (bypass found in review)', async () => {
  const { builtinDenylistReason } = await import('@/modules/bots/gate/builtin-tool-gate.js');
  const scope = { workspaceRoot: '/tmp/ws-jq', botHome: '/tmp/home-jq/.cloudcli/bots/b1/home' };
  const attacks = [
    'jq -n env',
    `jq -rn 'env|to_entries[]|.key+"="+.value'`,
    'jq -n env > leak.txt',
    'jq -n "$ENV.CLOUDCLI_API_TOKEN"',
    `awk 'BEGIN{for(k in ENVIRON)print k"="ENVIRON[k]}'`,
    `gawk 'BEGIN{print ENVIRON["CLOUDCLI_API_TOKEN"]}'`,
    `mawk 'BEGIN{for(k in ENVIRON)print k}'`,
  ];
  for (const command of attacks) {
    assert.ok(builtinDenylistReason('Bash', { command }, scope), `must be denied: ${command}`);
  }
  // Ordinary jq/awk use stays usable.
  assert.equal(builtinDenylistReason('Bash', { command: `jq '.items | length' data.json` }, scope), null);
  assert.equal(builtinDenylistReason('Bash', { command: `awk '{print $1}' report.txt` }, scope), null);
});
