import assert from 'node:assert/strict';
import test from 'node:test';

import { isPristineDraft, parseDraft, serializeDraft } from './draftStorage';
import { emptyRuntimeDraft } from './runtimeDraft';
import type { CreateMcSectionInput } from './types';

const form: CreateMcSectionInput = { title: 'Inbox', scope: 'global', schedule_cron: '*/30 * * * *', produce_prompt: 'p' };

test('the classic wizard stores the bare form exactly as it always did', () => {
  assert.equal(serializeDraft(form, null), JSON.stringify(form));
});

test('an old draft (bare form) restores into the runtime wizard with default runtime choices', () => {
  const restored = parseDraft(JSON.stringify(form));
  assert.ok(restored);
  assert.equal(restored.form.title, 'Inbox');
  assert.deepEqual(restored.runtime, emptyRuntimeDraft());
});

test('a runtime draft round-trips, and a classic wizard can read it back (form only)', () => {
  const runtime = emptyRuntimeDraft();
  runtime.goals = [{ id: 'goal-1', statement: 'Ship', successCriteria: 'Shipped', horizon: '' }];
  runtime.budget.draft.dailyUsd = '7';
  const text = serializeDraft(form, runtime);
  const restored = parseDraft(text);
  assert.deepEqual(restored?.form, form);
  assert.equal(restored?.runtime.goals[0].statement, 'Ship');
  assert.equal(restored?.runtime.budget.draft.dailyUsd, '7');
});

test('a stale or damaged runtime part is repaired, not trusted', () => {
  const restored = parseDraft(JSON.stringify({ v: 2, form, runtime: { goals: 'broken', budget: { draft: { dailyUsd: 4 } } } }));
  assert.deepEqual(restored?.runtime, emptyRuntimeDraft());
});

test('unreadable text is not a draft', () => {
  assert.equal(parseDraft('{not json'), null);
  assert.equal(parseDraft('[1,2]'), null);
  assert.equal(parseDraft('null'), null);
});

test('an untouched draft is pristine in either wizard flavour; real work is not', () => {
  assert.equal(isPristineDraft(JSON.stringify(form), form, false), true);
  assert.equal(isPristineDraft(serializeDraft(form, emptyRuntimeDraft()), form, true), true);
  assert.equal(isPristineDraft(JSON.stringify(form), form, true), true, 'a classic draft of the starting point is pristine for the new wizard');
  assert.equal(isPristineDraft(serializeDraft(form, emptyRuntimeDraft()), form, false), true);
  assert.equal(isPristineDraft(JSON.stringify({ ...form, title: 'Changed' }), form, false), false);
  const edited = emptyRuntimeDraft();
  edited.rules.neverDelete = true;
  assert.equal(isPristineDraft(serializeDraft(form, edited), form, true), false);
  assert.equal(isPristineDraft('garbage', form, true), false);
});
