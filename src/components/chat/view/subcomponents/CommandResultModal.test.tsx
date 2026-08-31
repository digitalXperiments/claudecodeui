import assert from 'node:assert/strict';
import test from 'node:test';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import type { ModelCommandData } from '../../hooks/useChatComposerState';
import type { ProviderModelsDefinition } from '../../../../types/app';
import type { ProviderAuthStatus, ProviderAuthStatusMap } from '../../../provider-auth/types';

import { OMP_FALLBACK_DEFAULT_MODEL } from '../../../../utils/providerModels';
import { ModelsContent } from './CommandResultModal';

const noop = () => {};
const neverSelect = async () => ({ scope: 'default' as const, changed: false, model: '' });

const baseData: ModelCommandData = {
  current: { provider: 'omp', providerLabel: 'Oh My Pi', model: 'openai-codex/gpt-5.6-luna' },
};

const authStatus = (overrides: Partial<ProviderAuthStatus>): ProviderAuthStatus => ({
  installed: null,
  authenticated: false,
  email: null,
  method: null,
  error: null,
  loading: false,
  ...overrides,
});

const renderModels = (overrides: {
  data?: ModelCommandData;
  catalog?: Partial<Record<'omp', ProviderModelsDefinition>>;
  providerAuthStatus?: Partial<ProviderAuthStatusMap>;
  providerModelErrors?: Record<string, string | null>;
} = {}) => renderToStaticMarkup(
  <ModelsContent
    data={overrides.data ?? baseData}
    providerModelCatalog={(overrides.catalog ?? {}) as any}
    providerModelsRefreshing={false}
    providerModelErrors={overrides.providerModelErrors}
    providerAuthStatus={overrides.providerAuthStatus}
    onHardRefreshProviderModels={noop}
    currentSessionId={null}
    onSelectProviderModel={neverSelect}
    onSwitchSessionTarget={undefined}
    onClose={noop}
  />,
);

test('ModelsContent filters out decorative and header rows leaked from a malformed catalog', () => {
  const html = renderModels({
    catalog: {
      omp: {
        OPTIONS: [
          { value: 'openai-codex/gpt-5.6-luna', label: 'GPT-5.6 Luna', description: 'openai-codex' },
          { value: '───────────', label: '───────────' },
          { value: '┌────────┐', label: '┌────────┐' },
          { value: '╔════════╗', label: '╔════════╗' },
          { value: '┏━━━━━━━━┓', label: '┏━━━━━━━━┓' },
          { value: 'provider', label: 'provider' },
          { value: '', label: '' },
        ],
        DEFAULT: 'openai-codex/gpt-5.6-luna',
      },
    },
  });

  assert.ok(html.includes('gpt-5.6-luna') || html.includes('openai-codex/gpt-5.6-luna'));
  assert.ok(!html.includes('───'));
  assert.ok(!html.includes('═══'));
  assert.ok(!html.includes('━━━'));
  // The header word alone must never render as a selectable model card.
  assert.ok(!/>provider</.test(html));
});

test('OMP frontend fallback matches the backend fallback default', () => {
  assert.equal(OMP_FALLBACK_DEFAULT_MODEL, 'openai-codex/gpt-5.4');
});

test('ModelsContent renders duplicate model ids from different sub-providers distinctly', () => {
  const html = renderModels({
    catalog: {
      omp: {
        OPTIONS: [
          { value: 'openai-codex/gpt-5.6-luna', label: 'GPT-5.6 Luna', description: 'openai-codex' },
          { value: 'openrouter/gpt-5.6-luna', label: 'GPT-5.6 Luna', description: 'openrouter' },
        ],
        DEFAULT: 'openai-codex/gpt-5.6-luna',
      },
    },
  });

  assert.ok(html.includes('openai-codex'));
  assert.ok(html.includes('openrouter'));
  assert.ok(html.includes('openai-codex/gpt-5.6-luna'));
  assert.ok(html.includes('openrouter/gpt-5.6-luna'));
});

test('ModelsContent renders context and max-output metadata when the catalog supplies it', () => {
  const html = renderModels({
    catalog: {
      omp: {
        OPTIONS: [
          {
            value: 'openai-codex/gpt-5.6-luna',
            label: 'GPT-5.6 Luna',
            description: 'openai-codex',
            runtimeContextWindow: 200000,
            runtimeMaxOutputTokens: 8000,
          },
        ],
        DEFAULT: 'openai-codex/gpt-5.6-luna',
      },
    },
  });

  assert.ok(html.includes('200k context'));
  assert.ok(html.includes('8k max output'));
});

test('ModelsContent disables selection and shows guidance when OMP is not authenticated', () => {
  const html = renderModels({
    catalog: {
      omp: {
        OPTIONS: [{ value: 'openai-codex/gpt-5.6-luna', label: 'GPT-5.6 Luna', description: 'openai-codex' }],
        DEFAULT: 'openai-codex/gpt-5.6-luna',
      },
    },
    providerAuthStatus: {
      omp: authStatus({ installed: true, authenticated: false, error: 'Not logged in — run `omp` and use /login' }),
    },
  });

  assert.ok(html.includes('Not logged in'));
  assert.match(html, /disabled=""/);
});

test('ModelsContent does not gate selection while auth status is still loading', () => {
  const html = renderModels({
    catalog: {
      omp: {
        OPTIONS: [{ value: 'openai-codex/gpt-5.6-luna', label: 'GPT-5.6 Luna', description: 'openai-codex' }],
        DEFAULT: 'openai-codex/gpt-5.6-luna',
      },
    },
    providerAuthStatus: {
      omp: authStatus({ installed: null, authenticated: false, loading: true }),
    },
  });

  assert.ok(!/disabled=""/.test(html));
  assert.ok(html.includes('Checking Oh My Pi connection'));
});

test('ModelsContent shows a distinct empty-catalog message vs a no-search-matches message', () => {
  const emptyHtml = renderModels({ catalog: { omp: { OPTIONS: [], DEFAULT: '' } } });
  assert.ok(emptyHtml.includes('No models available for Oh My Pi.'));
});

test('ModelsContent surfaces a stale-data warning without hiding the last known models', () => {
  const html = renderModels({
    catalog: {
      omp: {
        OPTIONS: [{ value: 'openai-codex/gpt-5.6-luna', label: 'GPT-5.6 Luna', description: 'openai-codex' }],
        DEFAULT: 'openai-codex/gpt-5.6-luna',
      },
    },
    providerModelErrors: { omp: 'Request timed out' },
  });

  assert.ok(html.includes('Request timed out'));
  assert.ok(html.includes('openai-codex/gpt-5.6-luna'));
});
