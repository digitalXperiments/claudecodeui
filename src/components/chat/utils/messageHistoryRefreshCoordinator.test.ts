import assert from 'node:assert/strict';
import test from 'node:test';

import { createMessageHistoryRefreshCoordinator } from './messageHistoryRefreshCoordinator';

type Deferred = {
  promise: Promise<boolean | void>;
  resolve: (value?: boolean | void) => void;
  reject: (error: unknown) => void;
};

function createDeferred(): Deferred {
  let resolve!: (value?: boolean | void) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<boolean | void>((res, rej) => {
    resolve = res as (value?: boolean | void) => void;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createHarness({ visible = true }: { visible?: boolean } = {}) {
  const state = { visible };
  const calls: string[] = [];
  const pendingExecutions: Deferred[] = [];

  const coordinator = createMessageHistoryRefreshCoordinator(
    (sessionId) => {
      calls.push(sessionId);
      const deferred = createDeferred();
      pendingExecutions.push(deferred);
      return deferred.promise;
    },
    () => state.visible,
  );

  return { coordinator, state, calls, pendingExecutions };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test('visible request executes exactly one refresh', async () => {
  const { coordinator, calls, pendingExecutions } = createHarness();

  const request = coordinator.request('s1');
  assert.equal(calls.length, 1);
  pendingExecutions[0].resolve();
  await request;

  assert.equal(calls.length, 1);
  assert.equal(coordinator.hasPending('s1'), false);
});

test('hidden sessions are marked dirty instead of fetched', async () => {
  const { coordinator, calls } = createHarness({ visible: false });

  await coordinator.request('s1');
  assert.equal(calls.length, 0);
  assert.equal(coordinator.hasPending('s1'), true);

  // allowNetwork=false defers even when canRefreshNow would allow it.
  const allowNetworkFalse = createHarness({ visible: true });
  await allowNetworkFalse.coordinator.request('s2', false);
  assert.equal(allowNetworkFalse.calls.length, 0);
  assert.equal(allowNetworkFalse.coordinator.hasPending('s2'), true);
});

test('a burst of requests collapses to the current fetch plus one trailing fetch', async () => {
  const { coordinator, calls, pendingExecutions } = createHarness();

  const first = coordinator.request('s1');
  // Five more signals arrive while the first request is in flight.
  void coordinator.request('s1');
  void coordinator.request('s1');
  void coordinator.request('s1');
  void coordinator.request('s1');
  void coordinator.request('s1');
  assert.equal(calls.length, 1);

  pendingExecutions[0].resolve();
  await settle();

  // The drain loop issued exactly one trailing request for the whole burst.
  assert.equal(calls.length, 2);
  pendingExecutions[1].resolve();
  await first;
  await settle();
  assert.equal(calls.length, 2);
  assert.equal(coordinator.hasPending('s1'), false);
});

test('executor returning false re-queues the session (deferred mid-flight)', async () => {
  const { coordinator, calls, pendingExecutions } = createHarness();

  const request = coordinator.request('s1');
  pendingExecutions[0].resolve(false);
  await request;

  assert.equal(calls.length, 1);
  assert.equal(coordinator.hasPending('s1'), true);
});

test('executor failure re-queues the session for the next flush', async () => {
  const { coordinator, calls, pendingExecutions } = createHarness();

  const request = coordinator.request('s1');
  pendingExecutions[0].reject(new Error('network down'));
  await request; // never rejects — failures convert to pending state

  assert.equal(calls.length, 1);
  assert.equal(coordinator.hasPending('s1'), true);
});

test('flushPending runs a dirty session once it is visible again', async () => {
  const { coordinator, state, calls, pendingExecutions } = createHarness({ visible: false });

  await coordinator.request('s1');
  assert.equal(coordinator.hasPending('s1'), true);

  // Still hidden: flush is a no-op.
  await coordinator.flushPending('s1');
  assert.equal(calls.length, 0);

  state.visible = true;
  const flush = coordinator.flushPending('s1');
  assert.equal(calls.length, 1);
  pendingExecutions[0].resolve();
  await flush;
  assert.equal(coordinator.hasPending('s1'), false);
});

test('flushPending is a no-op without a pending signal', async () => {
  const { coordinator, calls } = createHarness();
  await coordinator.flushPending('s1');
  assert.equal(calls.length, 0);
});

test('discardPending clears the dirty mark (superseded by a full page load)', async () => {
  const { coordinator, calls } = createHarness({ visible: false });

  await coordinator.request('s1');
  assert.equal(coordinator.hasPending('s1'), true);

  coordinator.discardPending('s1');
  assert.equal(coordinator.hasPending('s1'), false);
  await coordinator.flushPending('s1');
  assert.equal(calls.length, 0);
});

test('sessions are coalesced independently', async () => {
  const { coordinator, calls, pendingExecutions } = createHarness();

  const a = coordinator.request('a');
  const b = coordinator.request('b');
  assert.deepEqual(calls, ['a', 'b']);

  pendingExecutions[0].resolve();
  pendingExecutions[1].resolve();
  await Promise.all([a, b]);
  assert.equal(coordinator.hasPending('a'), false);
  assert.equal(coordinator.hasPending('b'), false);
});

test('a request while hidden then a visible request drains the dirty mark too', async () => {
  const { coordinator, state, calls, pendingExecutions } = createHarness({ visible: false });

  await coordinator.request('s1');
  state.visible = true;

  const request = coordinator.request('s1');
  assert.equal(calls.length, 1);
  pendingExecutions[0].resolve();
  await request;
  await settle();

  // The visible request consumed the dirty mark; nothing further is pending.
  assert.equal(coordinator.hasPending('s1'), false);
});
