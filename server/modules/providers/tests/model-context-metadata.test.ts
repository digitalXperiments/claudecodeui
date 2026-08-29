import assert from 'node:assert/strict';
import test from 'node:test';

import { buildCodexModelsDefinition } from '@/modules/providers/list/codex/codex-models.provider.js';
import { mapGrokModel } from '@/modules/providers/list/grok/grok-models.provider.js';

test('Codex catalog preserves active and maximum runtime context separately', () => {
  const definition = buildCodexModelsDefinition([{
    slug: 'gpt-5.6-luna',
    display_name: 'GPT-5.6-Luna',
    visibility: 'list',
    supported_in_api: true,
    priority: 1,
    context_window: 272_000,
    max_context_window: 872_000,
  }]);

  assert.equal(definition.OPTIONS[0]?.runtimeContextWindow, 272_000);
  assert.equal(definition.OPTIONS[0]?.runtimeMaxContextWindow, 872_000);
});

test('Grok catalog preserves the runtime context advertised by its cache', () => {
  const option = mapGrokModel('grok-4.6', {
    name: 'Grok 4.6',
    context_window: 500_000,
  });

  assert.equal(option.runtimeContextWindow, 500_000);
  assert.equal(option.runtimeMaxContextWindow, undefined);
});
