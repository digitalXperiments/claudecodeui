import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import test from 'node:test';
import { rm } from 'node:fs/promises';

import express from 'express';

import { closeConnection, initializeDatabase, systemNotificationsDb } from '@/modules/database/index.js';
import { interruptsDb, interruptsService } from '@/modules/interrupt-queue/index.js';
import { missionControlDb } from '@/modules/mission-control/index.js';
import { configureSecretsKeyDir, secretsService } from '@/modules/secrets/index.js';
import { botGateDecisionsDb } from '@/modules/bots/gate/bot-gate-decisions.repository.js';
import {
  actionGate,
  approvalCardTitle,
  expiredApprovalMessage,
  initBotGate,
  setAutoReviewer,
  setGateHumanPollInterval,
  setHumanWaitHooks,
  APPROVAL_FINISH_MARGIN_MS,
} from '@/modules/bots/gate/index.js';
import {
  DEFAULT_APPROVAL_TIMEOUT_MINUTES,
  normalizeBotRuntimeConfig,
  patchBotRuntimeConfig,
  readApprovalTimeoutMs,
} from '@/modules/bots/bots-runtime-config.js';
import { validateRuntimeConfigInput } from '@/modules/bots/exec/runtime-validation.js';
import {
  announceApprovalExpired,
  announceApprovalReminder,
  fanOutInterrupt,
  resetApprovalFanoutState,
} from '@/modules/bots/channels/approvals.js';
import {
  botChannelsRouter,
  channelsService,
  createCallbackData,
  handleTelegramCallback,
  isPublicHttpsUrl,
  notifyOperator,
  pollTelegramOnce,
  resolveCallbackData,
  setChannelsFetch,
} from '@/modules/bots/channels/index.js';
import { botThreadDb } from '@/modules/bots/index.js';
import type { FetchLike } from '@/modules/bots/channels/adapters/types.js';
import { makeScratchDir } from '@/shared/scratch.js';

type Call = { url: string; body: Record<string, any> };

function fakeFetch(respond: (call: Call) => unknown = () => ({ ok: true })): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetchFn: FetchLike = async (url, init) => {
    const call: Call = { url, body: init?.body ? JSON.parse(init.body) : {} };
    calls.push(call);
    const payload = respond(call);
    return { ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) };
  };
  return { fetch: fetchFn, calls };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(condition: () => boolean, ms = 3_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await sleep(10);
  }
}

