import assert from 'node:assert/strict';
import test from 'node:test';

import type { BotChannel } from '../../types/botRuntime';

import {
  EMAIL_DEFERRED_MESSAGE,
  EMPTY_CONFIG_DRAFT,
  EMPTY_POLICY_DRAFT,
  addableKinds,
  channelMeta,
  configToDraft,
  draftToConfig,
  draftToPolicy,
  groupChannels,
  isValidTimeZone,
  normalizeSecretRef,
  outboundReasonLabel,
  policyParts,
  policySummary,
  policyToDraft,
  publicUrlStatus,
  urgencyLabel,
  validateQuietHours,
} from './channelsModel';

function channel(id: string, kind: string, botId: string | null): BotChannel {
  return { channel_id: id, bot_id: botId, kind, config: {}, policy: {}, enabled: true, created_at: '', updated_at: '' };
}

test('normalizeSecretRef accepts refs and bare names, rejects raw-looking values', () => {
  assert.equal(normalizeSecretRef(''), '');
  assert.equal(normalizeSecretRef('  '), '');
  assert.equal(normalizeSecretRef('${secret:SLACK_TOKEN}'), '${secret:SLACK_TOKEN}');
  assert.equal(normalizeSecretRef('SLACK_TOKEN'), '${secret:SLACK_TOKEN}');
  assert.equal(normalizeSecretRef('xoxb-123'), '${secret:xoxb-123}');
  assert.equal(normalizeSecretRef('has space'), null);
  assert.equal(normalizeSecretRef('https://hooks.slack.com/x/y'), null);
  assert.equal(normalizeSecretRef('${secret:}'), null);
});

test('validateQuietHours checks times, difference and time zone', () => {
  assert.equal(validateQuietHours('22:00', '07:00', 'Asia/Dubai'), null);
  assert.equal(validateQuietHours('22:00', '07:00', ''), null);
  assert.match(validateQuietHours('25:00', '07:00', '') ?? '', /HH:MM/);
  assert.match(validateQuietHours('9:00', '07:00', '') ?? '', /HH:MM/);
  assert.match(validateQuietHours('08:00', '08:00', '') ?? '', /differ/);
  assert.match(validateQuietHours('22:00', '07:00', 'Mars/Olympus') ?? '', /not a valid IANA/);
  assert.equal(isValidTimeZone('Asia/Dubai'), true);
  assert.equal(isValidTimeZone('nope'), false);
});

test('policy draft round-trips and omits everything left off', () => {
  assert.deepEqual(draftToPolicy(EMPTY_POLICY_DRAFT, { global: true }), { policy: {}, errors: [] });
  const policy = { quiet_hours: { start: '22:00', end: '06:30', tz: 'Asia/Dubai' }, max_pings_per_day: 5, min_urgency: 0.4, digest: true, brief_at: '08:00', brief_tz: 'Asia/Dubai' };
  const draft = policyToDraft(policy);
  assert.equal(draft.quietEnabled, true);
  assert.equal(draft.maxPings, '5');
  assert.deepEqual(draftToPolicy(draft, { global: true }), { policy, errors: [] });
  // brief_* are global-only.
  const botScoped = draftToPolicy(draft, { global: false }).policy;
  assert.equal('brief_at' in botScoped, false);
  assert.equal('brief_tz' in botScoped, false);
});

test('draftToPolicy reports every invalid field', () => {
  const { policy, errors } = draftToPolicy({
    ...EMPTY_POLICY_DRAFT,
    quietEnabled: true,
    quietStart: '99:00',
    maxPings: '-2',
    minUrgency: 2,
    briefAt: '8am',
    briefTz: 'Nope/Zone',
  }, { global: true });
  assert.equal(errors.length, 5);
  assert.deepEqual(policy, {});
  assert.match(draftToPolicy({ ...EMPTY_POLICY_DRAFT, maxPings: '2.5' }, { global: false }).errors[0], /whole number/);
  assert.equal(draftToPolicy({ ...EMPTY_POLICY_DRAFT, maxPings: '0' }, { global: false }).policy.max_pings_per_day, 0);
  // A disabled quiet-hours toggle never validates its leftover fields.
  assert.deepEqual(draftToPolicy({ ...EMPTY_POLICY_DRAFT, quietEnabled: false, quietStart: 'garbage' }, { global: false }), { policy: {}, errors: [] });
});

