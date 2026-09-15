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