async function withDb(run: (ctx: { botId: string }) => void | Promise<void>): Promise<void> {
  const previousDb = process.env.DATABASE_PATH;
  const previousKey = process.env.CLOUDCLI_SECRETS_KEY;
  const scratch = await makeScratchDir('bots-approval-delivery-');
  closeConnection();
  process.env.DATABASE_PATH = path.join(scratch, 'auth.db');
  process.env.CLOUDCLI_SECRETS_KEY = randomBytes(32).toString('base64');
  configureSecretsKeyDir(path.join(scratch, 'key'));
  await initializeDatabase();
  interruptsService.configureBotGateResolver(null);
  setAutoReviewer(async () => {
    throw new Error('real reviewer must not run in tests');
  });
  try {
    const bot = missionControlDb.createSection({ title: 'Personal Gmail', produce_prompt: 'Go' });
    secretsService.put({ name: 'TG_TOKEN', value: '123:abc' });
    secretsService.put({ name: 'SLACK_TOKEN', value: 'xoxb-secret' });
    await run({ botId: bot.section_id });
  } finally {
    setHumanWaitHooks(null);
    setAutoReviewer(null);
    setGateHumanPollInterval(null);
    interruptsService.configureBotGateResolver(null);
    resetApprovalFanoutState();
    setChannelsFetch(null);
    closeConnection();
    configureSecretsKeyDir(null);
    if (previousDb === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDb;
    if (previousKey === undefined) delete process.env.CLOUDCLI_SECRETS_KEY;
    else process.env.CLOUDCLI_SECRETS_KEY = previousKey;
    await rm(scratch, { recursive: true, force: true });
  }
}

/** A pending built-in call waiting for a human, the way the gate leaves it: an `ask` decision row. */
function askDecision(botId: string, overrides: Partial<{ tool: string; server: string; args: Record<string, unknown>; episodeId: string | null; risk: string }> = {}) {
  return botGateDecisionsDb.create({
    botId,
    episodeId: overrides.episodeId ?? null,
    server: overrides.server ?? 'builtin',
    tool: overrides.tool ?? 'Write',
    risk: overrides.risk ?? 'prod_change',
    args: overrides.args ?? { file_path: '/Users/someone/Documents/report.md', content: 'x' },
    decision: 'ask',
    decidedBy: 'floor',
    reason: 'Risk "prod_change" needs approval',
  });
}

const gateActions = [
  { id: 'approve_once', label: 'Approve once', style: 'primary' as const },
  { id: 'deny', label: 'Deny', style: 'destructive' as const },
];

function gateInterrupt(botId: string, decisionId = 'bgd_test') {
  return interruptsService.create({
    kind: 'bot_gate',
    severity: 'warning',
    title: 'Personal Gmail wants to change ~/Documents/report.md',
    body: 'Server: builtin\nTool: Write',
    href: `/bots/b/${botId}/overview`,
    actions: gateActions,
    meta: { botId, decisionId },
    expiresAt: null,
  });
}

// ---- Telegram buttons ---------------------------------------------------------------------

test('telegram: a localhost base URL sends the message WITHOUT buttons plus "Open CloudCLI to approve" (never dropped)', async () => {
  await withDb(async ({ botId }) => {
    const { fetch, calls } = fakeFetch();
    setChannelsFetch(fetch);
    channelsService.create({ botId, kind: 'telegram', config: { token_ref: '${secret:TG_TOKEN}', chat_id: '4242' } });
    const interrupt = gateInterrupt(botId);
    const result = await notifyOperator({ botId, title: interrupt.title, body: interrupt.body, urgency: 0.8, actions: interrupt.actions, interruptId: interrupt.interrupt_id });
    assert.ok(result.delivered.includes('telegram'));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].body.reply_markup, undefined, 'Telegram rejects localhost URL buttons, so there are none');
    assert.match(String(calls[0].body.text), /Personal Gmail wants to change/);
    assert.match(String(calls[0].body.text), /Open CloudCLI to approve/);
    // An http base on a real host is not usable either.
    calls.length = 0;
    channelsService.create({ botId, kind: 'telegram', config: { token_ref: '${secret:TG_TOKEN}', chat_id: '4242', action_base_url: 'http://bots.example.com' } });
    await notifyOperator({ botId, title: interrupt.title, body: interrupt.body, urgency: 0.8, actions: interrupt.actions, interruptId: interrupt.interrupt_id });
    assert.equal(calls[0].body.reply_markup, undefined);
  });
});

test('telegram: a public https base URL keeps URL buttons; inbound polling switches to callback_data buttons', async () => {
  await withDb(async ({ botId }) => {
    const { fetch, calls } = fakeFetch();
    setChannelsFetch(fetch);
    const interrupt = gateInterrupt(botId);
    const send = () => notifyOperator({ botId, title: interrupt.title, body: interrupt.body, urgency: 0.8, actions: interrupt.actions, interruptId: interrupt.interrupt_id });

    const channel = channelsService.create({ botId, kind: 'telegram', config: { token_ref: '${secret:TG_TOKEN}', chat_id: '4242', action_base_url: 'https://cloudcli.insaneanalytics.co.in' } });
    await send();
    const urlButtons = calls[0].body.reply_markup.inline_keyboard as Array<Array<{ text: string; url?: string; callback_data?: string }>>;
    assert.deepEqual(urlButtons.map((row) => row[0].text), ['Approve once', 'Deny']);
    assert.ok(urlButtons.every((row) => row[0].url?.startsWith('https://cloudcli.insaneanalytics.co.in/api/bot-actions/') && !row[0].callback_data));

    // Inbound polling on (even with a public URL): callback buttons the poller answers.
    channelsService.update(channel.channel_id, { config: { token_ref: '${secret:TG_TOKEN}', chat_id: '4242', action_base_url: 'https://cloudcli.insaneanalytics.co.in', inbound: true } });
    calls.length = 0;
    await send();
    const callbackButtons = calls[0].body.reply_markup.inline_keyboard as Array<Array<{ text: string; url?: string; callback_data?: string }>>;
    assert.ok(callbackButtons.every((row) => row[0].callback_data && !row[0].url));
    for (const row of callbackButtons) {
      assert.match(row[0].callback_data!, /^a:[A-Za-z0-9_-]{8}$/);
      assert.ok(Buffer.byteLength(row[0].callback_data!) <= 64);
    }
    assert.deepEqual(callbackButtons.map((row) => resolveCallbackData(row[0].callback_data)?.actionKey), ['approve_once', 'deny']);
    assert.ok(callbackButtons.every((row) => resolveCallbackData(row[0].callback_data)?.interruptId === interrupt.interrupt_id));

    // Localhost + inbound: callback buttons as well (no URL button can work).
    channelsService.update(channel.channel_id, { config: { token_ref: '${secret:TG_TOKEN}', chat_id: '4242', inbound: true } });
    calls.length = 0;
    await send();
    assert.ok((calls[0].body.reply_markup.inline_keyboard as Array<Array<{ callback_data?: string }>>).every((row) => row[0].callback_data));
  });
});

