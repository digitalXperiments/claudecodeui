import assert from 'node:assert/strict';
import test from 'node:test';

import { emptyDraft } from '../view/tabs/runtime/triggers/triggerForm';

import {
  DEFAULT_BUDGET_DRAFT, MAX_EXTRA_TRIGGERS, MAX_GOALS, activeGoals, emptyRuntimeDraft, firstSentence, goalProblems,
  newGoalId, normalizeRuntimeDraft, suggestGoal, validateRuntimeDraft,
} from './runtimeDraft';

test('defaults are cautious: $5/day, 12 wake-ups/hour, nothing allowed, no auto-apply', () => {
  const draft = emptyRuntimeDraft();
  assert.equal(draft.budget.enabled, true);
  assert.equal(draft.budget.draft.dailyUsd, '5');
  assert.equal(draft.budget.draft.maxWakes, '12');
  assert.deepEqual(draft.rules, { allow: [], neverDelete: false, neverPurchase: false });
  assert.equal(draft.learning.autoApply, false);
  assert.equal(draft.watcher.enabled, false);
  assert.deepEqual(draft.triggers, []);
  assert.deepEqual(validateRuntimeDraft(draft), []);
  assert.notEqual(emptyRuntimeDraft().budget.draft, DEFAULT_BUDGET_DRAFT, 'each draft gets its own copy');
});

test('normalizing garbage, null and partial drafts never throws and falls back to defaults', () => {
  assert.deepEqual(normalizeRuntimeDraft(null), emptyRuntimeDraft());
  assert.deepEqual(normalizeRuntimeDraft('nope'), emptyRuntimeDraft());
  assert.deepEqual(normalizeRuntimeDraft({ goals: 'x', rules: 7, budget: [], channels: null, learning: 3, triggers: { a: 1 } }), emptyRuntimeDraft());
  const partial = normalizeRuntimeDraft({ budget: { draft: { dailyUsd: '9' } }, learning: { autoApply: true, minConfidence: 7 } });
  assert.equal(partial.budget.draft.dailyUsd, '9');
  assert.equal(partial.budget.draft.maxWakes, '12', 'missing fields keep their default');
  assert.equal(partial.learning.minConfidence, 1, 'confidence is clamped to 0..1');
});

test('normalizing keeps well-formed choices and drops malformed entries', () => {
  const stored = {
    triggers: [{ ...emptyDraft('webhook'), secretRef: 'HOOK' }, 'bad', null],
    goals: [{ id: 'g', statement: 'Ship', successCriteria: 'Done', horizon: 'Q4' }, { statement: 5 }],
    fallback: [{ provider: 'codex', model: 'm' }, { model: 'no provider' }],
    rules: { allow: [{ server: 'mail', tool: 'send', risk: 'send' }, { server: 'x' }], neverDelete: true },
    channels: { skipGlobal: ['c1', 4], own: { slack: { enabled: true, config: { tokenRef: '${secret:T}', channelId: 'C1' } }, email: { enabled: true } }, quiet: { enabled: true, start: '23:00' } },
    watcher: { enabled: true, route: { provider: 'claude', model: 'haiku' } },
  };
  const draft = normalizeRuntimeDraft(stored);
  assert.equal(draft.triggers.length, 1);
  assert.equal(draft.triggers[0].secretRef, 'HOOK');
  assert.equal(draft.goals.length, 2);
  assert.equal(draft.goals[1].statement, '');
  assert.deepEqual(draft.fallback, [{ provider: 'codex', model: 'm' }]);
  assert.deepEqual(draft.rules.allow, [{ server: 'mail', tool: 'send', risk: 'send' }]);
  assert.equal(draft.rules.neverDelete, true);
  assert.deepEqual(draft.channels.skipGlobal, ['c1']);
  assert.equal(draft.channels.own.slack?.config.channelId, 'C1');
  assert.equal(draft.channels.own.slack?.config.slackMode, 'bot');
  assert.equal('email' in draft.channels.own, false);
  assert.deepEqual(draft.channels.quiet, { enabled: true, start: '23:00', end: '07:00', tz: '' });
  assert.deepEqual(draft.watcher.route, { provider: 'claude', model: 'haiku', effort: null });
});

test('normalizing caps the number of stored triggers and goals', () => {
  const many = Array.from({ length: 40 }, () => emptyDraft('run_completed'));
  assert.equal(normalizeRuntimeDraft({ triggers: many }).triggers.length, MAX_EXTRA_TRIGGERS);
  assert.equal(normalizeRuntimeDraft({ goals: Array.from({ length: 40 }, () => ({ statement: 's' })) }).goals.length, MAX_GOALS);
});

test('firstSentence tidies and caps', () => {
  assert.equal(firstSentence('  Watch new   tickets. And more.  '), 'Watch new tickets');
  assert.equal(firstSentence(''), '');
  assert.equal(firstSentence('x'.repeat(300), 20).length, 20);
  assert.equal(firstSentence('Does 3.5 count? yes'), 'Does 3.5 count');
});

