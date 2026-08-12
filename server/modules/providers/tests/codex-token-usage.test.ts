import assert from 'node:assert/strict';
import test from 'node:test';

import { buildCodexTokenUsage } from '@/modules/providers/list/codex/codex-token-usage.js';

test('Codex usage separates current context from cumulative session usage', () => {
  const usage = buildCodexTokenUsage({
    total: {
      inputTokens: 1_569_489,
      cachedInputTokens: 1_550_000,
      outputTokens: 5_774,
      totalTokens: 1_575_263,
    },
    last: {
      inputTokens: 156_989,
      cachedInputTokens: 155_392,
      outputTokens: 1_321,
      totalTokens: 158_310,
    },
    modelContextWindow: 258_400,
    model: 'gpt-5.6-luna',
  });

  assert.deepEqual(usage, {
    used: 158_310,
    total: 258_400,
    contextUsed: 158_310,
    contextWindow: 258_400,
    contextFree: 100_090,
    contextPercent: 61.3,
    cumulativeUsed: 1_575_263,
    billedInputTokens: 1_569_489,
    billedOutputTokens: 5_774,
    lastTurnInputTokens: 156_989,
    lastTurnOutputTokens: 1_321,
    inputTokens: 156_989,
    outputTokens: 1_321,
    breakdown: { input: 156_989, output: 1_321 },
    model: 'gpt-5.6-luna',
    cacheReadTokens: 1_550_000,
  });
});

test('Codex usage normalizes rollout JSONL snake_case fields', () => {
  const usage = buildCodexTokenUsage({
    total: {
      input_tokens: 500,
      output_tokens: 25,
      total_tokens: 525,
    },
    last: {
      input_tokens: 120,
      output_tokens: 5,
      total_tokens: 125,
    },
    modelContextWindow: 1_000,
  });

  assert.equal(usage?.contextUsed, 125);
  assert.equal(usage?.cumulativeUsed, 525);
  assert.equal(usage?.contextFree, 875);
  assert.equal(usage?.billedInputTokens, 500);
  assert.equal(usage?.lastTurnOutputTokens, 5);
});

test('Codex usage does not invent context occupancy without a last-turn record', () => {
  const usage = buildCodexTokenUsage({
    total: { inputTokens: 500, outputTokens: 25, totalTokens: 525 },
    modelContextWindow: 1_000,
  });

  assert.equal(usage?.used, 525);
  assert.equal(usage?.contextUsed, 0);
  assert.equal(usage?.contextFree, 0);
  assert.equal(usage?.contextPercent, null);
});
