import assert from 'node:assert/strict';
import test from 'node:test';

import { channelAllowedByRules } from '../services/notification-orchestrator.service.js';

function baseEvent(overrides = {}) {
  return {
    provider: 'claude',
    sessionId: 'sess-1',
    kind: 'error',
    code: 'run.failed',
    severity: 'error',
    source: 'chat',
    ...overrides,
  };
}

test('allows when there are no rules', () => {
  const preferences = { rules: [] };
  assert.equal(channelAllowedByRules(preferences, 'webPush', baseEvent()), true);
  assert.equal(channelAllowedByRules(preferences, 'desktop', baseEvent()), true);
});

test('allows when rules exist only for other channels', () => {
  const preferences = {
    rules: [{ channel: 'desktop', kinds: ['error'], sources: [], enabled: false }],
  };
  assert.equal(channelAllowedByRules(preferences, 'webPush', baseEvent()), true);
});

test('blocks when a rule blocks the event kind', () => {
  const preferences = {
    rules: [{ channel: 'webPush', kinds: ['error'], sources: [], enabled: false }],
  };
  assert.equal(channelAllowedByRules(preferences, 'webPush', baseEvent({ kind: 'error' })), false);
  assert.equal(channelAllowedByRules(preferences, 'webPush', baseEvent({ kind: 'stop' })), true);
});

test('matches kinds against the mapped preference key (actionRequired)', () => {
  const preferences = {
    rules: [{ channel: 'webPush', kinds: ['actionRequired'], sources: [], enabled: false }],
  };
  assert.equal(channelAllowedByRules(preferences, 'webPush', baseEvent({ kind: 'action_required' })), false);
  assert.equal(channelAllowedByRules(preferences, 'webPush', baseEvent({ kind: 'error' })), true);
});

test('blocks when a rule blocks the event source', () => {
  const preferences = {
    rules: [{ channel: 'desktop', kinds: [], sources: ['kanban'], enabled: false }],
  };
  assert.equal(channelAllowedByRules(preferences, 'desktop', baseEvent({ source: 'kanban' })), false);
  assert.equal(channelAllowedByRules(preferences, 'desktop', baseEvent({ source: 'chat' })), true);
});

test('blocks only when kind and source both match', () => {
  const preferences = {
    rules: [{ channel: 'webPush', kinds: ['error'], sources: ['kanban'], enabled: false }],
  };
  const blocked = baseEvent({ kind: 'error', source: 'kanban' });
  assert.equal(channelAllowedByRules(preferences, 'webPush', blocked), false);
  assert.equal(channelAllowedByRules(preferences, 'webPush', baseEvent({ kind: 'error', source: 'chat' })), true);
  assert.equal(channelAllowedByRules(preferences, 'webPush', baseEvent({ kind: 'stop', source: 'kanban' })), true);
});

test('a rule with no kinds/sources blocks everything on that channel', () => {
  const preferences = {
    rules: [{ channel: 'webPush', kinds: [], sources: [], enabled: false }],
  };
  assert.equal(channelAllowedByRules(preferences, 'webPush', baseEvent({ kind: 'stop' })), false);
  assert.equal(channelAllowedByRules(preferences, 'webPush', baseEvent({ kind: 'error' })), false);
  assert.equal(channelAllowedByRules(preferences, 'webPush', baseEvent({ kind: 'info' })), false);
});

test('force-allow rule overrides a blocking rule', () => {
  const preferences = {
    rules: [
      { channel: 'webPush', kinds: ['error'], sources: [], enabled: false },
      { channel: 'webPush', kinds: ['error'], sources: ['chat'], enabled: true },
    ],
  };
  assert.equal(channelAllowedByRules(preferences, 'webPush', baseEvent({ kind: 'error', source: 'chat' })), true);
  assert.equal(channelAllowedByRules(preferences, 'webPush', baseEvent({ kind: 'error', source: 'kanban' })), false);
});

test('derives source from provider when event.source is missing', () => {
  const preferences = {
    rules: [{ channel: 'webPush', kinds: [], sources: ['claude'], enabled: false }],
  };
  const { source, ...withoutSource } = baseEvent();
  assert.equal(channelAllowedByRules(preferences, 'webPush', withoutSource), false);
});

test('non-matching block rules leave the event allowed', () => {
  const preferences = {
    rules: [
      { channel: 'webPush', kinds: ['stop'], sources: ['auth-health'], enabled: false },
    ],
  };
  assert.equal(channelAllowedByRules(preferences, 'webPush', baseEvent({ kind: 'error', source: 'chat' })), true);
});