test('a goal is suggested from the purpose with plain rules, or not at all', () => {
  assert.equal(suggestGoal('Bot', ''), null);
  assert.equal(suggestGoal('Bot', 'tiny'), null);
  const triage = suggestGoal('Support triage', 'Watch new support tickets, classify urgency, and draft the next useful action with evidence. Also more text.');
  assert.ok(triage);
  assert.match(triage.statement, /^Support triage: watch new support tickets/);
  assert.doesNotMatch(triage.statement, /Also more text/);
  assert.match(triage.successCriteria, /classified/);
  assert.match(suggestGoal('', 'Summarize the weekly sales report for me')!.successCriteria, /summary/);
  assert.match(suggestGoal('', 'Keep an eye on the deployment pipeline')!.statement, /^Keep an eye on the deployment pipeline, consistently$/);
  assert.match(suggestGoal('', 'Reorganize my notes into folders somehow')!.successCriteria, /act on/);
  assert.ok(suggestGoal('T', 'a'.repeat(400) + ' watch')!.statement.length <= 500);
});

test('goal ids are unique and half-filled goals are flagged, empty ones skipped', () => {
  assert.equal(newGoalId([]), 'goal-1');
  assert.equal(newGoalId([{ id: 'goal-2', statement: '', successCriteria: '', horizon: '' }]), 'goal-3');
  const goals = [
    { id: 'a', statement: '', successCriteria: '', horizon: '' },
    { id: 'b', statement: '  ', successCriteria: 'orphan criteria', horizon: '' },
    { id: 'c', statement: 'Real', successCriteria: '', horizon: 'x'.repeat(101) },
  ];
  assert.deepEqual(activeGoals(goals).map((goal) => goal.id), ['c']);
  const problems = goalProblems(goals);
  assert.equal(problems.length, 2);
  assert.match(problems[0], /Goal 2 needs a statement/);
  assert.match(problems[1], /Goal 3: the horizon is too long/);
});

test('validation points at the step that fixes each problem', () => {
  const runtime = emptyRuntimeDraft();
  runtime.triggers = [{ ...emptyDraft('webhook'), secretRef: '' }];
  runtime.goals = [{ id: 'g', statement: '', successCriteria: 'x', horizon: '' }];
  runtime.watcher = { enabled: true, route: { provider: null, model: null, effort: null } };
  runtime.fallback = Array.from({ length: 6 }, () => ({ provider: 'codex' }));
  runtime.budget.draft.dailyUsd = '500';
  runtime.channels.quiet = { enabled: true, start: '22:00', end: '22:00', tz: '' };
  runtime.learning = { autoApply: true, minConfidence: 0.2 };
  const problems = validateRuntimeDraft(runtime);
  const steps = problems.map((problem) => problem.step);
  assert.deepEqual([...new Set(steps)].sort(), ['agent', 'goals', 'guardrails', 'reach', 'triggers']);
  assert.match(problems.find((problem) => problem.step === 'triggers')!.message, /^Wake-up 1: Enter the name of the secret/);
  assert.match(problems.find((problem) => problem.step === 'guardrails')!.message, /daily spend limit is higher than the monthly/);
  runtime.budget.enabled = false;
  assert.equal(validateRuntimeDraft(runtime).some((problem) => problem.step === 'guardrails'), false, 'a disabled budget is not validated');
});

test('autonomy defaults to Ask and a stored draft can only restore a valid level', () => {
  assert.equal(emptyRuntimeDraft().autonomy, 'ask');
  assert.equal(normalizeRuntimeDraft(null).autonomy, 'ask');
  assert.equal(normalizeRuntimeDraft({ autonomy: 'ask' }).autonomy, 'ask');
  assert.equal(normalizeRuntimeDraft({ autonomy: 'auto' }).autonomy, 'auto');
  assert.equal(normalizeRuntimeDraft({ autonomy: 'bypass' }).autonomy, 'bypass');
  assert.equal(normalizeRuntimeDraft({ autonomy: 'yolo' }).autonomy, 'ask');
  assert.equal(normalizeRuntimeDraft({ autonomy: 7 }).autonomy, 'ask');
  assert.equal(normalizeRuntimeDraft({ rules: { neverDelete: true } }).autonomy, 'ask', 'drafts saved before autonomy existed restore as Ask');
});

test('drafts stored with the old autonomy names restore as the new ones', () => {
  assert.equal(normalizeRuntimeDraft({ autonomy: 'careful' }).autonomy, 'ask');
  assert.equal(normalizeRuntimeDraft({ autonomy: 'trusted' }).autonomy, 'auto');
  assert.equal(normalizeRuntimeDraft({ autonomy: 'unrestricted' }).autonomy, 'bypass');
  assert.equal(normalizeRuntimeDraft({ autonomy: 'Unrestricted ' }).autonomy, 'ask', 'only the exact legacy names map; anything else is Ask');
});
