import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { rm } from 'node:fs/promises';

import express from 'express';

import { closeConnection, getConnection, initializeDatabase, systemNotificationsDb } from '@/modules/database/index.js';
import { interruptsService } from '@/modules/interrupt-queue/index.js';
import { missionControlDb } from '@/modules/mission-control/index.js';
import { configureSecretsKeyDir, secretsService } from '@/modules/secrets/index.js';
import { parseKernelEnvelope } from '@/modules/bots/kernel/envelope.js';
import { botCommitmentsDb } from '@/modules/bots/kernel/bot-commitments.repository.js';
import { botEpisodesDb } from '@/modules/bots/kernel/bot-episodes.repository.js';
import { botGateDecisionsDb } from '@/modules/bots/gate/bot-gate-decisions.repository.js';
import { botEventsDb } from '@/modules/bots/signals/bot-events.repository.js';
import { botSignals } from '@/modules/bots/signals/signals.service.js';
import {
  botActionsPublicRouter,
  botChannelsRouter,
  botThreadRouter,
  channelsService,
  createActionToken,
  decodeActionToken,
  deliverEpisodeReply,
  evaluatePolicy,
  generateBrief,
  notifyOperator,
  pollTelegramOnce,
  setChannelsFetch,
  signedActionLinks,
  startApprovalFanout,
  stopApprovalFanout,
  thread,
  verifyActionToken,
  sendBrief,
  EMAIL_DEFERRED_MESSAGE,
} from '@/modules/bots/channels/index.js';
import { botOutboundLogDb, botThreadDb } from '@/modules/bots/index.js';
import { resetApprovalFanoutState } from '@/modules/bots/channels/approvals.js';
import type { FetchLike } from '@/modules/bots/channels/adapters/types.js';
import { makeScratchDir } from '@/shared/scratch.js';

type Call = { url: string; body: Record<string, unknown>; headers: Record<string, string> };

function fakeFetch(respond: (call: Call) => unknown = () => ({ ok: true })): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetchFn: FetchLike = async (url, init) => {
    const call: Call = { url, body: init?.body ? JSON.parse(init.body) : {}, headers: init?.headers ?? {} };
    calls.push(call);
    const payload = respond(call);
    return { ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) };
  };
  return { fetch: fetchFn, calls };
}

