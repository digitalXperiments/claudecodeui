export interface ScrollRestoreState {
  height: number;
  top: number;
  anchor: Element | null;
  anchorTop: number;
}

export function captureScrollPosition(container: HTMLDivElement): ScrollRestoreState {
  const top = container.getBoundingClientRect().top;
  const rows = container.querySelectorAll('[data-transcript-row]');
  // Rows are in document order. Avoid forcing geometry reads for every older
  // row when a fully loaded transcript contains thousands of placeholders.
  let low = 0;
  let high = rows.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (rows[middle].getBoundingClientRect().bottom <= top) low = middle + 1;
    else high = middle;
  }
  const anchor = rows[low] ?? null;
  return {
    height: container.scrollHeight,
    top: container.scrollTop,
    anchor,
    anchorTop: anchor ? anchor.getBoundingClientRect().top - top : 0,
  };
}

export function restoreScrollPosition(container: HTMLDivElement, position: ScrollRestoreState): void {
  const { height, top, anchor, anchorTop } = position;
  container.scrollTop = anchor?.isConnected
    ? container.scrollTop + anchor.getBoundingClientRect().top - container.getBoundingClientRect().top - anchorTop
    : top + container.scrollHeight - height;
}
