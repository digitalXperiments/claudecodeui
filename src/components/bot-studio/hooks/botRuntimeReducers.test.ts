import assert from 'node:assert/strict';
import test from 'node:test';

import type { BotCommitment, BotEpisode, BotGoal, BotThreadMessage } from '../types/botRuntime';

import {
  appendThreadMessage,
  createRuntimeState,
  mergeSections,
  parseThreadMessage,
  prependThreadPage,
  removeGoal,
  routeRuntimeEvent,
  runtimeReducer,
  upsertCommitment,
  upsertEpisode,
  upsertGoal,
  type BotRuntimeState,
} from './botRuntimeReducers';

const goal = (id: string, sort: number, extra: Partial<BotGoal> = {}): BotGoal => ({
  goal_id: id, bot_id: 'bot-1', statement: id, success_criteria: '', horizon: null, status: 'active',
  progress: {}, sort_order: sort, created_at: `2026-01-0${sort + 1}T00:00:00Z`, updated_at: '', ...extra,
});

const message = (id: string, at: string, extra: Partial<BotThreadMessage> = {}): BotThreadMessage => ({
  message_id: id, bot_id: 'bot-1', role: 'bot', body: id, channel: 'inapp', meta: {}, created_at: at, ...extra,
});

const episode = (id: string, at: string, status: BotEpisode['status'] = 'running'): BotEpisode => ({
  episode_id: id, bot_id: 'bot-1', status, trigger_kinds: 'manual', event_ids: [], run_ids: [], plan_text: '', summary: '',
  outcome: {}, feedback: [], tainted: false, cost_usd: 0, bot_version: null, started_at: at, finished_at: null,
});

const commitment = (id: string, due: string): BotCommitment => ({
  commitment_id: id, bot_id: 'bot-1', item_id: null, goal_id: null, description: id, waiting_on: null, due_at: due,
  nudge_policy: {}, status: 'open', source_episode_id: null, tainted: false, created_at: '', updated_at: '',
});

test('upsertGoal replaces in place and keeps sort_order ordering; removeGoal drops by id', () => {
  const goals = [goal('a', 0), goal('c', 2)];
  const inserted = upsertGoal(goals, goal('b', 1));
  assert.deepEqual(inserted.map((g) => g.goal_id), ['a', 'b', 'c']);
  const updated = upsertGoal(inserted, goal('b', 1, { status: 'achieved' }));
  assert.equal(updated.length, 3);
  assert.equal(updated[1].status, 'achieved');
  assert.equal(inserted[1].status, 'active', 'input is not mutated');
  assert.deepEqual(removeGoal(updated, 'a').map((g) => g.goal_id), ['b', 'c']);
});

test('upsertCommitment orders by due date; upsertEpisode is newest first and capped', () => {
  const list = upsertCommitment([commitment('late', '2026-03-01')], commitment('soon', '2026-01-01'));
  assert.deepEqual(list.map((c) => c.commitment_id), ['soon', 'late']);

  let episodes = [episode('e1', '2026-01-01T00:00:00Z')];
  episodes = upsertEpisode(episodes, episode('e2', '2026-01-02T00:00:00Z'));
  assert.deepEqual(episodes.map((e) => e.episode_id), ['e2', 'e1']);
  episodes = upsertEpisode(episodes, episode('e1', '2026-01-01T00:00:00Z', 'succeeded'));
  assert.equal(episodes.length, 2);
  assert.equal(episodes[1].status, 'succeeded');
  assert.equal(upsertEpisode(episodes, episode('e3', '2026-01-03T00:00:00Z'), 2).length, 2);
});

