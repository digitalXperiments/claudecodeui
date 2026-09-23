import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { classifyRelayPermissionRequest } from '@/modules/agent-relay/agent-relay-permission.service.js';
import { stripHeredocBodies } from '@/modules/permissions/index.js';
import { makeScratchDir } from '@/shared/scratch.js';
import {
  buildSeatbeltProfile,
  claudeSdkSandboxSettings,
  codexSandboxConfig,
  processSandboxAvailable,
  wrapCommandForSandbox,
} from '@/shared/worker-sandbox.js';

const ROOT = '/Users/x/proj/.worktrees/ws_1';

function classify(command: string, overrides: Partial<Parameters<typeof classifyRelayPermissionRequest>[0]> = {}) {
  return classifyRelayPermissionRequest({
    mode: 'isolated_write',
    approvalPolicy: 'auto',
    envelopeRoot: ROOT,
    toolName: 'Bash',
    command,
    cwd: ROOT,
    ...overrides,
  });
}

test('process sandbox approves in-sandbox work and denies boundary crossings', () => {
  const sandbox = { sandbox: 'process' as const, network: 'open' as const };
  for (const command of ['python3 -m pytest -q', 'npm install lodash', 'cargo run', "cat > a.md <<'EOF'\nconst x = 1\nEOF"]) {
    assert.equal(classify(command, sandbox).tier, 'approve', command);
  }
  for (const command of ['git push origin main', 'sudo ls', 'npm publish', 'gh pr merge 3', 'osascript -e 1']) {
    assert.equal(classify(command, sandbox).tier, 'deny', command);
  }
  assert.equal(classify('curl https://example.com', { ...sandbox, network: 'restricted' }).tier, 'deny');
  assert.equal(classify('curl https://example.com', sandbox).tier, 'approve');
});

test('provider sandbox keeps strict classification for escalations and refuses widening', () => {
  const sandbox = { sandbox: 'provider' as const, network: 'open' as const };
  assert.equal(classify('git -C /elsewhere commit -m x', sandbox).tier, 'deny');
  assert.equal(
    classifyRelayPermissionRequest({ mode: 'isolated_write', approvalPolicy: 'auto', envelopeRoot: ROOT, toolName: 'CodexPermissions', sandbox: 'provider' }).tier,
    'deny',
  );
});

test('granted MCP server tools are part of the envelope', () => {
  const verdict = classifyRelayPermissionRequest({
    mode: 'isolated_write',
    approvalPolicy: 'auto',
    envelopeRoot: ROOT,
    toolName: 'mcp__cloudcli-browser__browser_navigate',
    sandbox: 'provider',
    grantedMcpServers: ['cloudcli-browser'],
  });
  assert.equal(verdict.tier, 'approve');
});

test('manual policy bypasses sandbox auto-approval', () => {
  assert.notEqual(classify('python3 -m pytest', { sandbox: 'process', approvalPolicy: 'manual' }).tier, 'approve');
});

test('unsandboxed classifier no longer treats code execution as reads', () => {
  assert.equal(classify('cargo run', { mode: 'read_only' }).tier, 'deny');
  assert.equal(classify("awk 'BEGIN{system(\"id\")}'", { mode: 'read_only' }).tier, 'deny');
  assert.equal(classify("awk '{print $1}' f.txt", { mode: 'read_only' }).tier, 'approve');
  assert.equal(classify('git -C /Users/x/other commit -am x').tier, 'deny');
  assert.equal(classify('git -C /Users/x/other log').tier, 'approve');
});

test('unsandboxed writers can run project checks and scripts in their workspace', () => {
  for (const command of ['python3 -m pytest', 'npm run dev', 'bash scripts/check.sh', 'node scripts/gen.js', 'make', "cat > n.md <<'EOF'\nrev-parse\nEOF"]) {
    assert.equal(classify(command).tier, 'approve', command);
  }
  for (const command of ['python3 -c "import os"', 'node -e 1', 'bash ../escape.sh']) {
    assert.equal(classify(command).tier, 'deny', command);
  }
});

test('heredoc bodies are stripped, commands are kept', () => {
  assert.equal(stripHeredocBodies("cat > f <<'EOF'\nconst x\nEOF\necho done"), "cat > f <<'EOF'\necho done");
  assert.equal(stripHeredocBodies('cat <<-END\n\tbody\n\tEND'), 'cat <<-END');
  assert.equal(stripHeredocBodies('grep x <<< "$v"'), 'grep x <<< "$v"');
});

