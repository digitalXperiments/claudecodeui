import assert from 'node:assert/strict';
import test from 'node:test';

import type { BotBudgetStatus, BotRule } from '../../../../types/botRuntime';

import {
  budgetDraftFromBudget,
  budgetInputFromDraft,
  budgetMeters,
  budgetStateText,
  canClassifyTool,
  cleanRoutes,
  decidedByLabel,
  describeEnforcement,
  draftFromRule,
  emptyRuleDraft,
  expiresAtFromChoice,
  floorCheck,
  formatUsd,
  groupCredentials,
  isPendingAsk,
  matchFromDraft,
  meter,
  moveRoute,
  normalizeServerKey,
  parsePredicateValue,
  parseScalar,
  routesEqual,
  ruleInputFromDraft,
  rulePatchFromDraft,
  sortRules,
  summarizePredicate,
  summarizeRuleMatch,
  validateCredentialInput,
  validateRoutes,
  validateRuleDraft,
} from './ruleHelpers';

const rule = (overrides: Partial<BotRule> = {}): BotRule => ({
  rule_id: 'r1', scope: 'bot', bot_id: 'b1', match: {}, decision: 'ask', priority: 0, created_from: 'manual', note: '',
  expires_at: null, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', ...overrides,
});

test('summarizeRuleMatch describes target, risks and predicates', () => {
  assert.deepEqual(summarizeRuleMatch({}), { target: 'any tool', risks: [], predicates: [], allowWhenTainted: false, matchesEverything: true });
  assert.equal(summarizeRuleMatch({ server: 'jira' }).target, 'jira · any tool');
  assert.equal(summarizeRuleMatch({ tool: 'send_*' }).target, 'any server · send_*');
  const full = summarizeRuleMatch({
    server: 'gmail', tool: 'send_email', risk: ['send'], allow_when_tainted: true,
    args: [{ path: 'to', op: 'contains', value: '@eyewa.com' }, { path: 'cc', op: 'in', value: ['a', 'b'] }, { path: 'subject', op: 'regex', value: '^Re:' }, { path: 'draft', op: 'eq', value: true }],
  });
  assert.equal(full.target, 'gmail · send_email');
  assert.deepEqual(full.risks, ['send']);
  assert.deepEqual(full.predicates, ['to contains "@eyewa.com"', 'cc in [a, b]', 'subject matches /^Re:/', 'draft = true']);
  assert.equal(full.allowWhenTainted, true);
  assert.equal(full.matchesEverything, false);
  assert.equal(summarizePredicate({ path: 'n', op: 'eq', value: 5 }), 'n = 5');
  assert.equal(summarizeRuleMatch(undefined).target, 'any tool');
});

test('sortRules puts bot rules first, then by priority', () => {
  const sorted = sortRules([
    rule({ rule_id: 'g', scope: 'global', bot_id: null, priority: 50 }),
    rule({ rule_id: 'low', priority: 1 }),
    rule({ rule_id: 'high', priority: 9 }),
  ]);
  assert.deepEqual(sorted.map((r) => r.rule_id), ['high', 'low', 'g']);
});

test('floorCheck warns loudly for bot allow on the floor and blocks global allow on it', () => {
  assert.equal(floorCheck({ scope: 'bot', decision: 'ask', risks: ['send'] }).level, 'none');
  assert.equal(floorCheck({ scope: 'bot', decision: 'deny', risks: [] }).level, 'none');
  const warn = floorCheck({ scope: 'bot', decision: 'allow', risks: ['send', 'read'] });
  assert.equal(warn.level, 'warn');
  assert.match(warn.message ?? '', /send/);
  assert.match(warn.message ?? '', /WITHOUT asking/);
  assert.equal(floorCheck({ scope: 'bot', decision: 'allow', risks: [] }).level, 'warn');
  assert.equal(floorCheck({ scope: 'bot', decision: 'allow', risks: ['read'] }).level, 'none');
  assert.equal(floorCheck({ scope: 'bot', decision: 'allow', risks: ['read'], classifiedFloor: true }).level, 'warn');
  assert.equal(floorCheck({ scope: 'global', decision: 'allow', risks: ['delete'] }).level, 'blocked');
  assert.equal(floorCheck({ scope: 'global', decision: 'allow', risks: [] }).level, 'info');
  assert.equal(floorCheck({ scope: 'global', decision: 'allow', risks: ['read', 'draft'] }).level, 'none');
});

