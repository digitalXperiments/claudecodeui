import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  createKimiUsageAdapter,
  parseKimiUsagePayload,
} from '../provider-usage.adapters.js';

const fixture = async (): Promise<unknown> => (
  JSON.parse(await readFile(new URL('./fixtures/kimi-usage.json', import.meta.url), 'utf8'))
);

const jsonResponse = (payload: unknown, status = 200): Response => (
  new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
);

test('Kimi usage parser maps weekly and rolling five-hour quota windows', async () => {
  const result = parseKimiUsagePayload(await fixture());

  assert.equal(result.status, 'ok');
  assert.equal(result.primaryWindowId, 'five_hour');
  assert.deepEqual(result.windows.map((window) => ({
    id: window.id,
    label: window.label,
    used: window.used,
    limit: window.limit,
    remaining: window.remaining,
    remainingRatio: window.remainingRatio,
    resetsAt: window.resetsAt,
    unit: window.unit,
  })), [
    {
      id: 'weekly',
      label: 'Weekly',
      used: 42,
      limit: 100,
      remaining: 58,
      remainingRatio: 0.58,
      resetsAt: '2026-08-22T12:00:00.000Z',
      unit: 'unknown',
    },
    {
      id: 'five_hour',
      label: '5h window',
      used: 18,
      limit: 100,
      remaining: 82,
      remainingRatio: 0.82,
      resetsAt: '2026-08-16T18:00:00.000Z',
      unit: 'unknown',
    },
  ]);
});

test('Kimi usage adapter refreshes an expired access token before reading quota', async () => {
  const nowMs = Date.parse('2026-08-16T17:00:00.000Z');
  const calls: Array<{ url: string; method: string; authorization: string | null }> = [];
  let savedCredentials: Record<string, unknown> | null = null;

  const adapter = createKimiUsageAdapter({
    now: () => nowMs,
    endpoint: 'https://api.example.test/coding/v1/usages',
    oauthEndpoint: 'https://auth.example.test/api/oauth/token',
    readCredentials: async () => ({
      access_token: 'expired-access-token',
      refresh_token: 'refresh-token',
      expires_at: Math.floor(nowMs / 1000) - 1,
    }),
    writeCredentials: async (credentials) => {
      savedCredentials = credentials;
    },
    fetchImpl: async (input, init) => {
      const url = String(input);
      calls.push({
        url,
        method: init?.method ?? 'GET',
        authorization: new Headers(init?.headers).get('authorization'),
      });
      if (url === 'https://auth.example.test/api/oauth/token') {
        return jsonResponse({
          access_token: 'fresh-access-token',
          refresh_token: 'rotated-refresh-token',
          expires_in: 900,
        });
      }
      return jsonResponse(await fixture());
    },
  });

  const result = await adapter({
    authStatus: {
      provider: 'kimi',
      installed: true,
      authenticated: true,
      email: 'kimi@example.test',
      method: 'oauth',
    },
  });

  assert.equal(result.status, 'ok');
  assert.deepEqual(calls.map(({ url, method, authorization }) => ({ url, method, authorization })), [
    {
      url: 'https://auth.example.test/api/oauth/token',
      method: 'POST',
      authorization: null,
    },
    {
      url: 'https://api.example.test/coding/v1/usages',
      method: 'GET',
      authorization: 'Bearer fresh-access-token',
    },
  ]);
  const persistedCredentials = savedCredentials as unknown as Record<string, unknown>;
  assert.equal(persistedCredentials.access_token, 'fresh-access-token');
  assert.equal(persistedCredentials.refresh_token, 'rotated-refresh-token');
  assert.equal(persistedCredentials.expires_at, Math.floor(nowMs / 1000) + 900);
});
