import assert from 'node:assert/strict';
import test from 'node:test';

import { createRunSeqCursor, trackRunSeq } from './runSeqCursor';

test('the cursor tracks the highest seq of a run', () => {
  const cursor = createRunSeqCursor();
  trackRunSeq(cursor, 's', 'text', 1);
  trackRunSeq(cursor, 's', 'text', 3);
  trackRunSeq(cursor, 's', 'text', 2);
  assert.equal(cursor.lastSeq.get('s'), 3);
});

test('a straggler after complete cannot push the cursor past the next run', () => {
  const cursor = createRunSeqCursor();
  trackRunSeq(cursor, 's', 'text', 1);
  trackRunSeq(cursor, 's', 'complete', 2);
  assert.equal(cursor.lastSeq.has('s'), false);

  // Late token_budget from the finished run (older server builds sequenced it).
  trackRunSeq(cursor, 's', 'status', 3);
  assert.equal(cursor.lastSeq.has('s'), false);

  // The next run restarts at seq 1 and resumes tracking.
  trackRunSeq(cursor, 's', 'text', 1);
  trackRunSeq(cursor, 's', 'text', 2);
  assert.equal(cursor.lastSeq.get('s'), 2);
});

test('sessions are tracked independently', () => {
  const cursor = createRunSeqCursor();
  trackRunSeq(cursor, 'a', 'complete', 4);
  trackRunSeq(cursor, 'b', 'text', 5);
  trackRunSeq(cursor, 'a', 'text', 5);
  assert.equal(cursor.lastSeq.get('b'), 5);
  assert.equal(cursor.lastSeq.has('a'), false);
});
