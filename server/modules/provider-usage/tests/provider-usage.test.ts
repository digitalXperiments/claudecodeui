import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import test, { mock } from 'node:test';
import type { AddressInfo } from 'node:net';

import express from 'express';

import {
  ClaudeProviderAuth,
  providerAuthService,
  providerRegistry,
  setClaudeAuthIoForTests,
  type ClaudeAuthIo,
  type DetectedProviderAuthStatus,
  type ProviderAuthDetection,
} from '@/modules/providers/index.js';
import type { ProviderAuthStatus } from '@/shared/types.js';

import {
  TransientCredentialError,
  createClaudeUsageAdapter,
  createGrokUsageAdapter,
  parseClaudeUsagePayload,
  parseCodexUsagePayload,
  parseGrokBillingPayload,
  resetClaudeLiveGate,
} from '../provider-usage.adapters.js';
import {
  getProviderUsage,
  isInconclusiveProviderAuthStatus,
  providerUsageAdapters,
  resetProviderUsageCache,
} from '../provider-usage.service.js';
import providerUsageRoutes from '../provider-usage.routes.js';
import type { ProviderUsageAdapterResult } from '../provider-usage.adapters.js';

const fixture = async (name: string): Promise<unknown> => (
  JSON.parse(await readFile(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'))
);

const authStatus = (
  provider: string,
  authenticated: boolean,
  method: ProviderAuthStatus['method'] = authenticated ? 'oauth' : null,
): ProviderAuthStatus => ({
  provider: provider as ProviderAuthStatus['provider'],
  installed: true,
  authenticated,
  email: authenticated ? `${provider}@example.test` : null,
  method,
  error: authenticated ? undefined : 'Not logged in',
});

const inconclusiveAuthStatus = (
  provider: string,
  error: string,
): DetectedProviderAuthStatus => ({
  ...authStatus(provider, false),
  error,
  detection: 'inconclusive',
});

const detectionFromStatus = (status: ProviderAuthStatus): ProviderAuthDetection => {
  const detected = status as DetectedProviderAuthStatus;
  if (status.authenticated) {
    return { kind: 'authenticated', status };
  }
  if (detected.detection === 'inconclusive') {
    return { kind: 'inconclusive', status, error: status.error };
  }
  return { kind: 'unauthenticated', status, error: status.error };
};

const mockClaudeDetectAuth = (resolve: () => ProviderAuthStatus) => (
  mock.method(ClaudeProviderAuth.prototype, 'detectAuth', async () => (
    detectionFromStatus(resolve())
  ))
);

const validClaudeCredentials = JSON.stringify({
  claudeAiOauth: {
    accessToken: 'test-access',
    refreshToken: 'test-refresh',
    expiresAt: 9_999_999_999_999,
  },
});

const throwEnoent = (): never => {
  const error = new Error('ENOENT') as NodeJS.ErrnoException;
  error.code = 'ENOENT';
  throw error;
};

const installClaudeAuthIo = (options: {
  credentials?: () => Promise<string>;
  platform?: NodeJS.Platform;
  spawn?: ClaudeAuthIo['spawn'];
  now?: () => number;
}): void => {
  setClaudeAuthIoForTests({
    isCliInstalled: () => true,
    platform: () => options.platform ?? 'linux',
    homedir: () => '/tmp/cloudcli-claude-auth-test',
    env: () => ({}),
    now: options.now ?? (() => 1_800_000_000_000),
    keychainTimeoutMs: () => 20,
    unrefTimers: false,
    ...(options.spawn ? { spawn: options.spawn } : {}),
    readFile: async (filePath): Promise<string> => {
      if (String(filePath).includes('.credentials.json')) {
        return (options.credentials ?? (async () => validClaudeCredentials))();
      }
      return throwEnoent();
    },
  });
};

const restoreClaudeAuthIo = (): void => {
  setClaudeAuthIoForTests(null);
  ClaudeProviderAuth.invalidateStatusCache();
};

const okResult = (remainingRatio = 0.72): ProviderUsageAdapterResult => ({
  planName: 'Pro',
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

const jsonResponse = (payload: unknown): Response => (
  new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
);

test('Claude fixture preserves real utilization, reset, and plan fields', async () => {
  const result = parseClaudeUsagePayload(await fixture('claude-usage.json'));

  assert.equal(result.status, 'ok');
  assert.equal(result.planName, 'Pro');
  assert.equal(result.primaryWindowId, 'five_hour');
  assert.deepEqual(result.windows.map((window) => ({
    id: window.id,
    used: window.used,
    limit: window.limit,
    remaining: window.remaining,
    remainingRatio: window.remainingRatio,
    resetsAt: window.resetsAt,
  })), [
    {
      id: 'five_hour',
      used: null,
      limit: null,
      remaining: 72,
      remainingRatio: 0.72,
      resetsAt: '2026-08-15T18:00:00.000Z',
    },
    {
      id: 'weekly',
      used: null,
      limit: null,
      remaining: 36,
      remainingRatio: 0.36,
      resetsAt: '2026-08-19T00:00:00.000Z',
    },
  ]);
});

test('Claude CLI cache shape parses five-hour, weekly, and model-specific windows', () => {
  const result = parseClaudeUsagePayload({
    fetchedAtMs: 1_786_861_215_575,
    utilization: {
      five_hour: { utilization: 8, resets_at: '2026-08-16T05:00:00.000Z' },
      seven_day: { utilization: 50, resets_at: '2026-08-19T09:00:00.000Z' },
      limits: [
        {
          kind: 'session',
          group: 'session',
          percent: 4,
          resets_at: '2026-08-16T06:50:00.000Z',
          scope: null,
        },
        {
          kind: 'weekly_all',
          group: 'weekly',
          percent: 58,
          resets_at: '2026-08-19T10:00:00.000Z',
          scope: null,
        },
        {
          kind: 'weekly_scoped',
          group: 'weekly',
          percent: 3,
          resets_at: '2026-08-19T10:00:00.000Z',
          scope: { model: { display_name: 'Fable' } },
        },
      ],
    },
  });

  assert.equal(result.status, 'ok');
  assert.deepEqual(result.windows.map(({ id, remainingRatio }) => ({ id, remainingRatio })), [
    { id: 'five_hour', remainingRatio: 0.96 },
    { id: 'weekly', remainingRatio: 0.42 },
    { id: 'weekly_scoped_fable', remainingRatio: 0.97 },
  ]);
  assert.deepEqual(result.windows.map(({ label }) => label), [
    'Current session',
    'All models',
    'Fable',
  ]);
});

test('Claude adapter falls back to the CLI cache when live usage is rate limited', async () => {
  resetClaudeLiveGate();
  let anthropicVersion = '';
  const adapter = createClaudeUsageAdapter({
    readCredentials: async () => ({ accessToken: 'fixture-token' }),
    readCachedUsage: async () => ({
      utilization: {
        five_hour: { utilization: 4, resets_at: '2026-08-16T06:50:00.000Z' },
        seven_day: { utilization: 58, resets_at: '2026-08-19T10:00:00.000Z' },
      },
    }),
    fetchImpl: async (_input, init) => {
      anthropicVersion = new Headers(init?.headers).get('anthropic-version') ?? '';
      return new Response('', { status: 429 });
    },
  });

  try {
    const result = await adapter({ authStatus: authStatus('claude', true) });
    assert.equal(anthropicVersion, '2023-06-01');
    assert.equal(result.status, 'stale');
    assert.equal(result.windows[0]?.remainingRatio, 0.96);
    assert.match(result.error ?? '', /HTTP 429/);
    // No retry-after header on the fixture response: default 15-minute gate.
    assert.match(result.error ?? '', /retrying in 15m/);
  } finally {
    resetClaudeLiveGate();
  }
});

test('Claude adapter prefers the valid username keychain item over expired ones', async () => {
  resetClaudeLiveGate();
  let authorization = '';
  const adapter = createClaudeUsageAdapter({
    readCredentialCandidates: async () => [
      {
        source: 'keychain:first-match',
        accessToken: 'legacy-token',
        refreshToken: null,
        expiresAtMs: 1_786_000_000_000,
      },
      {
        source: 'keychain:unknown',
        accessToken: 'legacy-token',
        refreshToken: null,
        expiresAtMs: 1_786_000_000_000,
      },
      {
        source: 'keychain:rammanohar',
        accessToken: 'fresh-token',
        refreshToken: 'fresh-refresh',
        expiresAtMs: Date.now() + 3_600_000,
      },
    ],
    fetchImpl: async (_input, init) => {
      authorization = new Headers(init?.headers).get('authorization') ?? '';
      return jsonResponse({
        utilization: {
          five_hour: { utilization: 4, resets_at: '2026-08-16T06:50:00.000Z' },
        },
      });
    },
  });

  try {
    const result = await adapter({ authStatus: authStatus('claude', true) });
    assert.equal(authorization, 'Bearer fresh-token');
    assert.equal(result.status, 'ok');
  } finally {
    resetClaudeLiveGate();
  }
});

test('Claude adapter skips the live call when every stored credential is expired', async () => {
  resetClaudeLiveGate();
  let fetchCalls = 0;
  const adapter = createClaudeUsageAdapter({
    readCredentialCandidates: async () => [
      {
        source: 'keychain:unknown',
        accessToken: 'legacy-token',
        refreshToken: null,
        expiresAtMs: 1_786_000_000_000,
      },
      {
        source: 'credentials-file',
        accessToken: 'file-token',
        refreshToken: null,
        expiresAtMs: 1_786_500_000_000,
      },
    ],
    readCachedUsage: async () => ({
      utilization: {
        five_hour: { utilization: 4, resets_at: '2026-08-16T06:50:00.000Z' },
      },
    }),
    fetchImpl: async () => {
      fetchCalls += 1;
      return jsonResponse({});
    },
  });

  try {
    const result = await adapter({ authStatus: authStatus('claude', true) });
    assert.equal(fetchCalls, 0);
    assert.equal(result.status, 'stale');
    assert.match(result.error ?? '', /login expired/);
  } finally {
    resetClaudeLiveGate();
  }
});

test('Claude adapter honors retry-after and gates immediate retries', async () => {
  resetClaudeLiveGate();
  let fetchCalls = 0;
  const adapter = createClaudeUsageAdapter({
    readCredentials: async () => ({ accessToken: 'fixture-token' }),
    readCachedUsage: async () => ({
      utilization: {
        five_hour: { utilization: 4, resets_at: '2026-08-16T06:50:00.000Z' },
      },
    }),
    fetchImpl: async () => {
      fetchCalls += 1;
      return new Response('', { status: 429, headers: { 'retry-after': '1800' } });
    },
  });

  try {
    const first = await adapter({ authStatus: authStatus('claude', true) });
    assert.equal(first.status, 'stale');
    assert.match(first.error ?? '', /retrying in 30m/);

    const second = await adapter({ authStatus: authStatus('claude', true) });
    assert.equal(fetchCalls, 1, 'gated retry must not hit the live endpoint again');
    assert.equal(second.status, 'stale');
    assert.match(second.error ?? '', /rate-limited \(HTTP 429\)/);
    assert.match(second.error ?? '', /retrying in 30m/);
  } finally {
    resetClaudeLiveGate();
  }
});

test('Claude stale fallback reports the CLI cache fetch time as fetchedAt', async () => {
  resetClaudeLiveGate();
  const fetchedAtMs = 1_786_861_215_575;
  const adapter = createClaudeUsageAdapter({
    readCredentials: async () => ({ accessToken: 'fixture-token' }),
    readCachedUsage: async () => ({
      fetchedAtMs,
      utilization: {
        five_hour: { utilization: 4, resets_at: '2026-08-16T06:50:00.000Z' },
      },
    }),
    fetchImpl: async () => new Response('', { status: 500 }),
  });

  try {
    const result = await adapter({ authStatus: authStatus('claude', true) });
    assert.equal(result.status, 'stale');
    assert.equal(result.fetchedAt, new Date(fetchedAtMs).toISOString());
  } finally {
    resetClaudeLiveGate();
  }
});

test('Codex fixture parses short window, weekly window, and credits', async () => {
  const result = parseCodexUsagePayload(await fixture('codex-usage.json'));

  assert.equal(result.status, 'ok');
  assert.equal(result.planName, 'Plus');
  assert.equal(result.primaryWindowId, 'five_hour');
  assert.deepEqual(result.windows.map((window) => window.id), ['five_hour', 'weekly', 'credits']);
  assert.equal(result.windows[0]?.remainingRatio, 0.61);
  assert.equal(result.windows[0]?.used, null);
  assert.equal(result.windows[0]?.limit, null);
  assert.equal(result.windows[1]?.remainingRatio, 0.17);
  assert.equal(result.windows[1]?.used, null);
  assert.equal(result.windows[1]?.limit, null);
  assert.equal(result.windows[2]?.remaining, 12.5);
  assert.equal(result.windows[2]?.remainingRatio, null);
});

test('Codex derives the primary label from the actual returned duration', () => {
  const result = parseCodexUsagePayload({
    planType: 'plus',
    rateLimits: {
      primary: {
        usedPercent: 40,
        windowDurationMins: 10_080,
        resetsAt: 1_787_199_668,
      },
      secondary: null,
    },
  });

  assert.equal(result.primaryWindowId, 'weekly');
  assert.equal(result.windows[0]?.label, 'Weekly');
  assert.equal(result.windows[0]?.remainingRatio, 0.6);
});

test('Grok billing parses the CLI weekly pool as used percentage', () => {
  const result = parseGrokBillingPayload({
    config: {
      creditUsagePercent: 84,
      currentPeriod: {
        type: 'USAGE_PERIOD_TYPE_WEEKLY',
        start: '2026-08-11T13:21:00.000Z',
        end: '2026-08-18T13:21:00.000Z',
      },
    },
    subscription_tier: 'SuperGrok',
  });
  assert.equal(result.status, 'ok');
  assert.equal(result.planName, 'SuperGrok');
  assert.equal(result.primaryWindowId, 'weekly');
  assert.equal(result.windows[0]?.remainingRatio, 0.16);
  assert.equal(result.windows[0]?.resetsAt, '2026-08-18T13:21:00.000Z');
});

test('Grok adapter reads billing through its injectable ACP boundary', async () => {
  const adapter = createGrokUsageAdapter({
    readBilling: async () => ({
      config: {
        creditUsagePercent: 25,
        currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY' },
      },
      subscription_tier: 'SuperGrok',
    }),
  });
  const result = await adapter({ authStatus: authStatus('grok', true) });
  assert.equal(result.windows[0]?.remainingRatio, 0.75);
});

test('usage route membership omits signed-out providers and keeps signed-in N/A rows', async () => {
  resetProviderUsageCache();
  const listMock = mock.method(providerRegistry, 'listProviders', () => ([
    { id: 'claude' },
    { id: 'grok' },
  ] as never));
  const authMock = mock.method(providerAuthService, 'getProviderAuthStatus', async (provider: string) => (
    authStatus(provider, provider === 'claude')
  ));
  const detectMock = mockClaudeDetectAuth(() => authStatus('claude', true));
  const originalAdapter = providerUsageAdapters.claude;
  providerUsageAdapters.claude = async () => ({
    planName: null,
    primaryWindowId: null,
    windows: [],
    status: 'unavailable',
    error: 'Usage unavailable in fixture',
  });

  try {
    const response = await getProviderUsage({ now: 1_800_000_000_000 });
    assert.deepEqual(response.providers.map((provider) => provider.providerId), ['claude']);
    assert.equal(response.providers[0]?.signedIn, true);
    assert.equal(response.providers[0]?.status, 'unavailable');
  } finally {
    providerUsageAdapters.claude = originalAdapter;
    listMock.mock.restore();
    authMock.mock.restore();
    detectMock.mock.restore();
    resetProviderUsageCache();
  }
});

test('second GET within TTL reuses adapters and fresh GET after 15s refetches', async () => {
  resetProviderUsageCache();
  const listMock = mock.method(providerRegistry, 'listProviders', () => ([{ id: 'claude' }] as never));
  const authMock = mock.method(providerAuthService, 'getProviderAuthStatus', async () => authStatus('claude', true));
  const detectMock = mockClaudeDetectAuth(() => authStatus('claude', true));
  const originalAdapter = providerUsageAdapters.claude;
  let adapterCalls = 0;
  providerUsageAdapters.claude = async () => {
    adapterCalls += 1;
    return okResult();
  };

  try {
    const first = await getProviderUsage({ now: 1_800_000_000_000 });
    const second = await getProviderUsage({ now: 1_800_000_001_000 });
    const third = await getProviderUsage({
      now: 1_800_000_016_000,
      fresh: true,
    });

    assert.equal(first.cached, false);
    assert.equal(second.cached, true);
    assert.equal(third.cached, false);
    assert.equal(adapterCalls, 2);
  } finally {
    providerUsageAdapters.claude = originalAdapter;
    listMock.mock.restore();
    authMock.mock.restore();
    detectMock.mock.restore();
    resetProviderUsageCache();
  }
});

test('manual refresh inside 15 seconds returns cache without invoking adapters', async () => {
  resetProviderUsageCache();
  const listMock = mock.method(providerRegistry, 'listProviders', () => ([{ id: 'claude' }] as never));
  const authMock = mock.method(providerAuthService, 'getProviderAuthStatus', async () => authStatus('claude', true));
  const detectMock = mockClaudeDetectAuth(() => authStatus('claude', true));
  const originalAdapter = providerUsageAdapters.claude;
  let adapterCalls = 0;
  providerUsageAdapters.claude = async () => {
    adapterCalls += 1;
    return okResult();
  };

  try {
    await getProviderUsage({ now: 1_800_000_000_000 });
    const response = await getProviderUsage({ now: 1_800_000_005_000, fresh: true });

    assert.equal(response.cached, true);
    assert.equal(response.refreshSuppressed, true);
    assert.equal(adapterCalls, 1);
  } finally {
    providerUsageAdapters.claude = originalAdapter;
    listMock.mock.restore();
    authMock.mock.restore();
    detectMock.mock.restore();
    resetProviderUsageCache();
  }
});

test('adapter failure preserves the last-known provider window as stale', async () => {
  resetProviderUsageCache();
  const listMock = mock.method(providerRegistry, 'listProviders', () => ([{ id: 'claude' }] as never));
  const authMock = mock.method(providerAuthService, 'getProviderAuthStatus', async () => authStatus('claude', true));
  const detectMock = mockClaudeDetectAuth(() => authStatus('claude', true));
  const originalAdapter = providerUsageAdapters.claude;
  let shouldFail = false;
  providerUsageAdapters.claude = async () => {
    if (shouldFail) {
      throw new Error('fixture adapter failed');
    }
    return okResult();
  };

  try {
    const first = await getProviderUsage({ now: 1_800_000_000_000 });
    shouldFail = true;
    const second = await getProviderUsage({ now: 1_800_000_016_000, fresh: true });

    assert.equal(first.providers[0]?.status, 'ok');
    assert.equal(second.providers[0]?.status, 'stale');
    assert.equal(second.providers[0]?.error, 'fixture adapter failed');
    assert.equal(second.providers[0]?.windows[0]?.remainingRatio, 0.72);
    assert.equal(second.fetchedAt, first.fetchedAt);
  } finally {
    providerUsageAdapters.claude = originalAdapter;
    listMock.mock.restore();
    authMock.mock.restore();
    detectMock.mock.restore();
    resetProviderUsageCache();
  }
});

test('transient credential-read failures keep last-known windows as stale', async () => {
  resetProviderUsageCache();
  resetClaudeLiveGate();
  const listMock = mock.method(providerRegistry, 'listProviders', () => ([{ id: 'claude' }] as never));
  const authMock = mock.method(providerAuthService, 'getProviderAuthStatus', async () => authStatus('claude', true));
  const detectMock = mockClaudeDetectAuth(() => authStatus('claude', true));
  const originalAdapter = providerUsageAdapters.claude;
  const payload = await fixture('claude-usage.json');
  let failCredentials = false;

  providerUsageAdapters.claude = createClaudeUsageAdapter({
    readCredentials: async () => {
      if (failCredentials) {
        throw new TransientCredentialError('keychain timed out');
      }
      return { accessToken: 'fixture-token' };
    },
    fetchImpl: async () => jsonResponse(payload),
  });

  try {
    const first = await getProviderUsage({ now: 1_800_000_000_000 });
    failCredentials = true;
    const second = await getProviderUsage({ now: 1_800_000_016_000, fresh: true });

    assert.equal(first.providers[0]?.status, 'ok');
    assert.equal(first.providers[0]?.windows[0]?.remainingRatio, 0.72);
    assert.equal(second.providers[0]?.status, 'stale');
    assert.equal(second.providers[0]?.error, 'keychain timed out');
    assert.equal(second.providers[0]?.windows[0]?.remainingRatio, 0.72);
    assert.equal(second.providers[0]?.windows[1]?.remainingRatio, 0.36);
    assert.equal(second.fetchedAt, first.fetchedAt);
  } finally {
    providerUsageAdapters.claude = originalAdapter;
    listMock.mock.restore();
    authMock.mock.restore();
    detectMock.mock.restore();
    resetProviderUsageCache();
  }
});

test('unsupported auth replaces cached windows with unavailable', async () => {
  resetProviderUsageCache();
  const listMock = mock.method(providerRegistry, 'listProviders', () => ([{ id: 'claude' }] as never));
  const authMock = mock.method(providerAuthService, 'getProviderAuthStatus', async () => (
    authStatus('claude', true, 'api_key')
  ));
  const detectMock = mockClaudeDetectAuth(() => authStatus('claude', true, 'api_key'));
  const originalAdapter = providerUsageAdapters.claude;
  const payload = await fixture('claude-usage.json');

  providerUsageAdapters.claude = createClaudeUsageAdapter({
    readCredentials: async () => ({ accessToken: 'fixture-token' }),
    fetchImpl: async () => jsonResponse(payload),
  });

  try {
    const first = await getProviderUsage({ now: 1_800_000_000_000 });
    assert.equal(first.providers[0]?.status, 'unavailable');
    assert.equal(first.providers[0]?.windows.length, 0);
    assert.match(first.providers[0]?.error ?? '', /API-key/);
  } finally {
    providerUsageAdapters.claude = originalAdapter;
    listMock.mock.restore();
    authMock.mock.restore();
    detectMock.mock.restore();
    resetProviderUsageCache();
  }
});

test('auth-change refresh bypasses the 15s suppress-after-success rule', async () => {
  resetProviderUsageCache();
  const listMock = mock.method(providerRegistry, 'listProviders', () => ([
    { id: 'claude' },
    { id: 'grok' },
  ] as never));
  let signedIn = new Set(['claude']);
  const authMock = mock.method(providerAuthService, 'getProviderAuthStatus', async (provider: string) => (
    authStatus(provider, signedIn.has(provider))
  ));
  const detectMock = mockClaudeDetectAuth(() => authStatus('claude', signedIn.has('claude')));
  const originalAdapter = providerUsageAdapters.claude;
  const originalGrokAdapter = providerUsageAdapters.grok;
  let adapterCalls = 0;
  providerUsageAdapters.claude = async () => {
    adapterCalls += 1;
    return okResult();
  };
  providerUsageAdapters.grok = async () => ({
    planName: null,
    primaryWindowId: null,
    windows: [],
    status: 'unavailable',
    error: 'Usage unavailable in fixture',
  });

  try {
    await getProviderUsage({ now: 1_800_000_000_000 });
    const suppressed = await getProviderUsage({ now: 1_800_000_005_000, fresh: true });
    assert.equal(suppressed.refreshSuppressed, true);
    assert.deepEqual(suppressed.providers.map((provider) => provider.providerId), ['claude']);
    assert.equal(adapterCalls, 1);

    signedIn = new Set(['grok']);
    const authChanged = await getProviderUsage({
      now: 1_800_000_005_000,
      reason: 'auth-change',
    });

    assert.equal(authChanged.cached, false);
    assert.equal(authChanged.refreshSuppressed, undefined);
    assert.deepEqual(authChanged.providers.map((provider) => provider.providerId), ['grok']);
    assert.equal(authChanged.providers[0]?.status, 'unavailable');
  } finally {
    providerUsageAdapters.claude = originalAdapter;
    providerUsageAdapters.grok = originalGrokAdapter;
    listMock.mock.restore();
    authMock.mock.restore();
    detectMock.mock.restore();
    resetProviderUsageCache();
  }
});

test('GET /api/provider-usage returns the aggregate payload and cache headers', async () => {
  resetProviderUsageCache();
  const listMock = mock.method(providerRegistry, 'listProviders', () => ([{ id: 'claude' }] as never));
  const authMock = mock.method(providerAuthService, 'getProviderAuthStatus', async () => authStatus('claude', true));
  const detectMock = mockClaudeDetectAuth(() => authStatus('claude', true));
  const originalAdapter = providerUsageAdapters.claude;
  providerUsageAdapters.claude = async () => okResult();

  const app = express();
  app.use('/api/provider-usage', providerUsageRoutes);
  const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });

  try {
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}/api/provider-usage`);
    const body = await response.json() as { providers?: Array<{ providerId: string }> };
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.deepEqual(body.providers?.map((provider) => provider.providerId), ['claude']);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    providerUsageAdapters.claude = originalAdapter;
    listMock.mock.restore();
    authMock.mock.restore();
    detectMock.mock.restore();
    resetProviderUsageCache();
  }
});

const hangingKeychainSpawn = (() => {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    kill: () => void;
  };
  child.stdout = new EventEmitter();
  child.kill = () => undefined;
  return child;
}) as unknown as ClaudeAuthIo['spawn'];

const spawnKeychainResult = (
  code: number,
  stdout = '',
): ClaudeAuthIo['spawn'] => (
  (() => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      kill: () => void;
    };
    child.stdout = new EventEmitter();
    child.kill = () => undefined;
    queueMicrotask(() => {
      if (stdout) {
        child.stdout.emit('data', Buffer.from(stdout));
      }
      child.emit('close', code);
    });
    return child;
  }) as unknown as ClaudeAuthIo['spawn']
);

test('membership filter keeps last-known Claude row when detectAuth is inconclusive', async () => {
  resetProviderUsageCache();
  const listMock = mock.method(providerRegistry, 'listProviders', () => ([{ id: 'claude' }] as never));
  let status: ProviderAuthStatus = authStatus('claude', true);
  const detectMock = mockClaudeDetectAuth(() => status);
  const originalAdapter = providerUsageAdapters.claude;
  let adapterCalls = 0;
  providerUsageAdapters.claude = async () => {
    adapterCalls += 1;
    return okResult();
  };

  try {
    const first = await getProviderUsage({ now: 1_800_000_000_000 });
    status = inconclusiveAuthStatus('claude', 'keychain timed out');
    const second = await getProviderUsage({ now: 1_800_000_016_000, fresh: true });

    assert.equal(first.providers[0]?.status, 'ok');
    assert.equal(second.providers[0]?.status, 'stale');
    assert.equal(second.providers[0]?.error, 'keychain timed out');
    assert.equal(second.providers[0]?.windows[0]?.remainingRatio, 0.72);
    assert.equal(adapterCalls, 1);
    assert.equal(second.fetchedAt, first.fetchedAt);
  } finally {
    providerUsageAdapters.claude = originalAdapter;
    listMock.mock.restore();
    detectMock.mock.restore();
    resetProviderUsageCache();
  }
});

test('Claude detectAuth treats file JSON/I/O as inconclusive and ENOENT as logout', async () => {
  const auth = new ClaudeProviderAuth();
  try {
    installClaudeAuthIo({
      credentials: async () => '{',
    });
    const parsed = await auth.detectAuth({ bypassCache: true });
    assert.equal(parsed.kind, 'inconclusive');
    assert.equal(parsed.status.detection, 'inconclusive');
    assert.equal(parsed.status.authenticated, false);
    assert.equal(isInconclusiveProviderAuthStatus(parsed.status), true);

    installClaudeAuthIo({
      credentials: async () => {
        const error = new Error('EACCES: permission denied') as NodeJS.ErrnoException;
        error.code = 'EACCES';
        throw error;
      },
    });
    const ioFailure = await auth.detectAuth({ bypassCache: true });
    assert.equal(ioFailure.kind, 'inconclusive');
    assert.equal(ioFailure.status.detection, 'inconclusive');

    installClaudeAuthIo({
      credentials: async () => throwEnoent(),
    });
    const missing = await auth.detectAuth({ bypassCache: true });
    assert.equal(missing.kind, 'unauthenticated');
    assert.equal(missing.status.detection, undefined);
    assert.equal(isInconclusiveProviderAuthStatus(missing.status), false);
  } finally {
    restoreClaudeAuthIo();
  }
});

test('Claude detectAuth treats keychain timeout/spawn/parse as inconclusive', async () => {
  const auth = new ClaudeProviderAuth();
  try {
    installClaudeAuthIo({
      platform: 'darwin',
      spawn: hangingKeychainSpawn,
      credentials: async () => throwEnoent(),
    });
    const timedOut = await auth.detectAuth({ bypassCache: true });
    assert.equal(timedOut.kind, 'inconclusive');
    assert.match(timedOut.error ?? '', /timed out/);

    installClaudeAuthIo({
      platform: 'darwin',
      spawn: (() => {
        throw new Error('spawn ENOENT');
      }) as unknown as ClaudeAuthIo['spawn'],
      credentials: async () => throwEnoent(),
    });
    const spawned = await auth.detectAuth({ bypassCache: true });
    assert.equal(spawned.kind, 'inconclusive');
    assert.match(spawned.error ?? '', /spawn/);

    installClaudeAuthIo({
      platform: 'darwin',
      spawn: spawnKeychainResult(0, 'not-json'),
      credentials: async () => throwEnoent(),
    });
    const invalidJson = await auth.detectAuth({ bypassCache: true });
    assert.equal(invalidJson.kind, 'inconclusive');
    assert.match(invalidJson.error ?? '', /JSON/);
  } finally {
    restoreClaudeAuthIo();
  }
});

test('transient Claude auth detection keeps last-known quota stale', async () => {
  resetProviderUsageCache();
  restoreClaudeAuthIo();
  const listMock = mock.method(providerRegistry, 'listProviders', () => ([{ id: 'claude' }] as never));
  const originalAdapter = providerUsageAdapters.claude;
  let credentialMode: 'ok' | 'json' | 'timeout' | 'logout' = 'ok';
  let adapterCalls = 0;
  providerUsageAdapters.claude = async () => {
    adapterCalls += 1;
    return okResult();
  };

  try {
    installClaudeAuthIo({
      credentials: async () => {
        if (credentialMode === 'ok') return validClaudeCredentials;
        if (credentialMode === 'json') return '{';
        return throwEnoent();
      },
    });

    const first = await getProviderUsage({ now: 1_800_000_000_000 });
    assert.equal(first.providers[0]?.status, 'ok');
    assert.equal(first.providers[0]?.windows[0]?.remainingRatio, 0.72);
    assert.equal(adapterCalls, 1);

    credentialMode = 'json';
    const second = await getProviderUsage({ now: 1_800_000_016_000, fresh: true });
    assert.equal(second.providers[0]?.providerId, 'claude');
    assert.equal(second.providers[0]?.status, 'stale');
    assert.equal(second.providers[0]?.windows[0]?.remainingRatio, 0.72);
    assert.equal(second.providers[0]?.windows.length, first.providers[0]?.windows.length);
    assert.equal(adapterCalls, 1);
    assert.equal(second.fetchedAt, first.fetchedAt);

    const cached = await getProviderUsage({ now: 1_800_000_017_000 });
    assert.equal(cached.cached, true);
    assert.equal(cached.providers[0]?.status, 'stale');
    assert.equal(cached.providers[0]?.windows[0]?.remainingRatio, 0.72);
  } finally {
    providerUsageAdapters.claude = originalAdapter;
    listMock.mock.restore();
    restoreClaudeAuthIo();
    resetProviderUsageCache();
  }
});

test('keychain timeout keeps last-known Claude quota and does not wipe cache', async () => {
  resetProviderUsageCache();
  const listMock = mock.method(providerRegistry, 'listProviders', () => ([{ id: 'claude' }] as never));
  const originalAdapter = providerUsageAdapters.claude;
  providerUsageAdapters.claude = async () => okResult();

  try {
    installClaudeAuthIo({
      platform: 'linux',
      credentials: async () => validClaudeCredentials,
    });
    const first = await getProviderUsage({ now: 1_800_000_000_000 });
    assert.equal(first.providers[0]?.status, 'ok');

    installClaudeAuthIo({
      platform: 'darwin',
      spawn: hangingKeychainSpawn,
      credentials: async () => throwEnoent(),
    });
    const second = await getProviderUsage({ now: 1_800_000_016_000, fresh: true });
    assert.equal(second.providers.length, 1);
    assert.equal(second.providers[0]?.status, 'stale');
    assert.match(second.providers[0]?.error ?? '', /timed out/);
    assert.equal(second.providers[0]?.windows[0]?.remainingRatio, 0.72);
  } finally {
    providerUsageAdapters.claude = originalAdapter;
    listMock.mock.restore();
    restoreClaudeAuthIo();
    resetProviderUsageCache();
  }
});

test('confirmed Claude logout omits the previous row', async () => {
  resetProviderUsageCache();
  const listMock = mock.method(providerRegistry, 'listProviders', () => ([{ id: 'claude' }] as never));
  const originalAdapter = providerUsageAdapters.claude;
  providerUsageAdapters.claude = async () => okResult();

  try {
    installClaudeAuthIo({
      credentials: async () => validClaudeCredentials,
    });
    const first = await getProviderUsage({ now: 1_800_000_000_000 });
    assert.equal(first.providers[0]?.providerId, 'claude');

    installClaudeAuthIo({
      credentials: async () => throwEnoent(),
    });
    const second = await getProviderUsage({ now: 1_800_000_016_000, fresh: true });
    assert.deepEqual(second.providers, []);
  } finally {
    providerUsageAdapters.claude = originalAdapter;
    listMock.mock.restore();
    restoreClaudeAuthIo();
    resetProviderUsageCache();
  }
});

test('cold-cache all-inconclusive does not persist a 5-minute empty snapshot', async () => {
  resetProviderUsageCache();
  const listMock = mock.method(providerRegistry, 'listProviders', () => ([{ id: 'claude' }] as never));
  let attempts = 0;
  const detectMock = mock.method(ClaudeProviderAuth.prototype, 'detectAuth', async () => {
    attempts += 1;
    if (attempts === 1) {
      return detectionFromStatus(inconclusiveAuthStatus('claude', 'keychain timed out'));
    }
    return detectionFromStatus(authStatus('claude', true));
  });
  const originalAdapter = providerUsageAdapters.claude;
  let adapterCalls = 0;
  providerUsageAdapters.claude = async () => {
    adapterCalls += 1;
    return okResult();
  };

  try {
    const first = await getProviderUsage({ now: 1_800_000_000_000 });
    assert.equal(first.cached, false);
    assert.equal(first.providers[0]?.status, 'error');
    assert.match(first.providers[0]?.error ?? '', /timed out/);
    assert.equal(adapterCalls, 0);

    const second = await getProviderUsage({ now: 1_800_000_001_000 });
    assert.equal(second.cached, false, 'cold inconclusive snapshot must not occupy the 5-minute poll TTL');
    assert.equal(second.providers[0]?.status, 'ok');
    assert.equal(second.providers[0]?.windows[0]?.remainingRatio, 0.72);
    assert.equal(adapterCalls, 1);
    assert.equal(attempts, 2);
  } finally {
    providerUsageAdapters.claude = originalAdapter;
    listMock.mock.restore();
    detectMock.mock.restore();
    resetProviderUsageCache();
  }
});

test('confirmed logout error strings are not classified inconclusive', () => {
  for (const error of ['Not logged in', 'Grok not configured', 'No valid tokens found', 'Codex not configured']) {
    assert.equal(isInconclusiveProviderAuthStatus({
      ...authStatus('grok', false),
      error,
    }), false, error);
  }
  assert.equal(isInconclusiveProviderAuthStatus({
    ...authStatus('grok', false),
    error: 'EACCES: permission denied',
  }), true);
});

test('Grok transient auth I/O keeps last-known quota stale', async () => {
  resetProviderUsageCache();
  const listMock = mock.method(providerRegistry, 'listProviders', () => ([
    { id: 'claude' },
    { id: 'grok' },
  ] as never));
  let grokAuthenticated = true;
  const authMock = mock.method(providerAuthService, 'getProviderAuthStatus', async (provider: string) => {
    if (provider === 'grok') {
      return grokAuthenticated
        ? authStatus('grok', true)
        : {
          ...authStatus('grok', false),
          error: 'EACCES: permission denied',
        };
    }
    return authStatus(provider, false);
  });
  const detectMock = mockClaudeDetectAuth(() => authStatus('claude', false));
  const originalGrok = providerUsageAdapters.grok;
  providerUsageAdapters.grok = async () => okResult(0.4);

  try {
    const first = await getProviderUsage({ now: 1_800_000_000_000 });
    assert.deepEqual(first.providers.map((provider) => provider.providerId), ['grok']);
    assert.equal(first.providers[0]?.status, 'ok');

    grokAuthenticated = false;
    const second = await getProviderUsage({ now: 1_800_000_016_000, fresh: true });
    assert.equal(second.providers[0]?.providerId, 'grok');
    assert.equal(second.providers[0]?.status, 'stale');
    assert.equal(second.providers[0]?.windows[0]?.remainingRatio, 0.4);
    assert.match(second.providers[0]?.error ?? '', /EACCES/);
  } finally {
    providerUsageAdapters.grok = originalGrok;
    listMock.mock.restore();
    authMock.mock.restore();
    detectMock.mock.restore();
    resetProviderUsageCache();
  }
});

test('Grok confirmed logout omits the previous row', async () => {
  resetProviderUsageCache();
  const listMock = mock.method(providerRegistry, 'listProviders', () => ([{ id: 'grok' }] as never));
  let grokAuthenticated = true;
  const authMock = mock.method(providerAuthService, 'getProviderAuthStatus', async () => (
    grokAuthenticated
      ? authStatus('grok', true)
      : { ...authStatus('grok', false), error: 'Not logged in' }
  ));
  const originalGrok = providerUsageAdapters.grok;
  providerUsageAdapters.grok = async () => okResult(0.4);

  try {
    const first = await getProviderUsage({ now: 1_800_000_000_000 });
    assert.equal(first.providers[0]?.providerId, 'grok');

    grokAuthenticated = false;
    const second = await getProviderUsage({ now: 1_800_000_016_000, fresh: true });
    assert.deepEqual(second.providers, []);
  } finally {
    providerUsageAdapters.grok = originalGrok;
    listMock.mock.restore();
    authMock.mock.restore();
    resetProviderUsageCache();
  }
});

test('Codex transient auth I/O keeps last-known quota stale', async () => {
  resetProviderUsageCache();
  const listMock = mock.method(providerRegistry, 'listProviders', () => ([
    { id: 'claude' },
    { id: 'codex' },
  ] as never));
  let codexAuthenticated = true;
  const authMock = mock.method(providerAuthService, 'getProviderAuthStatus', async (provider: string) => {
    if (provider === 'codex') {
      return codexAuthenticated
        ? authStatus('codex', true)
        : {
          ...authStatus('codex', false),
          error: 'EACCES: permission denied',
        };
    }
    return authStatus(provider, false);
  });
  const detectMock = mockClaudeDetectAuth(() => authStatus('claude', false));
  const originalCodex = providerUsageAdapters.codex;
  providerUsageAdapters.codex = async () => okResult(0.55);

  try {
    const first = await getProviderUsage({ now: 1_800_000_000_000 });
    assert.deepEqual(first.providers.map((provider) => provider.providerId), ['codex']);
    assert.equal(first.providers[0]?.status, 'ok');

    codexAuthenticated = false;
    const second = await getProviderUsage({ now: 1_800_000_016_000, fresh: true });
    assert.equal(second.providers[0]?.providerId, 'codex');
    assert.equal(second.providers[0]?.status, 'stale');
    assert.equal(second.providers[0]?.windows[0]?.remainingRatio, 0.55);
    assert.match(second.providers[0]?.error ?? '', /EACCES/);
  } finally {
    providerUsageAdapters.codex = originalCodex;
    listMock.mock.restore();
    authMock.mock.restore();
    detectMock.mock.restore();
    resetProviderUsageCache();
  }
});

test('auth-change invalidates Claude 30s cache so login/logout membership is fresh', async () => {
  resetProviderUsageCache();
  restoreClaudeAuthIo();
  const listMock = mock.method(providerRegistry, 'listProviders', () => ([{ id: 'claude' }] as never));
  const originalAdapter = providerUsageAdapters.claude;
  let clock = 1_800_000_000_000;
  let loggedIn = true;
  providerUsageAdapters.claude = async () => okResult();

  try {
    installClaudeAuthIo({
      now: () => clock,
      credentials: async () => (loggedIn ? validClaudeCredentials : throwEnoent()),
    });

    const first = await getProviderUsage({ now: clock });
    assert.equal(first.providers[0]?.providerId, 'claude');

    loggedIn = false;
    clock += 5_000;
    const stillCached = await new ClaudeProviderAuth().getStatus();
    assert.equal(stillCached.authenticated, true);

    const afterLogout = await getProviderUsage({ now: clock, reason: 'auth-change' });
    assert.deepEqual(afterLogout.providers.map((provider) => provider.providerId), []);
    assert.equal(afterLogout.cached, false);

    loggedIn = true;
    clock += 5_000;
    const afterLogin = await getProviderUsage({ now: clock, reason: 'auth-change' });
    assert.deepEqual(afterLogin.providers.map((provider) => provider.providerId), ['claude']);
    assert.equal(afterLogin.providers[0]?.status, 'ok');
  } finally {
    providerUsageAdapters.claude = originalAdapter;
    listMock.mock.restore();
    restoreClaudeAuthIo();
    resetProviderUsageCache();
  }
});

test('auth-change bypasses a cached authenticated=false Claude status', async () => {
  resetProviderUsageCache();
  const listMock = mock.method(providerRegistry, 'listProviders', () => ([{ id: 'claude' }] as never));
  const originalAdapter = providerUsageAdapters.claude;
  let bypassSeen = false;
  const detectMock = mock.method(ClaudeProviderAuth.prototype, 'detectAuth', async (options?: { bypassCache?: boolean }) => {
    if (options?.bypassCache) {
      bypassSeen = true;
      return detectionFromStatus(authStatus('claude', true));
    }
    return detectionFromStatus(authStatus('claude', false));
  });
  const invalidateMock = mock.method(ClaudeProviderAuth, 'invalidateStatusCache', () => undefined);
  providerUsageAdapters.claude = async () => okResult();

  try {
    const loggedOut = await getProviderUsage({ now: 1_800_000_000_000 });
    assert.deepEqual(loggedOut.providers, []);

    const loggedIn = await getProviderUsage({
      now: 1_800_000_005_000,
      reason: 'auth-change',
    });
    assert.equal(bypassSeen, true);
    assert.equal(invalidateMock.mock.callCount() > 0, true);
    assert.deepEqual(loggedIn.providers.map((provider) => provider.providerId), ['claude']);
  } finally {
    providerUsageAdapters.claude = originalAdapter;
    listMock.mock.restore();
    detectMock.mock.restore();
    invalidateMock.mock.restore();
    resetProviderUsageCache();
  }
});
