import assert from 'node:assert/strict';
import test from 'node:test';

import type { ProviderModelsDefinition } from '../types/app';

import {
  findProviderModelOption,
  isProviderModelMatch,
  resolveProviderModelLabel,
} from './providerModels';

const catalog: ProviderModelsDefinition = {
  OPTIONS: [
    { value: 'opus', label: 'Claude Opus 4.5', resolvedModel: 'claude-opus-5-20260101' },
    { value: 'anthropic/claude-sonnet-4-5', label: 'Anthropic · Claude Sonnet 4.5' },
    { value: 'opencode/big-pickle', label: 'OpenCode · Big Pickle' },
    { value: 'openrouter/z-ai/glm-5.2', label: 'OpenRouter · GLM 5.2' },
  ],
  DEFAULT: 'opus',
};

test('findProviderModelOption matches a Claude alias by its picker value', () => {
  const option = findProviderModelOption(catalog, 'opus');
  assert.equal(option?.label, 'Claude Opus 4.5');
});

test('findProviderModelOption matches a Claude alias by its resolved concrete id', () => {
  const option = findProviderModelOption(catalog, 'claude-opus-5-20260101');
  assert.equal(option?.value, 'opus');
  assert.equal(option?.label, 'Claude Opus 4.5');
});

test('findProviderModelOption returns null for an unknown model', () => {
  assert.equal(findProviderModelOption(catalog, 'unknown/model'), null);
  assert.equal(findProviderModelOption(catalog, ''), null);
  assert.equal(findProviderModelOption(undefined, 'opus'), null);
});

test('isProviderModelMatch accepts either the alias value or the resolved id', () => {
  const option = catalog.OPTIONS[0];
  assert.equal(isProviderModelMatch(option, 'opus'), true);
  assert.equal(isProviderModelMatch(option, 'claude-opus-5-20260101'), true);
  assert.equal(isProviderModelMatch(option, 'something-else'), false);
});

test('resolveProviderModelLabel returns the canonical provider-qualified label', () => {
  assert.equal(resolveProviderModelLabel(catalog, 'opencode/big-pickle'), 'OpenCode · Big Pickle');
  assert.equal(resolveProviderModelLabel(catalog, 'openrouter/z-ai/glm-5.2'), 'OpenRouter · GLM 5.2');
  assert.equal(resolveProviderModelLabel(catalog, 'anthropic/claude-sonnet-4-5'), 'Anthropic · Claude Sonnet 4.5');
});

test('resolveProviderModelLabel falls back to the raw model id when the catalog has no match', () => {
  assert.equal(resolveProviderModelLabel(catalog, 'brand-new/unreleased-model'), 'brand-new/unreleased-model');
  assert.equal(resolveProviderModelLabel(catalog, null), null);
});
