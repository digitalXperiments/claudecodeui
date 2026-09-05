import assert from 'node:assert/strict';
import test from 'node:test';

import type { ContinuityProviderHealth } from '../../chat/types/continuity';
import { summarizeContinuityHealth } from './continuitySettings';

// Mirrors one entry of the real `GET /api/continuity/health` response
// (server/modules/continuity/continuity-health.service.ts). If the service
// changes shape, this fixture and the client type must move together.
const providerHealth = (
  overrides: Partial<ContinuityProviderHealth> = {},
): ContinuityProviderHealth => ({
  provider: 'claude',
  displayName: 'Claude',
  authenticated: true,
  authError: null,
  installed: true,
  liveUsageSupported: true,
  quota: { status: 'available', remainingRatio: 0.5, resetsAt: null, planName: null },
  recoveries24h: 0,
  ...overrides,
});

test('summarizeContinuityHealth counts authenticated, healthy and 24h recoveries', () => {
  const summary = summarizeContinuityHealth([
    providerHealth({ provider: 'claude', recoveries24h: 2 }),
    providerHealth({
      provider: 'codex',
      quota: { status: 'exhausted', remainingRatio: 0, resetsAt: null, planName: null },
      recoveries24h: 1,
    }),
    providerHealth({ provider: 'grok', authenticated: false }),
  ]);

  assert.deepEqual(summary, { authenticated: 2, healthy: 1, recoveries24h: 3 });
});

test('summarizeContinuityHealth returns null instead of throwing on a non-array payload', () => {
  // The tab used to read `summary.healthyCount` off this response; the API
  // never sent it, so every render threw and blanked the whole app.
  assert.equal(summarizeContinuityHealth(null), null);
  assert.equal(summarizeContinuityHealth(undefined), null);
  assert.equal(summarizeContinuityHealth({} as never), null);
  assert.deepEqual(summarizeContinuityHealth([]), { authenticated: 0, healthy: 0, recoveries24h: 0 });
});
