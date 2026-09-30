import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import {
  actionGate,
  budgets,
  classifyToolRisk,
  initBotGate,
  resolveBotGateDecision,
  rules,
  setAutoReviewer,
  setGateHumanPollInterval,
  wakeAllowed,
  type GateContext,
  type GateRequest,
  type Risk,
} from '@/modules/bots/gate/index.js';
import { botBudgetsDb, botEpisodesDb, botGateDecisionsDb, botRulesDb } from '@/modules/bots/index.js';
import { closeConnection, getConnection, initializeDatabase } from '@/modules/database/index.js';
import { interruptsDb, interruptsService } from '@/modules/interrupt-queue/index.js';
import { missionControlDb } from '@/modules/mission-control/index.js';
import { runsDb } from '@/modules/runs/index.js';
import { makeScratchDir } from '@/shared/scratch.js';

async function withDatabase(run: (botId: string) => void | Promise<void>): Promise<void> {
  const previousDb = process.env.DATABASE_PATH;
  const scratch = await makeScratchDir('bots-gate-');
  closeConnection();
  process.env.DATABASE_PATH = path.join(scratch, 'auth.db');
  await initializeDatabase();
  interruptsService.configureBotGateResolver(null);
  setAutoReviewer(async () => {
    throw new Error('real reviewer must not run in tests');
  });
  try {
    const bot = missionControlDb.createSection({ title: 'Inbox bot', produce_prompt: 'Go' });
    await run(bot.section_id);
  } finally {
    setAutoReviewer(null);
    setGateHumanPollInterval(null);
    interruptsService.configureBotGateResolver(null);
    closeConnection();
    if (previousDb === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDb;
    await rm(scratch, { recursive: true, force: true });
  }
}

const ctxFor = (botId: string, overrides: Partial<GateContext> = {}): GateContext => ({
  botId,
  tainted: false,
  operatorInstructions: 'Triage my inbox',
  goals: [],
  ...overrides,
});

const call = (server: string, tool: string, args: Record<string, unknown> = {}): GateRequest => ({ server, tool, args });

// ---------------------------------------------------------------------------

const RISK_TABLE: [string, string, Risk][] = [
  // Gmail
  ['gmail', 'send_message', 'send'],
  ['gmail', 'reply', 'send'],
  ['gmail', 'forward', 'send'],
  ['gmail', 'create_draft', 'draft'],
  ['gmail', 'update_draft', 'draft'],
  ['gmail', 'delete_draft', 'delete'],
  ['gmail', 'list_drafts', 'read'],
  ['gmail', 'get_thread', 'read'],
  ['gmail', 'search_threads', 'read'],
  ['gmail', 'trash_message', 'delete'],
  ['gmail', 'list_labels', 'read'],
  ['gmail', 'label_message', 'unknown'],
  // Composio SLUGs
  ['composio', 'GMAIL_SEND_EMAIL', 'send'],
  ['composio', 'GMAIL_CREATE_EMAIL_DRAFT', 'draft'],
  ['composio', 'GMAIL_SEND_DRAFT', 'send'],
  ['composio', 'GMAIL_FETCH_EMAILS', 'read'],
  ['composio', 'GMAIL_DELETE_MESSAGE', 'delete'],
  ['composio', 'GMAIL_REPLY_TO_THREAD', 'send'],
  ['composio', 'SLACK_SENDS_A_MESSAGE_TO_A_SLACK_CHANNEL', 'send'],
  ['composio', 'SLACK_LIST_ALL_SLACK_TEAM_CHANNELS', 'read'],
  ['composio', 'JIRA_TRANSITION_ISSUE', 'prod_change'],
  ['composio', 'GITHUB_MERGE_A_PULL_REQUEST', 'prod_change'],
  ['composio', 'GITHUB_LIST_COMMITS', 'read'],
  ['composio', 'GITHUB_DELETE_A_REPOSITORY', 'delete'],
  ['composio', 'GITHUB_GET_A_REPOSITORY', 'read'],
  ['composio', 'TWITTER_CREATION_OF_A_POST', 'publish'],
  ['composio', 'SHOPIFY_CREATE_DRAFT_ORDER', 'draft'],
  ['composio', 'STRIPE_CREATE_CHARGE', 'purchase'],
  // Slack
  ['slack', 'slack_send_message', 'send'],
  ['slack', 'slack_send_message_draft', 'draft'],
  ['slack', 'slack_read_channel', 'read'],
  ['slack', 'slack_search_users', 'read'],
  ['slack', 'postMessage', 'send'],
  ['slack', 'post_message', 'send'],
  ['slack', 'slack_add_reaction', 'unknown'],
  ['slack', 'slack_schedule_message', 'unknown'],
  // Jira
  ['jira', 'getJiraIssue', 'read'],
  ['jira', 'searchJiraIssuesUsingJql', 'read'],
  ['jira', 'lookupJiraAccountId', 'read'],
  ['jira', 'transitionJiraIssue', 'prod_change'],
  ['jira', 'createJiraIssue', 'unknown'],
  ['jira', 'addCommentToJiraIssue', 'unknown'],
  // GitHub
  ['github', 'list_pull_requests', 'read'],
  ['github', 'get_file_contents', 'read'],
  ['github', 'merge_pull_request', 'prod_change'],
  ['github', 'push_files', 'prod_change'],
  ['github', 'create_release', 'prod_change'],
  ['github', 'create_issue', 'unknown'],
  ['github', 'delete_branch', 'delete'],
  ['github', 'search_code', 'read'],
  // Publishing / purchases / credentials / prod
  ['x', 'tweet', 'publish'],
  ['linkedin', 'share_post', 'publish'],
  ['blog', 'publish_article', 'publish'],
  ['shop', 'purchase_item', 'purchase'],
  ['shop', 'checkout', 'purchase'],
  ['shop', 'list_orders', 'read'],
  ['shop', 'get_order', 'read'],
  ['pay', 'pay_invoice', 'purchase'],
  ['vault', 'get_secret', 'credential'],
  ['vault', 'rotate_api_key', 'credential'],
  ['auth', 'refresh_oauth_token', 'credential'],
  ['auth', 'set_password', 'credential'],
  ['ops', 'deploy_service', 'prod_change'],
  ['ops', 'rollback_release', 'prod_change'],
  ['db', 'drop_table', 'delete'],
  ['db', 'purge_cache', 'delete'],
  ['db', 'query_database', 'read'],
  ['db', 'describe_table', 'read'],
  // Filesystem
  ['filesystem', 'read_file', 'read'],
  ['filesystem', 'read_text_file', 'read'],
  ['filesystem', 'list_directory', 'read'],
  ['filesystem', 'search_files', 'read'],
  ['filesystem', 'get_file_info', 'read'],
  ['filesystem', 'write_file', 'unknown'],
  ['filesystem', 'move_file', 'unknown'],
  ['filesystem', 'remove_file', 'delete'],
  // Browser
  ['browser', 'browser_snapshot', 'read'],
  ['browser', 'browser_take_screenshot', 'read'],
  ['browser', 'browser_click', 'unknown'],
  ['browser', 'browser_type', 'unknown'],
  ['browser', 'browser_type_secret', 'credential'],
  ['browser', 'browser_navigate', 'unknown'],
  // Nothing recognisable
  ['misc', 'frobnicate', 'unknown'],
];

test('classifyToolRisk table: realistic tool names across servers', () => {
  for (const [server, tool, expected] of RISK_TABLE) {
    assert.equal(classifyToolRisk({ server, tool }), expected, `${server}/${tool}`);
  }
});

test('classifyToolRisk: annotations win over names, descriptions fill gaps', () => {
  assert.equal(classifyToolRisk({ server: 's', tool: 'send_message', annotations: { readOnlyHint: true } }), 'read');
  assert.equal(classifyToolRisk({ server: 's', tool: 'get_thing', annotations: { destructiveHint: true } }), 'delete');
  assert.equal(
    classifyToolRisk({ server: 's', tool: 'get_thing', annotations: { destructiveHint: true, readOnlyHint: true } }),
    'delete',
  );
  assert.equal(classifyToolRisk({ server: 's', tool: 'run', description: 'Sends an email to a recipient.' }), 'send');
  assert.equal(classifyToolRisk({ server: 's', tool: 'run', description: 'Lists all projects. Does not delete.' }), 'read');
  assert.equal(classifyToolRisk({ server: 's', tool: 'run', description: 'Does something mysterious' }), 'unknown');
});

// ---------------------------------------------------------------------------

test('rules: bot scope beats global, then priority, then deny > ask > allow; expired skipped', async () => {
  await withDatabase((botId) => {
    const req = call('jira', 'getJiraIssue');
    rules.create({ scope: 'global', match: { server: 'jira' }, decision: 'deny', priority: 100 });
    const bot = rules.create({ scope: 'bot', botId, match: { tool: 'getJira*' }, decision: 'allow', priority: 1 });
    assert.equal(rules.match(botId, req, 'read')?.rule_id, bot.rule_id, 'bot scope beats a higher-priority global');

    const hi = rules.create({ scope: 'bot', botId, match: { server: 'jira' }, decision: 'ask', priority: 5 });
    assert.equal(rules.match(botId, req, 'read')?.rule_id, hi.rule_id, 'higher priority wins within a scope');

    const tie = rules.create({ scope: 'bot', botId, match: { server: 'jira' }, decision: 'deny', priority: 5 });
    assert.equal(rules.match(botId, req, 'read')?.rule_id, tie.rule_id, 'deny beats ask on ties');

    botRulesDb.update(tie.rule_id, { expiresAt: new Date(Date.now() - 1000).toISOString() });
    assert.equal(rules.match(botId, req, 'read')?.rule_id, hi.rule_id, 'expired rule is skipped');

    // Other bot is unaffected by bot-scoped rules.
    const other = missionControlDb.createSection({ title: 'Other', produce_prompt: 'Go' });
    assert.equal(rules.match(other.section_id, req, 'read')?.scope, 'global');
  });
});

test('rules: match on server, tool glob, risk list and args predicates', async () => {
  await withDatabase((botId) => {
    rules.create({
      scope: 'bot',
      botId,
      decision: 'allow',
      match: {
        server: 'slack',
        tool: '*_message',
        risk: ['send'],
        args: [
          { path: 'channel.name', op: 'in', value: ['ops', 'dev'] },
          { path: 'text', op: 'contains', value: 'standup' },
          { path: 'text', op: 'regex', value: '^Daily' },
          { path: 'thread', op: 'eq', value: 7 },
        ],
      },
    });
    const good = { channel: { name: 'ops' }, text: 'Daily standup notes', thread: 7 };
    assert.ok(rules.match(botId, call('slack', 'slack_send_message', good), 'send'));
    assert.equal(rules.match(botId, call('slack', 'slack_send_message', { ...good, thread: 8 }), 'send'), null);
    assert.equal(rules.match(botId, call('slack', 'slack_send_message', { ...good, channel: { name: 'x' } }), 'send'), null);
    assert.equal(rules.match(botId, call('slack', 'slack_send_message', good), 'read'), null, 'risk mismatch');
    assert.equal(rules.match(botId, call('slack', 'slack_send_thing', good), 'send'), null, 'glob mismatch');
    assert.equal(rules.match(botId, call('gmail', 'slack_send_message', good), 'send'), null, 'server mismatch');
    assert.equal(rules.match(botId, call('slack', 'slack_send_message', { ...good, text: 'Daily' }), 'send'), null);
  });
});

test('evaluate: defaults, floor, and global allow cannot loosen a floor risk', async () => {
  await withDatabase(async (botId) => {
    const ctx = ctxFor(botId);
    const read = await actionGate.evaluate(ctx, call('gmail', 'get_thread'));
    assert.deepEqual([read.decision, read.decidedBy, read.risk], ['allow', 'default', 'read']);
    const draft = await actionGate.evaluate(ctx, call('gmail', 'create_draft'));
    assert.equal(draft.decision, 'allow');

    const send = await actionGate.evaluate(ctx, call('gmail', 'send_message'));
    assert.deepEqual([send.decision, send.decidedBy], ['ask', 'floor']);
    const unknown = await actionGate.evaluate(ctx, call('misc', 'frobnicate'));
    assert.equal(unknown.decision, 'ask');

    const globalAllow = rules.create({ scope: 'global', match: { server: 'gmail' }, decision: 'allow', priority: 50 });
    const stillAsk = await actionGate.evaluate(ctx, call('gmail', 'send_message'));
    assert.deepEqual([stillAsk.decision, stillAsk.decidedBy], ['ask', 'floor']);

    // A global deny still applies.
    rules.update(globalAllow.rule_id, { decision: 'deny' });
    const denied = await actionGate.evaluate(ctx, call('gmail', 'send_message'));
    assert.deepEqual([denied.decision, denied.decidedBy], ['deny', `rule:${globalAllow.rule_id}`]);
    rules.delete(globalAllow.rule_id);

    // Bot-scoped always_allow_click and manual rules can loosen it; other provenance cannot.
    const click = rules.create({
      scope: 'bot', botId, match: { server: 'gmail', tool: 'send_message' }, decision: 'allow', createdFrom: 'always_allow_click',
    });
    const loosened = await actionGate.evaluate(ctx, call('gmail', 'send_message'));
    assert.deepEqual([loosened.decision, loosened.decidedBy], ['allow', `rule:${click.rule_id}`]);
    rules.delete(click.rule_id);
    const manual = rules.create({ scope: 'bot', botId, match: { server: 'gmail' }, decision: 'allow', createdFrom: 'manual' });
    assert.equal((await actionGate.evaluate(ctx, call('gmail', 'send_message'))).decision, 'allow');
    rules.delete(manual.rule_id);
    rules.create({ scope: 'bot', botId, match: { server: 'gmail' }, decision: 'allow', createdFrom: 'reflector' });
    assert.equal((await actionGate.evaluate(ctx, call('gmail', 'send_message'))).decidedBy, 'floor');

    // Every verdict is persisted and carries its id.
    const row = botGateDecisionsDb.get(read.decisionId);
    assert.equal(row?.tool, 'get_thread');
    assert.equal(row?.decided_by, 'default');
    assert.ok(botGateDecisionsDb.listForBot(botId).length >= 8);
  });
});

test('evaluate: taint forces ask for floor risks unless the rule allows tainted', async () => {
  await withDatabase(async (botId) => {
    const tainted = ctxFor(botId, { tainted: true });
    const rule = rules.create({
      scope: 'bot', botId, match: { server: 'gmail', tool: 'send_message' }, decision: 'allow', createdFrom: 'always_allow_click',
    });
    const asked = await actionGate.evaluate(tainted, call('gmail', 'send_message'));
    assert.deepEqual([asked.decision, asked.decidedBy], ['ask', 'taint']);
    assert.equal((await actionGate.evaluate(ctxFor(botId), call('gmail', 'send_message'))).decision, 'allow');

    rules.update(rule.rule_id, { match: { server: 'gmail', tool: 'send_message', allow_when_tainted: true } });
    const ok = await actionGate.evaluate(tainted, call('gmail', 'send_message'));
    assert.deepEqual([ok.decision, ok.decidedBy], ['allow', `rule:${rule.rule_id}`]);

    // Reads stay allowed while tainted.
    assert.equal((await actionGate.evaluate(tainted, call('gmail', 'get_thread'))).decision, 'allow');
  });
});

test('evaluate: auto-reviewer approves allowed unknown-risk calls, fails closed otherwise', async () => {
  await withDatabase(async (botId) => {
    const seen: string[] = [];
    rules.create({ scope: 'bot', botId, match: { server: 'misc' }, decision: 'allow' });
    setAutoReviewer(async (_ctx, req, risk) => {
      seen.push(`${req.tool}:${risk}`);
      return { ok: true, reason: 'fits the task' };
    });
    const approved = await actionGate.evaluate(ctxFor(botId), call('misc', 'frobnicate'));
    assert.deepEqual([approved.decision, approved.decidedBy, approved.reason], ['allow', 'reviewer', 'fits the task']);
    assert.deepEqual(seen, ['frobnicate:unknown']);

    // Not called for plain reads or floor asks.
    await actionGate.evaluate(ctxFor(botId), call('gmail', 'get_thread'));
    await actionGate.evaluate(ctxFor(botId), call('gmail', 'send_message'));
    assert.equal(seen.length, 1);

    setAutoReviewer(async () => ({ ok: false, reason: 'not asked for' }));
    const rejected = await actionGate.evaluate(ctxFor(botId), call('misc', 'frobnicate'));
    assert.deepEqual([rejected.decision, rejected.decidedBy, rejected.reason], ['ask', 'reviewer', 'not asked for']);

    setAutoReviewer(async () => {
      throw new Error('boom');
    });
    const thrown = await actionGate.evaluate(ctxFor(botId), call('misc', 'frobnicate'));
    assert.deepEqual([thrown.decision, thrown.decidedBy], ['ask', 'reviewer']);

    setAutoReviewer(() => new Promise(() => undefined), { timeoutMs: 30 });
    const timedOut = await actionGate.evaluate(ctxFor(botId), call('misc', 'frobnicate'));
    assert.deepEqual([timedOut.decision, timedOut.decidedBy], ['ask', 'reviewer']);
    assert.match(timedOut.reason, /timed out/);

    // Tainted drafts go through the reviewer too.
    setAutoReviewer(async () => ({ ok: false, reason: 'tainted draft' }));
    const draft = await actionGate.evaluate(ctxFor(botId, { tainted: true }), call('gmail', 'create_draft'));
    assert.deepEqual([draft.decision, draft.decidedBy], ['ask', 'reviewer']);
  });
});

test('budgets: hard limit denies, soft ratio flags, actions count executed decisions, wake rate', async () => {
  await withDatabase(async (botId) => {
    assert.deepEqual(budgets.check(botId), { ok: true, soft: false });
    budgets.put(botId, { dailyUsd: 10, softRatio: 0.5 });
    assert.equal(budgets.get(botId)?.daily_usd, 10);

    const run = (cost: number) => {
      const created = runsDb.create({ source: 'mission_control', meta: { section_id: botId } });
      runsDb.attachUsage(created.run_id, { costUsdEstimate: cost });
    };
    // A run for another bot must not count.
    const foreign = runsDb.create({ source: 'mission_control', meta: { section_id: 'other' } });
    runsDb.attachUsage(foreign.run_id, { costUsdEstimate: 99 });

    run(6);
    const soft = budgets.check(botId);
    assert.equal(soft.ok, true);
    assert.equal(soft.soft, true);
    const verdict = await actionGate.evaluate(ctxFor(botId), call('gmail', 'get_thread'));
    assert.equal(verdict.decision, 'allow');
    assert.equal(verdict.soft, true);

    run(5);
    const hard = await actionGate.evaluate(ctxFor(botId), call('gmail', 'get_thread'));
    assert.deepEqual([hard.decision, hard.decidedBy], ['deny', 'budget']);
    assert.match(hard.reason, /daily spend/);
    assert.equal(botGateDecisionsDb.get(hard.decisionId)?.outcome, 'denied');

    // Monthly and action limits.
    budgets.put(botId, { dailyUsd: null, monthlyUsd: 5 });
    assert.equal(budgets.check(botId).ok, false);
    budgets.put(botId, { monthlyUsd: null, dailyActions: 2 });
    assert.equal(budgets.check(botId).ok, true);
    const a = await actionGate.evaluate(ctxFor(botId), call('gmail', 'get_thread'));
    const b = await actionGate.evaluate(ctxFor(botId), call('gmail', 'get_thread'));
    actionGate.recordOutcome(a.decisionId, 'executed');
    assert.equal(budgets.check(botId).ok, true);
    actionGate.recordOutcome(b.decisionId, 'executed');
    assert.equal(budgets.check(botId).ok, false);
    assert.equal((await actionGate.evaluate(ctxFor(botId), call('gmail', 'get_thread'))).decidedBy, 'budget');

    // Wakes per hour.
    botBudgetsDb.put(botId, { maxWakesPerHour: 2 });
    assert.equal(wakeAllowed(botId), true);
    botEpisodesDb.create({ botId });
    botEpisodesDb.create({ botId });
    assert.equal(wakeAllowed(botId), false);
    assert.equal(budgets.wakeAllowed(botId, new Date(Date.now() + 2 * 3_600_000)), true);
  });
});

test('evaluate: dry run denies everything except read and draft', async () => {
  await withDatabase(async (botId) => {
    missionControlDb.updateSection(botId, { dry_run: true });
    const ctx = ctxFor(botId);
    assert.equal((await actionGate.evaluate(ctx, call('gmail', 'get_thread'))).decision, 'allow');
    assert.equal((await actionGate.evaluate(ctx, call('gmail', 'create_draft'))).decision, 'allow');
    for (const tool of ['send_message', 'trash_message', 'frobnicate']) {
      const verdict = await actionGate.evaluate(ctx, call('gmail', tool));
      assert.deepEqual([verdict.decision, verdict.decidedBy], ['deny', 'dry_run'], tool);
    }
    // Even an explicit allow rule cannot override dry run.
    rules.create({ scope: 'bot', botId, match: { server: 'gmail' }, decision: 'allow' });
    assert.equal((await actionGate.evaluate(ctx, call('gmail', 'send_message'))).decidedBy, 'dry_run');
  });
});

test('evaluate: section tool_policy_json keeps working as implicit bot rules', async () => {
  await withDatabase(async (botId) => {
    missionControlDb.updateSection(botId, {
      tool_policy: { jira: { createJiraIssue: 'allow', 'delete*': 'deny' }, gmail: { send_message: 'allow' } },
    });
    setAutoReviewer(async () => ({ ok: true, reason: 'ok' }));
    const ctx = ctxFor(botId);
    // Unknown risk: the policy allow is provisional, the (fake) reviewer confirms it.
    const allowed = await actionGate.evaluate(ctx, call('jira', 'createJiraIssue'));
    assert.deepEqual([allowed.decision, allowed.decidedBy], ['allow', 'reviewer']);
    // The same tool without the policy would have asked outright.
    assert.equal((await actionGate.evaluate(ctx, call('jira', 'editJiraIssue'))).decidedBy, 'default');

    missionControlDb.updateSection(botId, {
      tool_policy: { jira: { createJiraIssue: 'allow', 'delete*': 'deny', getJiraIssue: 'ask' }, gmail: { send_message: 'allow' } },
    });
    const asked = await actionGate.evaluate(ctx, call('jira', 'getJiraIssue'));
    assert.deepEqual([asked.decision, asked.decidedBy], ['ask', 'rule:policy:jira:getJiraIssue']);

    const denied = await actionGate.evaluate(ctx, call('jira', 'delete_issue'));
    assert.equal(denied.decision, 'deny');

    // Manual bot-scoped policy may loosen the floor, like a manual rule.
    assert.equal((await actionGate.evaluate(ctx, call('gmail', 'send_message'))).decision, 'allow');

    // A real bot rule at the same priority: deny wins the tie.
    rules.create({ scope: 'bot', botId, match: { server: 'jira', tool: 'createJiraIssue' }, decision: 'deny' });
    assert.equal((await actionGate.evaluate(ctx, call('jira', 'createJiraIssue'))).decision, 'deny');
  });
});

// ---------------------------------------------------------------------------

async function askedDecision(botId: string, tool = 'send_message'): Promise<string> {
  const verdict = await actionGate.evaluate(ctxFor(botId), call('gmail', tool, { to: 'a@b.c', token: 'sk-secret-value-123456' }));
  assert.equal(verdict.decision, 'ask');
  return verdict.decisionId;
}

function activeInterrupt(decisionId: string) {
  const row = botGateDecisionsDb.get(decisionId);
  assert.ok(row?.interrupt_id, 'decision links its interrupt');
  const interrupt = interruptsDb.get(row.interrupt_id);
  assert.ok(interrupt);
  return interrupt;
}

test('awaitHuman: approve_once resolves approved via interrupt action, no rule created', async () => {
  await withDatabase(async (botId) => {
    initBotGate();
    const decisionId = await askedDecision(botId);
    const pending = actionGate.awaitHuman(decisionId, { timeoutMs: 5_000 });
    const interrupt = activeInterrupt(decisionId);
    assert.equal(interrupt.kind, 'bot_gate');
    assert.equal(interrupt.title, 'Inbox bot wants to send_message');
    assert.equal(interrupt.href, `/bots/b/${botId}/overview`);
    assert.deepEqual(interrupt.actions.map((action) => action.id), ['approve_once', 'always_allow', 'deny']);
    assert.deepEqual(interrupt.meta, { botId, decisionId, dedupeKey: `bot_gate:${decisionId}` });
    assert.match(interrupt.body, /gmail/);
    assert.match(interrupt.body, /send_message/);

    interruptsService.act(interrupt.interrupt_id, { key: 'approve_once' });
    assert.equal(await pending, 'approved');
    assert.equal(botGateDecisionsDb.get(decisionId)?.outcome, 'approved');
    assert.equal(rules.list({ botId }).length, 0);
    assert.equal(interruptsDb.get(interrupt.interrupt_id)?.status, 'resolved');
  });
});

test('awaitHuman: always_allow creates a bot-scoped always_allow_click rule', async () => {
  await withDatabase(async (botId) => {
    initBotGate();
    const decisionId = await askedDecision(botId);
    const pending = actionGate.awaitHuman(decisionId, { timeoutMs: 5_000 });
    interruptsService.act(activeInterrupt(decisionId).interrupt_id, { key: 'always_allow' });
    assert.equal(await pending, 'approved');

    const [rule] = rules.list({ botId });
    assert.equal(rule.scope, 'bot');
    assert.equal(rule.created_from, 'always_allow_click');
    assert.equal(rule.decision, 'allow');
    assert.deepEqual(rule.match, { server: 'gmail', tool: 'send_message' });
    const next = await actionGate.evaluate(ctxFor(botId), call('gmail', 'send_message'));
    assert.deepEqual([next.decision, next.decidedBy], ['allow', `rule:${rule.rule_id}`]);
  });
});

test('awaitHuman: deny resolves rejected', async () => {
  await withDatabase(async (botId) => {
    initBotGate();
    const decisionId = await askedDecision(botId);
    const pending = actionGate.awaitHuman(decisionId, { timeoutMs: 5_000 });
    interruptsService.act(activeInterrupt(decisionId).interrupt_id, { key: 'deny' });
    assert.equal(await pending, 'rejected');
    assert.equal(botGateDecisionsDb.get(decisionId)?.outcome, 'rejected');
    assert.equal(rules.list({ botId }).length, 0);
  });
});

test('awaitHuman: timeout expires the decision and the interrupt', async () => {
  await withDatabase(async (botId) => {
    initBotGate();
    const decisionId = await askedDecision(botId);
    const outcome = await actionGate.awaitHuman(decisionId, { timeoutMs: 50 });
    assert.equal(outcome, 'expired');
    assert.equal(botGateDecisionsDb.get(decisionId)?.outcome, 'expired');
    assert.equal(activeInterrupt(decisionId).status, 'expired');
    assert.equal(interruptsService.countOpen(), 0);
  });
});

test('awaitHuman: DB polling fallback resolves when no resolver is configured', async () => {
  await withDatabase(async (botId) => {
    setGateHumanPollInterval(20);
    // Resolver deliberately not wired: act() closes the interrupt, the poller reads it.
    const decisionId = await askedDecision(botId);
    const pending = actionGate.awaitHuman(decisionId, { timeoutMs: 5_000 });
    interruptsService.act(activeInterrupt(decisionId).interrupt_id, { key: 'always_allow' });
    assert.equal(await pending, 'approved');
    assert.equal(rules.list({ botId })[0]?.created_from, 'always_allow_click');

    // A decision settled straight in the DB also releases the waiter.
    const second = await askedDecision(botId, 'trash_message');
    const waiting = actionGate.awaitHuman(second, { timeoutMs: 5_000 });
    botGateDecisionsDb.recordOutcome(second, 'rejected');
    assert.equal(await waiting, 'rejected');
  });
});

test('resolveBotGateDecision is idempotent and recordOutcome stamps execution', async () => {
  await withDatabase(async (botId) => {
    const decisionId = await askedDecision(botId);
    resolveBotGateDecision(decisionId, 'approved', { alwaysAllow: true });
    resolveBotGateDecision(decisionId, 'rejected');
    resolveBotGateDecision(decisionId, 'approved', { alwaysAllow: true });
    assert.equal(botGateDecisionsDb.get(decisionId)?.outcome, 'approved');
    assert.equal(rules.list({ botId }).length, 1);
    actionGate.recordOutcome(decisionId, 'executed');
    const row = botGateDecisionsDb.get(decisionId);
    assert.equal(row?.outcome, 'executed');
    assert.ok(row?.resolved_at);
  });
});

test('interrupts act(): bot_gate keys route through the registered resolver, and reject unknown keys', async () => {
  await withDatabase(async (botId) => {
    const calls: unknown[] = [];
    interruptsService.configureBotGateResolver((decisionId, decision, options) => {
      calls.push([decisionId, decision, options.alwaysAllow]);
    });
    const make = (id: string) =>
      interruptsService.create({ kind: 'bot_gate', title: 't', meta: { botId, decisionId: id }, dedupeKey: `bot_gate:${id}` });
    for (const [key, expected] of [
      ['approve_once', ['d1', 'approved', false]],
      ['always_allow', ['d2', 'approved', true]],
      ['deny', ['d3', 'rejected', false]],
    ] as const) {
      const id = expected[0];
      const resolved = interruptsService.act(make(id).interrupt_id, { key });
      assert.equal(resolved.status, 'resolved');
      assert.equal(resolved.resolution, key);
      assert.deepEqual(calls.at(-1), expected);
    }
    assert.throws(() => interruptsService.act(make('d4').interrupt_id, { key: 'nope' }), /Unsupported interrupt action/);
    const noMeta = interruptsService.create({ kind: 'bot_gate', title: 'x', dedupeKey: 'bot_gate:none' });
    assert.throws(() => interruptsService.act(noMeta.interrupt_id, { key: 'deny' }), /no longer active/);
    assert.ok(getConnection());
  });
});