test('telegram: any send failure with buttons is retried once without them', async () => {
  await withDb(async ({ botId }) => {
    const { fetch, calls } = fakeFetch((call) =>
      call.body.reply_markup ? { ok: false, description: 'Bad Request: inline keyboard button URL \'http://localhost:3001/x\' is invalid: Wrong HTTP URL' } : { ok: true },
    );
    setChannelsFetch(fetch);
    channelsService.create({ botId, kind: 'telegram', config: { token_ref: '${secret:TG_TOKEN}', chat_id: '4242', action_base_url: 'https://bots.example.com' } });
    const interrupt = gateInterrupt(botId);
    const result = await notifyOperator({ botId, title: interrupt.title, body: interrupt.body, urgency: 0.8, actions: interrupt.actions, interruptId: interrupt.interrupt_id });
    assert.ok(result.delivered.includes('telegram'), 'the message still arrived');
    assert.equal(calls.length, 2);
    assert.ok(calls[0].body.reply_markup);
    assert.equal(calls[1].body.reply_markup, undefined);
    assert.match(String(calls[1].body.text), /Open CloudCLI to approve/);
    // Both attempts failing is reported, with the reason.
    const dead = fakeFetch(() => ({ ok: false, description: 'Forbidden: bot was blocked by the user' }));
    setChannelsFetch(dead.fetch);
    const failed = await notifyOperator({ botId, title: interrupt.title, body: interrupt.body, urgency: 0.8, actions: interrupt.actions, interruptId: interrupt.interrupt_id });
    assert.ok(failed.failed.includes('telegram'));
    assert.equal(dead.calls.length, 2);
    assert.match(failed.failures.find((failure) => failure.kind === 'telegram')?.detail ?? '', /blocked by the user/);
  });
});

test('isPublicHttpsUrl: only an https URL a phone can reach', () => {
  for (const url of ['https://cloudcli.insaneanalytics.co.in', 'https://bots.example.com/x', 'https://203.0.113.9']) assert.equal(isPublicHttpsUrl(url), true, url);
  for (const url of [
    'http://localhost:3001',
    'https://localhost:3001',
    'https://127.0.0.1',
    'https://0.0.0.0',
    'https://[::1]',
    'https://10.0.0.5',
    'https://192.168.1.20',
    'https://172.20.0.1',
    'https://mac.local',
    'https://cloudcli',
    'http://bots.example.com',
    'ftp://bots.example.com',
    'not a url',
    '',
  ]) assert.equal(isPublicHttpsUrl(url), false, url);
});

// ---- Slack ----------------------------------------------------------------------------------

