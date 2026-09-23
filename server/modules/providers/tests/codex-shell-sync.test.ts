import assert from 'node:assert/strict';
import test from 'node:test';

import {
  mapCodexSettingsToPermissionMode,
  parseCodexShellRuntime,
} from '@/modules/providers/list/codex/codex-shell-sync.js';

test('reads model, effort, and Fast from the newest Codex thread settings event', () => {
  const input = [
    JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5.6-sol', effort: 'low' } }),
    JSON.stringify({
      type: 'event_msg',
      payload: {
        type: 'thread_settings_applied',
        thread_settings: {
          model: 'gpt-5.6-luna',
          reasoning_effort: 'high',
          service_tier: 'fast',
        },
      },
    }),
  ].join('\n');

  assert.deepEqual(parseCodexShellRuntime(input), {
    model: 'gpt-5.6-luna',
    effort: 'high',
    fastMode: true,
  });
});

test('maps Codex default service tier to Fast off', () => {
  assert.deepEqual(parseCodexShellRuntime(JSON.stringify({
    type: 'event_msg',
    payload: {
      type: 'thread_settings_applied',
      thread_settings: { service_tier: 'default', reasoning_effort: 'medium' },
    },
  })), { effort: 'medium', fastMode: false });
});

test('ignores rollout settings written before the shell PTY started', () => {
  const settings = (timestamp: string, model: string) => JSON.stringify({
    timestamp,
    type: 'event_msg',
    payload: { type: 'thread_settings_applied', thread_settings: { model } },
  });
  const input = [
    settings('2026-09-23T10:00:00.000Z', 'gpt-old'),
    settings('2026-09-23T10:05:00.000Z', 'gpt-new'),
  ].join('\n');

  assert.equal(parseCodexShellRuntime(input, { since: Date.parse('2026-09-23T10:10:00.000Z') }), null);
  assert.deepEqual(
    parseCodexShellRuntime(input, { since: Date.parse('2026-09-23T10:01:00.000Z') }),
    { model: 'gpt-new' },
  );
});

test('maps rollout approval/sandbox settings onto chat permission modes', () => {
  assert.equal(mapCodexSettingsToPermissionMode({ approvalPolicy: 'untrusted', sandboxType: 'workspace-write' }), 'default');
  assert.equal(mapCodexSettingsToPermissionMode({ approvalPolicy: 'on-request', permissionProfileType: 'managed' }), 'auto');
  assert.equal(mapCodexSettingsToPermissionMode({ approvalPolicy: 'never', permissionProfileType: 'disabled' }), 'bypassPermissions');
  assert.equal(mapCodexSettingsToPermissionMode({ approvalPolicy: 'never', sandboxType: 'danger-full-access' }), 'bypassPermissions');
  // Unattended plan also uses `never`, but with a restricted sandbox.
  assert.equal(mapCodexSettingsToPermissionMode({ approvalPolicy: 'never', permissionProfileType: 'managed' }), undefined);
  assert.equal(mapCodexSettingsToPermissionMode({ approvalPolicy: 'untrusted', sandboxType: 'read-only' }), undefined);
});

test('thread settings carry the permission mode the TUI switched to', () => {
  assert.deepEqual(parseCodexShellRuntime(JSON.stringify({
    type: 'event_msg',
    payload: {
      type: 'thread_settings_applied',
      thread_settings: { approval_policy: 'never', permission_profile: { type: 'disabled' } },
    },
  })), { permissionMode: 'bypassPermissions' });
});
