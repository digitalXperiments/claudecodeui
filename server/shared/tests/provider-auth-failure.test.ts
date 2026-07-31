import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildProviderAuthFailureMessage,
  detectProviderAuthFailure,
  resolveProviderAuthFailure,
} from '@/shared/provider-auth-failure.js';

// The exact message that produced 13 bogus "produce parse failed" Mission
// Control items on 2026-07-30.
const REAL_CLAUDE_FAILURE = 'Failed to authenticate: OAuth session expired and could not be refreshed';

test('detectProviderAuthFailure recognises the real Claude OAuth failure', () => {
  assert.equal(detectProviderAuthFailure(REAL_CLAUDE_FAILURE), REAL_CLAUDE_FAILURE);
});

test('detectProviderAuthFailure returns the offending line out of noisy output', () => {
  const raw = [
    'Reading Slack threads…',
    'called tool slack_read_channel',
    REAL_CLAUDE_FAILURE,
    '    at Object.<anonymous> (/app/cli.js:1:1)',
  ].join('\n');

  assert.equal(detectProviderAuthFailure(raw), REAL_CLAUDE_FAILURE);
});

test('detectProviderAuthFailure covers common provider auth wordings', () => {
  const samples = [
    'Claude login has expired. Run claude auth login again.',
    'Error: invalid API key',
    'API key is missing',
    'The refresh token is invalid',
    '{"type":"authentication_error","message":"x"}',
    'error: invalid_grant',
    'HTTP 401 Unauthorized: token expired',
    'Please re-authenticate and try again',
  ];

  for (const sample of samples) {
    assert.ok(detectProviderAuthFailure(sample), `expected auth failure for: ${sample}`);
  }
});

test('detectProviderAuthFailure ignores content that merely mentions auth topics', () => {
  const samples = [
    '',
    '   ',
    '[]',
    '[{"title":"Rotate the Cloudflare token","dedupeKey":"jira-1"}]',
    'Summary: the team discussed authentication improvements this sprint.',
    'The article explains how OAuth refresh tokens work in general.',
    'Ticket AUTH-42: add a login button to the settings page.',
    'Returned 403 Forbidden because the channel is private.',
  ];

  for (const sample of samples) {
    assert.equal(detectProviderAuthFailure(sample), null, `false positive for: ${sample}`);
  }
});

test('buildProviderAuthFailureMessage names the provider and the fix', () => {
  const message = buildProviderAuthFailureMessage('claude', REAL_CLAUDE_FAILURE);
  assert.match(message, /Provider "claude" is not authenticated/);
  assert.match(message, /claude auth login/);
  assert.match(message, /OAuth session expired/);

  const grok = buildProviderAuthFailureMessage('grok', 'invalid API key');
  assert.match(grok, /Re-authenticate the "grok" CLI/);
});

test('resolveProviderAuthFailure prefers the error channel then falls back to text', () => {
  assert.match(
    resolveProviderAuthFailure('claude', REAL_CLAUDE_FAILURE, 'ignored') ?? '',
    /OAuth session expired/,
  );
  assert.match(
    resolveProviderAuthFailure('claude', null, REAL_CLAUDE_FAILURE) ?? '',
    /OAuth session expired/,
  );
  assert.equal(resolveProviderAuthFailure('claude', null, '[{"title":"ok"}]'), null);
});