test('parseScalar and parsePredicateValue type values like the gate compares them', () => {
  assert.equal(parseScalar('5'), 5);
  assert.equal(parseScalar('true'), true);
  assert.equal(parseScalar('null'), null);
  assert.equal(parseScalar('"5"'), '5');
  assert.equal(parseScalar('hello world'), 'hello world');
  assert.deepEqual(parsePredicateValue('in', 'a, 2, "3", '), ['a', 2, '3']);
  assert.equal(parsePredicateValue('regex', '^\\d+$'), '^\\d+$');
  assert.equal(parsePredicateValue('contains', 'x'), 'x');
});

test('rule drafts round-trip through match and API input', () => {
  const existing = rule({
    decision: 'allow', priority: 3, note: 'ok', expires_at: '2026-12-01T00:00:00.000Z',
    match: { server: 'jira', tool: 'transition_*', risk: ['draft'], args: [{ path: 'project', op: 'in', value: ['A', 'B'] }], allow_when_tainted: true },
  });
  const draft = draftFromRule(existing);
  assert.equal(draft.expiry, 'keep');
  assert.equal(draft.predicates[0].value, 'A, B');
  assert.deepEqual(matchFromDraft(draft), existing.match);
  const patch = rulePatchFromDraft(draft, existing, 0);
  assert.equal(patch.expiresAt, '2026-12-01T00:00:00.000Z');
  assert.equal(patch.priority, 3);
  assert.deepEqual(rulePatchFromDraft({ ...draft, expiry: 'never', priority: '' }, existing, 0), { decision: 'allow', match: existing.match, priority: 0, note: 'ok', expiresAt: null });

  const created = ruleInputFromDraft({ ...emptyRuleDraft('bot'), decision: 'deny', tool: ' delete_* ', expiry: '1h', priority: '5', note: ' n ' }, 'b1', Date.parse('2026-01-01T00:00:00Z'));
  assert.deepEqual(created, { scope: 'bot', botId: 'b1', decision: 'deny', match: { tool: 'delete_*' }, priority: 5, note: 'n', expiresAt: '2026-01-01T01:00:00.000Z' });
  assert.equal('botId' in ruleInputFromDraft(emptyRuleDraft('global'), null), false);
  assert.equal(expiresAtFromChoice('keep', 'x'), 'x');
  assert.equal(expiresAtFromChoice('never', 'x'), null);
});

test('validateRuleDraft catches the mistakes the server would reject', () => {
  const base = emptyRuleDraft('bot');
  assert.equal(validateRuleDraft(base), null);
  assert.match(validateRuleDraft({ ...base, priority: '5000' }) ?? '', /Priority/);
  assert.match(validateRuleDraft({ ...base, priority: '1.5' }) ?? '', /Priority/);
  assert.match(validateRuleDraft({ ...base, predicates: [{ path: '', op: 'eq', value: 'x' }] }) ?? '', /path/);
  assert.match(validateRuleDraft({ ...base, predicates: [{ path: 'a', op: 'regex', value: '(' }] }) ?? '', /regular expression/);
  assert.match(validateRuleDraft({ ...base, predicates: [{ path: 'a', op: 'in', value: ' , ' }] }) ?? '', /at least one value/);
  assert.match(validateRuleDraft({ ...base, predicates: [{ path: 'a', op: 'contains', value: '' }] }) ?? '', /needs a value/);
  assert.match(validateRuleDraft({ ...base, note: 'x'.repeat(501) }) ?? '', /Note/);
  assert.match(validateRuleDraft({ ...emptyRuleDraft('global'), decision: 'allow', risks: ['send'] }) ?? '', /global allow/);
  assert.equal(validateRuleDraft({ ...base, decision: 'allow', risks: ['send'] }), null, 'a bot allow on the floor is allowed, with a warning');
});

test('canClassifyTool skips blanks and globs', () => {
  assert.equal(canClassifyTool('send_email'), true);
  assert.equal(canClassifyTool('send_*'), false);
  assert.equal(canClassifyTool('  '), false);
});

