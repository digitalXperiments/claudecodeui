import assert from 'node:assert/strict';
import test from 'node:test';

import type { BotBudgetInput, BotChannel, BotGoalInput, BotPhaseRoute, BotRuleInput } from '../types/botRuntime';
import { emptyDraft } from '../view/tabs/runtime/triggers/triggerForm';

import { emptyRuntimeDraft } from './runtimeDraft';
import {
  buildSetupPlan, initialSetupState, needsDeferredEnable, runSetup, setupMessage, summarizeSetup, type SetupApi,
} from './setupPlan';

type Call = { type: string; botId: string; input?: unknown };

function fakeApi(failOn: (call: Call) => string | null = () => null): { api: SetupApi; calls: Call[] } {
  const calls: Call[] = [];
  const make = <A extends unknown[]>(type: string, pick: (...args: A) => { botId: string; input?: unknown }) => async (...args: A) => {
    const { botId, input } = pick(...args);
    const call = { type, botId, input };
    calls.push(call);
    const failure = failOn(call);
    if (failure) throw new Error(failure);
    return { trigger_id: `t-${calls.length}`, input };
  };
  const api: SetupApi = {
    createTrigger: make('trigger', (botId: string, input: unknown) => ({ botId, input })),
    createGoal: make('goal', (botId: string, input: BotGoalInput) => ({ botId, input })),
    createRule: make('rule', (botId: string, input: BotRuleInput) => ({ botId, input })),
    putBudget: make('budget', (botId: string, input: BotBudgetInput) => ({ botId, input })),
    setPerceive: make('perceive', (botId: string, input: BotPhaseRoute) => ({ botId, input })),
    setFallback: make('fallback', (botId: string, input: BotPhaseRoute[]) => ({ botId, input })),
    setLearning: make('learning', (botId: string, input: number) => ({ botId, input })),
    createChannel: make('channel', (botId: string, input: unknown) => ({ botId, input })),
    enableBot: make('enable', (botId: string) => ({ botId })),
  };
  return { api, calls };
}

const slack: BotChannel = { channel_id: 'c1', bot_id: null, kind: 'slack', config: { token_ref: '${secret:S}', channel_id: 'C1' }, policy: {}, enabled: true, created_at: '', updated_at: '' };

function fullDraft() {
  const runtime = emptyRuntimeDraft();
  runtime.triggers = [{ ...emptyDraft('nl_schedule'), text: 'weekdays at 9am' }, { ...emptyDraft('watch'), adapter: 'rss', url: 'https://a.b/feed' }];
  runtime.goals = [{ id: 'g1', statement: ' Keep inbox clear ', successCriteria: 'Under 10', horizon: 'Q4' }, { id: 'g2', statement: '', successCriteria: '', horizon: '' }];
  runtime.rules = { allow: [{ server: 'mail', tool: 'reply', risk: 'send' }], neverDelete: true, neverPurchase: false };
  runtime.fallback = [{ provider: 'codex' }];
  runtime.watcher = { enabled: true, route: { provider: 'claude', model: 'haiku', effort: null } };
  runtime.learning = { autoApply: true, minConfidence: 0.85 };
  runtime.channels.skipGlobal = ['c1'];
  return runtime;
}

test('the default draft needs only a budget (and the enable step when asked)', () => {
  const plan = buildSetupPlan({ runtime: emptyRuntimeDraft(), globalChannels: [], enableAfter: false });
  assert.deepEqual(plan.errors, []);
  assert.deepEqual(plan.tasks.map((task) => task.id), ['budget']);
  assert.deepEqual(plan.tasks[0].call, { type: 'budget', input: { daily_usd: 5, monthly_usd: 100, daily_actions: null, max_wakes_per_hour: 12, soft_ratio: 0.8 } });
  assert.equal(needsDeferredEnable(plan.tasks), false);
  const enabled = buildSetupPlan({ runtime: emptyRuntimeDraft(), globalChannels: [], enableAfter: true });
  assert.equal(needsDeferredEnable(enabled.tasks), true);
  const noBudget = emptyRuntimeDraft();
  noBudget.budget.enabled = false;
  assert.deepEqual(buildSetupPlan({ runtime: noBudget, globalChannels: [], enableAfter: false }).tasks, []);
});

test('everything configured becomes one small task each, limits and rules before triggers, enable last', () => {
  const plan = buildSetupPlan({ runtime: fullDraft(), globalChannels: [slack], enableAfter: true });
  assert.deepEqual(plan.errors, []);
  assert.deepEqual(plan.tasks.map((task) => task.id), [
    'budget', 'rule-allow-0', 'rule-deny-delete', 'perceive', 'fallback', 'learning', 'channel-0', 'goal-0', 'trigger-0', 'trigger-1', 'enable',
  ]);
  const byId = Object.fromEntries(plan.tasks.map((task) => [task.id, task.call]));
  assert.deepEqual(byId['goal-0'], { type: 'goal', input: { statement: 'Keep inbox clear', success_criteria: 'Under 10', horizon: 'Q4', sort_order: 0 } });
  assert.deepEqual(byId.perceive, { type: 'perceive', route: { provider: 'claude', model: 'haiku' } });
  assert.deepEqual(byId.fallback, { type: 'fallback', routes: [{ provider: 'codex' }] });
  assert.deepEqual(byId.learning, { type: 'learning', minConfidence: 0.85 });
  assert.deepEqual(byId['trigger-0'], { type: 'trigger', input: { kind: 'nl_schedule', config: { text: 'weekdays at 9am' }, enabled: true } });
  assert.equal((byId['trigger-1'] as { input: { kind: string } }).input.kind, 'watch');
  assert.equal((byId['channel-0'] as { input: { enabled: boolean } }).input.enabled, false);
  assert.match(plan.tasks.find((task) => task.id === 'trigger-1')!.label, /^Watch: RSS https:\/\/a\.b\/feed/);
});

