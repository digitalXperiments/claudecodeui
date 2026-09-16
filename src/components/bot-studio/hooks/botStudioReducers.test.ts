import assert from 'node:assert/strict';
import test from 'node:test';

import { setItemStatus, shouldTemporarilyCollapseContext } from './botStudioReducers';

test('lazy run transitions preserve inbox state', () => {
  const items = [{ item_id: 'item-1', status: 'pending' } as never];
  const next = setItemStatus(items, 'item-1', 'resolving');
  assert.equal((next[0] as { status: string }).status, 'resolving');
  assert.equal((items[0] as { status: string }).status, 'pending');
});

test('temporary context collapse waits for a selection and the narrow-centre threshold', () => {
  assert.equal(shouldTemporarilyCollapseContext(619, false), true);
  assert.equal(shouldTemporarilyCollapseContext(620, false), false);
  assert.equal(shouldTemporarilyCollapseContext(619, true), false);
  assert.equal(shouldTemporarilyCollapseContext(0, false), false);
});