test('meter computes tone and clamps the bar', () => {
  assert.deepEqual(meter(1, null, 0.8), { used: 1, cap: null, ratio: 0, percent: 0, tone: 'none' });
  assert.equal(meter(1, 10, 0.8).tone, 'ok');
  assert.equal(meter(8, 10, 0.8).tone, 'soft');
  assert.equal(meter(10, 10, 0.8).tone, 'hard');
  const over = meter(25, 10, 0.8);
  assert.equal(over.ratio, 1);
  assert.equal(over.percent, 250);
  assert.equal(meter(0, 0, 0.8).tone, 'hard');
  assert.equal(meter(2, 4, 0.5).tone, 'soft');
});

test('formatUsd rounds sensibly', () => {
  assert.equal(formatUsd(0), '$0.00');
  assert.equal(formatUsd(0.004), '<$0.01');
  assert.equal(formatUsd(1.256), '$1.26');
  assert.equal(formatUsd(250.4), '$250');
});

const status = (overrides: Partial<BotBudgetStatus> = {}): BotBudgetStatus => ({
  budget: { bot_id: 'b', daily_usd: 5, monthly_usd: 50, daily_actions: null, max_wakes_per_hour: 6, soft_ratio: 0.8, updated_at: '' },
  check: { ok: true, soft: false },
  spend: { today_usd: 4.5, month_usd: 10, actions_today: 3, wakes_last_hour: 6 },
  wake_allowed: true,
  ...overrides,
});

test('budgetMeters and budgetStateText reflect the status', () => {
  const rows = budgetMeters(status());
  assert.deepEqual(rows.map((r) => [r.id, r.meter.tone]), [['daily_usd', 'soft'], ['monthly_usd', 'ok'], ['daily_actions', 'none'], ['wakes', 'hard']]);
  assert.equal(rows[0].format(rows[0].meter.used), '$4.50');
  assert.equal(budgetMeters(status({ budget: null }))[0].meter.tone, 'none');
  assert.deepEqual(budgetStateText(status()), { tone: 'ok', text: 'Within budget.' });
  assert.equal(budgetStateText(status({ budget: null })).text, 'No limits set.');
  assert.equal(budgetStateText(status({ check: { ok: true, soft: true, reason: 'near cap' } })).tone, 'soft');
  assert.equal(budgetStateText(status({ wake_allowed: false })).tone, 'hard');
  assert.equal(budgetStateText(status({ check: { ok: false, soft: false, reason: 'daily cap' } })).text, 'daily cap');
});

test('budget draft converts to an input with null for no limit', () => {
  assert.deepEqual(budgetDraftFromBudget(null), { dailyUsd: '', monthlyUsd: '', dailyActions: '', maxWakes: '', softPercent: '80' });
  assert.deepEqual(
    budgetInputFromDraft({ dailyUsd: '5', monthlyUsd: '', dailyActions: '20', maxWakes: '', softPercent: '90' }),
    { daily_usd: 5, monthly_usd: null, daily_actions: 20, max_wakes_per_hour: null, soft_ratio: 0.9 },
  );
  const base = { dailyUsd: '', monthlyUsd: '', dailyActions: '', maxWakes: '', softPercent: '80' };
  assert.deepEqual(budgetInputFromDraft({ ...base, dailyUsd: '-1' }), { error: 'Daily spend must be a number of 0 or more, or empty for no limit.' });
  assert.deepEqual(budgetInputFromDraft({ ...base, dailyActions: '1.5' }), { error: 'Daily actions must be a whole number.' });
  assert.deepEqual(budgetInputFromDraft({ ...base, softPercent: '0' }), { error: 'Soft limit must be between 1 and 100 percent.' });
  assert.deepEqual(budgetInputFromDraft({ ...base, dailyUsd: '10', monthlyUsd: '5' }), { error: 'The daily spend limit is higher than the monthly one.' });
  assert.deepEqual(budgetDraftFromBudget(status().budget), { dailyUsd: '5', monthlyUsd: '50', dailyActions: '', maxWakes: '6', softPercent: '80' });
});