test('appendThreadMessage appends, dedupes, orders late arrivals and caps', () => {
  let thread: BotThreadMessage[] = [];
  thread = appendThreadMessage(thread, message('m1', '2026-01-01T00:00:01Z'));
  thread = appendThreadMessage(thread, message('m3', '2026-01-01T00:00:03Z'));
  thread = appendThreadMessage(thread, message('m2', '2026-01-01T00:00:02Z'));
  assert.deepEqual(thread.map((m) => m.message_id), ['m1', 'm2', 'm3']);
  const again = appendThreadMessage(thread, message('m2', '2026-01-01T00:00:02Z', { body: 'edited' }));
  assert.equal(again.length, 3);
  assert.equal(again[1].body, 'edited');
  const capped = appendThreadMessage(thread, message('m4', '2026-01-01T00:00:04Z'), 3);
  assert.deepEqual(capped.map((m) => m.message_id), ['m2', 'm3', 'm4']);
  assert.deepEqual(
    prependThreadPage(thread, [message('m0', '2026-01-01T00:00:00Z'), message('m1', '2026-01-01T00:00:01Z')]).map((m) => m.message_id),
    ['m0', 'm1', 'm2', 'm3'],
  );
});

test('parseThreadMessage accepts a server message and rejects malformed payloads', () => {
  assert.equal(parseThreadMessage(null), null);
  assert.equal(parseThreadMessage('x'), null);
  assert.equal(parseThreadMessage({ message_id: 'm', bot_id: 'b', body: 'hi', created_at: 't', role: 'wizard' }), null);
  assert.equal(parseThreadMessage({ bot_id: 'b', body: 'hi', created_at: 't', role: 'bot' }), null);
  const parsed = parseThreadMessage({ message_id: 'm', bot_id: 'b', body: 'hi', created_at: 't', role: 'operator' });
  assert.deepEqual(parsed, { message_id: 'm', bot_id: 'b', body: 'hi', created_at: 't', role: 'operator', channel: 'inapp', meta: {} });
});

test('reducer: lazy section lifecycle keeps stale data visible during a refresh', () => {
  let state: BotRuntimeState = createRuntimeState('bot-1');
  assert.equal(state.load.goals.state, 'idle');
  state = runtimeReducer(state, { type: 'start', botId: 'bot-1', section: 'goals' });
  assert.equal(state.load.goals.state, 'loading');
  state = runtimeReducer(state, { type: 'loaded', botId: 'bot-1', section: 'goals', data: [goal('a', 0)] });
  assert.equal(state.load.goals.state, 'ready');
  assert.equal(state.data.goals.length, 1);
  state = runtimeReducer(state, { type: 'start', botId: 'bot-1', section: 'goals' });
  assert.equal(state.load.goals.state, 'ready', 'a refresh does not flash back to loading');
  state = runtimeReducer(state, { type: 'failed', botId: 'bot-1', section: 'goals', error: 'boom' });
  assert.equal(state.load.goals.state, 'ready');
  assert.equal(state.load.goals.error, 'boom');
  assert.equal(state.data.goals.length, 1, 'last good data survives a failed refresh');
  state = runtimeReducer(state, { type: 'failed', botId: 'bot-1', section: 'skills', error: 'nope' });
  assert.equal(state.load.skills.state, 'error');
});

test('reducer: actions for another bot are ignored and reset clears the store', () => {
  let state = createRuntimeState('bot-1');
  state = runtimeReducer(state, { type: 'loaded', botId: 'bot-1', section: 'goals', data: [goal('a', 0)] });
  const stale = runtimeReducer(state, { type: 'loaded', botId: 'bot-0', section: 'goals', data: [] });
  assert.equal(stale, state, 'a late response for the previous bot changes nothing');
  assert.equal(runtimeReducer(state, { type: 'thread_message', botId: 'bot-0', message: message('m', 't') }), state);
  assert.equal(runtimeReducer(state, { type: 'reset', botId: 'bot-1' }), state, 'resetting to the same bot keeps data');
  const switched = runtimeReducer(state, { type: 'reset', botId: 'bot-2' });
  assert.equal(switched.botId, 'bot-2');
  assert.deepEqual(switched.data.goals, []);
  assert.equal(switched.load.goals.state, 'idle');
  assert.equal(runtimeReducer(createRuntimeState(null), { type: 'start', botId: 'bot-1', section: 'goals' }).botId, null);
});

