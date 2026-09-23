import assert from 'node:assert/strict';
import test from 'node:test';

import { createTranscriptScrollController } from './transcriptScrollController';

function fixture() {
  const target = new EventTarget();
  let above = 0;
  const changes: boolean[] = [];
  const container = Object.assign(target, {
    scrollTop: 1000, scrollHeight: 1500, clientHeight: 500,
    getBoundingClientRect: () => ({ top: 0 }),
    querySelectorAll: () => rows,
  });
  const rows = Array.from({ length: 15 }, (_, i) => ({
    isConnected: true,
    getBoundingClientRect: () => ({ top: i * 100 + above - container.scrollTop, bottom: (i + 1) * 100 + above - container.scrollTop }),
  }));
  const controller = createTranscriptScrollController(container as unknown as HTMLDivElement, value => changes.push(value));
  const wheel = (deltaY: number) => container.dispatchEvent(Object.assign(new Event('wheel'), { deltaY }));
  return { container, controller, wheel, changes, grow: (height: number) => { above += height; container.scrollHeight += height; } };
}

test('small upward gesture disables following even within the old 100px threshold', () => {
  const f = fixture();
  f.wheel(-20);
  f.container.scrollTop -= 20;
  f.container.dispatchEvent(new Event('scroll'));
  f.container.scrollHeight += 300;
  f.controller.reconcile();
  assert.equal(f.container.scrollTop, 980);
  assert.equal(f.controller.following, false);
  f.controller.dispose();
});

test('resize before scroll delivery preserves user movement and compensates only layout', () => {
  const f = fixture();
  f.wheel(-200);
  f.container.scrollTop = 800;
  f.grow(70);
  f.controller.reconcile();
  assert.equal(f.container.scrollTop, 870);
  f.controller.reconcile();
  assert.equal(f.container.scrollTop, 870);
  f.container.dispatchEvent(new Event('scroll'));
  f.controller.reconcile();
  assert.equal(f.container.scrollTop, 870);
  f.controller.dispose();
});

test('scrollbar movement without wheel cannot be undone by resize', () => {
  const f = fixture();
  f.controller.interrupt(false);
  f.container.scrollTop = 500;
  f.controller.reconcile();
  assert.equal(f.container.scrollTop, 500);
  f.controller.dispose();
});

test('only returning to the bottom or an explicit jump resumes following', () => {
  const f = fixture();
  f.wheel(-100);
  f.container.scrollTop = 900;
  f.container.dispatchEvent(new Event('scroll'));
  f.wheel(50);
  f.container.scrollTop = 950;
  f.container.dispatchEvent(new Event('scroll'));
  assert.equal(f.controller.following, false);
  f.wheel(50);
  f.container.scrollTop = 1000;
  f.container.dispatchEvent(new Event('scroll'));
  assert.equal(f.controller.following, true);
  f.controller.interrupt();
  const revision = f.controller.revision;
  f.controller.jumpToBottom();
  assert.equal(f.controller.following, true);
  assert.ok(f.controller.revision > revision);
  f.controller.dispose();
});

test('user input invalidates pending navigation even when already reading history', () => {
  const f = fixture();
  f.controller.interrupt();
  const navigationRevision = f.controller.revision;
  f.wheel(-1);
  assert.ok(f.controller.revision > navigationRevision);
  f.controller.dispose();
});

test('hidden panes do not alter scroll position during layout notifications', () => {
  const f = fixture();
  f.container.clientHeight = 0;
  f.container.scrollHeight += 700;
  f.controller.reconcile();
  assert.equal(f.container.scrollTop, 1000);
  f.controller.dispose();
});

