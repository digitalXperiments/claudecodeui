import assert from 'node:assert/strict';
import test from 'node:test';

import { mapLimit } from './concurrency';

test('mapLimit preserves order and never exceeds the limit', async () => {
  let active = 0;
  let peak = 0;
  const results = await mapLimit([5, 1, 4, 2, 3, 6], 2, async (n) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, n));
    active -= 1;
    return n * 10;
  });
  assert.deepEqual(results, [50, 10, 40, 20, 30, 60]);
  assert.ok(peak <= 2);
});

test('mapLimit handles empty input and a non-positive limit', async () => {
  assert.deepEqual(await mapLimit([], 4, async (n: number) => n), []);
  assert.deepEqual(await mapLimit([1, 2], 0, async (n) => n + 1), [2, 3]);
});

test('mapLimit rejects when a task throws', async () => {
  await assert.rejects(mapLimit([1, 2, 3], 2, async (n) => { if (n === 2) throw new Error('nope'); return n; }), /nope/);
});