test('policy summaries read naturally', () => {
  assert.deepEqual(policyParts({}), ['No limits']);
  assert.deepEqual(policyParts(null), ['No limits']);
  assert.equal(
    policySummary({ quiet_hours: { start: '22:00', end: '07:00', tz: 'Asia/Dubai' }, max_pings_per_day: 3, min_urgency: 0.5, digest: true }),
    'Quiet 22:00–07:00 (Asia/Dubai) · Max 3 pings/day · Urgency ≥ 50% · Digest only',
  );
  assert.deepEqual(policyParts({ max_pings_per_day: 0 }), ['No pings']);
  assert.deepEqual(policyParts({ min_urgency: 0 }), ['No limits']);
  assert.deepEqual(policyParts({ brief_at: '07:30' }), ['Brief at 07:30']);
  assert.equal(urgencyLabel(0), 'Everything');
  assert.equal(urgencyLabel(0.5), 'Medium and above');
  assert.equal(urgencyLabel(1), 'Urgent only');
});

test('slack config: bot mode needs token + channel, webhook mode needs only the webhook ref', () => {
  const bot = draftToConfig('slack', { ...EMPTY_CONFIG_DRAFT, tokenRef: 'SLACK_TOKEN', channelId: ' C012 ' });
  assert.deepEqual(bot, { config: { token_ref: '${secret:SLACK_TOKEN}', channel_id: 'C012' }, errors: [] });
  assert.equal(draftToConfig('slack', { ...EMPTY_CONFIG_DRAFT }).errors.length, 2);
  const hook = draftToConfig('slack', { ...EMPTY_CONFIG_DRAFT, slackMode: 'webhook', webhookUrlRef: '${secret:HOOK}', tokenRef: 'ignored', channelId: 'ignored' });
  assert.deepEqual(hook, { config: { webhook_url_ref: '${secret:HOOK}' }, errors: [] });
  assert.equal(draftToConfig('slack', { ...EMPTY_CONFIG_DRAFT, slackMode: 'webhook' }).errors.length, 1);
  assert.match(draftToConfig('slack', { ...EMPTY_CONFIG_DRAFT, slackMode: 'webhook', webhookUrlRef: 'https://hooks.slack.com/x' }).errors[0], /secret reference/);
});

test('telegram config validates chat id and inbound, and preserves server-owned keys on edit', () => {
  const base = { ...EMPTY_CONFIG_DRAFT, tokenRef: 'TG_TOKEN', chatId: '-100123' };
  assert.deepEqual(draftToConfig('telegram', base).config, { token_ref: '${secret:TG_TOKEN}', chat_id: '-100123' });
  const inbound = draftToConfig('telegram', { ...base, inbound: true }, { inbound: true, inbound_offset: 42, poll_timeout_s: 20, token_ref: 'x' });
  assert.deepEqual(inbound.config, { token_ref: '${secret:TG_TOKEN}', chat_id: '-100123', inbound: true, inbound_offset: 42, poll_timeout_s: 20 });
  assert.match(draftToConfig('telegram', { ...base, chatId: 'abc' }).errors[0], /numeric/);
  assert.match(draftToConfig('telegram', { ...base, chatId: '@chan', inbound: true }).errors[0], /numeric/);
  assert.deepEqual(draftToConfig('telegram', { ...base, chatId: '@chan' }).errors, []);
  assert.equal(draftToConfig('telegram', { ...EMPTY_CONFIG_DRAFT, chatId: '1' }).errors.length, 1);
});

