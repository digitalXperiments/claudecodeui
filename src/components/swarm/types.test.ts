import assert from 'node:assert/strict';
import test from 'node:test';

import type { ProviderModelOption } from '../../types/app';

import {
  clampEffort,
  clampPermissionMode,
  defaultRoster,
  effortOptionsForProvider,
} from './types';

test('defaultRoster defaults the orchestrator seat to bypassPermissions', () => {
  const roster = defaultRoster();
  const orchestrator = roster.find((a) => a.kind === 'orchestrator');
  assert.ok(orchestrator);
  assert.equal(orchestrator!.permissionMode, 'bypassPermissions');
});

test('clampPermissionMode falls back to the provider default when a mode is unsupported', () => {
  // opencode has no bypassPermissions mode; clamp must not invent one.
  assert.equal(clampPermissionMode('opencode', 'bypassPermissions'), 'default');
  assert.equal(clampPermissionMode('claude', 'bypassPermissions'), 'bypassPermissions');
});

test('effortOptionsForProvider falls back to the static provider list before the catalog loads', () => {
  assert.deepEqual(
    effortOptionsForProvider('grok', null, []).map((o) => o.value),
    ['low', 'medium', 'high'],
  );
  assert.deepEqual(
    effortOptionsForProvider('claude', null, []).map((o) => o.value),
    ['low', 'medium', 'high', 'xhigh', 'max'],
  );
});

test('effortOptionsForProvider never offers xhigh/max for grok once the catalog loads', () => {
  const grokModels: ProviderModelOption[] = [
    { value: 'grok-4.5', label: 'Grok 4.5', effort: { default: 'medium', values: [{ value: 'low' }, { value: 'medium' }, { value: 'high' }] } },
  ];
  assert.deepEqual(
    effortOptionsForProvider('grok', 'grok-4.5', grokModels).map((o) => o.value),
    ['low', 'medium', 'high'],
  );
});

test('effortOptionsForProvider returns no options for a known model without effort support, even after the catalog loads', () => {
  // A model that IS in the loaded catalog but reports no effort metadata is a
  // real capability fact — it must not fall back to the provider-wide list
  // (which could offer options like xhigh/max the model doesn't accept).
  const models: ProviderModelOption[] = [
    { value: 'kimi-for-coding', label: 'Kimi for Coding' },
  ];
  assert.deepEqual(effortOptionsForProvider('kimi', 'kimi-for-coding', models), []);
});

test('effortOptionsForProvider returns no options for an unrecognized model once the catalog has loaded', () => {
  const models: ProviderModelOption[] = [{ value: 'claude-opus-5', label: 'Opus 5' }];
  assert.deepEqual(effortOptionsForProvider('claude', 'not-a-real-model', models), []);
});

test('clampEffort resets an unsupported persisted value to default', () => {
  // xhigh/max were previously offered for every provider — grok never supported them.
  assert.equal(clampEffort('grok', 'grok-4.5', 'xhigh'), 'default');
  assert.equal(clampEffort('grok', 'grok-4.5', 'max'), 'default');
  assert.equal(clampEffort('grok', 'grok-4.5', 'medium'), 'medium');
});

test('clampEffort passes through "default" and empty values unchanged', () => {
  assert.equal(clampEffort('grok', 'grok-4.5', 'default'), 'default');
  assert.equal(clampEffort('grok', 'grok-4.5', null), 'default');
  assert.equal(clampEffort('grok', 'grok-4.5', undefined), 'default');
});