test('reducer: thread_message appends and patch applies a local update', () => {
  let state = createRuntimeState('bot-1');
  state = runtimeReducer(state, { type: 'thread_message', botId: 'bot-1', message: message('m1', '2026-01-01T00:00:01Z') });
  state = runtimeReducer(state, { type: 'thread_message', botId: 'bot-1', message: message('m1', '2026-01-01T00:00:01Z') });
  assert.equal(state.data.thread.length, 1);
  state = runtimeReducer(state, {
    type: 'patch', botId: 'bot-1', section: 'goals',
    update: (current) => upsertGoal(current as BotGoal[], goal('z', 1)),
  });
  assert.deepEqual(state.data.goals.map((g) => g.goal_id), ['z']);
});

test('routeRuntimeEvent targets the sections each event can change', () => {
  const route = (frame: unknown, botId: string | null = 'bot-1') => routeRuntimeEvent(frame, botId);
  assert.deepEqual(route({ kind: 'bot_event_received', bot_id: 'bot-1', event_id: 'e', event_kind: 'manual' }), {
    type: 'refresh', sections: ['events', 'triggers'],
  });
  assert.deepEqual(route({ kind: 'bot_episode_updated', bot_id: 'bot-1', episode_id: 'x', status: 'running' }), {
    type: 'refresh', sections: ['episodes'],
  });
  assert.deepEqual(route({ kind: 'bot_episode_updated', bot_id: 'bot-1', episode_id: 'x', status: 'succeeded' }), {
    type: 'refresh', sections: ['episodes', 'commitments', 'budget', 'events'],
  });
  assert.deepEqual(route({ kind: 'bot_gate_decision', bot_id: 'bot-1', decision_id: 'd', decision: 'ask', tool: 't' }), {
    type: 'refresh', sections: ['gateDecisions', 'budget'],
  });
  assert.deepEqual(route({ type: 'bot_proposal_updated', bot_id: 'bot-1', proposal_id: 'p', status: 'approved' }), {
    type: 'refresh', sections: ['proposals', 'skills'],
  });
  assert.deepEqual(route({ kind: 'bot_goal_updated', bot_id: 'bot-1', goal_id: 'g' }), { type: 'refresh', sections: ['goals'] });
});

test('routeRuntimeEvent filters by bot and unrelated frames, and appends thread messages directly', () => {
  const frame = { kind: 'bot_goal_updated', bot_id: 'bot-2', goal_id: 'g' };
  assert.equal(routeRuntimeEvent(frame, 'bot-1'), null);
  assert.equal(routeRuntimeEvent(frame, null), null);
  assert.equal(routeRuntimeEvent({ kind: 'mc_item_updated', bot_id: 'bot-1' }, 'bot-1'), null);
  assert.equal(routeRuntimeEvent('nope', 'bot-1'), null);
  assert.equal(routeRuntimeEvent(null, 'bot-1'), null);

  const msg = message('m1', '2026-01-01T00:00:01Z');
  assert.deepEqual(routeRuntimeEvent({ kind: 'bot_thread_message', bot_id: 'bot-1', message: msg }, 'bot-1'), {
    type: 'thread_message', message: msg,
  });
  // An unusable payload falls back to refetching the thread.
  assert.deepEqual(routeRuntimeEvent({ kind: 'bot_thread_message', bot_id: 'bot-1', message: { oops: true } }, 'bot-1'), {
    type: 'refresh', sections: ['thread'],
  });
  // A message payload that names a different bot is not appended into this bot's thread.
  assert.deepEqual(
    routeRuntimeEvent({ kind: 'bot_thread_message', bot_id: 'bot-1', message: message('m2', 't', { bot_id: 'bot-9' }) }, 'bot-1'),
    { type: 'refresh', sections: ['thread'] },
  );
});

test('mergeSections dedupes bursts and keeps first-seen order', () => {
  assert.deepEqual(mergeSections(['episodes'], ['budget', 'episodes', 'goals']), ['episodes', 'budget', 'goals']);
  assert.deepEqual(mergeSections([], []), []);
});
