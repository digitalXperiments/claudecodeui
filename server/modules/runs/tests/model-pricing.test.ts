import assert from 'node:assert/strict';
import test from 'node:test';

import { estimateCostUsd, resolveModelPriceRate } from '@/modules/runs/model-pricing.js';

test('resolveModelPriceRate finds an exact match per provider', () => {
  // claude-sonnet-5 is time-windowed (see below) — pin a date inside its
  // introductory window so this assertion never flips on its own as time
  // passes.
  assert.deepEqual(resolveModelPriceRate('claude', 'claude-sonnet-5', '2026-08-01'), {
    inputPerMillion: 2.0,
    outputPerMillion: 10.0,
    cacheReadPerMillion: 0.2,
    cacheWritePerMillion: 2.5,
  });
  assert.deepEqual(resolveModelPriceRate('codex', 'gpt-5.6-luna'), {
    inputPerMillion: 0.2,
    outputPerMillion: 1.2,
    cacheReadPerMillion: 0.02,
  });
  // No verified cache rate for grok — the rate object omits it entirely
  // rather than guessing a discount ratio.
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
    resolveModelPriceRate('Claude', 'Claude-Sonnet-5', '2026-08-01'),
    resolveModelPriceRate('claude', 'claude-sonnet-5', '2026-08-01'),
  );
});

test('resolveModelPriceRate picks the rate that was in effect at the given date, not today\'s rate', () => {
  // claude-sonnet-5: $2/$10 through 2026-08-31, $3/$15 from 2026-09-01.
  assert.deepEqual(resolveModelPriceRate('claude', 'claude-sonnet-5', '2026-06-01'), {
    inputPerMillion: 2.0,
    outputPerMillion: 10.0,
    cacheReadPerMillion: 0.2,
    cacheWritePerMillion: 2.5,
  });
  assert.deepEqual(resolveModelPriceRate('claude', 'claude-sonnet-5', '2026-08-31'), {
    inputPerMillion: 2.0,
    outputPerMillion: 10.0,
    cacheReadPerMillion: 0.2,
    cacheWritePerMillion: 2.5,
  });
  assert.deepEqual(resolveModelPriceRate('claude', 'claude-sonnet-5', '2026-09-01'), {
    inputPerMillion: 3.0,
    outputPerMillion: 15.0,
    cacheReadPerMillion: 0.3,
    cacheWritePerMillion: 3.75,
  });
  assert.deepEqual(resolveModelPriceRate('claude', 'claude-sonnet-5', '2027-01-01'), {
    inputPerMillion: 3.0,
    outputPerMillion: 15.0,
    cacheReadPerMillion: 0.3,
    cacheWritePerMillion: 3.75,
  });
});

test('estimateCostUsd prices an old run at the old rate even called after a rate change', () => {
  // A run that happened in July must always cost the same, however long
  // after the fact this gets computed — even once "today" has moved past
  // the 2026-09-01 rate change for this same model.
  const julyCost = estimateCostUsd('claude', 'claude-sonnet-5', 1_000_000, 500_000, '2026-07-15');
  assert.equal(julyCost, 2 * 1 + 10 * 0.5);
  const octoberCost = estimateCostUsd('claude', 'claude-sonnet-5', 1_000_000, 500_000, '2026-10-15');
  assert.equal(octoberCost, 3 * 1 + 15 * 0.5);
  // Re-pricing the SAME July usage later must still land on July's rate.
  assert.equal(
    estimateCostUsd('claude', 'claude-sonnet-5', 1_000_000, 500_000, '2026-07-15'),
    julyCost,
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
  // claude-sonnet-5: $2/M in, $10/M out (introductory window)
  const cost = estimateCostUsd('claude', 'claude-sonnet-5', 1_000_000, 500_000, '2026-08-01');
  assert.equal(cost, 2 + 5);
});

test('estimateCostUsd prices a cache read far below the base input rate', () => {
  // claude-sonnet-5 intro: $2/M input, $0.2/M cache read. 900k plain +
  // 100k cache read (a SUBSET of the 1M input, not additional).
  const cost = estimateCostUsd(
    'claude',
    'claude-sonnet-5',
    1_000_000,
    0,
    '2026-08-01',
    100_000,
    0,
  );
  assert.equal(cost, 0.9 * 2 + 0.1 * 0.2);
});

test('estimateCostUsd prices a cache write ABOVE the base input rate, not below', () => {
  // claude-sonnet-5 intro: $2/M input, $2.5/M cache write (1.25x, a markup
  // for priming the cache, not a discount).
  const cost = estimateCostUsd(
    'claude',
    'claude-sonnet-5',
    1_000_000,
    0,
    '2026-08-01',
    0,
    200_000,
  );
  assert.equal(cost, 0.8 * 2 + 0.2 * 2.5);
  assert.ok(cost! > estimateCostUsd('claude', 'claude-sonnet-5', 1_000_000, 0, '2026-08-01')!);
});

test('estimateCostUsd falls back to the base input rate for an unverified cache rate', () => {
  // grok-4.5 has no verified cache rate — a "cache read" there must cost
  // exactly the same as plain input, not a fabricated discount.
  const withCache = estimateCostUsd('grok', 'grok-4.5', 1_000_000, 0, undefined, 500_000, 0);
  const withoutCache = estimateCostUsd('grok', 'grok-4.5', 1_000_000, 0);
  assert.equal(withCache, withoutCache);
});

test('estimateCostUsd never double-counts cache tokens against the input total', () => {
  // cacheRead + cacheCreation reported as MORE than input must clamp, not
  // produce a negative "plain input" remainder.
  const cost = estimateCostUsd(
    'claude',
    'claude-sonnet-5',
    1_000_000,
    0,
    '2026-08-01',
    900_000,
    900_000, // together this overshoots the 1M input total
  );
  // Clamped: 900k cache read + 100k cache write (whatever's left), 0 plain.
  assert.equal(cost, 0.9 * 0.2 + 0.1 * 2.5);
});

test('estimateCostUsd returns null (never a guess) for an unpriced model', () => {
  assert.equal(estimateCostUsd('claude', 'brand-new-unlisted-model', 1000, 1000), null);
});

test('estimateCostUsd treats missing/negative token counts as zero, not NaN', () => {
  assert.equal(estimateCostUsd('claude', 'claude-sonnet-5', null, undefined), 0);
  assert.equal(estimateCostUsd('claude', 'claude-sonnet-5', -500, -500), 0);
});
