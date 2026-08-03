import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AUTH_HEALTH_DEDUPE_PREFIX,
  planAuthHealthNotifications,
  REAUTH_HINTS,
  RENOTIFY_COOLDOWN_MS,
  type AuthHealthOpenNotification,
  type AuthHealthProviderReport,
  type AuthHealthReport,
} from '@/modules/auth-health/auth-health.service.js';

const NOW = 1_800_000_000_000;

function entry(patch: Partial<AuthHealthProviderReport>): AuthHealthProviderReport {
  return {
    provider: 'claude',
    installed: true,
    authenticated: true,
    email: null,
    method: null,
    error: null,
    ...patch,
  };
}

function report(providers: AuthHealthProviderReport[]): AuthHealthReport {
  return { checkedAt: new Date(NOW).toISOString(), providers };
}

function openAlert(provider: string, notificationId = `note-${provider}`): AuthHealthOpenNotification {
  return {
    notification_id: notificationId,
    meta: { dedupeKey: `${AUTH_HEALTH_DEDUPE_PREFIX}${provider}` },
  };
}

test('REAUTH_HINTS covers every known provider', () => {
  for (const provider of ['claude', 'codex', 'cursor', 'opencode', 'grok', 'kimi', 'agy', 'pi']) {
    assert.ok(REAUTH_HINTS[provider], `missing reauth hint for ${provider}`);
  }
});

test('broken provider with no open alert creates a notification', () => {
  const actions = planAuthHealthNotifications(
    report([entry({ authenticated: false, error: 'OAuth session expired' })]),
    [],
    new Map(),
    NOW,
  );

  assert.equal(actions.length, 1);
  const action = actions[0];
  assert.equal(action.type, 'create');
  if (action.type !== 'create') return;
  assert.equal(action.provider, 'claude');
  assert.equal(action.input.dedupeKey, 'auth-health:claude');
  assert.equal(action.input.kind, 'action_required');
  assert.equal(action.input.severity, 'error');
  assert.equal(action.input.source, 'auth-health');
  assert.equal(action.input.href, 'settings:agents');
  assert.deepEqual(action.input.meta, { provider: 'claude' });
  assert.match(action.input.title, /Claude authentication expired/);
  assert.match(action.input.body ?? '', /OAuth session expired/);
  assert.match(action.input.body ?? '', /claude auth login/);
  assert.match(action.input.body ?? '', /Settings → Agents/);
});

test('broken provider with an open alert is a no-op', () => {
  const actions = planAuthHealthNotifications(
    report([entry({ authenticated: false })]),
    [openAlert('claude')],
    new Map(),
    NOW,
  );

  assert.deepEqual(actions, []);
});

test('dismissed alert inside the 24h cooldown is a no-op', () => {
  const lastNotified = new Map([['claude', NOW - 60 * 60 * 1000]]); // 1h ago
  const actions = planAuthHealthNotifications(
    report([entry({ authenticated: false })]),
    [],
    lastNotified,
    NOW,
  );

  assert.deepEqual(actions, []);
});

test('dismissed alert past the 24h cooldown re-creates the notification', () => {
  const lastNotified = new Map([['claude', NOW - RENOTIFY_COOLDOWN_MS - 1]]);
  const actions = planAuthHealthNotifications(
    report([entry({ authenticated: false })]),
    [],
    lastNotified,
    NOW,
  );

  assert.equal(actions.length, 1);
  assert.equal(actions[0].type, 'create');
});

test('cooldown boundary: exactly 24h ago re-creates the notification', () => {
  const lastNotified = new Map([['claude', NOW - RENOTIFY_COOLDOWN_MS]]);
  const actions = planAuthHealthNotifications(
    report([entry({ authenticated: false })]),
    [],
    lastNotified,
    NOW,
  );

  assert.equal(actions.length, 1);
  assert.equal(actions[0].type, 'create');
});

test('recovered provider with an open alert dismisses it silently', () => {
  const actions = planAuthHealthNotifications(
    report([entry({ authenticated: true })]),
    [openAlert('claude', 'note-123')],
    new Map(),
    NOW,
  );

  assert.deepEqual(actions, [
    {
      type: 'dismiss',
      provider: 'claude',
      dedupeKey: 'auth-health:claude',
      notificationId: 'note-123',
    },
  ]);
});

test('recovered provider with no open alert is a no-op', () => {
  const actions = planAuthHealthNotifications(
    report([entry({ authenticated: true })]),
    [],
    new Map(),
    NOW,
  );

  assert.deepEqual(actions, []);
});

test('uninstalled provider never alerts, even when unauthenticated', () => {
  const actions = planAuthHealthNotifications(
    report([entry({ installed: false, authenticated: false, error: 'CLI not found' })]),
    [],
    new Map(),
    NOW,
  );

  assert.deepEqual(actions, []);
});

test('open alert for a different provider does not suppress this provider', () => {
  const actions = planAuthHealthNotifications(
    report([entry({ provider: 'codex', authenticated: false })]),
    [openAlert('claude')],
    new Map(),
    NOW,
  );

  assert.equal(actions.length, 1);
  const action = actions[0];
  assert.equal(action.type, 'create');
  if (action.type !== 'create') return;
  assert.equal(action.input.dedupeKey, 'auth-health:codex');
  assert.match(action.input.body ?? '', /codex login/);
});

test('mixed report plans per provider independently', () => {
  const actions = planAuthHealthNotifications(
    report([
      entry({ provider: 'claude', authenticated: false }), // broken, alert open → no-op
      entry({ provider: 'codex', authenticated: false }), // broken, no alert → create
      entry({ provider: 'grok', authenticated: true }), // recovered, alert open → dismiss
      entry({ provider: 'pi', installed: false, authenticated: false }), // not installed → no-op
    ]),
    [openAlert('claude'), openAlert('grok')],
    new Map(),
    NOW,
  );

  assert.deepEqual(
    actions.map((a) => [a.type, a.provider]),
    [
      ['create', 'codex'],
      ['dismiss', 'grok'],
    ],
  );
});

test('disabled provider with an open alert gets it dismissed', () => {
  const actions = planAuthHealthNotifications(
    report([]),
    [openAlert('cursor'), openAlert('pi')],
    new Map(),
    NOW,
    new Set(['cursor', 'pi']),
  );

  assert.deepEqual(
    actions.map((a) => [a.type, a.provider]),
    [
      ['dismiss', 'cursor'],
      ['dismiss', 'pi'],
    ],
  );
});

test('disabled provider with no open alert is a no-op', () => {
  const actions = planAuthHealthNotifications(report([]), [], new Map(), NOW, new Set(['cursor']));

  assert.deepEqual(actions, []);
});

test('disabled provider in the report is skipped even when broken', () => {
  const actions = planAuthHealthNotifications(
    report([entry({ provider: 'cursor', authenticated: false })]),
    [],
    new Map(),
    NOW,
    new Set(['cursor']),
  );

  assert.deepEqual(actions, []);
});
