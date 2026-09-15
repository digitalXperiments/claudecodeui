import { captureScrollPosition, type ScrollRestoreState } from './transcriptScroll';

/** One owner for scroll intent and layout correction, independent of provider. */
export function createTranscriptScrollController(
  container: HTMLDivElement,
  onReadingChange: (reading: boolean) => void,
  isSuppressed: () => boolean = () => false,
  onUserIntent: () => void = () => {},
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
  const interrupt = (upward = true) => {
    revision++;
    upwardIntent = upward;
    setReading(true);
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
    capture();
  };
  const reconcile = () => {
    if (container.clientHeight === 0 || isSuppressed()) return;
    if (following) {
      write(container.scrollHeight);
    } else if (position?.anchor?.isConnected) {
      // Native anchoring is disabled on the pane. Difference in document
      // position measures layout only, even if scrollTop changed before scroll.
      const documentTop = position.anchor.getBoundingClientRect().top
        - container.getBoundingClientRect().top + container.scrollTop;
      const delta = documentTop - (position.anchorTop + position.top);
      if (Math.abs(delta) > 0.5) write(container.scrollTop + delta);
    }
    capture();
  };
  const jumpToBottom = () => {
    revision++;
    upwardIntent = false;
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
    userInterrupt();
  };
  const touchMove = (event: TouchEvent) => {
    const nextY = event.touches[0]?.clientY ?? null;
    if (touchY !== null && nextY !== null) upwardIntent = nextY > touchY;
    touchY = nextY;
  };
  const keyDown = (event: KeyboardEvent) => {
    const target = event.target as HTMLElement;
    if (target.closest('input, textarea, select, [contenteditable="true"]')) return;
    if (['ArrowUp', 'PageUp', 'Home'].includes(event.key) || (event.key === ' ' && event.shiftKey)) userInterrupt();
    if (['ArrowDown', 'PageDown', 'End'].includes(event.key) || (event.key === ' ' && !event.shiftKey)) userInterrupt(false);
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