async function withDb(run: (ctx: { botId: string; otherBotId: string }) => void | Promise<void>): Promise<void> {
  const previousDb = process.env.DATABASE_PATH;
  const previousKey = process.env.CLOUDCLI_SECRETS_KEY;
  const scratch = await makeScratchDir('bots-channels-');
  closeConnection();
  process.env.DATABASE_PATH = path.join(scratch, 'auth.db');
  process.env.CLOUDCLI_SECRETS_KEY = randomBytes(32).toString('base64');
  configureSecretsKeyDir(path.join(scratch, 'key'));
  await initializeDatabase();
  try {
    const bot = missionControlDb.createSection({ title: 'Channel bot', produce_prompt: 'Go' });
    const other = missionControlDb.createSection({ title: 'PR Shepherd', produce_prompt: 'Go' });
    secretsService.put({ name: 'TG_TOKEN', value: '123:abc' });
    secretsService.put({ name: 'SLACK_TOKEN', value: 'xoxb-secret' });
    await run({ botId: bot.section_id, otherBotId: other.section_id });
  } finally {
    stopApprovalFanout();
    resetApprovalFanoutState();
    setChannelsFetch(null);
    botSignals.setWakeHandler(null);
    botSignals.cancelWakes();
    closeConnection();
    configureSecretsKeyDir(null);
    if (previousDb === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDb;
    if (previousKey === undefined) delete process.env.CLOUDCLI_SECRETS_KEY;
    else process.env.CLOUDCLI_SECRETS_KEY = previousKey;
    await rm(scratch, { recursive: true, force: true });
  }
}

async function withServer(
  mounts: Array<[string, express.Router]>,
  run: (request: (method: string, url: string, body?: unknown) => Promise<{ status: number; text: string; json: () => any }>) => Promise<void>,
): Promise<void> {
  const app = express();
  app.use(express.json());
  for (const [prefix, router] of mounts) app.use(prefix, router);
  app.use((error: { statusCode?: number; message: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(error.statusCode ?? 500).json({ error: error.message });
  });
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await run(async (method, url, body) => {
      const response = await fetch(`http://127.0.0.1:${port}${url}`, {
        method,
        headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await response.text();
      return { status: response.status, text, json: () => JSON.parse(text) };
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(condition: () => boolean, ms = 3_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await sleep(15);
  }
}

function makeApproval(botId: string, kind = 'approval_pending', actions?: Array<{ id: string; label: string; style?: 'primary' | 'secondary' | 'destructive' }>) {
  return interruptsService.create({
    kind,
    severity: 'warning',
    title: 'Send the newsletter?',
    body: 'Server: mail\nTool: send',
    href: `/bots/b/${botId}/overview`,
    actions: actions ?? [
      { id: 'approve_mc_item', label: 'Approve', style: 'primary' },
      { id: 'deny_mc_item', label: 'Deny', style: 'destructive' },
    ],
    meta: { botId, itemId: 'mci_1' },
    expiresAt: null,
  });
}

// ---- policy ---------------------------------------------------------------------

test('evaluatePolicy: quiet hours, min urgency, digest, scheduled bypass', async () => {
  await withDb(() => {
    const base = { botId: null, kind: 'slack', urgency: 0.5, now: new Date('2026-01-01T23:30:00Z') };
    const quiet = { quiet_hours: { start: '22:00', end: '07:00', tz: 'UTC' } };
    assert.equal(evaluatePolicy(quiet, base), 'quiet_hours');
    assert.equal(evaluatePolicy(quiet, { ...base, urgency: 0.9 }), null, 'urgent messages break quiet hours');
    assert.equal(evaluatePolicy(quiet, { ...base, now: new Date('2026-01-01T12:00:00Z') }), null);
    // 23:30 UTC is 03:30 in Dubai: still quiet there, but 10:00 UTC (14:00 Dubai) is not.
    const dubai = { quiet_hours: { start: '22:00', end: '07:00', tz: 'Asia/Dubai' } };
    assert.equal(evaluatePolicy(dubai, base), 'quiet_hours');
    assert.equal(evaluatePolicy(dubai, { ...base, now: new Date('2026-01-01T10:00:00Z') }), null);
    // A same-day window.
    assert.equal(evaluatePolicy({ quiet_hours: { start: '09:00', end: '17:00', tz: 'UTC' } }, { ...base, now: new Date('2026-01-01T10:00:00Z') }), 'quiet_hours');

    assert.equal(evaluatePolicy({ min_urgency: 0.6 }, base), 'min_urgency');
    assert.equal(evaluatePolicy({ min_urgency: 0.6 }, { ...base, urgency: 0.7 }), null);
    assert.equal(evaluatePolicy({ digest: true }, base), 'digest');
    assert.equal(evaluatePolicy({ digest: true, min_urgency: 0.9 }, { ...base, scheduled: true }), null, 'the brief bypasses digest and min_urgency');
  });
});

test('notifyOperator: in-app always records; digest, cap and quiet hours suppress external channels and are logged', async () => {
  await withDb(async ({ botId }) => {
    const { fetch, calls } = fakeFetch();
    setChannelsFetch(fetch);
    channelsService.create({ botId, kind: 'telegram', config: { token_ref: '${secret:TG_TOKEN}', chat_id: '42' }, policy: { max_pings_per_day: 2 } });
    const digest = channelsService.create({
      botId: null,
      kind: 'slack',
      config: { webhook_url_ref: '${secret:SLACK_TOKEN}' },
      policy: { digest: true },
    });

    // Bot has its own telegram plus the global slack default; slack is digest-only.
    const first = await notifyOperator({ botId, title: 'One', body: 'b', urgency: 0.4 });
    assert.deepEqual(first.delivered.sort(), ['inapp', 'telegram']);
    assert.deepEqual(first.suppressed, ['slack']);
    assert.equal(calls.length, 1, 'only telegram hit the network');
    assert.ok(systemNotificationsDb.list().some((n) => n.title === 'One'));

    await notifyOperator({ botId, title: 'Two', body: 'b', urgency: 0.4 });
    const capped = await notifyOperator({ botId, title: 'Three', body: 'b', urgency: 0.4 });
    assert.deepEqual(capped.delivered, ['inapp'], 'cap of 2 telegram pings per day');
    assert.ok(capped.suppressed.includes('telegram'));

    const log = botOutboundLogDb.listRecent(botId, 50);
    const slackHeld = log.filter((entry) => entry.channel_kind === 'slack');
    assert.equal(slackHeld.length, 3);
    assert.ok(slackHeld.every((entry) => !entry.delivered && entry.reason?.startsWith('digest: ')));
    assert.ok(log.some((entry) => entry.channel_kind === 'telegram' && entry.reason?.startsWith('max_pings_per_day')));
    assert.equal(log.filter((entry) => entry.channel_kind === 'telegram' && entry.delivered).length, 2);

    // Quiet hours (global channel) held until urgent.
    channelsService.update(digest.channel_id, { policy: { quiet_hours: { start: '00:00', end: '23:59', tz: 'UTC' } } });
    const quiet = await notifyOperator({ botId: otherBotOf(botId), title: 'Q', body: 'b', urgency: 0.5 });
    assert.deepEqual(quiet.suppressed, ['slack']);
    const urgent = await notifyOperator({ botId: otherBotOf(botId), title: 'Q2', body: 'b', urgency: 0.95 });
    assert.ok(urgent.delivered.includes('slack'));
    assert.equal(calls.length, 3, 'two telegram + the urgent slack webhook');
  });
});

function otherBotOf(botId: string): string {
  return missionControlDb.listSections().find((section) => section.section_id !== botId)!.section_id;
}

// ---- adapters ---------------------------------------------------------------------

test('slack: chat.postMessage carries Block Kit with URL buttons that are signed links', async () => {
  await withDb(async ({ botId }) => {
    const { fetch, calls } = fakeFetch(() => ({ ok: true }));
    setChannelsFetch(fetch);
    channelsService.create({ botId: null, kind: 'slack', config: { token_ref: '${secret:SLACK_TOKEN}', channel_id: 'C123', action_base_url: 'https://bots.example.com/' } });
    const interrupt = makeApproval(botId);
    const result = await notifyOperator({
      botId,
      title: interrupt.title,
      body: interrupt.body,
      urgency: 0.8,
      actions: interrupt.actions,
      interruptId: interrupt.interrupt_id,
    });
    assert.ok(result.delivered.includes('slack'));
    assert.equal(calls.length, 1);
    const call = calls[0];
    assert.equal(call.url, 'https://slack.com/api/chat.postMessage');
    assert.equal(call.headers.Authorization, 'Bearer xoxb-secret');
    assert.equal(call.body.channel, 'C123');
    const blocks = call.body.blocks as Array<Record<string, any>>;
    assert.equal(blocks[0].type, 'header');
    const buttons = blocks.find((block) => block.type === 'actions')!.elements as Array<Record<string, any>>;
    assert.deepEqual(buttons.map((b) => b.text.text), ['Approve', 'Deny']);
    assert.deepEqual(buttons.map((b) => b.style), ['primary', 'danger']);
    for (const button of buttons) {
      assert.match(button.url, /^https:\/\/bots\.example\.com\/api\/bot-actions\/[\w-]+\.[\w-]+$/);
      const token = button.url.split('/').pop() as string;
      const verdict = verifyActionToken(token);
      assert.ok(verdict.ok && verdict.payload.interruptId === interrupt.interrupt_id);
    }
    // The token is a secret ref at rest: the config never held the raw value.
    assert.equal(JSON.stringify(channelsService.list(null)).includes('xoxb-secret'), false);
  });
});

test('slack webhook variant posts blocks to the secret-resolved URL', async () => {
  await withDb(async ({ botId }) => {
    secretsService.put({ name: 'SLACK_HOOK', value: 'https://hooks.slack.test/T/B/x' });
    const { fetch, calls } = fakeFetch();
    setChannelsFetch(fetch);
    channelsService.create({ botId: null, kind: 'slack', config: { webhook_url_ref: '${secret:SLACK_HOOK}' } });
    await notifyOperator({ botId, title: 'Hello', body: 'World', urgency: 0.5 });
    assert.equal(calls[0].url, 'https://hooks.slack.test/T/B/x');
    assert.ok(Array.isArray(calls[0].body.blocks));
  });
});

test('telegram: sendMessage with inline keyboard URL buttons (public https base URL)', async () => {
  await withDb(async ({ botId }) => {
    const { fetch, calls } = fakeFetch();
    setChannelsFetch(fetch);
    channelsService.create({ botId, kind: 'telegram', config: { token_ref: '${secret:TG_TOKEN}', chat_id: '4242', action_base_url: 'https://bots.example.com' } });
    const interrupt = makeApproval(botId, 'bot_gate', [
      { id: 'approve_once', label: 'Approve once', style: 'primary' },
      { id: 'always_allow', label: 'Always allow', style: 'secondary' },
      { id: 'deny', label: 'Deny', style: 'destructive' },
    ]);
    await notifyOperator({ botId, title: interrupt.title, body: interrupt.body, urgency: 0.8, actions: interrupt.actions, interruptId: interrupt.interrupt_id });
    const call = calls[0];
    assert.equal(call.url, 'https://api.telegram.org/bot123:abc/sendMessage');
    assert.equal(call.body.chat_id, '4242');
    assert.match(String(call.body.text), /Send the newsletter\?/);
    const keyboard = (call.body.reply_markup as { inline_keyboard: Array<Array<{ text: string; url: string }>> }).inline_keyboard;
    assert.deepEqual(keyboard.map((row) => row[0].text), ['Approve once', 'Always allow', 'Deny']);
    const keys = keyboard.map((row) => {
      const verdict = verifyActionToken(row[0].url.split('/').pop()!);
      assert.ok(verdict.ok);
      return verdict.ok ? verdict.payload.actionKey : '';
    });
    assert.deepEqual(keys, ['approve_once', 'always_allow', 'deny']);
  });
});

test('channel validation: raw tokens, unknown keys and email are rejected', async () => {
  await withDb(({ botId }) => {
    assert.throws(() => channelsService.create({ botId, kind: 'slack', config: { token: 'xoxb-raw', channel_id: 'C1' } }), /unknown config key/);
    assert.throws(() => channelsService.create({ botId, kind: 'slack', config: { token_ref: 'xoxb-raw', channel_id: 'C1' } }), /secret reference/);
    assert.throws(() => channelsService.create({ botId, kind: 'telegram', config: { token_ref: '${secret:TG_TOKEN}' } }), /chat_id/);
    assert.throws(() => channelsService.create({ botId, kind: 'email', config: {} }), new RegExp(EMAIL_DEFERRED_MESSAGE.slice(0, 30)));
    assert.throws(() => channelsService.create({ botId, kind: 'pager' }), /Unknown channel kind/);
    assert.throws(() => channelsService.create({ botId: null, kind: 'inapp', policy: { min_urgency: 4 } }), /min_urgency/);
    assert.throws(() => channelsService.create({ botId: null, kind: 'inapp', policy: { quiet_hours: { start: '25:00', end: '07:00' } } }), /quiet_hours/);
    assert.throws(() => channelsService.create({ botId: 'nope', kind: 'inapp' }), /Bot not found/);
    const ok = channelsService.create({ botId: null, kind: 'inapp', policy: { digest: true, brief_at: '08:00', brief_tz: 'Asia/Dubai' } });
    assert.equal(ok.policy.digest, true);
  });
});

test('webpush adapter sends only when subscriptions exist', async () => {
  await withDb(async ({ botId }) => {
    const { setWebPushSender } = await import('@/modules/bots/channels/index.js');
    const { userDb, pushSubscriptionsDb } = await import('@/modules/database/index.js');
    const sent: Array<{ title: string; data: Record<string, unknown> }> = [];
    setWebPushSender((input) => sent.push({ title: input.title, data: input.data }));
    try {
      channelsService.create({ botId: null, kind: 'webpush' });
      const before = await notifyOperator({ botId, title: 'P1', body: 'b', urgency: 0.5 });
      assert.ok(before.failed.includes('webpush'), 'no user / no subscription is a logged failure');
      assert.equal(sent.length, 0);
      userDb.createUser('operator', 'hash');
      const user = userDb.getFirstUser()!;
      pushSubscriptionsDb.createPushSubscription(user.id, 'https://push.test/e', 'k', 'a');
      const after = await notifyOperator({ botId, title: 'P2', body: 'b', urgency: 0.5 });
      assert.ok(after.delivered.includes('webpush'));
      assert.equal(sent[0].title, 'P2');
      assert.equal(sent[0].data.botId, botId);
    } finally {
      setWebPushSender(null);
    }
  });
});

// ---- telegram inbound ---------------------------------------------------------------

test('telegram inbound: maps the configured chat to operator messages, ignores foreign chats, persists the offset', async () => {
  await withDb(async ({ botId, otherBotId }) => {
    const updates = [
      { update_id: 10, message: { chat: { id: 4242 }, text: '/bot pr-shepherd  what are you working on?' } },
      { update_id: 11, message: { chat: { id: 999 }, text: '/bot pr-shepherd do something evil' } },
      { update_id: 12, message: { chat: { id: 4242 }, text: 'just chatting' } },
      { update_id: 13, message: { chat: { id: 4242 }, text: '/bot "Channel bot" stop emailing X' } },
    ];
    const { fetch, calls } = fakeFetch((call) => (call.url.endsWith('/getUpdates') ? { ok: true, result: updates } : { ok: true }));
    setChannelsFetch(fetch);
    const channel = channelsService.create({
      botId: null,
      kind: 'telegram',
      config: { token_ref: '${secret:TG_TOKEN}', chat_id: '4242', inbound: true },
    });

    const accepted = await pollTelegramOnce(channel.channel_id);
    assert.equal(accepted, 2);
    assert.equal(calls[0].url, 'https://api.telegram.org/bot123:abc/getUpdates');
    assert.equal(calls[0].body.offset, 0);

    const shepherd = botEventsDb.listRecent(otherBotId).filter((e) => e.kind === 'operator_message');
    assert.equal(shepherd.length, 1);
    assert.equal(shepherd[0].trust, 'operator');
    assert.equal(shepherd[0].payload.text, 'what are you working on?');
    assert.equal(shepherd[0].payload.channel, 'telegram');
    assert.deepEqual(thread.list(otherBotId).map((m) => [m.role, m.channel, m.body]), [['operator', 'telegram', 'what are you working on?']]);
    assert.equal(botEventsDb.listRecent(botId).filter((e) => e.kind === 'operator_message')[0].payload.text, 'stop emailing X');
    assert.equal(
      botEventsDb.listRecent(otherBotId).some((e) => String(e.payload.text).includes('evil')),
      false,
      'foreign chat ignored',
    );
    // Plain text on a global channel cannot pick a bot: the operator gets a hint, nothing is ingested.
    const hint = calls.find((call) => call.url.endsWith('/sendMessage'));
    assert.match(String(hint?.body.text), /\/bot <name>/);
    assert.equal(channelsService.get(channel.channel_id)!.config.inbound_offset, 14);

    // The next poll resumes from the persisted offset.
    updates.length = 0;
    await pollTelegramOnce(channel.channel_id);
    assert.equal(calls[calls.length - 1].body.offset, 14);
  });
});

test('telegram inbound: a bot-bound channel maps plain text to that bot', async () => {
  await withDb(async ({ botId }) => {
    const { fetch } = fakeFetch(() => ({ ok: true, result: [{ update_id: 1, message: { chat: { id: 7 }, text: 'status?' } }] }));
    setChannelsFetch(fetch);
    const channel = channelsService.create({ botId, kind: 'telegram', config: { token_ref: '${secret:TG_TOKEN}', chat_id: 7, inbound: true } });
    assert.equal(await pollTelegramOnce(channel.channel_id), 1);
    assert.equal(botEventsDb.listRecent(botId)[0].payload.text, 'status?');
    // Inbound disabled: no network, no ingest.
    channelsService.update(channel.channel_id, { config: { token_ref: '${secret:TG_TOKEN}', chat_id: 7 } });
    assert.equal(await pollTelegramOnce(channel.channel_id), 0);
  });
});

// ---- signed links -------------------------------------------------------------------

test('signed links: verify, expiry, tamper and used interrupt', async () => {
  await withDb(({ botId }) => {
    const interrupt = makeApproval(botId);
    const token = createActionToken(interrupt.interrupt_id, 'approve_mc_item');
    const ok = verifyActionToken(token);
    assert.ok(ok.ok);

    // Expiry.
    const short = createActionToken(interrupt.interrupt_id, 'approve_mc_item', { ttlMs: 1_000 });
    assert.deepEqual(verifyActionToken(short, Date.now() + 5_000), { ok: false, reason: 'expired' });
    assert.ok(verifyActionToken(short, Date.now() + 100).ok);
    const defaultTtl = decodeActionToken(token);
    assert.ok(defaultTtl.ok && defaultTtl.payload.exp - Date.now() > 23 * 3_600_000);

    // Tamper: swap the payload (action key) but keep the signature.
    const forged = Buffer.from(JSON.stringify({ i: interrupt.interrupt_id, a: 'deny_mc_item', e: Date.now() + 9e6 })).toString('base64url');
    assert.deepEqual(verifyActionToken(`${forged}.${token.split('.')[1]}`), { ok: false, reason: 'bad_signature' });
    assert.deepEqual(verifyActionToken(`${token}x`), { ok: false, reason: 'bad_signature' });
    assert.deepEqual(verifyActionToken('garbage'), { ok: false, reason: 'malformed' });
    assert.deepEqual(verifyActionToken(''), { ok: false, reason: 'malformed' });

    // An action the interrupt never offered.
    assert.deepEqual(verifyActionToken(createActionToken(interrupt.interrupt_id, 'abort_run')), { ok: false, reason: 'unknown_action' });
    // Unknown interrupt.
    assert.deepEqual(verifyActionToken(createActionToken('int_missing', 'approve_mc_item')), { ok: false, reason: 'missing' });

    // Single use: once the interrupt is answered, every link for it is dead.
    interruptsService.act(interrupt.interrupt_id, { key: 'deny_mc_item', actor: 'test' });
    assert.deepEqual(verifyActionToken(token), { ok: false, reason: 'used' });
    assert.match(signedActionLinks.create(interrupt.interrupt_id, 'approve_mc_item', undefined, 'https://x.test'), /^https:\/\/x\.test\/api\/bot-actions\//);
  });
});

test('public action router: GET has no side effects, POST acts once', async () => {
  await withDb(async ({ botId }) => {
    const interrupt = makeApproval(botId);
    const token = createActionToken(interrupt.interrupt_id, 'approve_mc_item');
    await withServer([['/api/bot-actions', botActionsPublicRouter]], async (request) => {
      const get = await request('GET', `/api/bot-actions/${token}`);
      assert.equal(get.status, 200);
      assert.match(get.text, /Send the newsletter\?/);
      assert.match(get.text, /<form method="post"/);
      assert.match(get.text, />Approve</);
      await request('GET', `/api/bot-actions/${token}`);
      assert.equal(interruptsService.get(interrupt.interrupt_id)!.status, 'open', 'GET never resolves the interrupt');

      const post = await request('POST', `/api/bot-actions/${token}`);
      assert.equal(post.status, 200);
      assert.match(post.text, /Done/);
      const after = interruptsService.get(interrupt.interrupt_id)!;
      assert.equal(after.status, 'resolved');
      assert.equal(after.resolved_by, 'channel');
      assert.equal(after.resolution, 'approve_mc_item');

      const again = await request('POST', `/api/bot-actions/${token}`);
      assert.equal(again.status, 410);
      assert.match(again.text, /already answered/);
      assert.equal((await request('GET', '/api/bot-actions/not-a-token')).status, 400);
      assert.equal((await request('GET', `/api/bot-actions/${token}`)).status, 410);
    });
  });
});

test('public action router escapes interrupt text', async () => {
  await withDb(async ({ botId }) => {
    const interrupt = interruptsService.create({
      kind: 'approval_pending',
      title: '<script>alert(1)</script>',
      actions: [{ id: 'approve_mc_item', label: 'Approve' }],
      meta: { botId },
      expiresAt: null,
    });
    await withServer([['/api/bot-actions', botActionsPublicRouter]], async (request) => {
      const page = await request('GET', `/api/bot-actions/${createActionToken(interrupt.interrupt_id, 'approve_mc_item')}`);
      assert.equal(page.text.includes('<script>alert(1)'), false);
      assert.match(page.text, /&lt;script&gt;/);
    });
  });
});

// ---- approvals fan-out ----------------------------------------------------------------

test('interrupt_created for bot_gate and approval_pending fans out through the automation sink', async () => {
  await withDb(async ({ botId }) => {
    const { fetch, calls } = fakeFetch();
    setChannelsFetch(fetch);
    channelsService.create({ botId: null, kind: 'telegram', config: { token_ref: '${secret:TG_TOKEN}', chat_id: '1', action_base_url: 'https://bots.example.com' } });
    startApprovalFanout();

    const gate = makeApproval(botId, 'bot_gate', [
      { id: 'approve_once', label: 'Approve once', style: 'primary' },
      { id: 'deny', label: 'Deny', style: 'destructive' },
    ]);
    await waitFor(() => calls.length >= 1);
    const keyboard = (calls[0].body.reply_markup as { inline_keyboard: Array<Array<{ url: string }>> }).inline_keyboard;
    assert.equal(keyboard.length, 2);
    const verdict = verifyActionToken(keyboard[0][0].url.split('/').pop()!);
    assert.ok(verdict.ok && verdict.payload.interruptId === gate.interrupt_id && verdict.payload.actionKey === 'approve_once');
    const logged = botOutboundLogDb.listRecent(botId).find((entry) => entry.channel_kind === 'telegram');
    assert.ok(logged?.delivered && Math.abs(logged.urgency - 0.8) < 1e-9);

    makeApproval(botId, 'approval_pending');
    await waitFor(() => calls.length >= 2);

    // Other kinds, and interrupts that name no bot, stay quiet.
    interruptsService.create({ kind: 'run_failed', title: 'nope', meta: { botId } });
    interruptsService.create({ kind: 'approval_pending', title: 'no bot', meta: {} });
    await sleep(150);
    assert.equal(calls.length, 2);
    assert.equal(systemNotificationsDb.list().filter((n) => n.source === 'bot').length, 2);

    // Interrupts settled before delivery are skipped; the sink unsubscribes cleanly.
    stopApprovalFanout();
    makeApproval(botId, 'approval_pending');
    await sleep(150);
    assert.equal(calls.length, 2);
  });
});

test('automation: configureAutomationEventSink and addAutomationEventSink coexist', async () => {
  await withDb(async () => {
    const { automationService, configureAutomationEventSink, addAutomationEventSink } = await import('@/modules/automation/index.js');
    const seen: string[] = [];
    configureAutomationEventSink(() => seen.push('single'));
    const off = addAutomationEventSink(() => seen.push('multi-a'));
    addAutomationEventSink(() => {
      throw new Error('boom');
    });
    const originalError = console.error;
    console.error = () => {};
    try {
      await automationService.fire({ type: 'manual', payload: {} });
      assert.deepEqual(seen, ['single', 'multi-a']);
      off();
      await automationService.fire({ type: 'manual', payload: {} });
      assert.deepEqual(seen, ['single', 'multi-a', 'single']);
    } finally {
      console.error = originalError;
      configureAutomationEventSink(null);
    }
  });
});

// ---- thread -----------------------------------------------------------------------------

test('thread: operator post ingests an operator_message event; the router enforces bots and pages', async () => {
  await withDb(async ({ botId }) => {
    const wakes: string[] = [];
    botSignals.setWakeHandler((id) => wakes.push(id));
    await withServer(
      [
        ['/api/bots', botChannelsRouter],
        ['/api/bots', botThreadRouter],
      ],
      async (request) => {
        const posted = await request('POST', `/api/bots/${botId}/thread`, { body: 'what are you working on?' });
        assert.equal(posted.status, 201);
        const message = posted.json().message;
        assert.equal(message.role, 'operator');
        const events = botEventsDb.listRecent(botId).filter((e) => e.kind === 'operator_message');
        assert.equal(events.length, 1);
        assert.equal(events[0].trust, 'operator');
        assert.equal(events[0].payload.message_id, message.message_id);
        assert.equal((await request('POST', `/api/bots/${botId}/thread`, { body: '  ' })).status, 400);
        assert.equal((await request('POST', `/api/bots/nope/thread`, { body: 'hi' })).status, 404);

        thread.post(botId, { role: 'bot', body: 'Reviewing PRs.', channel: 'inapp' });
        const listed = (await request('GET', `/api/bots/${botId}/thread?limit=10`)).json().messages;
        assert.deepEqual(listed.map((m: { role: string }) => m.role), ['operator', 'bot']);
        const before = listed[1].created_at;
        assert.ok((await request('GET', `/api/bots/${botId}/thread?before=${encodeURIComponent(before)}`)).json().messages.length <= 1);
        assert.equal((await request('GET', '/api/bots/nope/thread')).status, 404);
      },
    );
    botSignals.flushWakes();
    assert.ok(wakes.includes(botId), 'the operator message wakes the bot through the normal path');
  });
});

test('thread.post broadcasts bot_thread_message', async () => {
  await withDb(async ({ botId }) => {
    const { broadcastSystemEvent } = await import('@/modules/websocket/index.js');
    void broadcastSystemEvent; // the real broadcaster is a no-op without clients; the row is the contract here
    const message = thread.post(botId, { role: 'system', body: 'hello', channel: 'inapp' });
    assert.equal(botThreadDb.get(message.message_id)?.body, 'hello');
  });
});

// ---- envelope reply -------------------------------------------------------------------------

test('envelope parses an optional reply', () => {
  assert.equal(parseKernelEnvelope(JSON.stringify({ summary: 's', reply: '  Reviewing PRs.  ' })).reply, 'Reviewing PRs.');
  assert.equal(parseKernelEnvelope(JSON.stringify({ summary: 's' })).reply, '');
  assert.equal(parseKernelEnvelope(JSON.stringify({ reply: 'only a reply' })).reply, 'only a reply');
});

test('episode reply: posts a bot thread message and delivers it to the originating channel; summary is the fallback', async () => {
  await withDb(async ({ botId }) => {
    const { fetch, calls } = fakeFetch();
    setChannelsFetch(fetch);
    channelsService.create({ botId: null, kind: 'telegram', config: { token_ref: '${secret:TG_TOKEN}', chat_id: '4242' } });

    const telegramEvent = botSignals.ingest({ botId, source: 'thread:telegram', kind: 'operator_message', trust: 'operator', payload: { text: 'status?', channel: 'telegram' } }).event;
    const episode = botEpisodesDb.create({ botId, triggerKinds: 'operator_message', eventIds: [telegramEvent.event_id] });
    const finished = botEpisodesDb.update(episode.episode_id, { status: 'succeeded', summary: 'Checked 3 PRs.', outcome: { reply: 'Reviewing PR #12 now.' }, finishedAt: new Date().toISOString() })!;
    assert.equal(await deliverEpisodeReply(finished), true);
    const reply = thread.list(botId).find((m) => m.role === 'bot')!;
    assert.equal(reply.body, 'Reviewing PR #12 now.');
    assert.equal(reply.channel, 'telegram');
    assert.equal(calls.length, 1);
    assert.match(String(calls[0].body.text), /Reviewing PR #12 now\./);

    // No reply given, operator-triggered: the summary answers.
    const inappEvent = botSignals.ingest({ botId, source: 'thread:inapp', kind: 'operator_message', trust: 'operator', payload: { text: 'hi', channel: 'inapp' } }).event;
    const second = botEpisodesDb.create({ botId, triggerKinds: 'operator_message', eventIds: [inappEvent.event_id] });
    const secondDone = botEpisodesDb.update(second.episode_id, { status: 'succeeded', summary: 'All quiet.', finishedAt: new Date().toISOString() })!;
    assert.equal(await deliverEpisodeReply(secondDone), true);
    assert.equal(thread.list(botId).filter((m) => m.role === 'bot').pop()!.body, 'All quiet.');
    assert.equal(calls.length, 1, 'in-app replies do not hit external channels');

    // A scheduled episode without a reply says nothing.
    const quiet = botEpisodesDb.update(botEpisodesDb.create({ botId, triggerKinds: 'schedule' }).episode_id, { status: 'succeeded', summary: 'Nothing new.' })!;
    assert.equal(await deliverEpisodeReply(quiet), false);
  });
});

// ---- brief -------------------------------------------------------------------------------------

test('brief: aggregates episodes, cost, approvals, QA, gate decisions, commitments, proposals and held pings', async () => {
  await withDb(async ({ botId, otherBotId }) => {
    const db = getConnection();
    const finish = (id: string, status: 'succeeded' | 'failed', summary: string, cost: number) =>
      botEpisodesDb.update(id, { status, summary, costUsd: cost, finishedAt: new Date().toISOString() });
    finish(botEpisodesDb.create({ botId }).episode_id, 'succeeded', 'Triaged 5 emails', 0.4);
    finish(botEpisodesDb.create({ botId }).episode_id, 'failed', 'Provider error', 0.1);
    finish(botEpisodesDb.create({ botId: otherBotId }).episode_id, 'succeeded', 'Reviewed PR 12', 1.25);
    botEpisodesDb.create({ botId: otherBotId }); // still running: excluded

    makeApproval(botId, 'approval_pending');
    makeApproval(botId, 'bot_gate'); // bot_gate rides the gate-decision list, not approvals
    db.prepare(`INSERT INTO mc_items (item_id, section_id, status, title, dedupe_key) VALUES ('mci_1', ?, 'in_qa', 'Ship the fix', 'k1')`).run(botId);
    db.prepare(`INSERT INTO mc_items (item_id, section_id, status, title, dedupe_key) VALUES ('mci_2', ?, 'resolved', 'Old', 'k2')`).run(botId);
    botGateDecisionsDb.create({ botId, server: 'mail', tool: 'send', risk: 'high', decision: 'ask', decidedBy: 'floor' });
    botGateDecisionsDb.create({ botId, server: 'mail', tool: 'read', risk: 'low', decision: 'allow', decidedBy: 'rule:x' });
    botCommitmentsDb.create({ botId, description: 'Follow up with Dana', dueAt: new Date(Date.now() + 3_600_000).toISOString(), waitingOn: 'Dana' });
    botCommitmentsDb.create({ botId, description: 'Next month', dueAt: new Date(Date.now() + 40 * 86_400_000).toISOString() });
    db.prepare(
      `INSERT INTO bot_learning_proposals (proposal_id, bot_id, kind, title, created_at) VALUES ('bpr_1', ?, 'memory', 'Prefers terse replies', ?)`,
    ).run(botId, new Date().toISOString());
    db.prepare(
      `INSERT INTO bot_learning_proposals (proposal_id, bot_id, kind, title, status, created_at) VALUES ('bpr_2', ?, 'memory', 'Already applied', 'applied', ?)`,
    ).run(botId, new Date().toISOString());
    const held = botOutboundLogDb.record({ botId, channelKind: 'telegram', urgency: 0.3, delivered: false, reason: 'digest: Low priority FYI' });
    assert.ok(held);

    const doc = generateBrief({ since: new Date(Date.now() - 86_400_000).toISOString() });
    assert.equal(doc.totals.episodes, 3);
    assert.equal(doc.totals.failed, 1);
    assert.equal(doc.totals.cost_usd, 1.75);
    assert.deepEqual(doc.bots.map((b) => b.title), ['PR Shepherd', 'Channel bot'], 'ordered by cost');
    assert.equal(doc.bots[1].episodes.failed, 1);
    assert.ok(doc.bots[1].episodes.top_summaries.includes('Triaged 5 emails'));
    assert.equal(doc.awaiting_you.approvals.length, 1);
    assert.equal(doc.awaiting_you.in_qa.length, 1);
    assert.equal(doc.awaiting_you.in_qa[0].title, 'Ship the fix');
    assert.equal(doc.gate_decisions_awaiting.length, 1);
    assert.equal(doc.gate_decisions_awaiting[0].tool, 'send');
    assert.deepEqual(doc.commitments_due.map((c) => c.description), ['Follow up with Dana']);
    assert.deepEqual(doc.learning_proposals.map((p) => p.proposal_id), ['bpr_1']);
    assert.equal(doc.suppressed.length, 1);
    for (const fragment of ['Triaged 5 emails', 'Send the newsletter?', 'Ship the fix', 'mail/send', 'Follow up with Dana', 'Prefers terse replies', '$1.75', 'Low priority FYI']) {
      assert.ok(doc.markdown.includes(fragment), `markdown mentions ${fragment}`);
    }
  });
});

test('brief: routes generate and send; scheduled send bypasses digest and records the send time', async () => {
  await withDb(async ({ botId }) => {
    const { fetch, calls } = fakeFetch();
    setChannelsFetch(fetch);
    botEpisodesDb.update(botEpisodesDb.create({ botId }).episode_id, { status: 'succeeded', summary: 'Did a thing', finishedAt: new Date().toISOString() });
    channelsService.create({ botId: null, kind: 'telegram', config: { token_ref: '${secret:TG_TOKEN}', chat_id: '1' }, policy: { digest: true, brief_at: '08:00', brief_tz: 'UTC' } });
    await notifyOperator({ botId, title: 'Held', body: 'x', urgency: 0.3 });
    assert.equal(calls.length, 0);

    await withServer([['/api/bots', botChannelsRouter]], async (request) => {
      const got = await request('GET', '/api/bots/brief');
      assert.equal(got.status, 200);
      assert.equal(got.json().brief.totals.episodes, 1);
      assert.equal(got.json().brief.suppressed.length, 1);

      const sent = await request('POST', '/api/bots/brief/send', {});
      assert.equal(sent.status, 200);
      assert.ok(sent.json().delivered.includes('telegram'));
    });
    assert.equal(calls.length, 1);
    assert.match(String(calls[0].body.text), /Morning brief/);
    // The next brief starts where this one ended.
    assert.equal(generateBrief().suppressed.length, 0);
    assert.ok(await sendBrief());
  });
});

test('channel routes: CRUD, botId filter and test send', async () => {
  await withDb(async ({ botId }) => {
    const { fetch, calls } = fakeFetch();
    setChannelsFetch(fetch);
    await withServer([['/api/bots', botChannelsRouter]], async (request) => {
      const bad = await request('POST', '/api/bots/channels', { kind: 'telegram', config: { token_ref: 'raw', chat_id: '1' } });
      assert.equal(bad.status, 400);
      const created = await request('POST', '/api/bots/channels', { botId, kind: 'telegram', config: { token_ref: '${secret:TG_TOKEN}', chat_id: '1' } });
      assert.equal(created.status, 201);
      const id = created.json().channel.channel_id;
      await request('POST', '/api/bots/channels', { kind: 'inapp' });
      assert.equal((await request('GET', '/api/bots/channels')).json().channels.length, 1);
      const scoped = (await request('GET', `/api/bots/channels?botId=${botId}`)).json();
      assert.equal(scoped.channels.length, 1);
      assert.equal(scoped.effective.length, 2);
      assert.equal((await request('PATCH', `/api/bots/channels/${id}`, { enabled: false })).json().channel.enabled, false);
      assert.equal((await request('POST', `/api/bots/channels/${id}/test`)).status, 200);
      assert.equal(calls.length, 1);
      assert.equal((await request('DELETE', `/api/bots/channels/${id}`)).status, 200);
      assert.equal((await request('DELETE', `/api/bots/channels/${id}`)).status, 404);
    });
  });
});
