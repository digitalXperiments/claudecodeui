import assert from 'node:assert/strict';
import test from 'node:test';

import {
  resolveClaudeCodeExecutablePath,
  type ResolveClaudeCodeExecutablePathDependencies,
} from '@/shared/claude-cli-path.js';

test('resolveClaudeCodeExecutablePath resolves the npm Claude wrapper to its native exe on Windows', () => {
  const wrapperDir = 'C:\\nvm4w\\nodejs';
  const nativePath = `${wrapperDir}\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe`;
  const execFileSync =
    (() => `${wrapperDir}\\claude\r\n${wrapperDir}\\claude.cmd\r\n`) as unknown as ResolveClaudeCodeExecutablePathDependencies['execFileSync'];
  const readFileSync = (() => '') as unknown as ResolveClaudeCodeExecutablePathDependencies['readFileSync'];

  const resolved = resolveClaudeCodeExecutablePath('claude', {
    platform: 'win32',
    execFileSync,
    existsSync: (candidate) => candidate === nativePath,
    readFileSync,
  });

  assert.equal(resolved, nativePath);
});

test('resolveClaudeCodeExecutablePath keeps an explicit JavaScript launcher path unchanged', () => {
  const scriptPath = 'C:\\tools\\claude.js';

  const resolved = resolveClaudeCodeExecutablePath(scriptPath, {
    platform: 'win32',
  });

  assert.equal(resolved, scriptPath);
});

test('resolveClaudeCodeExecutablePath can parse a wrapper file path containing letters r and n before claude.exe', () => {
  const wrapperPath = 'C:\\tools\\claude';
  const nativePath = 'C:\\tools\\custom\\bin\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe';
  const readFileSync = (() => `exec "$basedir/custom/bin/node_modules/@anthropic-ai/claude-code/bin/claude.exe" "$@"`) as unknown as ResolveClaudeCodeExecutablePathDependencies['readFileSync'];

  const resolved = resolveClaudeCodeExecutablePath(wrapperPath, {
    platform: 'win32',
    existsSync: (candidate) => candidate === nativePath,
    readFileSync,
  });

  assert.equal(resolved, nativePath);
});

test('resolveClaudeCodeExecutablePath falls back to the configured command when PATH lookup fails', () => {
  const execFileSync = (() => {
    throw new Error('not found');
  }) as unknown as ResolveClaudeCodeExecutablePathDependencies['execFileSync'];

  const resolved = resolveClaudeCodeExecutablePath('claude', {
    platform: 'win32',
    execFileSync,
  });

  assert.equal(resolved, 'claude');
});

// A GUI-launched Electron app inherits launchd's minimal PATH, so `claude` is
// not on it even though the user's shell is logged in. Resolving to the native
// installer keeps CloudCLI on the same binary — and therefore the same OAuth
// profile — instead of reporting "not installed" and prompting for auth.
test('resolveClaudeCodeExecutablePath finds the native installer when PATH is the minimal GUI default', () => {
  const nativePath = '/Users/dev/.local/bin/claude';

  const resolved = resolveClaudeCodeExecutablePath('claude', {
    platform: 'darwin',
    pathEnv: '/usr/bin:/bin:/usr/sbin:/sbin',
    homedir: (() => '/Users/dev') as ResolveClaudeCodeExecutablePathDependencies['homedir'],
    existsSync: (candidate) => candidate === nativePath,
  });

  assert.equal(resolved, nativePath);
});

test('resolveClaudeCodeExecutablePath prefers PATH over the install-location probe on posix', () => {
  const onPath = '/opt/custom/bin/claude';

  const resolved = resolveClaudeCodeExecutablePath('claude', {
    platform: 'darwin',
    pathEnv: '/opt/custom/bin',
    homedir: (() => '/Users/dev') as ResolveClaudeCodeExecutablePathDependencies['homedir'],
    // Both exist; PATH must win so the server matches the user's shell.
    existsSync: (candidate) => candidate === onPath || candidate === '/Users/dev/.local/bin/claude',
  });

  assert.equal(resolved, onPath);
});

test('resolveClaudeCodeExecutablePath honours an explicit posix CLAUDE_CLI_PATH verbatim', () => {
  const resolved = resolveClaudeCodeExecutablePath('/custom/claude', {
    platform: 'darwin',
    pathEnv: '/usr/bin:/bin',
    existsSync: () => false,
  });

  assert.equal(resolved, '/custom/claude');
});

test('resolveClaudeCodeExecutablePath keeps the bare command when nothing is installed on posix', () => {
  const resolved = resolveClaudeCodeExecutablePath('claude', {
    platform: 'darwin',
    pathEnv: '/nowhere',
    homedir: (() => '/Users/dev') as ResolveClaudeCodeExecutablePathDependencies['homedir'],
    existsSync: () => false,
  });

  assert.equal(resolved, 'claude');
});
