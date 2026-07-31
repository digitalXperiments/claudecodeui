import assert from 'node:assert/strict';
import test from 'node:test';

import { ClaudeProviderAuth } from '../list/claude/claude-auth.provider.js';

/**
 * Smoke + cache tests for Claude auth status.
 * Live keychain/CLI behaviour is machine-dependent.
 */

test('ClaudeProviderAuth returns a status object with expected fields', async () => {
  ClaudeProviderAuth.invalidateStatusCache();
  const auth = new ClaudeProviderAuth();
  const status = await auth.getStatus();

  assert.equal(status.provider, 'claude');
  assert.equal(typeof status.installed, 'boolean');
  assert.equal(typeof status.authenticated, 'boolean');

  if (status.authenticated) {
    assert.ok(status.email);
    assert.equal(status.error, undefined);
  }
});

test('ClaudeProviderAuth memoises status across concurrent/rapid calls', async () => {
  ClaudeProviderAuth.invalidateStatusCache();
  const auth = new ClaudeProviderAuth();

  const [a, b] = await Promise.all([auth.getStatus(), auth.getStatus()]);
  // Same object identity: single-flight + cache share one resolve result.
  assert.equal(a, b);

  const again = await auth.getStatus();
  assert.equal(again, a);

  ClaudeProviderAuth.invalidateStatusCache();
  const after = await auth.getStatus();
  assert.notEqual(after, a);
  assert.equal(after.authenticated, a.authenticated);
});

test('ClaudeProviderAuth reports installed=false for a missing CLI path', async () => {
  const previous = process.env.CLAUDE_CLI_PATH;
  process.env.CLAUDE_CLI_PATH = '/nonexistent/claude-binary-for-test';
  ClaudeProviderAuth.invalidateStatusCache();
  try {
    const status = await new ClaudeProviderAuth().getStatus();
    assert.equal(status.provider, 'claude');
    assert.equal(status.installed, false);
    assert.equal(status.authenticated, false);
  } finally {
    if (previous === undefined) {
      delete process.env.CLAUDE_CLI_PATH;
    } else {
      process.env.CLAUDE_CLI_PATH = previous;
    }
    ClaudeProviderAuth.invalidateStatusCache();
  }
});
