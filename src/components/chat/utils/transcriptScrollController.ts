import { captureScrollPosition, resolveScrollAnchor, type ScrollRestoreState } from './transcriptScroll';

/** One owner for scroll intent and layout correction, independent of provider. */
export function createTranscriptScrollController(
  container: HTMLDivElement,
  onReadingChange: (reading: boolean) => void,
  isSuppressed: () => boolean = () => false,
  onUserIntent: () => void = () => {},
  /** Every scroll event, after classification; `programmatic` = our own write. */
  onScrollObserved: (programmatic: boolean) => void = () => {},
) {
  let following = true;
  let position: ScrollRestoreState | null = null;
  let writtenTop: number | null = null;
  let upwardIntent = false;
  let revision = 0;
  const capture = () => { position = captureScrollPosition(container); };
  const setReading = (reading: boolean) => {
    if (following === !reading) return;
    following = !reading;
    onReadingChange(reading);
  };
  const write = (top: number) => {
    container.scrollTop = top;
    writtenTop = container.scrollTop;
  };
  // A downward/neutral input seen before its scroll event. If the viewport
  // moves up before that scroll is delivered (scrollbar drag), reconcile must
  // treat it as reading instead of snapping back to the bottom.
  let pendingIntent = false;
  const interrupt = (upward = true) => {
    revision++;
    upwardIntent = upward;
    // Only upward intent leaves follow mode. Downward input at the bottom emits
    // no scroll event, so entering reading here would never resume following
    // and streamed output would grow off-screen.
    if (upward) setReading(true);
    else pendingIntent = true;
    // Input arrives before scroll. Do not restore this viewport coordinate
    // later: reconcile uses document coordinates, preserving subsequent motion.
    capture();
  };
  const userInterrupt = (upward = true) => { interrupt(upward); onUserIntent(); };
  const onScroll = () => {
    const top = container.scrollTop;
    const ownWrite = writtenTop !== null && Math.abs(top - writtenTop) < 0.5;
    if (!ownWrite) {
      const previousTop = position?.top ?? top;
      if (top < previousTop) setReading(true);
      if (!upwardIntent && top > previousTop
        && container.scrollHeight - container.clientHeight - top <= 2) setReading(false);
    }
    writtenTop = null;
    pendingIntent = false;
    capture();
    onScrollObserved(ownWrite);
  };
  const reconcile = () => {
    if (container.clientHeight === 0 || isSuppressed()) return;
    if (following && pendingIntent && position && container.scrollTop < position.top - 0.5) {
      setReading(true);
    }
    if (following) {
      // Assigning scrollTop is not free on every engine (it can interrupt
      // inertial scrolling); skip it when already pinned to the bottom.
      const maxTop = container.scrollHeight - container.clientHeight;
      if (maxTop - container.scrollTop > 0.5) write(container.scrollHeight);
    } else if (position) {
      // Native anchoring is disabled on the pane. Difference in document
      // position measures layout only, even if scrollTop changed before scroll.
      // A remounted anchor row is re-found by its row/member key.
      const anchor = resolveScrollAnchor(container, position);
      if (anchor) {
        const documentTop = anchor.getBoundingClientRect().top
          - container.getBoundingClientRect().top + container.scrollTop;
        const delta = documentTop - (position.anchorTop + position.top);
        // Sub-pixel deltas are rounding noise; writing them only stutters
        // momentum scrolling.
        if (Math.abs(delta) >= 1) write(container.scrollTop + delta);
      }
    }
    capture();
  };
  const jumpToBottom = () => {
    revision++;
    upwardIntent = false;
    pendingIntent = false;
    setReading(false);
    write(container.scrollHeight);
    capture();
  };
  const wheel = (event: WheelEvent) => {
    if (event.deltaY !== 0) userInterrupt(event.deltaY < 0);
  };
  let touchY: number | null = null;
  const touchStart = (event: TouchEvent) => {
    touchY = event.touches[0]?.clientY ?? null;
    // Direction is unknown until the finger moves; a tap must not stop following.
    userInterrupt(false);
  };
  const touchMove = (event: TouchEvent) => {
    const nextY = event.touches[0]?.clientY ?? null;
    if (touchY !== null && nextY !== null && nextY !== touchY) {
      upwardIntent = nextY > touchY;
      if (upwardIntent) setReading(true);
    }
    touchY = nextY;
  };
  const keyDown = (event: KeyboardEvent) => {
    const target = event.target as HTMLElement;
    if (target.closest('input, textarea, select, [contenteditable="true"]')) return;
    if (['ArrowUp', 'PageUp', 'Home'].includes(event.key) || (event.key === ' ' && event.shiftKey)) userInterrupt();
    if (event.key === 'End') { jumpToBottom(); onUserIntent(); return; }
    if (['ArrowDown', 'PageDown'].includes(event.key) || (event.key === ' ' && !event.shiftKey)) userInterrupt(false);
  };
  const pointerDown = (event: PointerEvent) => {
    // Scrollbar dragging targets the pane itself; clicking message controls
    // must not change follow intent.
    if (event.target === container) userInterrupt(false);
  };
  container.addEventListener('scroll', onScroll, { passive: true });
  container.addEventListener('wheel', wheel, { passive: true });
  container.addEventListener('touchstart', touchStart, { passive: true });
  container.addEventListener('touchmove', touchMove, { passive: true });
  container.addEventListener('keydown', keyDown);
  container.addEventListener('pointerdown', pointerDown);
  capture();
  return {
    reconcile, jumpToBottom, interrupt, capture,
    get revision() { return revision; },
    get following() { return following; },
    setReading(reading: boolean) { if (reading) interrupt(); else jumpToBottom(); },
    dispose() {
      container.removeEventListener('scroll', onScroll);
      container.removeEventListener('wheel', wheel);
      container.removeEventListener('touchstart', touchStart);
      container.removeEventListener('touchmove', touchMove);
      container.removeEventListener('keydown', keyDown);
      container.removeEventListener('pointerdown', pointerDown);
    },
  };
}
