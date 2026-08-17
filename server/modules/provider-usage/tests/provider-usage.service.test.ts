import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

import { providerAuthService, providerRegistry } from '@/modules/providers/index.js';
import type { ProviderAuthStatus } from '@/shared/types.js';

import type { ProviderUsageAdapterResult } from '../provider-usage.adapters.js';
import {
  getProviderUsage,
  isInconclusiveProviderAuthStatus,
  providerUsageAdapters,
  resetProviderUsageCache,
} from '../provider-usage.service.js';

const authStatus = (
  provider: string,
  authenticated: boolean,
  error?: string,
): ProviderAuthStatus => ({
  provider: provider as ProviderAuthStatus['provider'],
  installed: true,
  authenticated,
  email: authenticated ? `${provider}@example.test` : null,
  method: authenticated ? 'oauth' : null,
  error: authenticated ? undefined : error,
});

const okResult = (remainingRatio = 0.55): ProviderUsageAdapterResult => ({
  planName: 'Plus',
  primaryWindowId: 'weekly',
  windows: [{
    id: 'weekly',
    label: 'Weekly',
    used: 28,
    limit: 100,
    remaining: 72,
    remainingRatio,
    resetsAt: '2026-08-19T00:00:00.000Z',
    unit: 'percent',
  }],
  status: 'ok',
  error: null,
});

const jsonParseError = (sample: string): string => {
  try {
    JSON.parse(sample);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error(`expected JSON.parse(${JSON.stringify(sample)}) to throw`);
};

test('Node JSON.parse SyntaxError messages are inconclusive after confirmed logout is ruled out', () => {
  for (const sample of ['{', '', 'not-json', 'null{', '{"']) {
    const error = jsonParseError(sample);
    assert.match(error, /JSON/i, error);
    assert.equal(isInconclusiveProviderAuthStatus({
      ...authStatus('codex', false, error),
    }), true, error);
    assert.equal(isInconclusiveProviderAuthStatus({
      ...authStatus('grok', false, error),
    }), true, error);
  }

  for (const error of ['Not logged in', 'Grok not configured', 'No valid tokens found', 'Codex not configured']) {
    assert.equal(isInconclusiveProviderAuthStatus({
      ...authStatus('codex', false, error),
    }), false, error);
  }
});

test('Codex JSON.parse SyntaxError keeps last-known quota as stale', async () => {
  resetProviderUsageCache();
  const parseError = jsonParseError('{');
  assert.match(parseError, /JSON/i);
  assert.doesNotMatch(parseError, /not valid JSON|invalid JSON/i);

  const listMock = mock.method(providerRegistry, 'listProviders', () => ([{ id: 'codex' }] as never));
  let codexAuthenticated = true;
  const authMock = mock.method(providerAuthService, 'getProviderAuthStatus', async () => (
    codexAuthenticated
      ? authStatus('codex', true)
      : authStatus('codex', false, parseError)
  ));
  const originalCodex = providerUsageAdapters.codex;
  providerUsageAdapters.codex = async () => okResult(0.55);

  try {
    const first = await getProviderUsage({ now: 1_800_000_000_000 });
    assert.equal(first.providers[0]?.providerId, 'codex');
    assert.equal(first.providers[0]?.status, 'ok');
    assert.equal(first.providers[0]?.windows[0]?.remainingRatio, 0.55);

    codexAuthenticated = false;
    const second = await getProviderUsage({ now: 1_800_000_016_000, fresh: true });
    assert.equal(second.providers[0]?.providerId, 'codex');
    assert.equal(second.providers[0]?.status, 'stale');
    assert.equal(second.providers[0]?.windows[0]?.remainingRatio, 0.55);
    assert.equal(second.providers[0]?.error, parseError);
    assert.equal(second.fetchedAt, first.fetchedAt);
  } finally {
    providerUsageAdapters.codex = originalCodex;
    listMock.mock.restore();
    authMock.mock.restore();
    resetProviderUsageCache();
  }
});

test('Grok JSON.parse SyntaxError keeps last-known quota as stale', async () => {
  resetProviderUsageCache();
  const parseError = jsonParseError('{');
  const listMock = mock.method(providerRegistry, 'listProviders', () => ([{ id: 'grok' }] as never));
  let grokAuthenticated = true;
  const authMock = mock.method(providerAuthService, 'getProviderAuthStatus', async () => (
    grokAuthenticated
      ? authStatus('grok', true)
      : authStatus('grok', false, parseError)
  ));
  const originalGrok = providerUsageAdapters.grok;
  providerUsageAdapters.grok = async () => okResult(0.4);

  try {
    const first = await getProviderUsage({ now: 1_800_000_000_000 });
    assert.equal(first.providers[0]?.providerId, 'grok');
    assert.equal(first.providers[0]?.status, 'ok');

    grokAuthenticated = false;
    const second = await getProviderUsage({ now: 1_800_000_016_000, fresh: true });
    assert.equal(second.providers[0]?.providerId, 'grok');
    assert.equal(second.providers[0]?.status, 'stale');
    assert.equal(second.providers[0]?.windows[0]?.remainingRatio, 0.4);
    assert.equal(second.providers[0]?.error, parseError);
    assert.equal(second.fetchedAt, first.fetchedAt);
  } finally {
    providerUsageAdapters.grok = originalGrok;
    listMock.mock.restore();
    authMock.mock.restore();
    resetProviderUsageCache();
  }
});

test('authenticated Kimi uses the provider-native quota adapter', async () => {
  resetProviderUsageCache();
  const listMock = mock.method(providerRegistry, 'listProviders', () => ([{ id: 'kimi' }] as never));
  const authMock = mock.method(providerAuthService, 'getProviderAuthStatus', async () => (
    authStatus('kimi', true)
  ));
  const originalKimi = providerUsageAdapters.kimi;
  let adapterCalls = 0;
  providerUsageAdapters.kimi = async () => {
    adapterCalls += 1;
    return okResult(0.81);
  };

  try {
    const result = await getProviderUsage({ now: 1_800_000_000_000 });
    const kimi = result.providers[0];
    assert.equal(adapterCalls, 1);
    assert.equal(kimi?.providerId, 'kimi');
    assert.equal(kimi?.displayName, 'Kimi');
    assert.equal(kimi?.status, 'ok');
    assert.equal(kimi?.windows[0]?.remainingRatio, 0.81);
  } finally {
    providerUsageAdapters.kimi = originalKimi;
    listMock.mock.restore();
    authMock.mock.restore();
    resetProviderUsageCache();
  }
});