test('slack: URL buttons only for a public https base; otherwise no buttons plus the "Open CloudCLI" line; a failed send retries without buttons', async () => {
  await withDb(async ({ botId }) => {
    const { fetch, calls } = fakeFetch(() => ({ ok: true }));
    setChannelsFetch(fetch);
    const interrupt = gateInterrupt(botId);
    const send = () => notifyOperator({ botId, title: interrupt.title, body: interrupt.body, urgency: 0.8, actions: interrupt.actions, interruptId: interrupt.interrupt_id });
    const channel = channelsService.create({ botId, kind: 'slack', config: { token_ref: '${secret:SLACK_TOKEN}', channel_id: 'C1' } });

    await send(); // localhost base
    assert.equal((calls[0].body.blocks as Array<{ type: string }>).some((block) => block.type === 'actions'), false);
    assert.match(JSON.stringify(calls[0].body), /Open CloudCLI to approve/);

    calls.length = 0;
    channelsService.update(channel.channel_id, { config: { token_ref: '${secret:SLACK_TOKEN}', channel_id: 'C1', action_base_url: 'https://bots.example.com' } });
    await send();
    const actions = (calls[0].body.blocks as Array<{ type: string; elements?: Array<{ url: string }> }>).find((block) => block.type === 'actions');
    assert.ok(actions?.elements?.every((button) => button.url.startsWith('https://bots.example.com/api/bot-actions/')));

    // A rejected message with buttons is sent again without them.
    const flaky = fakeFetch((call) => (JSON.stringify(call.body).includes('"actions"') ? { ok: false, error: 'invalid_blocks' } : { ok: true }));
    setChannelsFetch(flaky.fetch);
    const result = await send();
    assert.ok(result.delivered.includes('slack'));
    assert.equal(flaky.calls.length, 2);
    assert.equal(JSON.stringify(flaky.calls[1].body).includes('"actions"'), false);
  });
});

// ---- Telegram callback buttons ----------------------------------------------------------------

test('telegram callbacks resolve the approval from the configured chat only, then rewrite the message', async () => {
  await withDb(async ({ botId }) => {
    initBotGate();
    setGateHumanPollInterval(20);
    const decision = askDecision(botId);
    const waiting = actionGate.awaitHuman(decision.decision_id, { timeoutMs: 10_000 });
    await waitFor(() => Boolean(botGateDecisionsDb.get(decision.decision_id)?.interrupt_id));
    const interruptId = botGateDecisionsDb.get(decision.decision_id)!.interrupt_id!;

    const sent: Call[] = [];
    let updates: unknown[] = [];
    const { fetch, calls } = fakeFetch((call) => {
      sent.push(call);
      return call.url.endsWith('/getUpdates') ? { ok: true, result: updates } : { ok: true };
    });
    setChannelsFetch(fetch);
    const channel = channelsService.create({ botId, kind: 'telegram', config: { token_ref: '${secret:TG_TOKEN}', chat_id: '4242', inbound: true } });
    const interrupt = interruptsService.get(interruptId)!;
    await notifyOperator({ botId, title: interrupt.title, body: interrupt.body, urgency: 0.8, actions: interrupt.actions, interruptId, critical: true });
    const keyboard = calls.find((call) => call.url.endsWith('/sendMessage'))!.body.reply_markup.inline_keyboard as Array<Array<{ callback_data: string }>>;
    const approve = keyboard[0][0].callback_data;
    const deny = keyboard[1][0].callback_data;
    calls.length = 0;

    const query = (data: string, chatId: number | string, extra: Record<string, unknown> = {}) => ({
      callback_query: { id: `cb-${data}-${chatId}`, data, message: { message_id: 77, text: 'Personal Gmail wants to change report.md', chat: { id: chatId } }, ...extra },
    });

    // A callback from any other chat is ignored: nothing resolved, nothing sent back.
    updates = [{ update_id: 1, ...query(approve, 999) }];
    await pollTelegramOnce(channel.channel_id);
    assert.equal(interruptsService.get(interruptId)!.status, 'open');
    assert.deepEqual(calls.map((call) => call.url.split('/').pop()), ['getUpdates'], 'no answerCallbackQuery or edit for a foreign chat');

    // Forged / unknown ids from the right chat do nothing to the approval.
    calls.length = 0;
    updates = [{ update_id: 2, ...query('a:AAAAAAAA', 4242) }, { update_id: 3, ...query('x:whatever', 4242) }, { update_id: 4, ...query(`a:${'z'.repeat(80)}`, 4242) }];
    await pollTelegramOnce(channel.channel_id);
    assert.equal(interruptsService.get(interruptId)!.status, 'open');

    // The real button, from the configured chat: resolves, answers the tap, strips the buttons.
    calls.length = 0;
    updates = [{ update_id: 5, ...query(approve, 4242) }];
    await pollTelegramOnce(channel.channel_id);
    assert.equal(await waiting, 'approved');
    const resolved = interruptsService.get(interruptId)!;
    assert.equal(resolved.status, 'resolved');
    assert.equal(resolved.resolved_by, 'telegram');
    assert.equal(resolved.resolution, 'approve_once');
    const answered = calls.find((call) => call.url.endsWith('/answerCallbackQuery'))!;
    assert.equal(answered.body.callback_query_id, 'cb-' + approve + '-4242');
    assert.match(String(answered.body.text), /Approved/);
    const edited = calls.find((call) => call.url.endsWith('/editMessageText'))!;
    assert.equal(edited.body.message_id, 77);
    assert.match(String(edited.body.text), /Personal Gmail wants to change report\.md\n\nApproved ✓/);
    assert.deepEqual(edited.body.reply_markup, { inline_keyboard: [] });

    // Tapping again (or Deny after Approve) is stale: answered, never applied twice.
    calls.length = 0;
    updates = [{ update_id: 6, ...query(deny, 4242) }];
    await pollTelegramOnce(channel.channel_id);
    assert.equal(interruptsService.get(interruptId)!.resolution, 'approve_once');
    assert.match(String(calls.find((call) => call.url.endsWith('/answerCallbackQuery'))?.body.text), /Already answered/);
    assert.equal(botGateDecisionsDb.get(decision.decision_id)!.outcome, 'approved');
  });
});

