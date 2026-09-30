import { useCallback, useRef, useSyncExternalStore } from 'react';

/**
 * One shared minute clock for relative-time labels in the sidebar.
 *
 * Components read a DERIVED value through `useMinuteClockValue` (e.g. "5m",
 * or whether a session is still "recent"), so each re-renders only when its
 * own value changes — instead of a parent-held `currentTime` state that
 * re-rendered every row every minute and defeated their memo.
 */
const TICK_MS = 60_000;

let now = Date.now();
let timer: ReturnType<typeof setInterval> | null = null;
const listeners = new Set<() => void>();

const emit = () => {
  for (const listener of [...listeners]) listener();
};

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (!timer) {
    // Catch up after an idle period with no subscribers.
    const current = Date.now();
    if (current - now >= 1000) {
      now = current;
      queueMicrotask(emit);
    }
    timer = setInterval(() => {
      now = Date.now();
      emit();
    }, TICK_MS);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

export function getMinuteClockNow(): number {
  return now;
}

/** `compute` must return a primitive (compared with Object.is). */
export function useMinuteClockValue<T extends string | number | boolean | null>(compute: (nowMs: number) => T): T {
  const computeRef = useRef(compute);
  computeRef.current = compute;
  const getSnapshot = useCallback(() => computeRef.current(now), []);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
