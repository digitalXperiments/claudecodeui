import assert from 'node:assert/strict';
import fs from 'node:fs';
import { rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import test from 'node:test';

import express from 'express';

import { updateAppFeatures } from '@/modules/app-features/index.js';
import { closeConnection, initializeDatabase } from '@/modules/database/index.js';
import { interruptsDb, interruptsService } from '@/modules/interrupt-queue/index.js';
import { missionControlDb } from '@/modules/mission-control/index.js';
import type { RecordedAction } from '@/modules/browser-use/index.js';
import { gatewaySessions } from '@/shared/bot-gateway-sessions.js';
import { makeScratchDir } from '@/shared/scratch.js';
import { resolveBotBrowserProfileDir, resolveBotHome } from '@/modules/bots/bots-home.js';
import { APPROVAL_INTERRUPT_KINDS } from '@/modules/bots/channels/approvals.js';
import {
  botExecRouter,
  compileTeachSkill,
  installExec,
  redactUrl,
  resetTeachState,
  resolveHandoffTimeoutMs,
  setHandoffOptions,
  setTeachDeps,
  startTeach,
  stopTeach,
  type HandoffOutcome,
} from '@/modules/bots/exec/index.js';
import { getGatewayTool } from '@/modules/bots/gateway/index.js';
import { botSkillsDb } from '@/modules/bots/learning/bot-skills.repository.js';

async function withBot(run: (ctx: { botId: string; scratch: string }) => void | Promise<void>): Promise<void> {
  const previousDb = process.env.DATABASE_PATH;
  const previousHome = process.env.CLOUDCLI_BOTS_HOME;
  const scratch = await makeScratchDir('bots-exec-ht-');
  closeConnection();
  process.env.DATABASE_PATH = path.join(scratch, 'auth.db');
  process.env.CLOUDCLI_BOTS_HOME = path.join(scratch, 'bots');
  await initializeDatabase();
  updateAppFeatures({ botsRuntimeV2: true });
  installExec();
  try {
    const bot = missionControlDb.createSection({ title: 'Handoff bot', produce_prompt: 'Do it' });
    await run({ botId: bot.section_id, scratch });
  } finally {
    setHandoffOptions(null);
    setTeachDeps(null);
    resetTeachState();
    gatewaySessions.clearForTests();
    closeConnection();
    if (previousDb === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDb;
    if (previousHome === undefined) delete process.env.CLOUDCLI_BOTS_HOME;
    else process.env.CLOUDCLI_BOTS_HOME = previousHome;
    await rm(scratch, { recursive: true, force: true });
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until<T>(check: () => T | null | undefined | false, timeoutMs = 3_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await sleep(10);
  }
}

// ---- handoff ---------------------------------------------------------------------------------

function bindSession(botId: string, appSessionId = 'app-session-1') {
  gatewaySessions.bind(appSessionId, { botId, servers: [], provider: 'claude', runId: 'run-1', episodeId: 'ep-1' });
  return { appSessionId, botId, runId: 'run-1', episodeId: 'ep-1', provider: 'claude', tainted: false };
}

async function callHandoff(ctx: ReturnType<typeof bindSession>, args: Record<string, unknown>) {
  const tool = getGatewayTool('bot__request_handoff');
  assert.ok(tool, 'bot__request_handoff is registered by installExec');
  assert.equal(tool.risk, 'draft');
  const result = await tool.handler(ctx, args);
  const text = (result.content[0] as { text: string }).text;
  return { result, text, json: (() => { try { return JSON.parse(text) as { outcome: HandoffOutcome; note: string }; } catch { return null; } })() };
}

const openHandoff = () => interruptsDb.list({ status: ['open'] }).find((interrupt) => interrupt.kind === 'bot_handoff');

test('handoff: raises a bot_handoff interrupt, blocks until Done, returns the operator note', async () => {
  await withBot(async ({ botId }) => {
    setHandoffOptions({ pollMs: 20 });
    const ctx = bindSession(botId);
    const pending = callHandoff(ctx, { reason: 'Login wall', instructions: 'Sign in to Jira', url: 'https://jira.example.com/login' });

    const interrupt = await until(openHandoff);
    assert.equal(interrupt.title, 'Handoff bot needs you');
    assert.match(interrupt.body, /Sign in to Jira/);
    assert.match(interrupt.body, /https:\/\/jira\.example\.com\/login/);
    assert.deepEqual(interrupt.actions.map((action) => action.id), ['done', 'cancel']);
    assert.equal(interrupt.href, `/bots/b/${botId}/overview`);
    assert.equal(interrupt.meta.botId, botId);
    assert.equal(typeof interrupt.meta.handoffId, 'string');
    assert.ok(interrupt.expires_at && Date.parse(interrupt.expires_at) > Date.now() + 25 * 60_000, 'default wait is about 30 minutes');

    interruptsService.act(interrupt.interrupt_id, { key: 'done', actor: 'operator', body: { note: 'Logged in, MFA passed' } });
    const { result, json } = await pending;
    assert.equal(result.isError, undefined);
    assert.deepEqual(json && { outcome: json.outcome, note: json.note }, { outcome: 'done', note: 'Logged in, MFA passed' });
    assert.equal(interruptsDb.get(interrupt.interrupt_id)?.status, 'resolved');
  });
});

test('handoff: Cancel, a timeout and a finished run each end the wait with their own outcome', async () => {
  await withBot(async ({ botId }) => {
    setHandoffOptions({ pollMs: 20 });
    const cancelled = callHandoff(bindSession(botId), { reason: 'r', instructions: 'i' });
    const first = await until(openHandoff);
    interruptsService.act(first.interrupt_id, { key: 'cancel', body: { note: 'cannot do it now' } });
    const cancelResult = await cancelled;
    assert.equal(cancelResult.result.isError, true);
    assert.equal(cancelResult.json?.outcome, 'cancelled');
    assert.equal(cancelResult.json?.note, 'cannot do it now');

    setHandoffOptions({ pollMs: 20, timeoutMs: 120 });
    const timedOut = await callHandoff(bindSession(botId, 'app-session-2'), { reason: 'r', instructions: 'i' });
    assert.equal(timedOut.json?.outcome, 'timeout');
    assert.equal(timedOut.result.isError, true);
    const expired = interruptsDb.list({ status: ['expired'] }).find((interrupt) => interrupt.kind === 'bot_handoff');
    assert.ok(expired, 'the interrupt is expired, not left open');
    assert.equal(openHandoff(), undefined);

    setHandoffOptions({ pollMs: 20 });
    const ctx = bindSession(botId, 'app-session-3');
    const ended = callHandoff(ctx, { reason: 'r', instructions: 'i' });
    await until(openHandoff);
    gatewaySessions.unbind('app-session-3');
    assert.equal((await ended).json?.outcome, 'run_ended');
    assert.equal(openHandoff(), undefined, 'a dead run leaves no open card');
  });
});

test('handoff: an answer that arrives through the interrupt row alone (no resolver) still resolves the wait', async () => {
  await withBot(async ({ botId }) => {
    setHandoffOptions({ pollMs: 20 });
    interruptsService.configureBotHandoffResolver(null);
    const pending = callHandoff(bindSession(botId), { reason: 'r', instructions: 'i' });
    const interrupt = await until(openHandoff);
    interruptsService.act(interrupt.interrupt_id, { key: 'done' });
    assert.equal((await pending).json?.outcome, 'done');
  });
});

test('handoff: validates input, hands the live browser to the operator and takes it back', async () => {
  await withBot(async ({ botId }) => {
    const calls: string[] = [];
    setHandoffOptions({
      pollMs: 20,
      browser: {
        takeHumanControl: async (id) => { calls.push(`take:${id}`); },
        returnAgentControl: async (id) => { calls.push(`return:${id}`); },
      },
    });
    const ctx = bindSession(botId);
    assert.match((await callHandoff(ctx, { instructions: 'i' })).text, /reason is required/);
    assert.match((await callHandoff(ctx, { reason: 'r' })).text, /instructions is required/);
    assert.match((await callHandoff(ctx, { reason: 'r', instructions: 'i', url: 'javascript:alert(1)' })).text, /http\(s\)/);
    assert.equal(openHandoff(), undefined, 'rejected calls create nothing');

    const pending = callHandoff(ctx, { reason: 'Captcha', instructions: 'Solve it', browserSessionId: 'sess-42' });
    const interrupt = await until(openHandoff);
    assert.match(interrupt.body, /Browser panel/);
    assert.match(interrupt.body, /sess-42/);
    assert.equal(interrupt.meta.browserSessionId, 'sess-42');
    assert.deepEqual(calls, ['take:sess-42']);
    interruptsService.act(interrupt.interrupt_id, { key: 'done' });
    await pending;
    assert.deepEqual(calls, ['take:sess-42', 'return:sess-42']);
  });
});

test('handoff actions are only valid on bot_handoff interrupts; approvals fan-out includes the kind; timeout config', async () => {
  await withBot(({ botId }) => {
    const other = interruptsService.create({ kind: 'run_failed', title: 'x', meta: { botId } });
    assert.throws(() => interruptsService.act(other.interrupt_id, { key: 'done' }), /Unsupported interrupt action/);
    assert.ok(APPROVAL_INTERRUPT_KINDS.includes('bot_handoff'));

    assert.equal(resolveHandoffTimeoutMs(), 30 * 60_000);
    assert.equal(resolveHandoffTimeoutMs(5), 5 * 60_000);
    assert.equal(resolveHandoffTimeoutMs(10_000), 2_100_000 - 30_000, 'never longer than the gateway call can wait');
    const previous = process.env.CLOUDCLI_BOT_HANDOFF_TIMEOUT_MINUTES;
    process.env.CLOUDCLI_BOT_HANDOFF_TIMEOUT_MINUTES = '12';
    try {
      assert.equal(resolveHandoffTimeoutMs(), 12 * 60_000);
    } finally {
      if (previous === undefined) delete process.env.CLOUDCLI_BOT_HANDOFF_TIMEOUT_MINUTES;
      else process.env.CLOUDCLI_BOT_HANDOFF_TIMEOUT_MINUTES = previous;
    }
  });
});

// ---- teach mode --------------------------------------------------------------------------------

const RECORDING: RecordedAction[] = [
  { kind: 'navigate', url: 'https://portal.example.com/login?token=SECRET-IN-QUERY#frag', at: 1 },
  { kind: 'fill', selector: 'input[name="email"]', label: 'Email', name: 'email', inputType: 'email', value: 'ram@example.com', sensitive: false, at: 2 },
  { kind: 'fill', selector: 'input[name="password"]', label: 'Password', name: 'password', inputType: 'password', value: null, sensitive: true, at: 3 },
  { kind: 'click', selector: 'button[type="submit"]', text: 'Sign in', tag: 'button', at: 4 },
  { kind: 'navigate', url: 'https://portal.example.com/dashboard?session=ABC', at: 5, implied: true },
  { kind: 'select', selector: 'select[name="region"]', label: 'Region', value: 'Saudi Arabia', at: 6 },
  { kind: 'fill', selector: 'input[name="note"]', label: 'Note', name: 'note', inputType: 'text', value: 'standard ticket', sensitive: false, at: 7 },
  { kind: 'press', key: 'Enter', selector: 'input[name="note"]', at: 8 },
];

function fakeBrowser(recording: RecordedAction[], options: { status?: string } = {}) {
  const calls: string[] = [];
  const created: Array<{ profileDir?: string | null }> = [];
  const browser = {
    createAgentSession: async (input: { profileDir?: string | null; recordNetwork?: boolean }) => {
      created.push(input);
      calls.push('create');
      return { id: 'teach-session', status: options.status ?? 'ready', message: options.status ? 'Chromium is not installed' : null };
    },
    agentNavigate: async (_id: string, url: string) => { calls.push(`navigate:${url}`); },
    startActionRecording: async () => { calls.push('record'); },
    stopActionRecording: async () => { calls.push('collect'); return { actions: recording, startedAt: 1, stoppedAt: 2 }; },
    takeHumanControl: async () => { calls.push('take'); },
    returnAgentControl: async () => { calls.push('return'); },
    stopSession: async () => { calls.push('stop'); },
  };
  return { browser, calls, created };
}

test('teach: start records on the bot profile and hands over control; stop saves a disabled teach draft with redacted values', async () => {
  await withBot(async ({ botId }) => {
    const fake = fakeBrowser(RECORDING);
    setTeachDeps({ browser: fake.browser });

    const started = await startTeach(botId, { url: 'https://portal.example.com/login' });
    assert.equal(started.sessionId, 'teach-session');
    assert.equal(started.profile, 'bot');
    assert.equal(fake.created[0].profileDir, resolveBotBrowserProfileDir(botId));
    assert.deepEqual(fake.calls, ['create', 'navigate:https://portal.example.com/login', 'record', 'take']);
    await assert.rejects(startTeach(botId), /already running/);

    const stopped = await stopTeach(botId, { name: 'Portal login', description: 'Log in and file a ticket', successCheck: 'The dashboard shows "Ticket created".' });
    assert.deepEqual(fake.calls.slice(4), ['collect', 'return', 'stop'], 'the session is closed so the profile is unlocked');
    assert.deepEqual(stopped.skill, { name: 'portal-login', enabled: false, origin: 'teach' });

    const row = botSkillsDb.getByName(botId, 'portal-login');
    assert.equal(row?.origin, 'teach');
    assert.equal(row?.enabled, false);
    const file = path.join(resolveBotHome(botId), 'skills', 'portal-login', 'SKILL.md');
    const content = fs.readFileSync(file, 'utf8');
    assert.match(content, /^---\nname: portal-login\n/);
    assert.match(content, /description: Log in and file a ticket/);
    assert.match(content, /## Inputs/);
    assert.match(content, /\{\{email\}\}/);
    assert.match(content, /`password` \(secret\)/);
    assert.match(content, /browser_type_secret/);
    assert.match(content, /\{\{region\}\}/);
    assert.match(content, /Click "Sign in"/);
    assert.match(content, /Press Enter/);
    assert.match(content, /## Success check\nThe dashboard shows "Ticket created"\./);
    for (const leaked of ['ram@example.com', 'SECRET-IN-QUERY', 'session=ABC', 'Saudi Arabia', 'standard ticket']) {
      assert.equal(content.includes(leaked), false, `${leaked} must not appear in the draft`);
      assert.equal(JSON.stringify(stopped).includes(leaked), false, `${leaked} must not appear in the response`);
    }
    assert.match(content, /the page then loads https:\/\/portal\.example\.com\/dashboard\)/);
    assert.equal(stopped.captured.actions, RECORDING.length);
    assert.ok(stopped.capturedKinds.length >= 4);

    await assert.rejects(stopTeach(botId), /No teach session/);
  });
});

test('teach: fields marked safe keep their literal value; repeated names get unique skill names', async () => {
  await withBot(async ({ botId }) => {
    setTeachDeps({ browser: fakeBrowser(RECORDING).browser });
    await startTeach(botId);
    const first = await stopTeach(botId, { name: 'portal', safeFields: ['input[name="note"]'], safeSteps: [2] });
    assert.match(first.content, /Type "standard ticket" into Note/);
    assert.match(first.content, /Type "ram@example\.com" into Email/);
    assert.equal(first.inputs.some((input) => input.name === 'note'), false);
    assert.equal(first.inputs.some((input) => input.name === 'email'), false);
    assert.equal(first.content.includes('SECRET-IN-QUERY'), false);

    await startTeach(botId);
    const second = await stopTeach(botId, { name: 'portal' });
    assert.equal(first.skill?.name, 'portal');
    assert.equal(second.skill?.name, 'portal-2');
    assert.match(second.content, /^---\nname: portal-2\n/);
  });
});

test('teach: a password-like field is never safe, dry runs save nothing, an empty recording is rejected and cleans up', async () => {
  await withBot(async ({ botId }) => {
    const fake = fakeBrowser(RECORDING);
    setTeachDeps({ browser: fake.browser });
    await startTeach(botId);
    const dry = await stopTeach(botId, { dryRun: true, safeFields: ['input[name="password"]'], safeSteps: [3] });
    assert.equal(dry.skill, null);
    assert.equal(botSkillsDb.list(botId).length, 0);
    assert.equal(dry.inputs.find((input) => input.name === 'password')?.secret, true);

    setTeachDeps({ browser: fakeBrowser([]).browser });
    await startTeach(botId);
    await assert.rejects(stopTeach(botId), /Nothing was recorded/);
    await startTeach(botId); // state was cleaned up, so a new session can start
    await stopTeach(botId).catch(() => undefined);
  });
});

test('teach: browser problems surface as clear errors and leave no active session', async () => {
  await withBot(async ({ botId }) => {
    setTeachDeps({ browser: fakeBrowser(RECORDING, { status: 'unavailable' }).browser });
    await assert.rejects(startTeach(botId), /Chromium is not installed/);
    await assert.rejects(startTeach(botId, { url: 'file:///etc/passwd' }), /http\(s\)/);
    await assert.rejects(startTeach('missing-bot'), /Bot not found/);

    const failing = fakeBrowser(RECORDING);
    failing.browser.startActionRecording = async () => { throw new Error('no context binding'); };
    setTeachDeps({ browser: failing.browser });
    await assert.rejects(startTeach(botId), /Could not start teach mode: no context binding/);
    assert.ok(failing.calls.includes('stop'), 'the half-started session is closed');
    setTeachDeps({ browser: fakeBrowser(RECORDING).browser });
    await startTeach(botId);
  });
});

test('teach REST: start, status and stop', async () => {
  await withBot(async ({ botId }) => {
    setTeachDeps({ browser: fakeBrowser(RECORDING).browser });
    const app = express();
    app.use(express.json());
    app.use('/api/bots', botExecRouter);
    app.use((error: { statusCode?: number; message: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(error.statusCode ?? 500).json({ error: error.message });
    });
    const server = await new Promise<import('node:http').Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/bots`;
    const call = async (method: string, url: string, body?: unknown) => {
      const res = await fetch(`${base}${url}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: res.status, json: (await res.json()) as any };
    };
    try {
      assert.equal((await call('POST', `/${botId}/teach/stop`, {})).status, 404);
      assert.equal((await call('POST', `/${botId}/teach/start`, { url: 'ftp://x' })).status, 400);
      const start = await call('POST', `/${botId}/teach/start`, { url: 'https://portal.example.com/' });
      assert.equal(start.status, 200);
      assert.equal(start.json.teach.sessionId, 'teach-session');
      assert.equal((await call('GET', `/${botId}/teach`)).json.active.sessionId, 'teach-session');
      assert.equal((await call('POST', `/${botId}/teach/start`, {})).status, 409);
      const stop = await call('POST', `/${botId}/teach/stop`, { name: 'rest-skill', safeFields: ['input[name="note"]'] });
      assert.equal(stop.status, 200);
      assert.equal(stop.json.teach.skill.name, 'rest-skill');
      assert.equal(stop.json.teach.skill.enabled, false);
      assert.equal((await call('GET', `/${botId}/teach`)).json.active, null);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

test('teach compile: urls lose query and fragment, step cap is enforced', () => {
  assert.deepEqual(redactUrl('https://a.test/p?token=1#x'), { url: 'https://a.test/p', hadQuery: true });
  assert.deepEqual(redactUrl('not a url'), { url: '', hadQuery: false });
  const many: RecordedAction[] = Array.from({ length: 120 }, (_, i) => ({ kind: 'click', selector: `#b${i}`, text: `B${i}`, tag: 'button', at: i }));
  const compiled = compileTeachSkill(many, { name: 'many' });
  assert.equal(compiled.steps.length, 80);
  assert.equal(compiled.skipped, 40);
  assert.match(compiled.content, /40 further recorded actions were not included/);
  assert.match(compiled.content, /Edit this line|shows no error/);
});
