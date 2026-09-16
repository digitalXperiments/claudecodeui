import assert from 'node:assert/strict';
import test from 'node:test';

import { filterActivityRows, pageActivityRows, sortActivityRows } from './activitySelectors';

const rows = [
  { botId: 'a', run: { run_id: '1', status: 'failed', started_at: '2026-09-16T02:00:00Z' } },
  { botId: 'b', run: { run_id: '2', status: 'completed', started_at: '2026-09-16T03:00:00Z' } },
  { botId: 'c', run: { run_id: '3', status: 'skipped', started_at: '2026-09-16T01:00:00Z' } },
];

test('activity selectors filter, sort, and page', () => {
  assert.equal(filterActivityRows(rows, 'failed').length, 1);
  assert.equal(filterActivityRows(rows, 'completed').length, 1);
  assert.equal(filterActivityRows(rows, 'noop').length, 1);
  assert.deepEqual(sortActivityRows(rows).map((row) => row.run.run_id), ['2', '1', '3']);
  assert.deepEqual(pageActivityRows(sortActivityRows(rows), 2, 2).map((row) => row.run.run_id), ['2', '1', '3']);
});
