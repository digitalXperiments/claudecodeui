import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildOpenCodeDefinitionFromVerboseModels,
  buildOpenCodeDefinitionFromIds,
  OPENCODE_FALLBACK_MODELS,
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
      label: 'OpenCode · Deepseek V4 Flash Free',
      description: 'opencode - opencode/deepseek-v4-flash-free',
    },
    {
      value: 'opencode/nemotron-3-super-free',
      label: 'OpenCode · Nemotron 3 Super Free',
      description: 'opencode - opencode/nemotron-3-super-free',
    },
    {
      value: 'anthropic/claude-3-5-sonnet-20241022',
      label: 'Anthropic · Claude 3.5 Sonnet (2024-10-22)',
      description: 'anthropic - anthropic/claude-3-5-sonnet-20241022',
    },
    {
      value: 'anthropic/claude-opus-4-7-fast',
      label: 'Anthropic · Claude Opus 4.7 Fast',
      description: 'anthropic - anthropic/claude-opus-4-7-fast',
    },
    {
      value: 'openai/gpt-5.4-mini-fast',
      label: 'OpenAI · GPT-5.4 Mini Fast',
      description: 'openai - openai/gpt-5.4-mini-fast',
    },
    {
      value: 'openai/gpt-5.5-pro',
      label: 'OpenAI · GPT-5.5 Pro',
      description: 'openai - openai/gpt-5.5-pro',
    },
    {
      value: 'newprovider/alpha-v12-special-20261231',
      label: 'Newprovider · Alpha V12 Special (2026-12-31)',
      description: 'newprovider - newprovider/alpha-v12-special-20261231',
    },
  ]);
});

test('OpenCode model labels distinguish same-named models by provider without changing values', () => {
  const definition = buildOpenCodeDefinitionFromIds([
    'openrouter/llama-3.3-70b',
    'xai/llama-3.3-70b',
    'opencode-go/llama-3.3-70b',
  ]);

  assert.deepEqual(definition.OPTIONS, [
    {
      value: 'openrouter/llama-3.3-70b',
      label: 'OpenRouter · Llama 3.3 70b',
      description: 'openrouter - openrouter/llama-3.3-70b',
    },
    {
      value: 'xai/llama-3.3-70b',
      label: 'xAI · Llama 3.3 70b',
      description: 'xai - xai/llama-3.3-70b',
    },
    {
      value: 'opencode-go/llama-3.3-70b',
      label: 'OpenCode Go · Llama 3.3 70b',
      description: 'opencode-go - opencode-go/llama-3.3-70b',
    },
  ]);
});

test('OpenCode catalog omits NVIDIA ids (retired hosted deepseek-v4-flash etc.) but keeps opencode-go ids', () => {
  const definition = buildOpenCodeDefinitionFromIds([
    'nvidia/deepseek-ai/deepseek-v4-flash',
    'nvidia/llama-3.3-70b',
    'opencode-go/deepseek-v4-flash',
    'opencode-go/nemotron-free',
    'opencode/nemotron-free',
  ]);

  assert.deepEqual(definition.OPTIONS.map((option) => option.value), [
    'opencode-go/deepseek-v4-flash',
    'opencode-go/nemotron-free',
    'opencode/nemotron-free',
  ]);

  const verboseModels = parseOpenCodeVerboseModelsStdout(`
nvidia/deepseek-ai/deepseek-v4-flash
{
  "id": "deepseek-ai/deepseek-v4-flash",
  "providerID": "nvidia",
  "name": "DeepSeek V4 Flash"
}
opencode-go/deepseek-v4-flash
{
  "id": "deepseek-v4-flash",
  "providerID": "opencode-go",
  "name": "DeepSeek V4 Flash"
}
`);

  const verboseDefinition = buildOpenCodeDefinitionFromVerboseModels(verboseModels);
  assert.deepEqual(verboseDefinition.OPTIONS.map((option) => option.value), [
    'opencode-go/deepseek-v4-flash',
  ]);
});

test('OpenCode fallback labels include provider names without changing fallback values', () => {
  assert.deepEqual(OPENCODE_FALLBACK_MODELS.OPTIONS.map((option) => ({
    value: option.value,
    label: option.label,
  })), [
    { value: 'anthropic/claude-sonnet-4-5', label: 'Anthropic · Claude Sonnet 4.5' },
    { value: 'anthropic/claude-opus-4-1', label: 'Anthropic · Claude Opus 4.1' },
    { value: 'anthropic/claude-haiku-4-5', label: 'Anthropic · Claude Haiku 4.5' },
    { value: 'openai/gpt-5.1', label: 'OpenAI · GPT-5.1' },
    { value: 'openai/gpt-5.1-codex', label: 'OpenAI · GPT-5.1 Codex' },
    { value: 'openai/gpt-5.4-mini', label: 'OpenAI · GPT-5.4 Mini' },
  ]);
  assert.equal(OPENCODE_FALLBACK_MODELS.DEFAULT, 'anthropic/claude-sonnet-4-5');
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
      label: 'OpenCode · DeepSeek V4 Flash Free',
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
      label: 'Anthropic · Claude Sonnet 5',
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
    definition.OPTIONS.map((option) => ({ value: option.value, label: option.label })),
    [
      { value: 'openrouter/z-ai/glm-5.2', label: 'OpenRouter · GLM-5.2' },
      { value: 'openrouter/openai/gpt-oss-20b:free', label: 'OpenRouter · GPT OSS 20B Free' },
    ],
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