test('a remounted anchor row is re-found by key so prepends still preserve the view', () => {
  const target = new EventTarget();
  let above = 0;
  let generation = 0;
  const container = Object.assign(target, {
    scrollTop: 1000, scrollHeight: 1500, clientHeight: 500,
    getBoundingClientRect: () => ({ top: 0 }),
    querySelectorAll: () => rows,
    querySelector: (selector: string) => rows.find((row) => selector.includes(`"${row.key}"`)) ?? null,
  });
  const makeRows = () => Array.from({ length: 15 }, (_, i) => {
    const born = generation;
    return {
      key: `row-${i}`,
      get isConnected() { return born === generation; },
      getAttribute: (name: string) => (name === 'data-row-key' ? `row-${i}` : null),
      getBoundingClientRect: () => ({ top: i * 100 + above - container.scrollTop, bottom: (i + 1) * 100 + above - container.scrollTop }),
    };
  });
  let rows = makeRows();
  const controller = createTranscriptScrollController(container as unknown as HTMLDivElement, () => {});
  container.dispatchEvent(Object.assign(new Event('wheel'), { deltaY: -100 }));
  container.scrollTop = 900;
  container.dispatchEvent(new Event('scroll'));
  // Older page prepended and every row element replaced (re-keyed remount).
  generation++;
  rows = makeRows();
  above += 400;
  container.scrollHeight += 400;
  controller.reconcile();
  assert.equal(container.scrollTop, 1300);
  controller.dispose();
});

test('controller write scrolls are reported as programmatic, user scrolls are not', () => {
  const target = new EventTarget();
  const container = Object.assign(target, {
    scrollTop: 1000, scrollHeight: 1500, clientHeight: 500,
    getBoundingClientRect: () => ({ top: 0 }),
    querySelectorAll: () => [],
  });
  const seen: boolean[] = [];
  const controller = createTranscriptScrollController(
    container as unknown as HTMLDivElement, () => {}, () => false, () => {}, (programmatic) => seen.push(programmatic),
  );
  container.scrollHeight = 1800;
  controller.reconcile();
  container.dispatchEvent(new Event('scroll'));
  container.scrollTop = 40;
  container.dispatchEvent(new Event('scroll'));
  assert.deepEqual(seen, [true, false]);
  controller.dispose();
});

test('downward intent at the bottom keeps following so streamed output stays visible', () => {
  const f = fixture();
  f.wheel(40);
  // Dispatch sets `target` to the container; give it the element lookup keyDown uses.
  Object.assign(f.container, { closest: () => null });
  const key = (k: string) => f.container.dispatchEvent(Object.assign(new Event('keydown'), { key: k, shiftKey: false }));
  key('ArrowDown');
  key('PageDown');
  key(' ');
  f.container.dispatchEvent(Object.assign(new Event('pointerdown'), {}));
  assert.equal(f.controller.following, true);
  f.container.scrollHeight += 400;
  f.controller.reconcile();
  assert.equal(f.container.scrollTop, 1900); // pinned (mock does not clamp)
  assert.deepEqual(f.changes, []);
  f.controller.dispose();
});

test('End jumps to the bottom and resumes following', () => {
  const f = fixture();
  Object.assign(f.container, { closest: () => null });
  f.wheel(-100);
  f.container.scrollTop = 900;
  f.container.dispatchEvent(new Event('scroll'));
  assert.equal(f.controller.following, false);
  f.container.dispatchEvent(Object.assign(new Event('keydown'), { key: 'End' }));
  assert.equal(f.controller.following, true);
  assert.equal(f.container.scrollTop, 1500);
  f.controller.dispose();
});

test('upward keys and touch drags still enter reading mode', () => {
  const f = fixture();
  Object.assign(f.container, { closest: () => null });
  f.container.dispatchEvent(Object.assign(new Event('keydown'), { key: 'PageUp' }));
  assert.equal(f.controller.following, false);
  f.controller.jumpToBottom();
  f.container.dispatchEvent(Object.assign(new Event('touchstart'), { touches: [{ clientY: 100 }] }));
  assert.equal(f.controller.following, true);
  f.container.dispatchEvent(Object.assign(new Event('touchmove'), { touches: [{ clientY: 140 }] }));
  assert.equal(f.controller.following, false);
  f.controller.dispose();
});
