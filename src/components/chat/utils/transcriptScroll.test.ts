import assert from 'node:assert/strict';
import test from 'node:test';

import { captureScrollPosition, restoreScrollPosition } from './transcriptScroll';

function fixture() {
  let addedAbove = 0;
  let reads = 0;
  const container = {
    scrollTop: 50000, scrollHeight: 100000, clientHeight: 500,
    getBoundingClientRect: () => ({ top: 10 }),
    querySelectorAll: () => rows,
  };
  const rows = Array.from({ length: 1000 }, (_, index) => ({
    isConnected: true,
    getBoundingClientRect: () => {
      reads++;
      return { top: 10 + index * 100 + addedAbove - container.scrollTop,
        bottom: 110 + index * 100 + addedAbove - container.scrollTop };
    },
  }));
  return { container: container as unknown as HTMLDivElement, rows,
    prepend: (height: number) => { addedAbove += height; container.scrollHeight += height; },
    growBelow: (height: number) => { container.scrollHeight += height; },
    reads: () => reads };
}

test('captures the visible row with logarithmic geometry reads in long history', () => {
  const f = fixture();
  const position = captureScrollPosition(f.container);
  assert.equal(position.anchor, f.rows[500]);
  assert.equal(position.anchorTop, 0);
  assert.ok(f.reads() <= 12);
});

test('restore compensates prepend only, even when a live reply also grows below', () => {
  const f = fixture();
  const position = captureScrollPosition(f.container);
  f.prepend(250);
  f.growBelow(800);
  restoreScrollPosition(f.container, position);
  assert.equal(f.container.scrollTop, 50250);
  // Browser anchoring may already have applied the correction: do not double it.
  restoreScrollPosition(f.container, position);
  assert.equal(f.container.scrollTop, 50250);
});

test('removed anchor falls back to signed height delta', () => {
  const f = fixture();
  const position = captureScrollPosition(f.container);
  f.rows[500].isConnected = false;
  f.growBelow(-100);
  restoreScrollPosition(f.container, position);
  assert.equal(f.container.scrollTop, 49900);
});
