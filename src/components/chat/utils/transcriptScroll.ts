export interface ScrollRestoreState {
  height: number;
  top: number;
  anchor: Element | null;
  anchorTop: number;
  /** `data-row-key` of the anchor row, to re-find it after a remount. */
  anchorKey?: string | null;
  /** Member message keys of a grouped anchor row (`data-row-members`). */
  anchorMemberKeys?: string[];
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
  const members = anchor?.getAttribute?.('data-row-members');
  return {
    height: container.scrollHeight,
    top: container.scrollTop,
    anchor,
    anchorTop: anchor ? anchor.getBoundingClientRect().top - top : 0,
    anchorKey: anchor?.getAttribute?.('data-row-key') ?? null,
    anchorMemberKeys: members ? members.split(' ').filter(Boolean) : [],
  };
}

const escapeAttributeValue = (value: string) => (
  typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
    ? CSS.escape(value)
    : value.replace(/["\\]/g, '\\$&')
);

/**
 * The anchor row, or — when React remounted it under a new element (a tool
 * group re-keyed by a prepend, a single tool row absorbed into a group, a row
 * re-keyed by a history re-read) — the row now carrying the same key or one
 * of the same member messages. Member keys are URI-encoded in the attribute.
 */
export function resolveScrollAnchor(container: HTMLDivElement, position: ScrollRestoreState): Element | null {
  if (position.anchor?.isConnected) return position.anchor;
  if (typeof container.querySelector !== 'function') return null;
  const byKey = (key: string) => container.querySelector(`[data-row-key="${escapeAttributeValue(key)}"]`);
  const byMember = (encoded: string) => container.querySelector(`[data-row-members~="${escapeAttributeValue(encoded)}"]`);
  if (position.anchorKey) {
    const match = byKey(position.anchorKey) ?? byMember(encodeURIComponent(position.anchorKey));
    if (match) return match;
  }
  for (const encoded of position.anchorMemberKeys ?? []) {
    let decoded = encoded;
    try { decoded = decodeURIComponent(encoded); } catch { /* keep encoded */ }
    const match = byMember(encoded) ?? byKey(decoded);
    if (match) return match;
  }
  return null;
}

export function restoreScrollPosition(container: HTMLDivElement, position: ScrollRestoreState): void {
  const { height, top, anchor, anchorTop } = position;
  container.scrollTop = anchor?.isConnected
    ? container.scrollTop + anchor.getBoundingClientRect().top - container.getBoundingClientRect().top - anchorTop
    : top + container.scrollHeight - height;
}
