import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { clearSharedRequests, invalidateSharedRequest, sharedRequest } from './requestCache';

afterEach(() => clearSharedRequests());

test('concurrent callers share one in-flight request', async () => {
  let calls = 0;
  const fetcher = async () => { calls += 1; return calls; };
  const [a, b] = await Promise.all([sharedRequest('k', fetcher), sharedRequest('k', fetcher)]);
  assert.equal(calls, 1);
  assert.equal(a, 1);
  assert.equal(b, 1);
});

test('settled values are reused within the TTL and refetched after it', async () => {
  let calls = 0;
  const fetcher = async () => { calls += 1; return calls; };
  assert.equal(await sharedRequest('k', fetcher, { ttlMs: 1_000 }), 1);
  assert.equal(await sharedRequest('k', fetcher, { ttlMs: 1_000 }), 1);
  assert.equal(await sharedRequest('k', fetcher, { ttlMs: 1_000, force: true }), 2);
  assert.equal(await sharedRequest('z', fetcher, { ttlMs: 0 }), 3);
  assert.equal(await sharedRequest('z', fetcher, { ttlMs: 0 }), 4, 'ttl 0 dedupes in-flight only');
});

test('failures are not cached', async () => {
  let calls = 0;
  const failing = async () => { calls += 1; throw new Error('boom'); };
  await assert.rejects(sharedRequest('k', failing));
  await assert.rejects(sharedRequest('k', failing));
  assert.equal(calls, 2);
});

test('invalidation by key and by prefix', async () => {
  let calls = 0;
  const fetcher = async () => { calls += 1; return calls; };
  await sharedRequest('meta:a', fetcher, { ttlMs: 10_000 });
  await sharedRequest('meta:b', fetcher, { ttlMs: 10_000 });
  invalidateSharedRequest('meta:a');
  assert.equal(await sharedRequest('meta:a', fetcher, { ttlMs: 10_000 }), 3);
  invalidateSharedRequest('meta:*');
  assert.equal(await sharedRequest('meta:b', fetcher, { ttlMs: 10_000 }), 4);
});
