import assert from 'node:assert/strict';
import fs from 'node:fs';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import {
  analyzeReadOnlyShell,
  analyzeReadOnlyTool,
  createBuiltinToolGate,
  initBotGate,
  setAutoReviewer,
  setGateHumanPollInterval,
  skillRoots,
} from '@/modules/bots/gate/index.js';
import { patchBotRuntimeConfig } from '@/modules/bots/bots-runtime-config.js';
import { botGateDecisionsDb } from '@/modules/bots/gate/bot-gate-decisions.repository.js';
import { closeConnection, initializeDatabase } from '@/modules/database/index.js';
import { interruptsService } from '@/modules/interrupt-queue/index.js';
import { missionControlDb } from '@/modules/mission-control/index.js';
import { makeScratchDir } from '@/shared/scratch.js';

/** A fake operator home (os.homedir() follows $HOME) with provider skill folders, secrets and symlinks. */
async function withHome(
  run: (env: { botId: string; home: string; workspace: string; botHome: string; scratch: string }) => void | Promise<void>,
): Promise<void> {
  const previousDb = process.env.DATABASE_PATH;
  const previousHome = process.env.HOME;
  const scratch = await makeScratchDir('bots-read-access-');
  const home = path.join(scratch, 'home');
  const write = (relative: string, content = 'x') => {
    const target = path.join(home, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  };
  for (const dir of ['.agents', '.claude', '.codex', '.grok', '.cursor', '.cloudcli']) {
    write(path.join(dir, 'skills', 'demo', 'SKILL.md'), `# ${dir} skill`);
    write(path.join(dir, 'skills', 'demo', 'notes', 'ref.md'), 'ref');
  }
  write(path.join('.agents', 'skills', 'composio-cli', 'SKILL.md'), '# composio');
  write('.claude.json', '{"token":"secret"}');
  write(path.join('.claude', 'settings.json'), '{}');
  write(path.join('.grok', 'auth.json'), '{"token":"secret"}');
  write(path.join('.codex', 'auth.json'), '{"token":"secret"}');
  write(path.join('.cloudcli', 'auth.db'), 'db');
  write(path.join('.claude', 'skills', 'demo', 'auth.json'), '{"token":"secret"}');
  write(path.join('.claude', 'skills', 'demo', 'cache.db'), 'db');
  write(path.join('elsewhere', 'plain.txt'), 'plain');
  write(path.join('Documents', 'notes.md'), 'notes');
  // Symlinks inside skill folders.
  fs.symlinkSync(path.join(home, '.claude', 'settings.json'), path.join(home, '.agents', 'skills', 'evil'));
  fs.symlinkSync(path.join(home, '.grok', 'auth.json'), path.join(home, '.claude', 'skills', 'evil2'));
  fs.symlinkSync(path.join(home, '.claude', 'skills', 'demo'), path.join(home, '.agents', 'skills', 'linkok'));
  fs.rmSync(path.join(home, '.cursor', 'skills'), { recursive: true });
  fs.symlinkSync(path.join(home, '.claude'), path.join(home, '.cursor', 'skills')); // a skills folder that IS ~/.claude

  closeConnection();
  process.env.DATABASE_PATH = path.join(scratch, 'auth.db');
  process.env.HOME = home;
  await initializeDatabase();
  interruptsService.configureBotGateResolver(null);
  setAutoReviewer(async () => {
    throw new Error('real reviewer must not run in tests');
  });
  try {
    const bot = missionControlDb.createSection({ title: 'Personal Gmail', produce_prompt: 'Go' });
    const botHome = path.join(home, '.cloudcli', 'bots', bot.section_id, 'home');
    write(path.join('.cloudcli', 'bots', bot.section_id, 'home', 'skills', 'mine', 'SKILL.md'), '# mine');
    const workspace = path.join(scratch, 'project');
    fs.mkdirSync(workspace, { recursive: true });
    await run({ botId: bot.section_id, home, workspace, botHome, scratch });
  } finally {
    setAutoReviewer(null);
    setGateHumanPollInterval(null);
    interruptsService.configureBotGateResolver(null);
    closeConnection();
    if (previousDb === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDb;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await rm(scratch, { recursive: true, force: true });
  }
}

test('incident: an operator skill file (~/.agents/skills/composio-cli/SKILL.md) is read without a question at every level', async () => {
  await withHome(async ({ botId, home, workspace, botHome }) => {
    initBotGate();
    const gate = createBuiltinToolGate({ botId, workspaceRoot: workspace, botHome, tainted: false, approvalTimeoutMs: 30 });
    const skill = path.join(home, '.agents', 'skills', 'composio-cli', 'SKILL.md');
    for (const autonomy of ['ask', 'auto'] as const) {
      patchBotRuntimeConfig(botId, { autonomy });
      assert.deepEqual(await gate('Read', { file_path: skill }), { behavior: 'allow' }, autonomy);
    }
    assert.equal(botGateDecisionsDb.listForBot(botId).length, 0, 'no decision row, no approval card');
    assert.equal(interruptsService.list().filter((interrupt) => interrupt.kind === 'bot_gate').length, 0);
  });
});

test('skill folders under protected dirs are readable read-only: .claude .codex .grok .cursor .cloudcli and the bot home', async () => {
  await withHome(async ({ botId, home, workspace, botHome }) => {
    initBotGate();
    let tainted = false;
    const gate = createBuiltinToolGate({ botId, workspaceRoot: workspace, botHome, tainted: () => tainted, approvalTimeoutMs: 30 });
    const dirs = ['.agents', '.claude', '.codex', '.grok', '.cloudcli'];
    const allowed: Array<[string, Record<string, unknown>]> = [];
    for (const dir of dirs) {
      const base = path.join(home, dir, 'skills', 'demo');
      allowed.push(
        ['Read', { file_path: path.join(base, 'SKILL.md') }],
        ['Read', { file_path: `~/${dir}/skills/demo/notes/ref.md` }],
        ['Glob', { pattern: '**/SKILL.md', path: path.join(home, dir, 'skills') }],
        ['Grep', { pattern: 'skill', path: base }],
        ['Bash', { command: `cat ${base}/SKILL.md` }],
        ['Bash', { command: `head -n 20 ~/${dir}/skills/demo/SKILL.md` }],
        ['Bash', { command: `ls -la ~/${dir}/skills` }],
        ['Bash', { command: `grep -rn skill ~/${dir}/skills/demo` }],
        ['Bash', { command: `sed -n '1,5p' ~/${dir}/skills/demo/SKILL.md` }],
        ['Bash', { command: `wc -l ${base}/SKILL.md` }],
        ['Bash', { command: `find ~/${dir}/skills -name SKILL.md` }],
        ['Bash', { command: `/bin/zsh -lc "cat ${base}/SKILL.md"` }],
      );
    }
    allowed.push(
      ['Read', { file_path: path.join(botHome, 'skills', 'mine', 'SKILL.md') }],
      ['Read', { file_path: path.join(home, '.agents', 'skills', 'linkok', 'SKILL.md') }], // a link that resolves to another skill folder
    );
    for (const autonomy of ['ask', 'auto'] as const) {
      patchBotRuntimeConfig(botId, { autonomy });
      for (const taint of [false, true]) {
        tainted = taint;
        for (const [tool, input] of allowed) {
          assert.deepEqual(await gate(tool, input), { behavior: 'allow' }, `${autonomy} tainted=${taint} ${tool} ${JSON.stringify(input)}`);
        }
      }
    }
    assert.equal(botGateDecisionsDb.listForBot(botId).length, 0, 'allowed reads leave no audit rows');
  });
});

test('the protected list still holds: provider logins, settings, databases and credential files stay denied', async () => {
  await withHome(async ({ botId, home, workspace, botHome }) => {
    initBotGate();
    const gate = createBuiltinToolGate({ botId, workspaceRoot: workspace, botHome, tainted: false, approvalTimeoutMs: 30 });
    const denied: Array<[string, Record<string, unknown>]> = [
      ['Read', { file_path: path.join(home, '.claude.json') }],
      ['Read', { file_path: '~/.claude.json' }],
      ['Read', { file_path: path.join(home, '.claude', 'settings.json') }],
      ['Read', { file_path: path.join(home, '.grok', 'auth.json') }],
      ['Read', { file_path: path.join(home, '.codex', 'auth.json') }],
      ['Read', { file_path: path.join(home, '.cloudcli', 'auth.db') }],
      ['Read', { file_path: path.join(home, '.claude', 'skills', 'demo', 'auth.json') }], // a credential file inside a skill folder
      ['Read', { file_path: path.join(home, '.claude', 'skills', 'demo', 'cache.db') }],
      ['Read', { file_path: path.join(home, '.claude', 'skills', '..', 'settings.json') }],
      ['Read', { file_path: path.join(home, '.claude', 'projects') }],
      ['Glob', { pattern: '*', path: path.join(home, '.claude') }],
      ['Grep', { pattern: 'token', path: path.join(home, '.claude') }],
      ['Grep', { pattern: 'token', path: home }], // a recursive search from a folder that holds credentials
      ['Bash', { command: 'ls ~/.claude' }],
      ['Bash', { command: 'cat ~/.claude/settings.json' }],
      ['Bash', { command: `cat ${path.join(home, '.claude', 'skills', 'demo', 'SKILL.md')} ${path.join(home, '.claude', 'settings.json')}` }],
      ['Bash', { command: 'cat ~/.claude/skills/demo/auth.json' }],
      ['Bash', { command: 'cat ~/.claude/skills/../settings.json' }],
      ['Bash', { command: 'cat ~/.claude/skills/*/auth.json' }], // a wildcard could match a credential file
      ['Bash', { command: 'cat ~/.claude/skills/demo/SKILL.md; cat ~/.grok/auth.json' }],
      ['Bash', { command: 'cat $HOME/.claude/skills/demo/SKILL.md' }],
    ];
    for (const autonomy of ['ask', 'auto'] as const) {
      patchBotRuntimeConfig(botId, { autonomy });
      for (const [tool, input] of denied) {
        const decision = await gate(tool, input);
        assert.equal(decision.behavior, 'deny', `${autonomy} ${tool} ${JSON.stringify(input)}`);
      }
    }
    assert.ok(botGateDecisionsDb.listForBot(botId).some((row) => row.decided_by === 'denylist'), 'denied reads are audited');
    assert.ok(botGateDecisionsDb.listForBot(botId).every((row) => row.decision !== 'allow'));
  });
});

test('symlinks in skill folders are resolved and re-checked: a link to a protected file is denied', async () => {
  await withHome(async ({ botId, home, workspace, botHome }) => {
    initBotGate();
    const gate = createBuiltinToolGate({ botId, workspaceRoot: workspace, botHome, tainted: false, approvalTimeoutMs: 30 });
    const denied: Array<[string, Record<string, unknown>]> = [
      ['Read', { file_path: path.join(home, '.agents', 'skills', 'evil') }], // -> ~/.claude/settings.json
      ['Read', { file_path: path.join(home, '.claude', 'skills', 'evil2') }], // -> ~/.grok/auth.json
      ['Bash', { command: `cat ${path.join(home, '.claude', 'skills', 'evil2')}` }],
      ['Bash', { command: 'head -n 3 ~/.agents/skills/evil' }],
      // A skills folder that is itself a link to a protected dir: nothing below it is a skill.
      ['Read', { file_path: path.join(home, '.cursor', 'skills', 'settings.json') }],
      ['Read', { file_path: path.join(home, '.cursor', 'skills', 'projects') }],
      ['Bash', { command: 'cat ~/.cursor/skills/settings.json' }],
    ];
    for (const [tool, input] of denied) {
      assert.equal((await gate(tool, input)).behavior, 'deny', `${tool} ${JSON.stringify(input)}`);
    }
    assert.deepEqual(
      skillRoots(path.join(home, '.cloudcli', 'bots', 'x', 'home')).filter((root) => root === path.join(home, '.claude')),
      [],
      'a skills folder that points at ~/.claude is not a skill root',
    );
  });
});

test('writes to skill folders stay denied or asked', async () => {
  await withHome(async ({ botId, home, workspace, botHome }) => {
    initBotGate();
    const gate = createBuiltinToolGate({ botId, workspaceRoot: workspace, botHome, tainted: false, approvalTimeoutMs: 30 });
    const protectedWrites: Array<[string, Record<string, unknown>]> = [
      ['Write', { file_path: path.join(home, '.claude', 'skills', 'demo', 'SKILL.md'), content: 'x' }],
      ['Edit', { file_path: path.join(home, '.codex', 'skills', 'demo', 'SKILL.md'), old_string: 'a', new_string: 'b' }],
      ['Bash', { command: 'echo x > ~/.claude/skills/demo/SKILL.md' }],
      ['Bash', { command: 'sed -i s/a/b/ ~/.grok/skills/demo/SKILL.md' }],
      ['Bash', { command: 'rm ~/.cloudcli/skills/demo/SKILL.md' }],
    ];
    for (const [tool, input] of protectedWrites) assert.equal((await gate(tool, input)).behavior, 'deny', `${tool} ${JSON.stringify(input)}`);
    const before = botGateDecisionsDb.listForBot(botId).length;
    // ~/.agents is not protected, but it is outside the workspace: an ask, never a silent write.
    const write = await gate('Write', { file_path: path.join(home, '.agents', 'skills', 'composio-cli', 'SKILL.md'), content: 'x' });
    assert.equal(write.behavior, 'deny', 'nobody answered the approval');
    const rows = botGateDecisionsDb.listForBot(botId);
    assert.equal(rows.length, before + 1);
    assert.equal(rows[0].decision, 'ask');
  });
});

test('reads elsewhere on the machine need no approval, but credential-looking files still ask', async () => {
  await withHome(async ({ botId, home, workspace, botHome }) => {
    initBotGate();
    const gate = createBuiltinToolGate({ botId, workspaceRoot: workspace, botHome, tainted: false, approvalTimeoutMs: 30 });
    assert.deepEqual(await gate('Read', { file_path: path.join(home, 'Documents', 'notes.md') }), { behavior: 'allow' });
    assert.deepEqual(await gate('Bash', { command: `ls ${path.join(home, 'Documents')}` }), { behavior: 'allow' });
    assert.deepEqual(await gate('Glob', { pattern: '*.txt', path: path.join(home, 'elsewhere') }), { behavior: 'allow' });
    fs.writeFileSync(path.join(home, 'Documents', '.env'), 'TOKEN=1');
    assert.equal((await gate('Read', { file_path: path.join(home, 'Documents', '.env') })).behavior, 'deny', 'asked; nobody answered');
    assert.equal(botGateDecisionsDb.listForBot(botId)[0].risk, 'credential');
  });
});

// ---- the read-only analyzer ------------------------------------------------------------------

test('analyzeReadOnlyShell accepts only provable reads', () => {
  const ok = [
    'cat /etc/hosts',
    'cat a.txt b.txt | head -n 5',
    "grep -rn 'foo bar' ~/notes",
    'rg -n todo src',
    'ls -la /tmp && pwd',
    "sed -n '10,20p' file.txt",
    'find . -name "*.md" -maxdepth 2',
    'wc -l a b c',
    'stat -f %z file',
    '/bin/zsh -lc "ls ~/Documents"',
    'sort a | uniq -c | head -5',
  ];
  for (const command of ok) assert.ok(analyzeReadOnlyShell(command), command);
  const bad = [
    'cat a > b',
    'cat a >> b',
    'cat $(pwd)/a',
    'cat `pwd`',
    'cat "$HOME/a"',
    'sed -i s/a/b/ f',
    'sed s/a/b/ f',
    "sed -n 'w out' f",
    'find . -exec rm {} +',
    'find . -delete',
    'find . -fprint out',
    'grep -f patterns file',
    'grep -R x .',
    'rg --pre ./run x .',
    'rg --glob *.md x',
    'sort -o out in',
    'uniq in out',
    'wc --files0-from=list',
    'file -f list',
    'tee out',
    'rm a',
    'curl http://x',
    'cat a\nrm b',
    'cat a & rm b',
    'cat a || rm b | tee c',
    'echo $(date)',
    'cat ~bob/a',
    "bash -c 'cat a; rm b'",
    '',
  ];
  for (const command of bad) assert.equal(analyzeReadOnlyShell(command), null, JSON.stringify(command));
});

test('analyzeReadOnlyTool covers the file tools of every provider and refuses expansions and escapes', () => {
  for (const tool of ['Read', 'read_file', 'view_file', 'Glob', 'list_dir', 'LS', 'Grep', 'grep_search']) {
    assert.ok(analyzeReadOnlyTool(tool, { path: '/x/y', file_path: '/x/y' }), tool);
  }
  assert.equal(analyzeReadOnlyTool('Write', { file_path: '/x' }), null);
  assert.equal(analyzeReadOnlyTool('Edit', { file_path: '/x' }), null);
  assert.equal(analyzeReadOnlyTool('Read', { file_path: '$HOME/x' }), null);
  assert.equal(analyzeReadOnlyTool('Read', {}), null, 'a read with no path names nothing to look at');
  assert.equal(analyzeReadOnlyTool('Glob', { pattern: '../../.claude.json', path: '/x' }), null);
  assert.equal(analyzeReadOnlyTool('Glob', { pattern: '**/*.md', path: '/x' })?.operands[0].text, '/x');
  const absolute = analyzeReadOnlyTool('Glob', { pattern: '/etc/*.conf' });
  assert.ok(absolute?.operands.some((entry) => entry.text === '/etc/' && entry.kind === 'names'));
  const search = analyzeReadOnlyTool('Grep', { pattern: 'x', path: '/data' });
  assert.deepEqual(search?.recursive.map((entry) => entry.text), ['/data']);
});
