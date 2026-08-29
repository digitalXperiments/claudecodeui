import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveRoster } from '@/modules/swarm/swarm.service.js';
import type { StartSwarmInput } from '@/modules/swarm/swarm.types.js';

function baseInput(overrides: Partial<StartSwarmInput> = {}): StartSwarmInput {
  return {
    projectId: 'proj-1',
    goal: 'test goal',
    ...overrides,
  };
}

test('dynamic engine is explicit so legacy API callers keep the compatible pipeline', () => {
  const defaultConfig = resolveRoster(baseInput()).config;
  assert.equal(defaultConfig.dynamicEngine, false, 'legacy API calls remain classic');

  const dynamic = resolveRoster(baseInput({ dynamicEngine: true })).config;
  assert.equal(dynamic.dynamicEngine, true, 'Swarm Studio explicitly enables dynamic dispatch');
});

test('autonomous long-horizon is the default and can be opted out', () => {
  const defaultConfig = resolveRoster(baseInput()).config;
  assert.equal(defaultConfig.autonomous, true, 'autonomous defaults ON');

  const short = resolveRoster(baseInput({ autonomous: false })).config;
  assert.equal(short.autonomous, false, 'explicit false restores a short run');
});

test('dynamic engine keeps dispatch as the live loop when requested', () => {
  const dynamicConfig = resolveRoster(baseInput({ dynamicEngine: true })).config;
  assert.equal(dynamicConfig.dynamicEngine, true);
  assert.equal(dynamicConfig.autonomous, true);
});

test('wall-clock budget is persisted when provided and null otherwise', () => {
  const withBudget = resolveRoster(baseInput({ wallClockMs: 30 * 60 * 1000 })).config;
  assert.equal(withBudget.wallClockMs, 30 * 60 * 1000);

  const withoutBudget = resolveRoster(baseInput()).config;
  assert.equal(withoutBudget.wallClockMs, null);

  // Invalid values fall back to null rather than poisoning the config.
  const invalid = resolveRoster(baseInput({ wallClockMs: -5 })).config;
  assert.equal(invalid.wallClockMs, null);
});
