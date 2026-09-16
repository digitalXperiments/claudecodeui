import test from 'node:test';
import assert from 'node:assert/strict';

import type { McItem } from '../../mission-control/api/missionControlApi';

import { removeItem, setItemStatus, upsertItem } from './botStudioReducers';

const item = (id: string, status: McItem['status'] = 'pending'): McItem => ({
  item_id: id,
  section_id: 'section-1',
  status,
  title: id,
  summary: '',
  body: {},
  source: {},
  actions: [],
  confidence: 0.5,
  provider: 'claude',
  model: 'sonnet',
  dedupe_key: id,
  result: null,
  error: null,
  created_at: '',
  updated_at: '',
  resolved_at: null,
});

test('optimistic item reducers preserve immutable list semantics', () => {
  const original = [item('one'), item('two')];
  const resolving = setItemStatus(original, 'one', 'resolving');
  assert.equal(original[0].status, 'pending');
  assert.equal(resolving[0].status, 'resolving');
  assert.deepEqual(removeItem(resolving, 'one').map((entry) => entry.item_id), ['two']);
  assert.deepEqual(upsertItem(resolving, item('two', 'resolved')).map((entry) => entry.status), ['resolving', 'resolved']);
  assert.deepEqual(upsertItem(resolving, item('three')).map((entry) => entry.item_id), ['three', 'one', 'two']);
});
