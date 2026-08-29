import assert from 'node:assert/strict';
import test from 'node:test';

import { mapPermissionModeToCodexOptions } from './modules/providers/list/codex/codex-permission-mode.js';

test('unattended plan explorers skip Codex exec prompts; interactive plan still asks', () => {
  assert.deepEqual(mapPermissionModeToCodexOptions('plan'), {
    sandbox: 'read-only',
    approvalPolicy: 'untrusted',
    approvalsReviewer: 'user',
  });
  assert.deepEqual(mapPermissionModeToCodexOptions('plan', { unattended: true }), {
    sandbox: 'read-only',
    approvalPolicy: 'never',
    approvalsReviewer: 'user',
  });
  assert.equal(mapPermissionModeToCodexOptions('default').approvalPolicy, 'untrusted');
});