test('telegram callbacks: Deny says Denied and the offset moves on; an expired mapping is answered, not applied', async () => {
  await withDb(async ({ botId }) => {
    const interrupt = gateInterrupt(botId, 'bgd_deny');
    const calls: Call[] = [];
    const { fetch } = fakeFetch((call) => {
      calls.push(call);
      return { ok: true };
    });
    setChannelsFetch(fetch);
    const channel = channelsService.create({ botId, kind: 'telegram', config: { token_ref: '${secret:TG_TOKEN}', chat_id: '4242', inbound: true } });
    const deny = createCallbackData(interrupt.interrupt_id, 'deny');
    const result = await handleTelegramCallback(channel, { id: 'cb1', data: deny, message: { message_id: 5, text: 'Question', chat: { id: 4242 } } });
    assert.equal(result, 'applied');
    assert.equal(interruptsService.get(interrupt.interrupt_id)!.resolution, 'deny');
    assert.match(String(calls.find((call) => call.url.endsWith('/editMessageText'))?.body.text), /Denied ✗$/);

    const other = gateInterrupt(botId, 'bgd_expired');
    const stale = createCallbackData(other.interrupt_id, 'approve_once', { ttlMs: 1 });
    await sleep(5);
    assert.equal(resolveCallbackData(stale), null);
    calls.length = 0;
    assert.equal(await handleTelegramCallback(channel, { id: 'cb2', data: stale, message: { message_id: 6, text: 'Q', chat: { id: 4242 } } }), 'stale');
    assert.equal(interruptsService.get(other.interrupt_id)!.status, 'open');
    assert.match(String(calls.find((call) => call.url.endsWith('/answerCallbackQuery'))?.body.text), /expired/);
    assert.equal(await handleTelegramCallback(channel, { id: 'cb3', data: stale, message: { message_id: 6, chat: { id: 1 } } }), 'ignored');
  });
});

// ---- delivery guarantee --------------------------------------------------------------------------

