import test from 'node:test';
import assert from 'node:assert/strict';

import type { BotCommitment, BotGoal } from '../../../../types/botRuntime';

import {
  buildCommitmentInput, buildGoalPatch, commitmentIsActionable, goalToDraft, countCommitments, filterCommitments, goalProgressView, moveGoal, nextSortOrder,
} from './goals';

function goal(id: string, sort: number, progress: Record<string, unknown> = {}): BotGoal {
  return { goal_id: id, bot_id: 'b', statement: id, success_criteria: '', horizon: null, status: 'active', progress, sort_order: sort, created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z' };
}

function commitment(id: string, status: BotCommitment['status'], due: string): BotCommitment {
  return { commitment_id: id, bot_id: 'b', item_id: null, goal_id: null, description: id, waiting_on: null, due_at: due, nudge_policy: {}, status, source_episode_id: null, tainted: false, created_at: due, updated_at: due };
}

test('goalProgressView clamps percent and surfaces the taint marker', () => {
  assert.deepEqual(goalProgressView(goal('a', 0, { percent: 42.4, note: 'halfway', note_tainted: true, updated_at: '2026-10-01T01:00:00Z' })),
    { percent: 42, note: 'halfway', tainted: true, updatedAt: '2026-10-01T01:00:00Z' });
  assert.equal(goalProgressView(goal('a', 0, { percent: 250 })).percent, 100);
  assert.equal(goalProgressView(goal('a', 0, { percent: -5 })).percent, 0);
  assert.deepEqual(goalProgressView(goal('a', 0, { percent: 'lots', note: 7 })), { percent: null, note: '', tainted: false, updatedAt: null });
  assert.equal(goalProgressView(goal('a', 0, { note: 'x', note_tainted: false })).tainted, false);
});

test('moveGoal swaps neighbours and renormalises tied sort_order', () => {
  const goals = [goal('a', 0), goal('b', 1), goal('c', 2)];
  assert.deepEqual(moveGoal(goals, 'b', 'up'), [{ goalId: 'b', sort_order: 0 }, { goalId: 'a', sort_order: 1 }]);
  assert.deepEqual(moveGoal(goals, 'b', 'down'), [{ goalId: 'c', sort_order: 1 }, { goalId: 'b', sort_order: 2 }]);
  assert.deepEqual(moveGoal(goals, 'a', 'up'), []);
  assert.deepEqual(moveGoal(goals, 'c', 'down'), []);
  assert.deepEqual(moveGoal(goals, 'missing', 'up'), []);
  const tied = [goal('a', 0), goal('b', 0), goal('c', 0)];
  assert.deepEqual(moveGoal(tied, 'c', 'up'), [{ goalId: 'c', sort_order: 1 }, { goalId: 'b', sort_order: 2 }]);
});

test('nextSortOrder lands after the current maximum', () => {
  assert.equal(nextSortOrder([]), 0);
  assert.equal(nextSortOrder([goal('a', 0), goal('b', 4)]), 5);
});

test('filterCommitments orders active by due date and finished newest first', () => {
  const list = [
    commitment('done1', 'done', '2026-10-01T05:00:00Z'),
    commitment('open-late', 'open', '2026-10-03T00:00:00Z'),
    commitment('open-soon', 'open', '2026-10-02T00:00:00Z'),
    commitment('fired', 'fired', '2026-09-30T00:00:00Z'),
    commitment('cancelled', 'cancelled', '2026-10-01T09:00:00Z'),
  ];
  assert.deepEqual(filterCommitments(list, 'open').map((c) => c.commitment_id), ['open-soon', 'open-late']);
  assert.deepEqual(filterCommitments(list, 'all').map((c) => c.commitment_id), ['fired', 'open-soon', 'open-late', 'cancelled', 'done1']);
  assert.deepEqual(countCommitments(list), { all: 5, open: 2, fired: 1, done: 1, cancelled: 1 });
  assert.equal(commitmentIsActionable(list[0]), false);
  assert.equal(commitmentIsActionable(list[3]), true);
});

test('buildCommitmentInput validates description and due date', () => {
  const toIso = (local: string) => (local ? `${local}:00.000Z` : null);
  assert.deepEqual(buildCommitmentInput({ description: ' ', dueLocal: '2026-10-02T09:00', waitingOn: '' }, toIso), { ok: false, error: 'Describe what the bot owes or is waiting for.' });
  assert.deepEqual(buildCommitmentInput({ description: 'Ping', dueLocal: '', waitingOn: '' }, toIso), { ok: false, error: 'Choose when this is due.' });
  assert.deepEqual(buildCommitmentInput({ description: ' Ping Sam ', dueLocal: '2026-10-02T09:00', waitingOn: ' Sam ' }, toIso),
    { ok: true, input: { description: 'Ping Sam', due_at: '2026-10-02T09:00:00.000Z', waiting_on: 'Sam' } });
  const noWait = buildCommitmentInput({ description: 'x', dueLocal: '2026-10-02T09:00', waitingOn: '' }, toIso);
  assert.ok(noWait.ok && !('waiting_on' in noWait.input));
});

test('buildGoalPatch validates and sends only what changed', () => {
  assert.deepEqual(buildGoalPatch({ ...goalToDraft(), statement: '  ' }), { ok: false, error: 'A goal needs a statement.' });
  assert.deepEqual(buildGoalPatch({ ...goalToDraft(), statement: 'x', percent: '140' }), { ok: false, error: 'Progress must be between 0 and 100.' });
  const created = buildGoalPatch({ ...goalToDraft(), statement: ' Grow newsletter ', horizon: 'Q4' });
  assert.ok(created.ok);
  assert.equal(created.ok && created.patch.statement, 'Grow newsletter');
  assert.equal(created.ok && created.patch.horizon, 'Q4');
  assert.equal(created.ok && created.patch.progress, undefined);

  const original = goal('g1', 0, { percent: 20, note: 'agent note', note_tainted: true, history: [1] });
  const unchanged = buildGoalPatch(goalToDraft(original), original);
  assert.deepEqual(unchanged, { ok: true, patch: {} });

  const edited = buildGoalPatch({ ...goalToDraft(original), percent: '55', note: 'operator note', status: 'paused' }, original);
  assert.ok(edited.ok);
  assert.equal(edited.ok && edited.patch.status, 'paused');
  assert.deepEqual(edited.ok && edited.patch.progress, { percent: 55, note: 'operator note', note_tainted: false, history: [1] });

  const percentOnly = buildGoalPatch({ ...goalToDraft(original), percent: '30' }, original);
  assert.deepEqual(percentOnly.ok && percentOnly.patch.progress, { percent: 30, note: 'agent note', note_tainted: true, history: [1] });

  const cleared = buildGoalPatch({ ...goalToDraft(original), percent: '' }, original);
  assert.ok(cleared.ok && cleared.patch.progress && !('percent' in cleared.patch.progress));
});