test('seatbelt profile orders denies before the worker re-allow', () => {
  const profile = buildSeatbeltProfile({
    mode: 'isolated_write',
    cwd: '/p/.worktrees/w',
    writableRoots: ['/p/.worktrees/w', '/p/.git/objects'],
    protectedRoots: ['/p'],
    scratchRoots: ['/p/.worktrees/w/tmp/cloudcli'],
  }, { homeDir: '/Users/nobody' });
  const protectedAt = profile.indexOf('(deny file-write* (subpath "/p"))');
  const reallowAt = profile.indexOf('(allow file-write* (subpath "/p/.worktrees/w/tmp/cloudcli")');
  assert.ok(protectedAt > 0 && reallowAt > protectedAt);
  assert.match(profile, /\.ssh/);
  const reader = buildSeatbeltProfile({ mode: 'read_only', cwd: '/p', writableRoots: ['/p'], protectedRoots: ['/p'], scratchRoots: [] }, { homeDir: '/Users/nobody' });
  assert.doesNotMatch(reader, /\(allow file-write\* \(subpath "\/p"\)\)/);
});

test('provider settings map the spec onto Claude and Codex sandboxes', () => {
  const spec = {
    mode: 'isolated_write',
    enforcement: 'provider',
    cwd: '/w',
    writableRoots: ['/w', '/repo/.git/objects'],
    protectedRoots: ['/repo'],
    scratchRoots: ['/w/tmp/cloudcli'],
    network: 'open',
    allowedDomains: ['registry.npmjs.org'],
  };
  const claude = claudeSdkSandboxSettings(spec);
  assert.equal(claude?.autoAllowBashIfSandboxed, true);
  assert.equal(claude?.allowUnsandboxedCommands, false);
  assert.deepEqual(claude?.filesystem.allowWrite, ['/w/tmp/cloudcli', '/repo/.git/objects']);
  assert.deepEqual(codexSandboxConfig(spec), {
    sandbox_workspace_write: { network_access: true, writable_roots: ['/repo/.git/objects', '/w/tmp/cloudcli'] },
  });
  assert.equal(wrapCommandForSandbox('grok', ['agent'], spec).sandboxed, false, 'provider enforcement never wraps');
});

// Seatbelt profiles cannot nest: skip when this suite itself runs as a Relay host check.
test('sandbox-exec lets a worker commit on its branch but not touch the primary', { skip: !processSandboxAvailable() || process.env.CLOUDCLI_HOST_CHECK === '1' }, async () => {
  const root = await makeScratchDir('relay-sandbox');
  try {
    const primary = path.join(root, 'primary');
    await mkdir(primary, { recursive: true });
    const git = (cwd: string, ...args: string[]) => spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' });
    git(primary, 'init', '-q', '-b', 'main');
    await writeFile(path.join(primary, 'a.txt'), 'a\n');
    git(primary, 'add', '.');
    git(primary, 'commit', '-qm', 'init');
    const worktree = path.join(primary, '.worktrees', 'w1');
    git(primary, 'worktree', 'add', '-q', '-b', 'relay/job1', worktree);
    const common = path.join(primary, '.git');
    const launch = wrapCommandForSandbox('/bin/bash', ['-c', [
      'echo b > b.txt && git add b.txt && git -c user.email=t@t -c user.name=t commit -qm b && echo COMMITTED',
      `echo x > ${JSON.stringify(path.join(primary, 'a.txt'))} 2>/dev/null && echo LEAKED || echo PRIMARY_DENIED`,
    ].join('; ')], {
      mode: 'isolated_write',
      enforcement: 'process',
      cwd: worktree,
      writableRoots: [worktree, path.join(common, 'worktrees', 'w1'), path.join(common, 'objects'), path.join(common, 'refs', 'heads', 'relay'), path.join(common, 'logs', 'refs', 'heads', 'relay'), path.join(common, 'packed-refs')],
      protectedRoots: [primary],
      scratchRoots: [],
    });
    assert.equal(launch.sandboxed, true);
    const result = spawnSync(launch.command, launch.args, { cwd: worktree, encoding: 'utf8' });
    assert.match(result.stdout, /COMMITTED/);
    assert.match(result.stdout, /PRIMARY_DENIED/);
    assert.doesNotMatch(result.stdout, /LEAKED/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
