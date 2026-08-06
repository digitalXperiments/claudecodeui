import assert from 'node:assert/strict';
import test from 'node:test';

import { newRunId, newWorkspaceId, ulid } from '@/shared/ids.js';

test('ulid produces 26-char Crockford base32 strings', () => {
  const id = ulid();
  assert.equal(id.length, 26);
  assert.match(id, /^[0-9A-HJKMNP-TV-Z]{26}$/);
});

test('ulid is lexicographically sortable by creation time', () => {
  const earlier = ulid(1_700_000_000_000);
  const later = ulid(1_700_000_000_001);
  assert.ok(earlier < later);
});

test('ulid is unique across large batches', () => {
  const ids = new Set<string>();
  for (let index = 0; index < 5000; index += 1) {
    ids.add(ulid());
  }
  assert.equal(ids.size, 5000);
});

test('prefixed ids carry their entity prefix', () => {
  assert.match(newRunId(), /^run_[0-9A-HJKMNP-TV-Z]{26}$/);
  assert.match(newWorkspaceId(), /^ws_[0-9A-HJKMNP-TV-Z]{26}$/);
});
