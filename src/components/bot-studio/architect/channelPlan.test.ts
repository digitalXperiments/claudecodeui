import assert from 'node:assert/strict';
import test from 'node:test';

import type { BotChannel } from '../types/botRuntime';

import { describeChannelChoices, planChannels, quietPolicy } from './channelPlan';
import { EMPTY_CHANNEL_CONFIG, emptyRuntimeDraft } from './runtimeDraft';

const channel = (id: string, kind: string, extra: Partial<BotChannel> = {}): BotChannel => ({
  channel_id: id, bot_id: null, kind, config: {}, policy: {}, enabled: true, created_at: '', updated_at: '', ...extra,
});

const slack = channel('c-slack', 'slack', { config: { token_ref: '${secret:S}', channel_id: 'C1' }, policy: { max_pings_per_day: 5, brief_at: '08:00', brief_tz: 'Asia/Dubai' } as BotChannel['policy'] });
const telegram = channel('c-tg', 'telegram', { config: { token_ref: '${secret:T}', chat_id: '1', inbound: true, inbound_offset: 99, poll_timeout_s: 30 } });
const push = channel('c-push', 'webpush');

test('by default a bot only inherits the shared channels: nothing to create', () => {
  const plan = planChannels(emptyRuntimeDraft().channels, [slack, telegram, push]);
  assert.deepEqual(plan, { ops: [], errors: [] });
});

test('opting out of a shared channel saves a disabled bot-specific copy of it', () => {
  const channels = { ...emptyRuntimeDraft().channels, skipGlobal: ['c-slack'] };
  const plan = planChannels(channels, [slack, push]);
  assert.equal(plan.ops.length, 1);
  assert.equal(plan.ops[0].kind, 'slack');
  assert.equal(plan.ops[0].input.enabled, false);
  assert.deepEqual(plan.ops[0].input.config, slack.config);
  assert.deepEqual(plan.ops[0].input.policy, {});
});

test('quiet hours copy each kept shared channel with the window and without global-only or poller state', () => {
  const channels = { ...emptyRuntimeDraft().channels, quiet: { enabled: true, start: '22:00', end: '07:00', tz: 'Asia/Dubai' } };
  const plan = planChannels(channels, [slack, telegram, push, channel('off', 'kimi-nope', { enabled: false })]);
  assert.deepEqual(plan.errors, []);
  assert.deepEqual(plan.ops.map((op) => op.kind), ['slack', 'telegram', 'webpush']);
  const slackOp = plan.ops[0];
  assert.deepEqual(slackOp.input.policy, { max_pings_per_day: 5, quiet_hours: { start: '22:00', end: '07:00', tz: 'Asia/Dubai' } });
  assert.equal('brief_at' in (slackOp.input.policy ?? {}), false);
  const tgOp = plan.ops[1];
  assert.deepEqual(tgOp.input.config, { token_ref: '${secret:T}', chat_id: '1' }, 'a second inbound poller on the same token must not be created');
  assert.ok(plan.ops.every((op) => op.quiet && op.input.enabled === true));
});

test('a switched-off shared channel is never copied for quiet hours, and in-app is implicit', () => {
  const channels = { ...emptyRuntimeDraft().channels, quiet: { enabled: true, start: '22:00', end: '07:00', tz: '' } };
  assert.deepEqual(planChannels(channels, [channel('x', 'slack', { enabled: false }), channel('i', 'inapp')]).ops, []);
});

test('a bot-specific channel replaces the shared one of that kind and takes quiet hours', () => {
  const channels = {
    ...emptyRuntimeDraft().channels,
    own: { slack: { enabled: true, config: { ...EMPTY_CHANNEL_CONFIG, tokenRef: 'BOT_TOKEN', channelId: ' C99 ' } } },
    skipGlobal: ['c-slack'],
    quiet: { enabled: true, start: '21:00', end: '06:30', tz: '' },
  };
  const plan = planChannels(channels, [slack]);
  assert.deepEqual(plan.errors, []);
  assert.equal(plan.ops.length, 1, 'the own channel wins; the opt-out copy is not also created');
  assert.deepEqual(plan.ops[0].input.config, { token_ref: '${secret:BOT_TOKEN}', channel_id: 'C99' });
  assert.deepEqual(plan.ops[0].input.policy, { quiet_hours: { start: '21:00', end: '06:30' } });
  assert.match(plan.ops[0].why, /Replaces the shared Slack/);
});

test('channel mistakes are reported in words, per channel, and nothing is planned for them', () => {
  const channels = {
    ...emptyRuntimeDraft().channels,
    own: {
      slack: { enabled: true, config: { ...EMPTY_CHANNEL_CONFIG, tokenRef: 'sk-live-raw token!', channelId: '' } },
      telegram: { enabled: true, config: { ...EMPTY_CHANNEL_CONFIG, tokenRef: 'T', chatId: 'abc' } },
    },
  };
  const plan = planChannels(channels, []);
  assert.deepEqual(plan.ops, []);
  assert.ok(plan.errors.some((message) => /^Slack: .*secret reference/.test(message)));
  assert.ok(plan.errors.some((message) => /^Telegram: Chat id must be numeric|^Telegram: Chat id must be a numeric/.test(message)));
  const quiet = planChannels({ ...emptyRuntimeDraft().channels, quiet: { enabled: true, start: '09:00', end: '09:00', tz: '' } }, []);
  assert.match(quiet.errors[0], /must differ/);
  assert.deepEqual(quietPolicy({ enabled: false, start: '1', end: '2', tz: '' }), { policy: {}, errors: [] });
});

test('the channel summary lists in-app, kept shared channels and the changes', () => {
  assert.deepEqual(describeChannelChoices(emptyRuntimeDraft().channels, [slack]), ['In-app notifications (always on)', 'Slack (shared channel)']);
  const lines = describeChannelChoices({ ...emptyRuntimeDraft().channels, skipGlobal: ['c-tg'], quiet: { enabled: true, start: '22:00', end: '07:00', tz: '' } }, [slack, telegram]);
  assert.deepEqual(lines, ['In-app notifications (always on)', 'Slack with quiet hours · quiet 22:00–07:00', 'Telegram: off for this bot']);
});
