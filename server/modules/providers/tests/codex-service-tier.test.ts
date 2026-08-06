import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CODEX_FAST_SERVICE_TIER,
  resolveCodexServiceTier,
} from '@/modules/providers/list/codex/codex-service-tier.js';

test('Codex Fast mode resolves to the app-server priority tier', () => {
  assert.equal(CODEX_FAST_SERVICE_TIER, 'priority');
  assert.equal(resolveCodexServiceTier({ fastMode: true }), 'priority');
  assert.equal(resolveCodexServiceTier({ serviceTier: 'fast' }), 'priority');
  assert.equal(resolveCodexServiceTier({ serviceTier: 'priority' }), 'priority');
});

test('Codex service tier resolution distinguishes clear from no override', () => {
  assert.equal(resolveCodexServiceTier({ serviceTier: null }), null);
  assert.equal(resolveCodexServiceTier({}), undefined);
  assert.equal(resolveCodexServiceTier({ serviceTier: 'standard' }), undefined);
});
