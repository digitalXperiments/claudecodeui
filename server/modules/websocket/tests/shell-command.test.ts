import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildShellCommand,
  type ShellIncomingMessage,
  type ShellWebSocketDependencies,
} from '@/modules/websocket/services/shell-websocket.service.js';

const dependencies = {
  resolveProviderSessionId: (sessionId: string) => sessionId,
  stripAnsiSequences: (content: string) => content,
  normalizeDetectedUrl: (url: string) => url,
  extractUrlsFromText: () => [],
  shouldAutoOpenUrlFromOutput: () => false,
} satisfies ShellWebSocketDependencies;

function build(message: ShellIncomingMessage): string {
  return buildShellCommand({ type: 'init', ...message }, dependencies);
}

test('claude maps non-default modes onto --permission-mode', () => {
  assert.equal(
    build({ provider: 'claude', permissionMode: 'plan' }),
    'claude --permission-mode plan',
  );
  assert.equal(
    build({ provider: 'claude', permissionMode: 'bypassPermissions' }),
    'claude --permission-mode bypassPermissions',
  );
  assert.equal(build({ provider: 'claude', permissionMode: 'default' }), 'claude');
  assert.equal(
    build({ provider: 'claude', hasSession: true, sessionId: 'abc', permissionMode: 'auto' }),
    'claude --resume "abc" --permission-mode auto || claude --permission-mode auto',
  );
});

test('kimi maps modes onto its start-in-mode flags', () => {
  assert.equal(build({ provider: 'kimi', permissionMode: 'plan' }), 'kimi --plan');
  assert.equal(build({ provider: 'kimi', permissionMode: 'auto' }), 'kimi --auto');
  assert.equal(build({ provider: 'kimi', permissionMode: 'bypassPermissions' }), 'kimi --yolo');
  assert.equal(build({ provider: 'kimi', permissionMode: 'default' }), 'kimi');
  assert.equal(
    build({ provider: 'kimi', hasSession: true, sessionId: 's1', permissionMode: 'plan' }),
    'kimi --session="s1" --plan',
  );
});

test('codex maps modes onto -c sandbox/approval overrides', () => {
  assert.equal(
    build({ provider: 'codex', permissionMode: 'bypassPermissions' }),
    'codex -c sandbox_mode="danger-full-access" -c approval_policy="never"',
  );
  assert.equal(
    build({ provider: 'codex', hasSession: true, sessionId: 'c1', permissionMode: 'acceptEdits' }),
    'codex resume "c1" -c sandbox_mode="workspace-write" -c approval_policy="never" || codex -c sandbox_mode="workspace-write" -c approval_policy="never"',
  );
});

test('cursor only exposes -f for bypassPermissions', () => {
  assert.equal(build({ provider: 'cursor', permissionMode: 'bypassPermissions' }), 'cursor-agent -f');
  assert.equal(build({ provider: 'cursor', permissionMode: 'default' }), 'cursor-agent');
});

test('opencode mirrors resolveOpenCodePermissionOptions', () => {
  assert.equal(build({ provider: 'opencode', permissionMode: 'plan' }), 'opencode --agent plan');
  assert.equal(
    build({ provider: 'opencode', permissionMode: 'bypassPermissions' }),
    'opencode --auto',
  );
  const acceptEdits = build({ provider: 'opencode', permissionMode: 'acceptEdits' });
  assert.ok(acceptEdits.includes('OPENCODE_PERMISSION'));
  assert.ok(acceptEdits.includes('opencode'));
});

test('agy mirrors agy-cli.js flag mapping', () => {
  assert.equal(build({ provider: 'agy', permissionMode: 'plan' }), 'agy --mode plan');
  assert.equal(build({ provider: 'agy', permissionMode: 'acceptEdits' }), 'agy --mode accept-edits');
  assert.equal(
    build({ provider: 'agy', permissionMode: 'bypassPermissions' }),
    'agy --dangerously-skip-permissions',
  );
});

test('pi restricts tools in plan mode only', () => {
  assert.equal(
    build({ provider: 'pi', permissionMode: 'plan' }),
    'pi --tools read,grep,find,ls',
  );
  assert.equal(build({ provider: 'pi', permissionMode: 'bypassPermissions' }), 'pi');
});

// Grok is intentionally not covered here: buildGrokShellCommand resolves a
// managed GROK_HOME on disk (ensureManagedGrokHome), which is a filesystem
// side effect outside the repo.

test('invalid or missing modes add no flags', () => {
  assert.equal(build({ provider: 'claude' }), 'claude');
  assert.equal(build({ provider: 'claude', permissionMode: 'not-a-mode' }), 'claude');
  assert.equal(build({ provider: 'kimi', permissionMode: 'acceptEdits' }), 'kimi');
});

test('plain shells ignore the permission mode', () => {
  assert.equal(
    build({ isPlainShell: true, initialCommand: 'bash', permissionMode: 'plan' }),
    'bash',
  );
});
