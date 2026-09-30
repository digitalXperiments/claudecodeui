import assert from 'node:assert/strict';
import test from 'node:test';

import { createHistoryLoadRunner, type HistoryLoadAttemptOutcome } from './sessionHistoryLoadRunner';

function manualTimers() {
  let now = 0;
  const pending: Array<{ at: number; callback: () => void }> = [];
  return {
    options: {
      now: () => now,
      setTimer: (callback: () => void, ms: number) => {
        const entry = { at: now + ms, callback };
        pending.push(entry);
        return entry;
      },
      clearTimer: (handle: unknown) => {
        const index = pending.indexOf(handle as (typeof pending)[number]);
        if (index >= 0) pending.splice(index, 1);
      },
    },
    delays: [] as number[],
    async advance(ms: number) {
      const target = now + ms;
      await flush();
      for (;;) {
        pending.sort((a, b) => a.at - b.at);
        const next = pending[0];
        if (!next || next.at > target) break;
        pending.shift();
        now = next.at;
        next.callback();
        await flush();
      }
      now = target;
    },
    get pendingCount() { return pending.length; },
  };
}

const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

test('an effect re-run mid-fetch does not strand the load (provider switch race)', async () => {
  const runner = createHistoryLoadRunner();
  const response = deferred<HistoryLoadAttemptOutcome>();
  const results: string[] = [];
  runner.start('s1', () => response.promise, (result) => results.push(result));
  // Old behaviour: the effect cleanup cancelled here and the re-run took the
  // alreadyLoaded shortcut. The runner has no per-effect cancellation.
  assert.equal(runner.inFlightKey, 's1');
  response.resolve('applied');
  await flush();
  assert.deepEqual(results, ['applied']);
  assert.equal(runner.inFlightKey, null);
});

test('a newer session load or cancel invalidates the older request', async () => {
  const runner = createHistoryLoadRunner();
  const first = deferred<HistoryLoadAttemptOutcome>();
  const results: string[] = [];
  runner.start('s1', () => first.promise, (result) => results.push(`s1:${result}`));
  runner.start('s2', async () => 'applied', (result) => results.push(`s2:${result}`));
  first.resolve('applied');
  await flush();
  assert.deepEqual(results, ['s2:applied']);

  const third = deferred<HistoryLoadAttemptOutcome>();
  runner.start('s3', () => third.promise, (result) => results.push(`s3:${result}`));
  runner.cancel();
  third.resolve('applied');
  await flush();
  assert.deepEqual(results, ['s2:applied']);
});

test('errors retry with backoff and then succeed', async () => {
  const timers = manualTimers();
  const runner = createHistoryLoadRunner(timers.options);
  const outcomes: HistoryLoadAttemptOutcome[] = ['error', 'error', 'applied'];
  const attempts: number[] = [];
  const results: string[] = [];
  runner.start('s1', async (index) => { attempts.push(index); return outcomes[index]; }, (r) => results.push(r));
  await flush();
  assert.deepEqual(attempts, [0]);
  await timers.advance(499);
  assert.deepEqual(attempts, [0]);
  await timers.advance(1);
  assert.deepEqual(attempts, [0, 1]);
  await timers.advance(1000);
  assert.deepEqual(attempts, [0, 1, 2]);
  assert.deepEqual(results, ['applied']);
});

test('persistent errors end in failed (retry UI), thrown attempts count as errors', async () => {
  const timers = manualTimers();
  const runner = createHistoryLoadRunner(timers.options);
  const results: string[] = [];
  let attempts = 0;
  runner.start('s1', async () => { attempts++; throw new Error('boom'); }, (r) => results.push(r));
  await timers.advance(60_000);
  assert.equal(attempts, 5);
  assert.deepEqual(results, ['failed']);
});

test('pending history keeps retrying inside the budget, then reports unavailable', async () => {
  const timers = manualTimers();
  const runner = createHistoryLoadRunner(timers.options);
  const results: string[] = [];
  let attempts = 0;
  runner.start('s1', async () => { attempts++; return 'pending'; }, (r) => results.push(r));
  await timers.advance(10_000);
  assert.deepEqual(results, []);
  await timers.advance(40_000);
  assert.deepEqual(results, ['unavailable']);
  assert.ok(attempts >= 8, `retried ${attempts} times`);
  assert.equal(timers.pendingCount, 0);
});

test('pending that becomes available is applied; switching sessions stops retries', async () => {
  const timers = manualTimers();
  const runner = createHistoryLoadRunner(timers.options);
  const results: string[] = [];
  let calls = 0;
  runner.start('s1', async () => (++calls < 3 ? 'pending' : 'applied'), (r) => results.push(r));
  await timers.advance(5000);
  assert.deepEqual(results, ['applied']);

  runner.start('s2', async () => 'pending', (r) => results.push(r));
  await flush();
  runner.cancel();
  await timers.advance(60_000);
  assert.deepEqual(results, ['applied']);
});
