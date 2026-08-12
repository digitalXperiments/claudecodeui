import assert from 'node:assert/strict';
import test from 'node:test';

import { estimateCostUsd, resolveModelPriceRate } from '@/modules/runs/model-pricing.js';

test('resolveModelPriceRate finds an exact match per provider', () => {
  assert.deepEqual(resolveModelPriceRate('claude', 'claude-sonnet-5'), {
    inputPerMillion: 2.0,
    outputPerMillion: 10.0,
  });
  assert.deepEqual(resolveModelPriceRate('codex', 'gpt-5.6-luna'), {
    inputPerMillion: 0.2,
    outputPerMillion: 1.2,
  });
  assert.deepEqual(resolveModelPriceRate('grok', 'grok-4.5'), {
    inputPerMillion: 2.0,
    outputPerMillion: 6.0,
  });
});

test('resolveModelPriceRate strips a trailing context-window suffix', () => {
  assert.deepEqual(
    resolveModelPriceRate('claude', 'claude-opus-5[1m]'),
    resolveModelPriceRate('claude', 'claude-opus-5'),
  );
});

test('resolveModelPriceRate is case-insensitive', () => {
  assert.deepEqual(
    resolveModelPriceRate('Claude', 'Claude-Sonnet-5'),
    resolveModelPriceRate('claude', 'claude-sonnet-5'),
  );
});

test('resolveModelPriceRate treats a "-free" suffix as a zero-cost tier', () => {
  assert.deepEqual(resolveModelPriceRate('opencode', 'deepseek-v4-flash-free'), {
    inputPerMillion: 0,
    outputPerMillion: 0,
  });
});

test('resolveModelPriceRate returns null for an unknown model rather than guessing', () => {
  assert.equal(resolveModelPriceRate('claude', 'some-future-model-nobody-has-priced-yet'), null);
  assert.equal(resolveModelPriceRate('claude', null), null);
  assert.equal(resolveModelPriceRate(null, 'claude-sonnet-5'), null);
});

test('estimateCostUsd computes input/output spend at the resolved rate', () => {
  // claude-sonnet-5: $2/M in, $10/M out
  const cost = estimateCostUsd('claude', 'claude-sonnet-5', 1_000_000, 500_000);
  assert.equal(cost, 2 + 5);
});

test('estimateCostUsd returns null (never a guess) for an unpriced model', () => {
  assert.equal(estimateCostUsd('claude', 'brand-new-unlisted-model', 1000, 1000), null);
});

test('estimateCostUsd treats missing/negative token counts as zero, not NaN', () => {
  assert.equal(estimateCostUsd('claude', 'claude-sonnet-5', null, undefined), 0);
  assert.equal(estimateCostUsd('claude', 'claude-sonnet-5', -500, -500), 0);
});
