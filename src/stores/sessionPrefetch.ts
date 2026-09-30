/**
 * Bridge for warming a session's first history page before it is opened.
 *
 * The session store lives inside the chat view (one hook instance), while the
 * hover/focus intent comes from the sidebar. The chat view registers a
 * prefetcher; sidebar rows call `scheduleSessionPrefetch` on hover/focus, and
 * a short debounce keeps a mouse sweeping across the list from firing a
 * request per row.
 */
type SessionPrefetcher = (sessionId: string) => void;

export const SESSION_PREFETCH_DELAY_MS = 150;

let prefetcher: SessionPrefetcher | null = null;

export function registerSessionPrefetcher(next: SessionPrefetcher): () => void {
  prefetcher = next;
  return () => {
    if (prefetcher === next) prefetcher = null;
  };
}

export function prefetchSessionHistory(sessionId: string): void {
  prefetcher?.(sessionId);
}

/** Debounced prefetch; returns a cancel function (call on leave/blur/unmount). */
export function scheduleSessionPrefetch(
  sessionId: string,
  delayMs: number = SESSION_PREFETCH_DELAY_MS,
): () => void {
  const timer = setTimeout(() => prefetchSessionHistory(sessionId), delayMs);
  return () => clearTimeout(timer);
}
