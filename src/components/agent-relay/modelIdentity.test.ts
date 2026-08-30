import assert from 'node:assert/strict';
import test from 'node:test';

import { formatAgentRelayModelIdentity } from './modelIdentity';

test('formats catalog labels with the exact selected OpenCode id', () => {
  assert.equal(formatAgentRelayModelIdentity({
    model: 'openrouter/z-ai/glm-5.2',
    model_label: 'OpenRouter · GLM 5.2',
    catalog_resolved_model: null,
    runtime_resolved_model: null,
    model_selection_source: 'requested',
  }), 'OpenRouter · GLM 5.2 (openrouter/z-ai/glm-5.2)');
});

test('shows Claude default and the freshest runtime-resolved identity', () => {
  assert.equal(formatAgentRelayModelIdentity({
    model: 'default',
    model_label: 'Default (recommended)',
    catalog_resolved_model: 'claude-opus-5',
    runtime_resolved_model: 'claude-sonnet-5',
    model_selection_source: 'catalog_default',
  }), 'Default (recommended) (default → claude-sonnet-5)');
});

test('describes legacy null models without inventing a concrete default', () => {
  assert.equal(formatAgentRelayModelIdentity({
    model: null,
    model_label: null,
    catalog_resolved_model: null,
    runtime_resolved_model: null,
    model_selection_source: null,
  }), 'Legacy default (model not recorded)');
});
