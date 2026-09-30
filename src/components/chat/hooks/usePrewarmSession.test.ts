import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PREWARM_CLIENT_REPEAT_MS,
  PREWARM_DWELL_MS,
  PREWARM_FOCUS_DEBOUNCE_MS,
  createPrewarmController,
  type PrewarmTarget,
} from './usePrewarmSession';

function setup(initial: Partial<PrewarmTarget> = {}) {
  let target: PrewarmTarget = {
    sessionId: 's1',
    provider: 'claude',
    projectId: 'p1',
    isProcessing: false,
    readOnly: false,
    ...initial,
  };
  let clock = 0;
  let options: Record<string, unknown> = { model: 'sonnet' };
  const timers = new Map<number, { fn: () => void; at: number }>();
  let seq = 0;
  const sent: Array<Record<string, unknown>> = [];
  const controller = createPrewarmController({
    getTarget: () => target,
    buildOptions: () => options,
    sendMessage: (message) => {
      sent.push(message as Record<string, unknown>);
      return true;
    },
    now: () => clock,
    setTimer: (fn, ms) => {
      const id = ++seq;
      timers.set(id, { fn, at: clock + ms });
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: (id) => {
      timers.delete(id as unknown as number);
    },
    isDisabled: () => false,
  });
  const advance = (ms: number) => {
    clock += ms;
    for (const [id, timer] of [...timers]) {
      if (timer.at <= clock) {
        timers.delete(id);
        timer.fn();
      }
    }
  };
  return {
    controller,
    sent,
    advance,
    setTarget: (next: Partial<PrewarmTarget>) => {
      target = { ...target, ...next };
    },
    setOptions: (next: Record<string, unknown>) => {
      options = next;
    },
  };
}

test('prewarms a Claude session after the dwell with the send options', () => {
  const { controller, sent, advance } = setup();
  controller.sessionOpened('s1');
  advance(PREWARM_DWELL_MS - 1);
  assert.equal(sent.length, 0);
  advance(1);
  assert.deepEqual(sent, [{
    type: 'chat.prewarm',
    sessionId: 's1',
    expectedProvider: 'claude',
    expectedProjectId: 'p1',
    options: { model: 'sonnet' },
  }]);
});

test('navigating away before the dwell cancels the prewarm', () => {
  const { controller, sent, advance, setTarget } = setup();
  controller.sessionOpened('s1');
  advance(300);
  setTarget({ sessionId: 's2' });
  controller.sessionOpened('s2');
  advance(PREWARM_DWELL_MS);
  assert.deepEqual(sent.map((m) => m.sessionId), ['s2']);

  controller.sessionOpened(null);
  advance(PREWARM_DWELL_MS * 2);
  assert.equal(sent.length, 1);
});

test('skips non-Claude, unsaved, running and read-only sessions', () => {
  for (const target of [
    { provider: 'codex' },
    { sessionId: null },
    { isProcessing: true },
    { readOnly: true },
  ] as Array<Partial<PrewarmTarget>>) {
    const { controller, sent, advance } = setup(target);
    controller.sessionOpened(target.sessionId === null ? null : 's1');
    controller.focused();
    advance(PREWARM_DWELL_MS);
    assert.equal(sent.length, 0, JSON.stringify(target));
  }
});

test('focus re-triggers (debounced) but identical repeats are held back', () => {
  const { controller, sent, advance, setOptions } = setup();
  controller.sessionOpened('s1');
  advance(PREWARM_DWELL_MS);
  assert.equal(sent.length, 1);

  controller.focused();
  controller.focused();
  advance(PREWARM_FOCUS_DEBOUNCE_MS);
  assert.equal(sent.length, 1, 'same options within the repeat window');

  setOptions({ model: 'opus' });
  controller.focused();
  advance(PREWARM_FOCUS_DEBOUNCE_MS);
  assert.equal(sent.length, 2, 'changed options go out');

  advance(PREWARM_CLIENT_REPEAT_MS);
  controller.focused();
  advance(PREWARM_FOCUS_DEBOUNCE_MS);
  assert.equal(sent.length, 3, 'after the window a repeat is allowed');
});

test('dispose cancels pending timers', () => {
  const { controller, sent, advance } = setup();
  controller.sessionOpened('s1');
  controller.focused();
  controller.dispose();
  advance(PREWARM_DWELL_MS * 2);
  assert.equal(sent.length, 0);
});