test('every ask reaches every enabled channel whatever the policy; if all external channels fail the app says why', async () => {
  await withDb(async ({ botId }) => {
    const { fetch, calls } = fakeFetch(() => ({ ok: false, description: 'Forbidden: bot was blocked by the user' }));
    setChannelsFetch(fetch);
    channelsService.create({
      botId: null,
      kind: 'telegram',
      config: { token_ref: '${secret:TG_TOKEN}', chat_id: '4242', action_base_url: 'https://bots.example.com' },
      policy: { digest: true, min_urgency: 0.99, quiet_hours: { start: '00:00', end: '23:59' }, max_pings_per_day: 0 },
    });
    const interrupt = gateInterrupt(botId, 'bgd_all_fail');
    const result = await fanOutInterrupt(interrupt.interrupt_id);
    assert.ok(result);
    assert.ok(result!.failed.includes('telegram'), 'the approval was attempted despite digest, quiet hours, min urgency and the daily cap');
    assert.deepEqual(result!.suppressed, []);
    assert.equal(calls.length, 2, 'with buttons, then without');
    const delivery = systemNotificationsDb.list({ limit: 50 }).find((notice) => /Couldn't reach you on Telegram/.test(notice.title));
    assert.ok(delivery, 'a system notification explains the failure');
    assert.match(delivery!.title, /blocked by the user/);
    assert.match(delivery!.title, /approve here/);
  });
});

test('no notice when an external channel got through; a bot with only in-app is not flagged', async () => {
  await withDb(async ({ botId }) => {
    const ok = fakeFetch(() => ({ ok: true }));
    setChannelsFetch(ok.fetch);
    channelsService.create({ botId: null, kind: 'telegram', config: { token_ref: '${secret:TG_TOKEN}', chat_id: '4242' } });
    await fanOutInterrupt(gateInterrupt(botId, 'bgd_ok').interrupt_id);
    const titles = (): string[] => systemNotificationsDb.list({ limit: 50 }).map((notice) => notice.title);
    assert.ok(!titles().some((title) => /Couldn't reach you/.test(title)));
  });
});

// ---- waiting on a human -------------------------------------------------------------------------

test('approval timeout: 30 minutes by default, runtime_json.approval_timeout_minutes 1..240 overrides', async () => {
  await withDb(({ botId }) => {
    assert.equal(DEFAULT_APPROVAL_TIMEOUT_MINUTES, 30);
    assert.equal(readApprovalTimeoutMs(botId), 30 * 60_000);
    assert.equal(readApprovalTimeoutMs('no-such-bot'), 30 * 60_000);
    patchBotRuntimeConfig(botId, { approval_timeout_minutes: 90 });
    assert.equal(readApprovalTimeoutMs(botId), 90 * 60_000);
    patchBotRuntimeConfig(botId, { approval_timeout_minutes: 240 });
    assert.equal(readApprovalTimeoutMs(botId), 240 * 60_000);
    patchBotRuntimeConfig(botId, { approval_timeout_minutes: 1 });
    assert.equal(readApprovalTimeoutMs(botId), 60_000);
    patchBotRuntimeConfig(botId, { approval_timeout_minutes: null });
    assert.equal(readApprovalTimeoutMs(botId), 30 * 60_000);
    for (const bad of [0, 241, 1.5, -3, '30', NaN, null]) {
      assert.equal(normalizeBotRuntimeConfig({ approval_timeout_minutes: bad }).approval_timeout_minutes, undefined, String(bad));
    }
    assert.equal(validateRuntimeConfigInput({ approval_timeout_minutes: 45 }), null);
    assert.equal(validateRuntimeConfigInput({ approval_timeout_minutes: null }), null);
    for (const bad of [0, 241, 2.5, '5']) assert.match(validateRuntimeConfigInput({ approval_timeout_minutes: bad }) ?? '', /approval_timeout_minutes must be a whole number from 1 to 240/);
  });
});

test('a gate ask uses the bot setting and keeps its episode alive while a human decides (capped like handoffs)', async () => {
  await withDb(async ({ botId }) => {
    initBotGate();
    setGateHumanPollInterval(20);
    patchBotRuntimeConfig(botId, { approval_timeout_minutes: 45 });
    const extensions: Array<[string, number]> = [];
    let answer: { remainingMs: number; capped: boolean } | null = { remainingMs: 60 * 60_000, capped: false };
    setHumanWaitHooks({ extendDeadline: (episodeId, atLeastMs) => { extensions.push([episodeId, atLeastMs]); return answer; } });

    const decision = askDecision(botId, { episodeId: 'bep_live' });
    const pending = actionGate.awaitHuman(decision.decision_id);
    await waitFor(() => Boolean(botGateDecisionsDb.get(decision.decision_id)?.interrupt_id));
    assert.deepEqual(extensions, [['bep_live', 45 * 60_000 + APPROVAL_FINISH_MARGIN_MS]], 'the episode is extended by the wait plus a margin');
    const interrupt = interruptsDb.get(botGateDecisionsDb.get(decision.decision_id)!.interrupt_id!)!;
    const expiresIn = Date.parse(interrupt.expires_at!) - Date.now();
    assert.ok(expiresIn > 44 * 60_000 && expiresIn <= 45 * 60_000, `the card lives 45 minutes, not 10 (${expiresIn})`);
    interruptsService.act(interrupt.interrupt_id, { key: 'approve_once', actor: 'test' });
    assert.equal(await pending, 'approved');

    // The kernel caps the total stretch: the wait is cut to what is left, so it expires before the episode would.
    answer = { remainingMs: 10 * 60_000, capped: true };
    extensions.length = 0;
    const capped = askDecision(botId, { episodeId: 'bep_capped' });
    const cappedWait = actionGate.awaitHuman(capped.decision_id);
    await waitFor(() => Boolean(botGateDecisionsDb.get(capped.decision_id)?.interrupt_id));
    const cappedInterrupt = interruptsDb.get(botGateDecisionsDb.get(capped.decision_id)!.interrupt_id!)!;
    const cappedLeft = Date.parse(cappedInterrupt.expires_at!) - Date.now();
    assert.ok(cappedLeft <= 10 * 60_000 - APPROVAL_FINISH_MARGIN_MS && cappedLeft > 7 * 60_000, `clamped to the room left (${cappedLeft})`);
    interruptsService.act(cappedInterrupt.interrupt_id, { key: 'deny', actor: 'test' });
    assert.equal(await cappedWait, 'rejected');

    // An ask outside an episode (no episode id) has nothing to extend.
    extensions.length = 0;
    const loose = askDecision(botId);
    const looseWait = actionGate.awaitHuman(loose.decision_id, { timeoutMs: 5_000 });
    await waitFor(() => Boolean(botGateDecisionsDb.get(loose.decision_id)?.interrupt_id));
    assert.deepEqual(extensions, []);
    interruptsService.act(botGateDecisionsDb.get(loose.decision_id)!.interrupt_id!, { key: 'approve_once' });
    await looseWait;
  });
});

test('half-way reminder fires once while pending and never after an answer; expiry posts the thread message and notifies', async () => {
  await withDb(async ({ botId }) => {
    initBotGate();
    setGateHumanPollInterval(20);
    const { fetch, calls } = fakeFetch(() => ({ ok: true }));
    setChannelsFetch(fetch);
    channelsService.create({ botId: null, kind: 'telegram', config: { token_ref: '${secret:TG_TOKEN}', chat_id: '4242' } });
    const reminders: string[] = [];
    setHumanWaitHooks({
      onReminder: async (info) => {
        reminders.push(info.decisionId);
        await announceApprovalReminder(info);
      },
      onExpired: announceApprovalExpired,
    });

    // Answered before half-way: no reminder.
    const quick = askDecision(botId);
    const quickWait = actionGate.awaitHuman(quick.decision_id, { timeoutMs: 600 });
    await waitFor(() => Boolean(botGateDecisionsDb.get(quick.decision_id)?.interrupt_id));
    interruptsService.act(botGateDecisionsDb.get(quick.decision_id)!.interrupt_id!, { key: 'approve_once' });
    assert.equal(await quickWait, 'approved');
    await sleep(700);
    assert.deepEqual(reminders, []);
    assert.equal(botThreadDb.list(botId).length, 0);

    // Never answered: one reminder at half the wait, then the expiry.
    calls.length = 0;
    const slow = askDecision(botId, { tool: 'Bash', args: { command: 'curl -X POST https://example.com/hook -d @notes.txt' } });
    const outcome = await actionGate.awaitHuman(slow.decision_id, { timeoutMs: 400 });
    assert.equal(outcome, 'expired');
    await waitFor(() => botThreadDb.list(botId).length === 1);
    assert.deepEqual(reminders, [slow.decision_id], 'exactly one reminder');
    const message = botThreadDb.list(botId)[0];
    assert.equal(message.role, 'bot');
    assert.match(message.body, /^I needed your OK to run: curl -X POST https:\/\/example\.com\/hook -d @notes\.txt but didn't hear back in 1 min, so I stopped\. Reply 'retry' or press Wake now\.$/);
    assert.equal(message.meta.kind, 'approval_expired');
    // Telegram got the reminder and the expiry notice (no buttons are needed on the notice).
    await waitFor(() => calls.filter((call) => call.url.endsWith('/sendMessage')).length >= 2);
    const texts = calls.filter((call) => call.url.endsWith('/sendMessage')).map((call) => String(call.body.text));
    assert.ok(texts.some((text) => /^Reminder: /.test(text)));
    assert.ok(texts.some((text) => /stopped waiting for your OK/.test(text) && /didn't hear back/.test(text)));
    assert.equal(botGateDecisionsDb.get(slow.decision_id)!.outcome, 'expired');
  });
});

test('wording: card titles name what the bot wants, and the expiry line is the agreed sentence', () => {
  const title = (tool: string, args: Record<string, unknown>) => approvalCardTitle('Personal Gmail', { server: 'builtin', tool, args });
  assert.equal(title('Write', { file_path: '/tmp/a.md' }), 'Personal Gmail wants to change /tmp/a.md');
  assert.match(title('Read', { file_path: `${process.env.HOME}/Documents/x/y/z/w/very-long-file-name-for-a-report.md` }), /^Personal Gmail wants to read ~\/…\/w\/very-long-file-name-for-a-report\.md$|^Personal Gmail wants to read …\//);
  assert.equal(title('Bash', { command: 'rm -rf build\nsecond line' }), 'Personal Gmail wants to run: rm -rf build');
  assert.equal(title('WebFetch', { url: 'https://example.com/a/b' }), 'Personal Gmail wants to fetch example.com');
  assert.equal(approvalCardTitle('Personal Gmail', { server: 'mail', tool: 'send_message', args: {} }), 'Personal Gmail wants to send_message');
  assert.equal(
    expiredApprovalMessage('send the newsletter', 30 * 60_000),
    "I needed your OK to send the newsletter but didn't hear back in 30 min, so I stopped. Reply 'retry' or press Wake now.",
  );
});

test('the approval card for a built-in call is titled by the action and explains why a human is asked', async () => {
  await withDb(async ({ botId }) => {
    initBotGate();
    const decision = botGateDecisionsDb.create({
      botId,
      server: 'builtin',
      tool: 'Write',
      risk: 'prod_change',
      args: { file_path: '/Users/someone/Documents/report.md', content: 'x' },
      decision: 'ask',
      decidedBy: 'floor',
      reason: 'Risk "prod_change" needs approval. Gateway-bound run: Write target reaches outside the workspace',
    });
    const pending = actionGate.awaitHuman(decision.decision_id, { timeoutMs: 200 });
    await waitFor(() => Boolean(botGateDecisionsDb.get(decision.decision_id)?.interrupt_id));
    const interrupt = interruptsDb.get(botGateDecisionsDb.get(decision.decision_id)!.interrupt_id!)!;
    assert.equal(interrupt.title, 'Personal Gmail wants to change /Users/someone/Documents/report.md');
    assert.match(interrupt.body, /Why: Risk "prod_change" needs approval\. Gateway-bound run: Write target reaches outside the workspace/);
    await pending;
  });
});

// ---- channels page ---------------------------------------------------------------------------------

test('GET /api/bots/channels reports where approval links point and whether that is local', async () => {
  await withDb(async () => {
    const { appConfigDb } = await import('@/modules/database/index.js');
    const previousEnv = process.env.CLOUDCLI_PUBLIC_URL;
    delete process.env.CLOUDCLI_PUBLIC_URL;
    const app = express();
    app.use(express.json());
    app.use('/api/bots', botChannelsRouter);
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const read = async () => ((await (await fetch(`http://127.0.0.1:${port}/api/bots/channels`)).json()) as { public_base_url: { value: string; source: string; is_local: boolean } }).public_base_url;
    try {
      const local = await read();
      assert.equal(local.source, 'default');
      assert.equal(local.is_local, true);
      assert.match(local.value, /^http:\/\/localhost:\d+$/);

      appConfigDb.set('bots.public_base_url', 'https://cloudcli.insaneanalytics.co.in/');
      assert.deepEqual(await read(), { value: 'https://cloudcli.insaneanalytics.co.in', source: 'app_config', is_local: false });

      appConfigDb.set('bots.public_base_url', 'http://localhost:3001');
      assert.deepEqual(await read(), { value: 'http://localhost:3001', source: 'app_config', is_local: true });

      appConfigDb.set('bots.public_base_url', '');
      process.env.CLOUDCLI_PUBLIC_URL = 'https://env.example.com';
      assert.deepEqual(await read(), { value: 'https://env.example.com', source: 'env', is_local: false });
    } finally {
      if (previousEnv === undefined) delete process.env.CLOUDCLI_PUBLIC_URL;
      else process.env.CLOUDCLI_PUBLIC_URL = previousEnv;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
