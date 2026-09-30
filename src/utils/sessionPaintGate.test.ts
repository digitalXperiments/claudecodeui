import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import {
  abandonSessionOpen,
  beginSessionOpen,
  isSessionPaintGateOpen,
  markSessionPainted,
  resetSessionPaintGateForTests,
  runAfterSessionPaint,
} from './sessionPaintGate';

const settle = () => new Promise((resolve) => setTimeout(resolve, 120));

afterEach(() => resetSessionPaintGateForTests());

test('runs immediately when no session open is pending', () => {
  let ran = 0;
  runAfterSessionPaint(() => { ran += 1; });
  assert.equal(ran, 1);
  assert.equal(isSessionPaintGateOpen(), true);
});

test('holds work until the pending session paints, then runs it', async () => {
  beginSessionOpen('a');
  let ran = 0;
  runAfterSessionPaint(() => { ran += 1; });
  assert.equal(ran, 0);
  markSessionPainted('other');
  await settle();
  assert.equal(ran, 0, 'painting a different session does not release the gate');
  markSessionPainted('a');
  await settle();
  assert.equal(ran, 1);
});

test('cancelled work never runs', async () => {
  beginSessionOpen('a');
  let ran = 0;
  const cancel = runAfterSessionPaint(() => { ran += 1; });
  cancel();
  markSessionPainted('a');
  await settle();
  assert.equal(ran, 0);
});

test('a newer session open keeps the gate closed until it paints', async () => {
  beginSessionOpen('a');
  let ran = 0;
  runAfterSessionPaint(() => { ran += 1; });
  beginSessionOpen('b');
  markSessionPainted('a');
  await settle();
  assert.equal(ran, 0);
  markSessionPainted('b');
  await settle();
  assert.equal(ran, 1);
});

test('abandoning the open releases waiting work', async () => {
  beginSessionOpen('a');
  let ran = 0;
  runAfterSessionPaint(() => { ran += 1; });
  abandonSessionOpen();
  await settle();
  assert.equal(ran, 1);
});
