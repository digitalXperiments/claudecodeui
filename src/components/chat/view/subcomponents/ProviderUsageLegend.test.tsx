import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import type { ProviderUsageResponse } from '../../types/providerUsage';

import {
  createProviderUsageLegendUi,
  formatExpandedWindowValue,
  ProviderUsageLegendContent,
  type ProviderUsageLegendContentProps,
} from './ProviderUsageLegendContent';

const response = (providers: ProviderUsageResponse['providers']): ProviderUsageResponse => ({
  fetchedAt: '2026-08-15T14:00:00.000Z',
  attemptedAt: '2026-08-15T14:00:00.000Z',
  providers,
  cached: false,
});

const provider = (patch: Partial<ProviderUsageResponse['providers'][number]> = {}) => ({
  providerId: 'claude',
  displayName: 'Claude',
  signedIn: true,
  planName: 'Pro',
  primaryWindowId: 'five_hour',
  windows: [{
    id: 'five_hour',
    label: 'Current session',
    used: 4,
    limit: 100,
    remaining: 96,
    remainingRatio: 0.96,
    resetsAt: '2026-08-15T18:00:00.000Z',
    unit: 'percent' as const,
  }, {
    id: 'weekly',
    label: 'All models',
    used: 58,
    limit: 100,
    remaining: 42,
    remainingRatio: 0.42,
    resetsAt: '2026-08-19T00:00:00.000Z',
    unit: 'percent' as const,
  }, {
    id: 'weekly_scoped_fable',
    label: 'Fable',
    used: 3,
    limit: 100,
    remaining: 97,
    remainingRatio: 0.97,
    resetsAt: '2026-08-19T00:00:00.000Z',
    unit: 'percent' as const,
  }],
  status: 'ok' as const,
  error: null,
  fetchedAt: '2026-08-15T14:00:00.000Z',
  ...patch,
});

const queryByAriaLabel = (html: string, label: string): boolean => (
  html.includes(`aria-label="${label}"`)
);

const queryByRole = (html: string, role: string): boolean => (
  new RegExp(`role="${role}"`).test(html)
);

const renderLegend = (props: Partial<ProviderUsageLegendContentProps> & {
  data?: ProviderUsageResponse | null;
  collapsed?: boolean;
  expandedProvider?: string | null;
} = {}) => (
  renderToStaticMarkup(
    React.createElement(ProviderUsageLegendContent, {
      data: props.data ?? response([provider()]),
      collapsed: props.collapsed ?? false,
      expandedProvider: props.expandedProvider ?? null,
      now: Date.parse('2026-08-15T14:00:00.000Z'),
      ...props,
    }),
  )
);

const createLegendUi = (initialCollapsed = false) => {
  const storage = new Map<string, string>();
  const ui = createProviderUsageLegendUi({
    readCollapsed: () => (
      storage.has('provider-usage-legend-collapsed')
        ? storage.get('provider-usage-legend-collapsed') === 'true'
        : initialCollapsed
    ),
    writeCollapsed: (collapsed) => {
      storage.set('provider-usage-legend-collapsed', String(collapsed));
    },
  });
  if (initialCollapsed) {
    storage.set('provider-usage-legend-collapsed', 'true');
  }
  return { storage, ui };
};

test('empty signed-in membership hides the legend', () => {
  const html = renderLegend({ data: response([]) });
  assert.equal(html, '');
});

test('single provider renders real remaining percentage and reset countdown', () => {
  const html = renderLegend();
  assert.match(html, /96% remaining/);
  assert.match(html, /resets in 4h 0m/);
  assert.match(html, /aria-valuenow="96"/);
});