test('action base url must be http(s) and only applies to slack/telegram', () => {
  const base = { ...EMPTY_CONFIG_DRAFT, tokenRef: 'T', chatId: '1' };
  assert.equal(draftToConfig('telegram', { ...base, actionBaseUrl: 'https://bots.example.com' }).config.action_base_url, 'https://bots.example.com');
  assert.match(draftToConfig('telegram', { ...base, actionBaseUrl: 'ftp://x' }).errors[0], /http/);
  assert.match(draftToConfig('telegram', { ...base, actionBaseUrl: 'not a url' }).errors[0], /valid URL/);
  assert.deepEqual(draftToConfig('webpush', { ...EMPTY_CONFIG_DRAFT, actionBaseUrl: 'https://x.test' }), { config: {}, errors: [] });
  assert.deepEqual(draftToConfig('email', EMPTY_CONFIG_DRAFT).errors, [EMAIL_DEFERRED_MESSAGE]);
});

test('configToDraft reads each kind back', () => {
  assert.equal(configToDraft('slack', { webhook_url_ref: '${secret:H}' }).slackMode, 'webhook');
  assert.equal(configToDraft('slack', { token_ref: '${secret:T}', channel_id: 'C1' }).slackMode, 'bot');
  const telegram = configToDraft('telegram', { token_ref: '${secret:T}', chat_id: 123, inbound: true, action_base_url: 'https://x.test' });
  assert.equal(telegram.chatId, '123');
  assert.equal(telegram.inbound, true);
  assert.equal(telegram.actionBaseUrl, 'https://x.test');
  assert.deepEqual(configToDraft('webpush', null), EMPTY_CONFIG_DRAFT);
});

test('addableKinds hides configured and deferred kinds', () => {
  assert.deepEqual(addableKinds([]).map((entry) => entry.kind), ['webpush', 'slack', 'telegram']);
  assert.deepEqual(addableKinds([{ kind: 'slack' }]).map((entry) => entry.kind), ['webpush', 'telegram']);
  assert.equal(channelMeta('email').deferred, true);
  assert.equal(channelMeta('inapp').alwaysOn, true);
  assert.equal(channelMeta('carrier-pigeon').label, 'carrier-pigeon');
});

test('groupChannels puts global first (even when empty) and sorts bots by title', () => {
  const groups = groupChannels(
    [channel('1', 'slack', 'zed'), channel('2', 'inapp', null), channel('3', 'telegram', 'alpha'), channel('4', 'webpush', 'zed')],
    (id) => ({ zed: 'Zed Bot', alpha: 'Alpha Bot' })[id] ?? id,
  );
  assert.deepEqual(groups.map((group) => [group.botId, group.channels.length]), [[null, 1], ['alpha', 1], ['zed', 2]]);
  assert.equal(groupChannels([], (id) => id)[0].channels.length, 0);
});

test('outboundReasonLabel explains held-back, failed and delivered rows', () => {
  assert.equal(outboundReasonLabel(true, null), 'Delivered');
  assert.equal(outboundReasonLabel(true, 'test'), 'Test message');
  assert.equal(outboundReasonLabel(false, null), 'Not delivered');
  assert.equal(outboundReasonLabel(false, 'quiet_hours: Deploy ready'), 'Held back (quiet hours): Deploy ready');
  assert.equal(outboundReasonLabel(false, 'digest'), 'Held back (digest)');
  assert.equal(outboundReasonLabel(false, 'max_pings_per_day: x'), 'Daily ping limit reached: x');
  assert.equal(outboundReasonLabel(false, 'telegram error: chat not found'), 'telegram error: chat not found');
});

test('publicUrlStatus reflects the host probe and tolerates missing data', () => {
  assert.equal(publicUrlStatus({ publicUrlConfigured: true }).tone, 'success');
  assert.equal(publicUrlStatus({ publicUrlConfigured: false }).tone, 'warning');
  assert.match(publicUrlStatus({ publicUrlConfigured: false }).detail, /localhost/);
  assert.equal(publicUrlStatus(null).label, 'Unknown');
  assert.equal(publicUrlStatus({ publicUrlConfigured: 'yes' }).label, 'Unknown');
});
