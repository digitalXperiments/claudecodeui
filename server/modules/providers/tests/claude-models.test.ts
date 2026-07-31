import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildClaudeModelsDefinition,
  toClaudeProviderModelOption,
} from '@/modules/providers/list/claude/claude-models.probe.js';
import {
  CLAUDE_FALLBACK_MODELS,
  findClaudeModelOption,
  findClaudeModelOptionIn,
} from '@/modules/providers/list/claude/claude-models.provider.js';

test('Claude models provider maps live CLI model info into catalog options', () => {
  const option = toClaudeProviderModelOption({
    value: 'opus[1m]',
    resolvedModel: 'claude-opus-5[1m]',
    displayName: 'Opus (1M context)',
    description: 'Opus 5 with 1M context · Best for everyday, complex tasks',
    supportsEffort: true,
    supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
  });

  assert.deepEqual(option, {
    value: 'opus[1m]',
    label: 'Opus (1M context)',
    description: 'Opus 5 with 1M context · Best for everyday, complex tasks',
    resolvedModel: 'claude-opus-5[1m]',
    effort: {
      default: 'high',
      values: [
        { value: 'low' },
        { value: 'medium' },
        { value: 'high' },
        { value: 'xhigh' },
        { value: 'max' },
      ],
    },
  });
});

test('Claude models provider omits effort for models that do not support it', () => {
  const option = toClaudeProviderModelOption({
    value: 'haiku',
    resolvedModel: 'claude-haiku-4-5-20251001',
    displayName: 'Haiku',
    description: 'Haiku 4.5 · Fastest for quick answers',
  });

  assert.equal(option?.effort, undefined);
  assert.equal(option?.resolvedModel, 'claude-haiku-4-5-20251001');
});

test('Claude models provider falls back to the last effort level when high is unsupported', () => {
  const option = toClaudeProviderModelOption({
    value: 'future',
    displayName: 'Future',
    supportsEffort: true,
    supportedEffortLevels: ['low', 'medium'],
  });

  assert.equal(option?.effort?.default, 'medium');
});

test('Claude models definition keeps CLI order, drops junk, and preserves the default', () => {
  const definition = buildClaudeModelsDefinition(
    [
      { value: 'default', displayName: 'Default (recommended)', resolvedModel: 'claude-opus-5[1m]' },
      { value: '  ' },
      { value: 'sonnet', displayName: 'Sonnet', resolvedModel: 'claude-sonnet-5' },
      { value: 'sonnet', displayName: 'Sonnet duplicate' },
    ],
    'default',
  );

  assert.deepEqual(definition?.OPTIONS.map((option) => option.value), ['default', 'sonnet']);
  assert.equal(definition?.DEFAULT, 'default');
});

test('Claude models definition falls back to the first option when the default is missing', () => {
  const definition = buildClaudeModelsDefinition(
    [{ value: 'sonnet', displayName: 'Sonnet' }],
    'default',
  );

  assert.equal(definition?.DEFAULT, 'sonnet');
});

test('Claude models definition returns null when the CLI reports nothing usable', () => {
  assert.equal(buildClaudeModelsDefinition([], 'default'), null);
  assert.equal(buildClaudeModelsDefinition([{ displayName: 'No value' }], 'default'), null);
});

test('Claude model lookup matches both aliases and resolved model ids', () => {
  const definition = {
    OPTIONS: [
      { value: 'opus[1m]', label: 'Opus (1M context)', resolvedModel: 'claude-opus-5[1m]' },
      { value: 'sonnet', label: 'Sonnet', resolvedModel: 'claude-sonnet-5' },
    ],
    DEFAULT: 'opus[1m]',
  };

  assert.equal(findClaudeModelOptionIn(definition, 'sonnet')?.label, 'Sonnet');
  assert.equal(findClaudeModelOptionIn(definition, ' claude-opus-5[1m] ')?.label, 'Opus (1M context)');
  assert.equal(findClaudeModelOptionIn(definition, 'claude-haiku-4-5'), null);
  assert.equal(findClaudeModelOptionIn(definition, ''), null);
  assert.equal(findClaudeModelOption('opus')?.label, 'Opus');
});

test('Claude fallback catalog does not hardcode model generations', () => {
  for (const option of CLAUDE_FALLBACK_MODELS.OPTIONS) {
    const text = `${option.label} ${option.description ?? ''}`;
    assert.ok(
      !/\d+\.\d+/.test(text),
      `Fallback catalog entry "${option.value}" names a model version ("${text.trim()}"), which goes stale when the CLI remaps the alias`,
    );
  }
});