test('gate log helpers', () => {
  assert.equal(isPendingAsk({ decision: 'ask', outcome: null }), true);
  assert.equal(isPendingAsk({ decision: 'ask', outcome: 'approved' }), false);
  assert.equal(isPendingAsk({ decision: 'allow', outcome: null }), false);
  assert.equal(decidedByLabel('floor'), 'safety floor');
  assert.equal(decidedByLabel('rule:abcdef123456'), 'rule abcdef12');
  assert.equal(decidedByLabel('some_thing'), 'some thing');
});

test('credential input validation mirrors the vault naming convention', () => {
  assert.equal(normalizeServerKey('jira-cloud'), 'JIRA_CLOUD');
  assert.equal(normalizeServerKey('--'), '');
  assert.equal(validateCredentialInput({ server: 'jira-cloud', key: 'JIRA_API_TOKEN', value: 'x' }), null);
  assert.equal(validateCredentialInput({ server: 'composio', key: 'x-api-key', value: 'x' }), null);
  assert.match(validateCredentialInput({ server: '', key: 'K', value: 'x' }) ?? '', /server/);
  assert.match(validateCredentialInput({ server: 's', key: 'A__B', value: 'x' }) ?? '', /no "__"/);
  assert.match(validateCredentialInput({ server: 's', key: 'has space', value: 'x' }) ?? '', /letters/);
  assert.match(validateCredentialInput({ server: 's', key: 'K', value: '' }) ?? '', /value/);
  assert.match(validateCredentialInput({ server: 's', key: 'K', value: 'x'.repeat(16_385) }) ?? '', /too long/);
});

test('groupCredentials groups by server and sorts', () => {
  const entry = (server: string, key: string) => ({ server, key, name: `${server}__${key}`, updated_at: '', last_used_at: null });
  const groups = groupCredentials([entry('JIRA', 'B'), entry('COMPOSIO', 'A'), entry('JIRA', 'A')]);
  assert.deepEqual(groups.map((g) => [g.server, g.entries.length]), [['COMPOSIO', 1], ['JIRA', 2]]);
});

test('failover helpers move, clean and validate routes', () => {
  assert.deepEqual(moveRoute(['a', 'b', 'c'], 1, -1), ['b', 'a', 'c']);
  assert.deepEqual(moveRoute(['a', 'b', 'c'], 2, 1), ['a', 'b', 'c']);
  assert.deepEqual(moveRoute(['a', 'b'], 5, 1), ['a', 'b']);
  assert.deepEqual(cleanRoutes([{ provider: 'codex', model: ' ', effort: 'high' }]), [{ provider: 'codex', effort: 'high' }]);
  assert.equal(routesEqual([{ provider: 'codex', model: '' }], [{ provider: 'codex' }]), true);
  assert.equal(validateRoutes([{ provider: 'codex' }]), null);
  assert.match(validateRoutes([{ provider: 'nope' }]) ?? '', /provider/);
  assert.match(validateRoutes(Array.from({ length: 6 }, () => ({ provider: 'codex' }))) ?? '', /At most 5/);
});

test('describeEnforcement explains advisory providers and flags a missing gateway', () => {
  const enforced = describeEnforcement({ level: 'enforced', builtin_tool_gate: true, gateway: true, configured: null, phases: [{ phase: 'act', provider: 'claude', level: 'enforced' }] });
  assert.match(enforced.headline, /^Enforced/);
  assert.deepEqual(enforced.notes, []);
  assert.match(enforced.phases[0].explanation, /every tool call/);

  const advisory = describeEnforcement({
    level: 'advisory', builtin_tool_gate: false, gateway: false, configured: 'enforced',
    phases: [{ phase: 'perceive', provider: 'claude', level: 'enforced' }, { phase: 'act', provider: 'codex', level: 'advisory' }],
  });
  assert.match(advisory.headline, /^Advisory/);
  assert.equal(advisory.notes.length, 3);
  assert.match(advisory.notes[0], /gateway is switched off/);
  assert.match(advisory.notes[1], /configured to require enforcement/);
  assert.equal(advisory.notes[2], 'Advisory in: act (codex).');
  assert.match(advisory.phases[1].explanation, /built-in tools or connectors/);
});
