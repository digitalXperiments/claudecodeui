import assert from 'node:assert/strict';
import test from 'node:test';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import type { ModelCommandData } from '../../hooks/useChatComposerState';
import type { ProviderModelsDefinition } from '../../../../types/app';
import type { ProviderAuthStatus, ProviderAuthStatusMap } from '../../../provider-auth/types';

import { OMP_FALLBACK_DEFAULT_MODEL } from '../../../../utils/providerModels';
import { FALLBACK_PERMISSION_MODES } from '../../hooks/useChatProviderState';
import { ModelsContent, StartingPermissionsPicker } from './CommandResultModal';
import type { PermissionMode } from '../../types/types';

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
  catalog?: Partial<Record<string, ProviderModelsDefinition>>;
  providerAuthStatus?: Partial<ProviderAuthStatusMap>;
  providerModelErrors?: Record<string, string | null>;
  currentPermissionMode?: PermissionMode;
  getPermissionModesForProvider?: (provider: any) => PermissionMode[];
  getDefaultPermissionModeForProvider?: (provider: any) => PermissionMode;
  initialPendingSwitch?: { provider: any; model: string } | null;
} = {}) => renderToStaticMarkup(
  <ModelsContent
    data={overrides.data ?? baseData}
    providerModelCatalog={(overrides.catalog ?? {}) as any}
    providerModelsRefreshing={false}
    providerModelErrors={overrides.providerModelErrors}
    providerAuthStatus={overrides.providerAuthStatus}
    onHardRefreshProviderModels={noop}
    currentSessionId={null}
    currentPermissionMode={overrides.currentPermissionMode}
    getPermissionModesForProvider={overrides.getPermissionModesForProvider}
    getDefaultPermissionModeForProvider={overrides.getDefaultPermissionModeForProvider}
    initialPendingSwitch={overrides.initialPendingSwitch}
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

test('ModelsContent shows the active session permission mode next to the model', () => {
  const html = renderToStaticMarkup(
    <ModelsContent
      data={baseData}
      providerModelCatalog={{}}
      providerModelsRefreshing={false}
      onHardRefreshProviderModels={noop}
      currentSessionId={null}
      currentPermissionMode="plan"
      onSelectProviderModel={neverSelect}
      onSwitchSessionTarget={undefined}
      onClose={noop}
    />,
  );

  assert.ok(html.includes('data-testid="active-permission-badge"'));
  assert.ok(html.includes('Plan'));
});

test('StartingPermissionsPicker lists the target provider modes and marks the selected one', () => {
  const cursorModes = FALLBACK_PERMISSION_MODES.cursor;
  const html = renderToStaticMarkup(
    <StartingPermissionsPicker
      provider="cursor"
      modes={cursorModes}
      selectedMode="bypassPermissions"
      onSelect={noop}
    />,
  );

  assert.ok(html.includes('Starting permissions'));
  assert.ok(html.includes('data-testid="starting-permissions-section"'));
  assert.ok(html.includes('data-testid="permission-mode-option-default"'));
  assert.ok(html.includes('data-testid="permission-mode-option-bypassPermissions"'));
  assert.ok(!html.includes('data-testid="permission-mode-option-plan"'));
  assert.match(html, /aria-checked="true"[^>]*data-testid="permission-mode-option-bypassPermissions"/);
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

test('ModelsContent renders active permission badge in active model context bar', () => {
  const claudeData: ModelCommandData = {
    current: { provider: 'claude', providerLabel: 'Claude', model: 'claude-3-7-sonnet' },
  };

  const htmlAcceptEdits = renderModels({
    data: claudeData,
    currentPermissionMode: 'acceptEdits',
  });
  assert.ok(htmlAcceptEdits.includes('data-testid="active-permission-badge"'));
  assert.ok(htmlAcceptEdits.includes('Accept Edits'));
  assert.ok(htmlAcceptEdits.includes('bg-green-500'));

  const htmlBypass = renderModels({
    data: claudeData,
    currentPermissionMode: 'bypassPermissions',
  });
  assert.ok(htmlBypass.includes('data-testid="active-permission-badge"'));
  assert.ok(htmlBypass.includes('Bypass Permissions'));
  assert.ok(htmlBypass.includes('bg-orange-500'));
});

test('ModelsContent renders starting permissions section when switching models', () => {
  const html = renderModels({
    initialPendingSwitch: { provider: 'claude', model: 'claude-3-7-sonnet' },
  });

  assert.ok(html.includes('data-testid="starting-permissions-section"'));
  assert.ok(html.includes('Starting permissions'));
  assert.ok(html.includes('data-testid="permission-mode-option-default"'));
  assert.ok(html.includes('data-testid="permission-mode-option-bypassPermissions"'));
  assert.ok(html.includes('data-testid="permission-mode-option-acceptEdits"'));
  assert.ok(html.includes('data-testid="permission-mode-option-auto"'));
  assert.ok(html.includes('data-testid="permission-mode-option-plan"'));
});

test('ModelsContent restricts starting permission options based on target provider capabilities', () => {
  const html = renderModels({
    initialPendingSwitch: { provider: 'cursor', model: 'cursor-small' },
  });

  assert.ok(html.includes('data-testid="starting-permissions-section"'));
  assert.ok(html.includes('data-testid="permission-mode-option-default"'));
  assert.ok(html.includes('data-testid="permission-mode-option-bypassPermissions"'));
  assert.ok(!html.includes('data-testid="permission-mode-option-acceptEdits"'));
  assert.ok(!html.includes('data-testid="permission-mode-option-plan"'));
  assert.ok(!html.includes('data-testid="permission-mode-option-auto"'));
});

test('ModelsContent respects custom getPermissionModesForProvider', () => {
  const html = renderModels({
    initialPendingSwitch: { provider: 'custom-provider', model: 'custom-model' },
    getPermissionModesForProvider: () => ['default', 'plan'],
  });

  assert.ok(html.includes('data-testid="starting-permissions-section"'));
  assert.ok(html.includes('data-testid="permission-mode-option-default"'));
  assert.ok(html.includes('data-testid="permission-mode-option-plan"'));
  assert.ok(!html.includes('data-testid="permission-mode-option-bypassPermissions"'));
});

test('StartingPermissionsPicker renders accessible radio group with expected mode copy and indicators', () => {
  const html = renderToStaticMarkup(
    <StartingPermissionsPicker
      provider="claude"
      modes={['default', 'bypassPermissions']}
      selectedMode="bypassPermissions"
      onSelect={noop}
    />,
  );

  assert.ok(html.includes('role="radiogroup"'));
  assert.ok(html.includes('aria-label="Starting permissions"'));
  assert.ok(html.includes('data-testid="permission-mode-option-bypassPermissions"'));
  assert.ok(html.includes('aria-checked="true"'));
  assert.ok(html.includes('data-testid="permission-mode-option-default"'));
  assert.ok(html.includes('aria-checked="false"'));
  assert.ok(html.includes('bg-orange-500'));
});
