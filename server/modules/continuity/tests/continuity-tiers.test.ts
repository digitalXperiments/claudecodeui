import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getTierForProviderDefault,
  listProviderTiers,
  pickEquivalentModel,
  resolveModelTier,
} from '../continuity-tiers.js';

test('resolves representative provider models to capability tiers', () => {
  assert.equal(resolveModelTier('claude', 'claude-opus-4-1'), 'frontier');
  assert.equal(resolveModelTier('claude', 'claude-3-7-sonnet-thinking'), 'frontier');
  assert.equal(resolveModelTier('claude', 'claude-3.5-haiku'), 'fast');
  assert.equal(resolveModelTier('codex', 'gpt-4o'), 'frontier');
  assert.equal(resolveModelTier('codex', 'o3-mini'), 'frontier');
  assert.equal(resolveModelTier('codex', 'o3-mini-low'), 'fast');
  assert.equal(resolveModelTier('opencode', 'deepseek/deepseek-r1'), 'frontier');
  assert.equal(resolveModelTier('antigravity', 'gemini-2.5-flash'), 'balanced');
  assert.equal(resolveModelTier('unknown-provider', 'gpt-4o'), 'unknown');
  assert.equal(resolveModelTier('claude', null), 'unknown');
});

test('picks the first model in the requested tier from an available catalog', () => {
  assert.deepEqual(pickEquivalentModel('opencode', 'frontier', [
    { value: 'anthropic/claude-3.5-haiku' },
    { value: 'openai/gpt-4o' },
    { value: 'anthropic/claude-3.5-sonnet' },
  ]), { model: 'openai/gpt-4o', tierMatch: 'exact' });
});

test('falls back gracefully to the nearest tier and reports its direction', () => {
  assert.deepEqual(pickEquivalentModel('cursor', 'frontier', [
    { value: 'claude-3.5-haiku' },
    { value: 'claude-3.5-sonnet' },
  ]), { model: 'claude-3.5-sonnet', tierMatch: 'downgraded' });

  assert.deepEqual(pickEquivalentModel('cursor', 'fast', [
    { value: 'gpt-4o' },
  ]), { model: 'gpt-4o', tierMatch: 'upgraded' });

  assert.deepEqual(pickEquivalentModel('cursor', 'unknown', []), {
    model: null,
    tierMatch: 'default',
  });
});

test('reports provider defaults', () => {
  assert.equal(getTierForProviderDefault('claude'), 'balanced');
  assert.equal(getTierForProviderDefault('not-real'), 'unknown');
  assert.deepEqual(listProviderTiers().antigravity, {
    tier: 'frontier',
    defaultModel: 'gemini-2.5-pro',
  });
});
