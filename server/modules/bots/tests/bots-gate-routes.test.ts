import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { rm } from 'node:fs/promises';

import express from 'express';

import { closeConnection, getConnection, initializeDatabase } from '@/modules/database/index.js';
import { missionControlDb } from '@/modules/mission-control/index.js';
import { botGateRouter } from '@/modules/bots/gate/index.js';
import { botGateDecisionsDb, botRulesDb } from '@/modules/bots/index.js';
import { AppError } from '@/shared/utils.js';
import { makeScratchDir } from '@/shared/scratch.js';

type Reply = { status: number; json: () => any };
type Request = (method: string, url: string, body?: unknown) => Promise<Reply>;

async function withApp(run: (ctx: { request: Request; botId: string; otherBotId: string }) => Promise<void>): Promise<void> {
  const previousDb = process.env.DATABASE_PATH;
  const scratch = await makeScratchDir('bots-gate-routes-');
  closeConnection();
  process.env.DATABASE_PATH = path.join(scratch, 'auth.db');
  await initializeDatabase();
  const app = express();
  app.use(express.json());
  app.use('/api/bots', botGateRouter);
  // Same envelope as the real server's global error middleware.
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (error instanceof AppError) {
      res.status(error.statusCode).json({ success: false, error: { code: error.code, message: error.message } });
      return;
    }
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: String(error) } });
  });
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    const bot = missionControlDb.createSection({ title: 'Gate bot', produce_prompt: 'Go', provider: 'claude' });
    const other = missionControlDb.createSection({ title: 'Cursor bot', produce_prompt: 'Go', provider: 'cursor' });
    await run({
      botId: bot.section_id,
      otherBotId: other.section_id,
      request: async (method, url, body) => {
        const response = await fetch(`http://127.0.0.1:${port}/api/bots${url}`, {
          method,
          headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        const text = await response.text();
        return { status: response.status, json: () => JSON.parse(text) };
      },
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    closeConnection();
    if (previousDb === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDb;
    await rm(scratch, { recursive: true, force: true });
  }
}

test('rules: create, list global vs bot, patch, delete', async () => {
  await withApp(async ({ request, botId, otherBotId }) => {
    const global = await request('POST', '/rules', {
      decision: 'deny',
      match: { server: 'notion', tool: 'delete_*', unknown_key: 1 },
      priority: 5,
      note: 'never delete in Notion',
    });
    assert.equal(global.status, 201);
    const globalRule = global.json().rule;
    assert.equal(globalRule.scope, 'global');
    assert.equal(globalRule.created_from, 'manual');
    assert.deepEqual(globalRule.match, { server: 'notion', tool: 'delete_*' });

    const scoped = await request('POST', '/rules', { scope: 'bot', botId, decision: 'allow', match: { server: 'gmail', risk: ['send'] } });
    assert.equal(scoped.status, 201, 'a bot-scoped allow may loosen a floor risk');
    assert.equal(scoped.json().rule.bot_id, botId);

    assert.deepEqual((await request('GET', '/rules')).json().rules.map((r: any) => r.rule_id), [globalRule.rule_id]);
    const forBot = (await request('GET', `/rules?botId=${botId}`)).json().rules;
    assert.deepEqual(forBot.map((r: any) => r.scope), ['bot']);
    const both = (await request('GET', `/rules?botId=${botId}&includeGlobal=1`)).json().rules;
    assert.equal(both.length, 2);
    assert.equal((await request('GET', `/rules?botId=${otherBotId}`)).json().rules.length, 0);
    assert.equal((await request('GET', '/rules?botId=nope')).status, 404);

    const patched = await request('PATCH', `/rules/${globalRule.rule_id}`, { decision: 'ask', note: 'ask instead', expiresAt: '2030-01-01T00:00:00Z' });
    assert.equal(patched.status, 200);
    assert.equal(patched.json().rule.decision, 'ask');
    assert.equal(patched.json().rule.expires_at, '2030-01-01T00:00:00.000Z');
    assert.equal((await request('PATCH', `/rules/${globalRule.rule_id}`, { expiresAt: null })).json().rule.expires_at, null);
    assert.equal((await request('PATCH', '/rules/missing', { decision: 'ask' })).status, 404);

    assert.equal((await request('DELETE', `/rules/${globalRule.rule_id}`)).status, 200);
    assert.equal((await request('DELETE', `/rules/${globalRule.rule_id}`)).status, 404);
    assert.equal(botRulesDb.get(globalRule.rule_id), null);
  });
});

test('rules: validation rejects bad scope, decision, match shape', async () => {
  await withApp(async ({ request, botId }) => {
    const bad = async (payload: Record<string, unknown>, pattern: RegExp) => {
      const reply = await request('POST', '/rules', payload);
      assert.equal(reply.status, 400, JSON.stringify(payload));
      assert.match(reply.json().error.message, pattern);
    };
    await bad({ decision: 'maybe' }, /decision must be/);
    await bad({ decision: 'ask', scope: 'goal' }, /scope must be/);
    await bad({ decision: 'ask', scope: 'bot' }, /requires botId/);
    await bad({ decision: 'ask', match: 'gmail' }, /match must be an object/);
    await bad({ decision: 'ask', match: { risk: ['sideways'] } }, /unknown risk/);
    await bad({ decision: 'ask', match: { risk: 'send' } }, /array of risks/);
    await bad({ decision: 'ask', match: { server: 7 } }, /match.server must be a string/);
    await bad({ decision: 'ask', match: { args: [{ path: 'to', op: 'startswith', value: 'x' }] } }, /op must be/);
    await bad({ decision: 'ask', match: { args: [{ path: 'to', op: 'regex', value: '(' }] } }, /valid regular expression/);
    await bad({ decision: 'ask', match: { args: [{ path: 'to', op: 'in', value: 'x' }] } }, /array/);
    await bad({ decision: 'ask', priority: 1.5 }, /priority/);
    await bad({ decision: 'ask', expiresAt: 'tomorrow-ish' }, /expiresAt/);
    assert.equal((await request('POST', '/rules', { decision: 'ask', scope: 'bot', botId: 'ghost' })).status, 404);
    const ok = await request('POST', '/rules', {
      scope: 'bot',
      botId,
      decision: 'deny',
      match: { args: [{ path: 'to', op: 'regex', value: '@evil\\.com$' }, { path: 'to', op: 'in', value: ['a', 'b'] }] },
    });
    assert.equal(ok.status, 201);
    assert.equal(ok.json().rule.match.args.length, 2);
  });
});

test('rules: a global allow can never cover floor risks', async () => {
  await withApp(async ({ request, botId }) => {
    const refused = await request('POST', '/rules', { decision: 'allow', match: { risk: ['read', 'send'] } });
    assert.equal(refused.status, 400);
    assert.match(refused.json().error.message, /floor/i);
    assert.match(refused.json().error.message, /send/);
    for (const risk of ['send', 'publish', 'delete', 'purchase', 'credential', 'prod_change']) {
      assert.equal((await request('POST', '/rules', { decision: 'allow', match: { risk: [risk] } })).status, 400, risk);
    }
    assert.equal((getConnection().prepare('SELECT COUNT(*) AS n FROM bot_rules').get() as { n: number }).n, 0);

    // No risk filter: accepted, with a warning that the floor still asks.
    const open = await request('POST', '/rules', { decision: 'allow', match: { server: 'notion' } });
    assert.equal(open.status, 201);
    assert.match(open.json().warnings[0], /still ask/);
    const safe = await request('POST', '/rules', { decision: 'allow', match: { risk: ['read', 'draft'] } });
    assert.equal(safe.status, 201);
    assert.equal(safe.json().warnings, undefined);

    // Patching a safe global allow into a floor-covering one is refused; deny/ask for floor is fine.
    const safeId = safe.json().rule.rule_id;
    const widen = await request('PATCH', `/rules/${safeId}`, { match: { risk: ['delete'] } });
    assert.equal(widen.status, 400);
    assert.deepEqual(botRulesDb.get(safeId)!.match.risk, ['read', 'draft']);
    assert.equal((await request('PATCH', `/rules/${safeId}`, { decision: 'deny', match: { risk: ['delete'] } })).status, 200);
    assert.equal((await request('POST', '/rules', { decision: 'deny', match: { risk: ['delete'] } })).status, 201);
    // Loosening a floor risk on one bot stays allowed.
    assert.equal((await request('POST', '/rules', { scope: 'bot', botId, decision: 'allow', match: { risk: ['delete'] } })).status, 201);
  });
});

test('risk classify previews tool risk and the floor', async () => {
  await withApp(async ({ request }) => {
    const send = (await request('GET', '/risk/classify?server=gmail&tool=send_email')).json();
    assert.deepEqual(send, { risk: 'send', floor: true, default_decision: 'ask' });
    const read = (await request('GET', '/risk/classify?server=notion&tool=search_pages')).json();
    assert.deepEqual(read, { risk: 'read', floor: false, default_decision: 'allow' });
    assert.equal((await request('GET', '/risk/classify?server=x&tool=frobnicate')).json().default_decision, 'ask');
    assert.equal((await request('GET', '/risk/classify?server=x')).status, 400);
  });
});

test('gate decisions: newest first, filtered, args redacted and summarized', async () => {
  await withApp(async ({ request, botId, otherBotId }) => {
    const make = (tool: string, decision: 'allow' | 'ask' | 'deny', args: Record<string, unknown> = {}, botIdFor = botId) =>
      botGateDecisionsDb.create({ botId: botIdFor, server: 'gmail', tool, risk: 'send', args, decision, decidedBy: 'floor' });
    const first = make('a_tool', 'allow');
    const second = make('b_tool', 'ask', { to: 'a@b.com', api_key: 'sk-live-123', body: 'x'.repeat(900), nested: { password: 'hunter2', ok: 1 } });
    const third = make('c_tool', 'deny');
    make('other_tool', 'deny', {}, otherBotId);
    botGateDecisionsDb.recordOutcome(first.decision_id, 'executed');
    botGateDecisionsDb.recordOutcome(third.decision_id, 'denied');
    getConnection().prepare('UPDATE bot_gate_decisions SET created_at = ? WHERE decision_id = ?').run('2026-01-01T00:00:01.000Z', first.decision_id);
    getConnection().prepare('UPDATE bot_gate_decisions SET created_at = ? WHERE decision_id = ?').run('2026-01-01T00:00:02.000Z', second.decision_id);
    getConnection().prepare('UPDATE bot_gate_decisions SET created_at = ? WHERE decision_id = ?').run('2026-01-01T00:00:03.000Z', third.decision_id);

    const all = (await request('GET', `/${botId}/gate-decisions`)).json().decisions;
    assert.deepEqual(all.map((d: any) => d.tool), ['c_tool', 'b_tool', 'a_tool']);
    assert.equal((await request('GET', `/${botId}/gate-decisions?limit=2`)).json().decisions.length, 2);
    assert.deepEqual((await request('GET', `/${botId}/gate-decisions?decision=deny`)).json().decisions.map((d: any) => d.tool), ['c_tool']);
    assert.deepEqual((await request('GET', `/${botId}/gate-decisions?outcome=executed`)).json().decisions.map((d: any) => d.tool), ['a_tool']);
    assert.deepEqual((await request('GET', `/${botId}/gate-decisions?outcome=pending`)).json().decisions.map((d: any) => d.tool), ['b_tool']);
    assert.equal((await request('GET', `/${botId}/gate-decisions?decision=bogus`)).status, 400);
    assert.equal((await request('GET', `/${botId}/gate-decisions?outcome=bogus`)).status, 400);
    assert.equal((await request('GET', '/ghost/gate-decisions')).status, 404);

    const view = all.find((d: any) => d.tool === 'b_tool');
    assert.equal(view.args.api_key, '[redacted]');
    assert.equal(view.args.nested.password, '[redacted]');
    assert.equal(view.args.nested.ok, 1);
    assert.equal(view.args.to, 'a@b.com');
    assert.match(view.args.body, /\.\.\. \(900 chars\)$/);
    assert.match(view.args_summary, /to: a@b\.com/);
    assert.equal(JSON.stringify(view).includes('hunter2'), false);
    assert.equal(JSON.stringify(view).includes('sk-live-123'), false);
    // The stored row is untouched.
    assert.equal(botGateDecisionsDb.get(second.decision_id)!.args.api_key, 'sk-live-123');
  });
});

test('budget: get, put validation, partial updates and status', async () => {
  await withApp(async ({ request, botId }) => {
    assert.equal((await request('GET', `/${botId}/budget`)).json().budget, null);
    const put = await request('PUT', `/${botId}/budget`, { daily_usd: 5, monthly_usd: null, daily_actions: 10, max_wakes_per_hour: 3, soft_ratio: 0.5 });
    assert.equal(put.status, 200);
    assert.deepEqual(
      { ...put.json().budget, updated_at: undefined },
      { bot_id: botId, daily_usd: 5, monthly_usd: null, daily_actions: 10, max_wakes_per_hour: 3, soft_ratio: 0.5, updated_at: undefined },
    );
    // Omitted fields keep their value; null clears.
    const partial = (await request('PUT', `/${botId}/budget`, { daily_usd: null })).json().budget;
    assert.equal(partial.daily_usd, null);
    assert.equal(partial.daily_actions, 10);

    for (const payload of [{ daily_usd: -1 }, { daily_usd: '5' }, { daily_actions: 1.5 }, { max_wakes_per_hour: -2 }, { soft_ratio: 0 }, { soft_ratio: 2 }]) {
      assert.equal((await request('PUT', `/${botId}/budget`, payload)).status, 400, JSON.stringify(payload));
    }
    assert.equal((await request('PUT', '/ghost/budget', { daily_usd: 1 })).status, 404);
    assert.equal((await request('GET', `/${botId}/budget`)).json().budget.daily_actions, 10);

    const status = (await request('GET', `/${botId}/budget/status`)).json().status;
    assert.equal(status.budget.bot_id, botId);
    assert.deepEqual(status.check, { ok: true, soft: false });
    assert.deepEqual(status.spend, { today_usd: 0, month_usd: 0, actions_today: 0, wakes_last_hour: 0 });
    assert.equal(status.wake_allowed, true);
  });
});

test('budget status reflects executed actions and a hard limit', async () => {
  await withApp(async ({ request, botId }) => {
    await request('PUT', `/${botId}/budget`, { daily_actions: 2 });
    for (const tool of ['a', 'b']) {
      const row = botGateDecisionsDb.create({ botId, server: 'notion', tool, risk: 'read', decision: 'allow', decidedBy: 'default' });
      botGateDecisionsDb.recordOutcome(row.decision_id, 'executed');
    }
    const status = (await request('GET', `/${botId}/budget/status`)).json().status;
    assert.equal(status.spend.actions_today, 2);
    assert.equal(status.check.ok, false);
    assert.match(status.check.reason, /daily actions/);
  });
});

test('enforcement preview: answers per provider without a bot and matches the per-bot route', async () => {
  await withApp(async ({ request, botId, otherBotId }) => {
    const claude = (await request('GET', '/enforcement/preview?provider=claude')).json().enforcement;
    const perBot = (await request('GET', `/${botId}/enforcement`)).json().enforcement;
    assert.equal(claude.provider, 'claude');
    assert.equal(claude.level, perBot.level);
    assert.equal(claude.builtin_tool_gate, perBot.builtin_tool_gate);
    assert.equal(typeof claude.detail, 'string');
    const cursor = (await request('GET', '/enforcement/preview?provider=cursor')).json().enforcement;
    assert.equal(cursor.level, (await request('GET', `/${otherBotId}/enforcement`)).json().enforcement.level);
    // An unknown provider is advisory, never a 404 or an accidental "enforced".
    assert.equal((await request('GET', '/enforcement/preview?provider=mystery')).json().enforcement.level, 'advisory');
    assert.equal((await request('GET', '/enforcement/preview')).status, 400);
  });
});

test('enforcement: claude is enforced with the built-in tool gate, others advisory', async () => {
  await withApp(async ({ request, botId, otherBotId }) => {
    const claude = (await request('GET', `/${botId}/enforcement`)).json().enforcement;
    assert.equal(claude.provider, 'claude');
    assert.equal(claude.level, 'enforced');
    assert.equal(claude.builtin_tool_gate, true);
    assert.equal(claude.gateway, true);
    assert.equal(claude.phases.length, 3);
    const cursor = (await request('GET', `/${otherBotId}/enforcement`)).json().enforcement;
    assert.equal(cursor.provider, 'cursor');
    assert.equal(cursor.level, 'advisory');
    assert.equal(cursor.builtin_tool_gate, false);
    assert.equal((await request('GET', '/ghost/enforcement')).status, 404);
  });
});
