import assert from 'node:assert/strict';
import test from 'node:test';

import { setItemStatus } from './botStudioReducers';

test('lazy run transitions preserve inbox state', () => {
  const items = [{ item_id: 'item-1', status: 'pending' } as never];
  const next = setItemStatus(items, 'item-1', 'resolving');
  assert.equal((next[0] as { status: string }).status, 'resolving');
  assert.equal((items[0] as { status: string }).status, 'pending');
});