test('Kimi provider renders native quota windows instead of N/A', () => {
  const html = renderLegend({
    data: response([provider({
      providerId: 'kimi',
      displayName: 'Kimi',
      planName: null,
      primaryWindowId: 'five_hour',
      windows: [{
        id: 'five_hour',
        label: '5h window',
        used: 18,
        limit: 100,
        remaining: 82,
        remainingRatio: 0.82,
        resetsAt: '2026-08-16T18:00:00.000Z',
        unit: 'unknown',
      }],
    })]),
    expandedProvider: 'kimi',
    now: Date.parse('2026-08-16T17:00:00.000Z'),
  });

  assert.match(html, /Kimi/);
  assert.match(html, />82%<\/span>/);
  assert.match(html, /5h window/);
  assert.match(html, /18% used/);
  assert.doesNotMatch(html, /usage unavailable/);
  assert.doesNotMatch(html, />N\/A</);
});

test('multi-provider output keeps unavailable rows explicit and includes all providers', () => {
  const html = renderLegend({
    data: response([
      provider(),
      provider({
        providerId: 'grok',
        displayName: 'Grok',
        planName: null,
        primaryWindowId: null,
        windows: [],
        status: 'unavailable',
      }),
    ]),
    expandedProvider: 'grok',
  });
  assert.match(html, /Claude/);
  assert.match(html, /Grok/);
  assert.match(html, /usage unavailable/);
  assert.match(html, /signed in/);
});

test('usage is a bottom-right floating card with a compact launcher', () => {
  const expanded = renderLegend({ collapsed: false });
  const collapsed = renderLegend({ collapsed: true });

  assert.match(expanded, /fixed bottom-4 right-4/);
  assert.match(expanded, /rounded-2xl/);
  assert.doesNotMatch(collapsed, /Claude usage details/);
  assert.match(collapsed, /Open provider usage/);
  assert.match(collapsed, /aria-controls="provider-usage-card"/);
  assert.doesNotMatch(collapsed, /id="provider-usage-card"/);
});

test('accessible control labels are present for refresh, collapse, and rows', () => {
  const html = renderLegend({ expandedProvider: 'claude' });
  assert.equal(queryByAriaLabel(html, 'Provider usage'), true);
  assert.equal(queryByAriaLabel(html, 'Refresh provider usage'), true);
  assert.equal(queryByAriaLabel(html, 'Close provider usage'), true);
  assert.equal(queryByAriaLabel(html, 'Claude usage details'), true);
  assert.equal(queryByAriaLabel(html, 'Claude Current session used quota'), true);
  assert.equal(queryByRole(html, 'progressbar'), true);
  assert.match(html, /type="button"/);
  assert.match(html, /aria-expanded="true"/);
});

test('refresh control is disabled and shows a spinner while refreshing', () => {
  const html = renderLegend({ refreshing: true });
  assert.match(html, /disabled=""/);
  assert.match(html, /data-testid="provider-usage-refresh-spinner"/);
  assert.match(html, /animate-spin/);
});

test('legend UI controller persists collapse and expands rows', () => {
  const { storage, ui } = createLegendUi();
  const states: Array<ReturnType<typeof ui.getState>> = [];
  ui.subscribe((state) => states.push(state));

  assert.equal(ui.getState().collapsed, false);
  ui.toggleCollapsed();
  assert.equal(ui.getState().collapsed, true);
  assert.equal(storage.get('provider-usage-legend-collapsed'), 'true');

  ui.toggleCollapsed();
  assert.equal(ui.getState().collapsed, false);
  assert.equal(storage.get('provider-usage-legend-collapsed'), 'false');
  assert.equal(states.length, 2);

  ui.toggleProvider('claude');
  assert.equal(ui.getState().expandedProvider, null);
  ui.toggleProvider('claude');
  assert.equal(ui.getState().expandedProvider, 'claude');

  const html = renderLegend({
    collapsed: true,
    expandedProvider: 'claude',
  });
  assert.match(html, /Open provider usage/);
  assert.match(html, /aria-controls="provider-usage-card"/);
  const expandedHtml = renderLegend({ expandedProvider: 'claude' });
  assert.match(expandedHtml, /Current session/);
  assert.match(expandedHtml, /All models/);
  assert.match(expandedHtml, /Fable/);
  assert.match(expandedHtml, /4% used/);
  assert.match(expandedHtml, /58% used/);
  assert.match(expandedHtml, /3% used/);
  assert.equal((expandedHtml.match(/role="progressbar"/g) ?? []).length, 3);
});

