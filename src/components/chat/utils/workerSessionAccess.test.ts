import assert from 'node:assert/strict';
import test from 'node:test';

import { guardWhenReadOnly, resolveReadOnlyWorkerSession } from './workerSessionAccess';

test('resolveReadOnlyWorkerSession: public session with no hint stays interactive', () => {
  const readOnly = resolveReadOnlyWorkerSession({
    selectedSession: { id: 'sess_1', isInternal: false },
    routeSessionId: 'sess_1',
    navigationHint: null,
  });
  assert.equal(readOnly, false);
});

test('resolveReadOnlyWorkerSession: loaded worker session is read-only', () => {
  const readOnly = resolveReadOnlyWorkerSession({
    selectedSession: { id: 'sess_worker', isInternal: true },
    routeSessionId: 'sess_worker',
    navigationHint: null,
  });
  assert.equal(readOnly, true);
});

test('resolveReadOnlyWorkerSession: fails closed on a same-navigation worker hint before the session loads', () => {
  const readOnly = resolveReadOnlyWorkerSession({
    selectedSession: null,
    routeSessionId: 'sess_worker',
    navigationHint: { isInternal: true },
  });
  assert.equal(readOnly, true, 'must not flicker enabled while the routed session is still loading');
});

test('resolveReadOnlyWorkerSession: never trusts an unscoped hint once the routed session has confirmed public', () => {
  const readOnly = resolveReadOnlyWorkerSession({
    // Simulates a hint left in location.state that names no session, now
    // overridden by a freshly loaded public session matching the route.
    selectedSession: { id: 'sess_worker', isInternal: false },
    routeSessionId: 'sess_worker',
    navigationHint: { isInternal: true },
  });
  assert.equal(readOnly, false, 'the loaded session is the source of truth once it matches the route');
});

test('resolveReadOnlyWorkerSession: an id-scoped hint outranks the placeholder session synthesized for an unknown route id', () => {
  // useProjectsState mints a placeholder selectedSession for a routed id it
  // has not heard of yet, and that placeholder carries isInternal: false
  // until /meta resolves. The relay panel's own hint must win in that window,
  // otherwise the composer flickers fully interactive on a worker transcript.
  const readOnly = resolveReadOnlyWorkerSession({
    selectedSession: { id: 'sess_worker', isInternal: false },
    routeSessionId: 'sess_worker',
    navigationHint: { isInternal: true, workerSessionId: 'sess_worker' },
  });
  assert.equal(readOnly, true);
});

test('resolveReadOnlyWorkerSession: an id-scoped hint for a different session does not leak onto this route', () => {
  const readOnly = resolveReadOnlyWorkerSession({
    selectedSession: { id: 'sess_public', isInternal: false },
    routeSessionId: 'sess_public',
    navigationHint: { isInternal: true, workerSessionId: 'sess_some_other_worker' },
  });
  assert.equal(readOnly, false);
});

test('resolveReadOnlyWorkerSession: an id-scoped hint keeps the gate closed before any session has loaded', () => {
  const readOnly = resolveReadOnlyWorkerSession({
    selectedSession: null,
    routeSessionId: 'sess_worker',
    navigationHint: { isInternal: true, workerSessionId: 'sess_worker' },
  });
  assert.equal(readOnly, true);
});

test('resolveReadOnlyWorkerSession: a hint that only carries openAgentRelay never gates anything', () => {
  // location.state is shared with the relay panel's own "open on arrival"
  // flag, so a state object without isInternal must stay interactive.
  const readOnly = resolveReadOnlyWorkerSession({
    selectedSession: { id: 'sess_lead', isInternal: false },
    routeSessionId: 'sess_lead',
    navigationHint: { workerSessionId: 'sess_lead' } as { isInternal?: boolean; workerSessionId?: string },
  });
  assert.equal(readOnly, false);
});

test('resolveReadOnlyWorkerSession: a null session on a route with no hint stays interactive', () => {
  const readOnly = resolveReadOnlyWorkerSession({
    selectedSession: null,
    routeSessionId: 'sess_public',
    navigationHint: null,
  });
  assert.equal(readOnly, false, 'an unloaded ordinary session must not be locked out');
});

test('resolveReadOnlyWorkerSession: a session without an id cannot match the route and falls through', () => {
  const readOnly = resolveReadOnlyWorkerSession({
    selectedSession: { isInternal: true },
    routeSessionId: 'sess_worker',
    navigationHint: null,
  });
  assert.equal(readOnly, true, 'an id-less worker session still fails closed');
});

test('resolveReadOnlyWorkerSession: a stale worker session on a draft route (no route id) fails closed', () => {
  const readOnly = resolveReadOnlyWorkerSession({
    selectedSession: { id: 'sess_worker', isInternal: true },
    routeSessionId: null,
    navigationHint: null,
  });
  assert.equal(readOnly, true);
});

test('resolveReadOnlyWorkerSession: fails closed while navigating away from a worker session mid-transition', () => {
  // selectedSession still describes the previous (worker) session while the
  // route has already moved on to a different id — must stay read-only
  // until the new session actually loads and confirms otherwise.
  const readOnly = resolveReadOnlyWorkerSession({
    selectedSession: { id: 'sess_worker_old', isInternal: true },
    routeSessionId: 'sess_public_new',
    navigationHint: null,
  });
  assert.equal(readOnly, true);
});

test('resolveReadOnlyWorkerSession: brand-new draft with no session or hint stays interactive', () => {
  const readOnly = resolveReadOnlyWorkerSession({
    selectedSession: null,
    routeSessionId: null,
    navigationHint: null,
  });
  assert.equal(readOnly, false);
});

test('guardWhenReadOnly: blocks the underlying handler when read-only', () => {
  let calls = 0;
  const submit = (value: string) => { calls += 1; return value; };

  const guarded = guardWhenReadOnly(true, submit);
  const result = guarded('hello');

  assert.equal(calls, 0, 'the real handler must never fire while read-only');
  assert.equal(result, undefined);
});

test('guardWhenReadOnly: passes calls straight through when interactive', () => {
  let received: string | null = null;
  const submit = (value: string) => { received = value; };

  const guarded = guardWhenReadOnly(false, submit);
  guarded('hello');

  assert.equal(received, 'hello');
});

test('guardWhenReadOnly: an absent handler passes through untouched either way', () => {
  assert.equal(guardWhenReadOnly(true, undefined), undefined);
  assert.equal(guardWhenReadOnly(false, undefined), undefined);
});

test('guardWhenReadOnly: returns a stable no-op reference so repeated calls do not re-render', () => {
  const submit = () => undefined;
  const first = guardWhenReadOnly(true, submit);
  const second = guardWhenReadOnly(true, submit);
  assert.equal(first, second);
});
