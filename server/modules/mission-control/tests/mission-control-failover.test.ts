import assert from 'node:assert/strict';
import test from 'node:test';

import { AppError } from '@/shared/utils.js';
import {
  classifyFailoverError,
  classifyFailoverFailure,
  isGateDenialText,
} from '@/modules/mission-control/mission-control-failover.js';

test('auth failures, rate/usage limits and unavailable providers are failover-eligible', () => {
  const cases: Array<[string, string, string]> = [
    ['claude', 'OAuth session expired. Run claude /login', 'auth'],
    ['codex', 'invalid api key provided', 'auth'],
    ['claude', 'Claude AI usage limit reached|1893456000', 'limit'],
    ['codex', 'HTTP 429 Too Many Requests', 'limit'],
    ['grok', 'You exceeded your current quota, please check your plan', 'limit'],
    ['claude', 'rate limit exceeded; retry in 30 seconds', 'limit'],
    ['codex', 'Error: connect ECONNREFUSED 127.0.0.1:443', 'unavailable'],
    ['claude', 'overloaded_error: Overloaded', 'unavailable'],
    ['grok', '503 Service Unavailable', 'unavailable'],
    ['kimi', 'spawn kimi ENOENT', 'unavailable'],
  ];
  for (const [provider, text, reason] of cases) {
    assert.equal(classifyFailoverFailure(provider, text, null)?.reason, reason, text);
    assert.equal(classifyFailoverFailure(provider, null, text)?.reason, reason, `${text} (as output text)`);
  }
});

test('normal task failures and stray mentions of "limit" are not eligible', () => {
  for (const text of [
    'TypeError: cannot read properties of undefined',
    'tool crashed: boom',
    'The summary exceeded the character limit of the draft field, so I truncated it.',
    'Could not parse the JSON the model produced',
    'Permission denied writing /tmp/x',
    '',
  ]) {
    assert.equal(classifyFailoverFailure('claude', text, text), null, text);
  }
  assert.equal(classifyFailoverFailure('claude', null, null), null);
});

test('a gate denial never fails over, even next to provider-sounding words', () => {
  const texts = [
    'Blocked by the action gate (send): rate limit of sends reached',
    'The operator rejected this call (send): 429 from downstream',
    'No operator decision before the approval expired (publish); ECONNREFUSED',
  ];
  for (const text of texts) {
    assert.equal(isGateDenialText(text), true, text);
    assert.equal(classifyFailoverFailure('claude', text, null), null, text);
  }
  assert.equal(isGateDenialText('429 rate limit exceeded'), false);
});

test('thrown start errors: a missing runtime is unavailable; an in-progress run is never retried', () => {
  assert.equal(classifyFailoverError('claude', new AppError('x', { code: 'MC_RUNTIME_UNAVAILABLE', statusCode: 400 }))?.reason, 'unavailable');
  assert.equal(classifyFailoverError('claude', new AppError('busy', { code: 'MC_RUN_IN_PROGRESS', statusCode: 409 })), null);
  assert.equal(classifyFailoverError('claude', new Error('connect ETIMEDOUT'))?.reason, 'unavailable');
  assert.equal(classifyFailoverError('claude', new Error('weird bug')), null);
});
