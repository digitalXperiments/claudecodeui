import test from 'node:test';
import assert from 'node:assert/strict';

import type { McAction } from '../../../mission-control/api/missionControlApi';

import { addAction, isSystemAction, removeAction, reorderActions, updateAction } from './actionSet';

const actions: McAction[] = [
  { id: 'approve', label: 'Approve', kind: 'approve', style: 'primary', terminal: false },
  { id: 'delete', label: 'Delete', kind: 'delete', style: 'destructive', terminal: true },
  { id: 'custom', label: 'Archive', kind: 'custom', style: 'secondary', terminal: true },
];

test('action set can reorder, add, and remove editable actions', () => {
  assert.deepEqual(reorderActions(actions, 2, 0).map((action) => action.id), ['custom', 'approve', 'delete']);
  const added = addAction(actions, { id: 'reply', label: 'Reply', kind: 'reply', style: 'primary' });
  assert.equal(added.at(-1)?.label, 'Reply');
  assert.deepEqual(removeAction(added, 2).map((action) => action.id), ['approve', 'delete', 'reply']);
});

test('Delete and Work system actions cannot be edited or removed', () => {
  assert.equal(isSystemAction(actions[1]), true);
  assert.deepEqual(removeAction(actions, 1), actions);
  assert.deepEqual(updateAction(actions, 1, { label: 'Nope', kind: 'custom' }), actions);
  assert.equal(isSystemAction({ id: 'work-item', kind: 'custom' }), true);
});
