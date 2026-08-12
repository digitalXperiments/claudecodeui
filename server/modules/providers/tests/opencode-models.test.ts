import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildOpenCodeDefinitionFromVerboseModels,
  buildOpenCodeDefinitionFromIds,
  parseOpenCodeModelsStdout,
  parseOpenCodeVerboseModelsStdout,
} from '@/modules/providers/list/opencode/opencode-models.provider.js';

test('OpenCode models provider parses plain CLI output and removes duplicates', () => {
  const ids = parseOpenCodeModelsStdout(`
opencode/big-pickle
not a model
anthropic/claude-opus-4-7-fast
anthropic/claude-opus-4-7-fast
openai/gpt-5.5-pro
openrouter/z-ai/glm-5.2
openrouter/openai/gpt-oss-20b:free
`);

  assert.deepEqual(ids, [
    'opencode/big-pickle',
    'anthropic/claude-opus-4-7-fast',
    'openai/gpt-5.5-pro',
    'openrouter/z-ai/glm-5.2',
    'openrouter/openai/gpt-oss-20b:free',
  ]);
});

test('OpenCode models provider formats frontend labels from provider-prefixed ids', () => {
  const definition = buildOpenCodeDefinitionFromIds([
    'opencode/deepseek-v4-flash-free',
    'opencode/nemotron-3-super-free',
    'anthropic/claude-3-5-sonnet-20241022',
    'anthropic/claude-opus-4-7-fast',
    'google/model-alpha',
    'openai/gpt-5.4-mini-fast',
    'openai/gpt-5.5-pro',
    'newprovider/alpha-v12-special-20261231',
  ]);

  assert.deepEqual(definition.OPTIONS, [
    {
      value: 'opencode/deepseek-v4-flash-free',
      label: 'Deepseek V4 Flash Free',
      description: 'opencode - opencode/deepseek-v4-flash-free',
    },
    {
      value: 'opencode/nemotron-3-super-free',
      label: 'Nemotron 3 Super Free',
      description: 'opencode - opencode/nemotron-3-super-free',
    },
    {
      value: 'anthropic/claude-3-5-sonnet-20241022',
      label: 'Claude 3.5 Sonnet (2024-10-22)',
      description: 'anthropic - anthropic/claude-3-5-sonnet-20241022',
    },
    {
      value: 'anthropic/claude-opus-4-7-fast',
      label: 'Claude Opus 4.7 Fast',
      description: 'anthropic - anthropic/claude-opus-4-7-fast',
    },
    {
      value: 'openai/gpt-5.4-mini-fast',
      label: 'GPT-5.4 Mini Fast',
      description: 'openai - openai/gpt-5.4-mini-fast',
    },
    {
      value: 'openai/gpt-5.5-pro',
      label: 'GPT-5.5 Pro',
      description: 'openai - openai/gpt-5.5-pro',
    },
    {
      value: 'newprovider/alpha-v12-special-20261231',
      label: 'Alpha V12 Special (2026-12-31)',
      description: 'newprovider - newprovider/alpha-v12-special-20261231',
    },
  ]);
});

test('OpenCode models provider maps verbose model variants to effort options', () => {
  const models = parseOpenCodeVerboseModelsStdout(`
opencode/deepseek-v4-flash-free
{
  "id": "deepseek-v4-flash-free",
  "providerID": "opencode",
  "name": "DeepSeek V4 Flash Free",
  "variants": {
    "low": {
      "reasoningEffort": "low"
    },
    "high": {
      "reasoningEffort": "high"
    }
  }
}
anthropic/claude-sonnet-5
{
  "id": "claude-sonnet-5",
  "providerID": "anthropic",
  "name": "Claude Sonnet 5",
  "variants": {
    "low": {
      "effort": "low"
    },
    "max": {
      "effort": "max"
    }
  }
}
google/model-alpha
{
  "id": "model-alpha",
  "providerID": "google",
  "name": "Model Alpha"
}
`);

  const definition = buildOpenCodeDefinitionFromVerboseModels(models);

  assert.deepEqual(definition.OPTIONS, [
    {
      value: 'opencode/deepseek-v4-flash-free',
      label: 'DeepSeek V4 Flash Free',
      description: 'opencode - opencode/deepseek-v4-flash-free',
      effort: {
        values: [
          { value: 'low' },
          { value: 'high' },
        ],
      },
    },
    {
      value: 'anthropic/claude-sonnet-5',
      label: 'Claude Sonnet 5',
      description: 'anthropic - anthropic/claude-sonnet-5',
      effort: {
        values: [
          { value: 'low' },
          { value: 'max' },
        ],
      },
    },
  ]);
});

test('OpenCode verbose models preserve nested canonical provider ids', () => {
  const models = parseOpenCodeVerboseModelsStdout(`
openrouter/z-ai/glm-5.2
{
  "id": "z-ai/glm-5.2",
  "providerID": "openrouter",
  "name": "GLM-5.2",
  "status": "active",
  "capabilities": {
    "toolcall": true,
    "input": { "text": true },
    "output": { "text": true }
  }
}
openrouter/openai/gpt-oss-20b:free
{
  "id": "openai/gpt-oss-20b:free",
  "providerID": "openrouter",
  "name": "GPT OSS 20B Free",
  "status": "active",
  "capabilities": {
    "toolcall": true,
    "input": { "text": true },
    "output": { "text": true }
  }
}
`);

  const definition = buildOpenCodeDefinitionFromVerboseModels(models);
  assert.deepEqual(
    definition.OPTIONS.map((option) => option.value),
    ['openrouter/z-ai/glm-5.2', 'openrouter/openai/gpt-oss-20b:free'],
  );
});

test('OpenCode verbose models exclude inactive, non-text, and no-tool entries', () => {
  const compatible = {
    id: 'coding-model',
    providerID: 'vendor',
    name: 'Coding Model',
    status: 'active',
    capabilities: {
      toolcall: true,
      input: { text: true },
      output: { text: true },
    },
  };
  const definition = buildOpenCodeDefinitionFromVerboseModels([
    compatible,
    { ...compatible, id: 'retired', status: 'deprecated' },
    {
      ...compatible,
      id: 'image-only',
      capabilities: { ...compatible.capabilities, output: { text: false } },
    },
    {
      ...compatible,
      id: 'no-text-input',
      capabilities: { ...compatible.capabilities, input: { text: false } },
    },
    {
      ...compatible,
      id: 'no-tools',
      capabilities: { ...compatible.capabilities, toolcall: false },
    },
  ]);

  assert.deepEqual(definition.OPTIONS.map((option) => option.value), ['vendor/coding-model']);
});
