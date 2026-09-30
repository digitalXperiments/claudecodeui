/**
 * "Transcript first" gate for session open.
 *
 * Opening a session used to fire ~35 requests at once; the 7 ms history request
 * then finished at ~1.6 s because the browser's connection pool and the
 * server were saturated by requests nothing on screen needed yet (relay jobs,
 * continuity, TaskMaster, live usage, skills…). Those callers now go through
 * `runAfterSessionPaint`, which runs them right away when no session open is
 * in progress, and otherwise once the transcript has painted and the browser
 * is idle.
 *
 * Ordering: `beginSessionOpen` is called from the history loader's layout
 * effect, and layout effects run before every passive effect of the same
 * commit — so a consumer's `useEffect` always sees the open as pending. Until
 * the loader runs (the URL already points at a session but the session object
 * has not resolved yet), the route itself keeps the gate closed.
 *
 * Every wait is bounded by a fallback timer, so a load that never paints
 * (errors, a hidden pane, a route with no chat view) only delays the deferred
 * work — it never drops it.
 */

type Waiter = () => void;

const FALLBACK_OPEN_MS = 4_000;
const IDLE_TIMEOUT_MS = 500;

let pendingSessionId: string | null = null;
let lastBegunSessionId: string | null = null;
let pendingFallbackTimer: ReturnType<typeof setTimeout> | null = null;
let routeFallbackSessionId: string | null = null;
let routeFallbackTimer: ReturnType<typeof setTimeout> | null = null;
const routeForcedOpen = new Set<string>();
let flushScheduled = false;
const waiters = new Set<Waiter>();

function routeSessionId(): string | null {
  if (typeof window === 'undefined' || !window.location) return null;
  const match = window.location.pathname.match(/\/session\/([^/?#]+)/);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

function routeBlocks(): boolean {
  const routeId = routeSessionId();
  return Boolean(routeId && routeId !== lastBegunSessionId && !routeForcedOpen.has(routeId));
}

export function isSessionPaintGateOpen(): boolean {
  return pendingSessionId === null && !routeBlocks();
}

function flushWaiters(): void {
  if (!isSessionPaintGateOpen()) {
    armRouteFallback();
    return;
  }
  const ready = [...waiters];
  waiters.clear();
  for (const waiter of ready) {
    try {
      waiter();
    } catch (error) {
      console.error('Deferred session work failed:', error);
    }
  }
}

function scheduleIdleFlush(): void {
  if (flushScheduled) return;
  flushScheduled = true;
  const run = () => {
    flushScheduled = false;
    flushWaiters();
  };
  const idle = typeof window !== 'undefined'
    ? (window as Window & { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number }).requestIdleCallback
    : undefined;
  // Let the browser paint the transcript first, then wait for an idle slot.
  const afterFrame = () => {
    if (typeof idle === 'function') idle.call(window, run, { timeout: IDLE_TIMEOUT_MS });
    else setTimeout(run, 50);
  };
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => afterFrame());
  else setTimeout(afterFrame, 16);
}

function armRouteFallback(): void {
  const routeId = routeSessionId();
  if (!routeId || !routeBlocks() || routeFallbackSessionId === routeId) return;
  if (routeFallbackTimer) clearTimeout(routeFallbackTimer);
  routeFallbackSessionId = routeId;
  routeFallbackTimer = setTimeout(() => {
    routeFallbackTimer = null;
    routeForcedOpen.add(routeId);
    scheduleIdleFlush();
  }, FALLBACK_OPEN_MS);
}

/** The transcript for `sessionId` started loading; hold deferred work until it paints. */
export function beginSessionOpen(sessionId: string): void {
  pendingSessionId = sessionId;
  lastBegunSessionId = sessionId;
  if (pendingFallbackTimer) clearTimeout(pendingFallbackTimer);
  pendingFallbackTimer = setTimeout(() => {
    pendingFallbackTimer = null;
    if (pendingSessionId === sessionId) {
      pendingSessionId = null;
      scheduleIdleFlush();
    }
  }, FALLBACK_OPEN_MS);
}

/** The transcript for `sessionId` has rendered (or failed); release deferred work after idle. */
export function markSessionPainted(sessionId: string): void {
  if (pendingSessionId !== sessionId) return;
  pendingSessionId = null;
  if (pendingFallbackTimer) {
    clearTimeout(pendingFallbackTimer);
    pendingFallbackTimer = null;
  }
  scheduleIdleFlush();
}

/** No session is being opened any more (e.g. the user went to a new chat). */
export function abandonSessionOpen(): void {
  if (pendingSessionId === null) return;
  pendingSessionId = null;
  if (pendingFallbackTimer) {
    clearTimeout(pendingFallbackTimer);
    pendingFallbackTimer = null;
  }
  scheduleIdleFlush();
}

/**
 * Run `task` now when no session open is pending, otherwise after the
 * transcript paints and the browser is idle. Returns a cancel function —
 * call it from the effect cleanup so a superseded effect never fires.
 */
export function runAfterSessionPaint(task: () => void): () => void {
  if (isSessionPaintGateOpen()) {
    task();
    return () => undefined;
  }
  const waiter: Waiter = () => task();
  waiters.add(waiter);
  armRouteFallback();
  return () => {
    waiters.delete(waiter);
  };
}

/** Promise flavour for non-React callers (context providers, modules). */
export function whenSessionPainted(): Promise<void> {
  return new Promise((resolve) => {
    runAfterSessionPaint(resolve);
  });
}

/** Test helper: reset module state. */
export function resetSessionPaintGateForTests(): void {
  pendingSessionId = null;
  lastBegunSessionId = null;
  routeFallbackSessionId = null;
  routeForcedOpen.clear();
  waiters.clear();
  flushScheduled = false;
  if (pendingFallbackTimer) clearTimeout(pendingFallbackTimer);
  if (routeFallbackTimer) clearTimeout(routeFallbackTimer);
  pendingFallbackTimer = null;
  routeFallbackTimer = null;
}