test('legend UI controller keyboard activation toggles collapse and rows', () => {
  const { storage, ui } = createLegendUi();
  assert.equal(ui.activate('Tab', () => ui.toggleCollapsed()), false);
  assert.equal(ui.getState().collapsed, false);

  assert.equal(ui.activate('Enter', () => ui.toggleCollapsed()), true);
  assert.equal(ui.getState().collapsed, true);
  assert.equal(storage.get('provider-usage-legend-collapsed'), 'true');

  assert.equal(ui.activate(' ', () => ui.toggleProvider('claude')), true);
  assert.equal(ui.getState().collapsed, false);
  assert.equal(ui.getState().expandedProvider, 'claude');
  assert.equal(storage.get('provider-usage-legend-collapsed'), 'false');
});

test('expanded percent-only windows render distinct used bars without invented counts', () => {
  const percentOnly = provider().windows[0];
  assert.equal(formatExpandedWindowValue(percentOnly), '96% remaining');

  const counted = {
    ...percentOnly,
    unit: 'requests' as const,
  };
  assert.equal(formatExpandedWindowValue(counted), '96% remaining · 4 / 100 requests');

  const html = renderLegend({ expandedProvider: 'claude' });
  assert.match(html, /4% used/);
  assert.match(html, /58% used/);
  assert.match(html, /3% used/);
  assert.doesNotMatch(html, /4 \/ 100/);
});

test('stale provider with a past reset shows reset overdue and an amber error line', () => {
  const html = renderLegend({
    data: response([
      provider({
        status: 'stale',
        error: 'Last known Claude CLI usage · 2h ago',
        windows: [{
          ...provider().windows[0],
          resetsAt: '2026-08-15T13:00:00.000Z',
        }],
      }),
    ]),
    expandedProvider: 'claude',
  });
  assert.match(html, /reset overdue/);
  assert.doesNotMatch(html, /resets now/);
  assert.match(html, /text-amber-700 dark:text-amber-300">Last known Claude CLI usage/);
  assert.doesNotMatch(html, /text-red-700 dark:text-red-300">Last known Claude CLI usage/);
});

test('error-status provider keeps resets now and a red error line', () => {
  const html = renderLegend({
    data: response([
      provider({
        status: 'error',
        error: 'usage fetch failed',
        windows: [{
          ...provider().windows[0],
          resetsAt: '2026-08-15T13:00:00.000Z',
        }],
      }),
    ]),
    expandedProvider: 'claude',
  });
  assert.match(html, /resets now/);
  assert.doesNotMatch(html, /reset overdue/);
  assert.match(html, /text-red-700 dark:text-red-300">usage fetch failed/);
});

test('settings appearance wires rail close and per-provider visibility', () => {
  const appearancePath = join(
    dirname(fileURLToPath(import.meta.url)),
    '../../../settings/view/tabs/AppearanceSettingsTab.tsx',
  );
  const source = readFileSync(appearancePath, 'utf8');
  assert.match(source, /Minimize provider usage widget/);
  assert.match(source, /PROVIDER_USAGE_PROVIDERS/);
  assert.match(source, /onProviderUsageVisibilityChange/);
});

test('quick settings includes close and per-provider visibility preferences', () => {
  const quickSettingsPath = join(
    dirname(fileURLToPath(import.meta.url)),
    '../../../quick-settings-panel/view/QuickSettingsContent.tsx',
  );
  const source = readFileSync(quickSettingsPath, 'utf8');
  assert.match(source, /collapseProviderUsage/);
  assert.match(source, /providerUsageLegendCollapsed/);
  assert.match(source, /PROVIDER_USAGE_PROVIDERS/);
  assert.match(source, /onProviderUsageVisibilityChange/);
});