test('invalid drafts produce errors the caller must act on', () => {
  const runtime = emptyRuntimeDraft();
  runtime.triggers = [{ ...emptyDraft('webhook'), secretRef: '' }];
  const plan = buildSetupPlan({ runtime, globalChannels: [], enableAfter: false });
  assert.equal(plan.errors.length, 1);
  assert.match(plan.errors[0], /Wake-up 1/);
});

test('running the plan calls the API once per task against the new bot, in order, and reports done', async () => {
  const { tasks } = buildSetupPlan({ runtime: fullDraft(), globalChannels: [slack], enableAfter: true });
  const { api, calls } = fakeApi();
  const seen: string[] = [];
  const state = await runSetup({ botId: 'bot-1', tasks, api, onChange: (next) => seen.push(Object.values(next).map((entry) => entry.status[0]).join('')) });
  assert.deepEqual(calls.map((call) => call.type), ['budget', 'rule', 'rule', 'perceive', 'fallback', 'learning', 'channel', 'goal', 'trigger', 'trigger', 'enable']);
  assert.ok(calls.every((call) => call.botId === 'bot-1'));
  const summary = summarizeSetup(tasks, state);
  assert.equal(summary.allDone, true);
  assert.equal(summary.done, tasks.length);
  assert.ok(seen.length >= tasks.length * 2, 'progress fires on start and finish of every task');
  assert.equal(setupMessage(tasks, state, true), 'Everything is set up and the bot is on.');
  assert.match(setupMessage(tasks, state, false), /paused until you turn it on/);
  assert.deepEqual((state['trigger-0'].result as { trigger_id: string }).trigger_id.startsWith('t-'), true);
});

test('a failed step does not stop the others, blocks enabling, and says exactly what to do', async () => {
  const { tasks } = buildSetupPlan({ runtime: fullDraft(), globalChannels: [slack], enableAfter: true });
  const { api, calls } = fakeApi((call) => (call.type === 'rule' && (call.input as BotRuleInput).decision === 'allow' ? 'A global allow cannot cover floor risks' : null));
  const state = await runSetup({ botId: 'bot-1', tasks, api });
  assert.equal(state['rule-allow-0'].status, 'failed');
  assert.equal(state['rule-allow-0'].error, 'A global allow cannot cover floor risks');
  assert.equal(state['trigger-1'].status, 'done', 'independent steps still ran');
  assert.equal(state.enable.status, 'blocked');
  assert.equal(calls.some((call) => call.type === 'enable'), false, 'the bot is never turned on with setup incomplete');
  const summary = summarizeSetup(tasks, state);
  assert.equal(summary.failed, 1);
  assert.equal(summary.blocked, 1);
  assert.deepEqual(summary.remaining.map((task) => task.id), ['rule-allow-0', 'enable']);
  const message = setupMessage(tasks, state, false);
  assert.match(message, /created, but 2 of 11 setup steps did not finish, so it is paused/);
  assert.match(message, /Retry remaining/);
});

test('retry re-runs only what did not finish, then enables the bot', async () => {
  const { tasks } = buildSetupPlan({ runtime: fullDraft(), globalChannels: [slack], enableAfter: true });
  let healthy = false;
  const first = fakeApi((call) => (call.type === 'budget' && !healthy ? 'network down' : null));
  const failed = await runSetup({ botId: 'bot-1', tasks, api: first.api });
  assert.equal(failed.budget.status, 'failed');
  healthy = true;
  const second = fakeApi();
  const state = await runSetup({ botId: 'bot-1', tasks, api: second.api, previous: failed });
  assert.deepEqual(second.calls.map((call) => call.type), ['budget', 'enable'], 'only the failed step and the enable step ran again');
  assert.equal(summarizeSetup(tasks, state).allDone, true);
});

test('with nothing to do the message says so, and a fresh state is all pending', () => {
  assert.equal(setupMessage([], {}, false), 'Nothing extra to set up.');
  const { tasks } = buildSetupPlan({ runtime: emptyRuntimeDraft(), globalChannels: [], enableAfter: false });
  assert.deepEqual(initialSetupState(tasks), { budget: { status: 'pending' } });
  assert.equal(summarizeSetup(tasks, initialSetupState(tasks)).allDone, false);
  assert.equal(summarizeSetup([], {}).allDone, false, 'an empty plan is not "all done" progress');
});
