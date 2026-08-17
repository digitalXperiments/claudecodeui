import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createAcpPermissionCancellation, findAcpPermissionOption } from '@/shared/acp-rpc.js';

describe('ACP permission selection', () => {
  it('returns the offered optionId, not a guessed semantic label', () => {
    const options = [{ kind: 'allow_once', optionId: 'qwen-approve-once' }, { kind: 'reject_once', optionId: 'qwen-deny-once' }];
    assert.equal(findAcpPermissionOption(options, ['allow_once']), 'qwen-approve-once');
    assert.equal(findAcpPermissionOption(options, ['reject_once']), 'qwen-deny-once');
  });

  it('cancels when an agent offers no compatible option', () => {
    assert.deepEqual(createAcpPermissionCancellation(), { outcome: { outcome: 'cancelled' } });
  });
});
