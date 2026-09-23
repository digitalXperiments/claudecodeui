import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import type { ChatMessage } from '../../types/types';
import type { LazyRowObserver } from '../../hooks/useLazyRowObserver';
import type { RowHeightCache } from '../../utils/rowHeightCache';

/**
 * Mounts a transcript row's real content only while the row is near the
 * viewport, and swaps it for a fixed-height placeholder otherwise.
 *
 * The transcript renders every loaded message into the DOM, so "Load all" on a
 * long session used to commit tens of thousands of markdown/tool subtrees at
 * once — a gigabyte-scale tab. The wrapper element here always stays in the
 * DOM (carrying the row's `data-message-timestamp`, so search jumps and scroll
 * anchors keep working against unmounted rows), while the expensive subtree
 * exists only inside a band around the viewport.
 *
 * The placeholder reuses the row's last measured height — kept in a
 * per-session cache that survives remounts and revisits — so scrolling back
 * through previously seen content changes no scroll geometry at all. Rows
 * never yet measured use a content-based estimate, which keeps the one
 * correction on first mount small.
 *
 * This deliberately does NOT use `content-visibility: auto` — its
 * contain-intrinsic-size re-estimates heights while streaming/tool rows grow,
 * which caused whole-pane flicker (see the comment in src/index.css). Here
 * heights are only ever *measured* while content is really in the DOM.
 */

/** Placeholder height for rows that have never been measured and have no estimate. */
const ESTIMATED_ROW_HEIGHT_PX = 100;

type LazyMessageRowProps = {
  lazyRows: LazyRowObserver | null;
  /** Mirrors the row's own `data-message-timestamp`, present even while unmounted. */
  timestamp: ChatMessage['timestamp'] | undefined;
  /**
   * Rows that render their content on first commit: the tail (so the initial
   * scroll-to-bottom measures real heights) and rows newly prepended next to
   * the reading position (so the layout-effect correction happens once,
   * before paint). Everything else starts as a placeholder.
   */
  initiallyNearViewport: boolean;
  /**
   * Live rows (streaming reply, growing thinking block, running tool, pending
   * permission prompt, the in-flight tail) always keep their content mounted,
   * even when scrolled far away, so they can keep growing and stay interactive.
   */
  forceMounted?: boolean;
  /** Stable row key, exposed as `data-row-key` for scroll-anchor recovery. */
  rowKey?: string;
  /** Member message keys of a grouped row, exposed URI-encoded and space-separated as `data-row-members`. */
  memberKeys?: string[];
  /** Keys this row's height is cached under, most specific first. */
  heightKeys?: string[];
  heightCache?: RowHeightCache | null;
  estimatedHeight?: number;
  children: ReactNode;
};

const NO_KEYS: string[] = [];

export default function LazyMessageRow({
  lazyRows,
  timestamp,
  initiallyNearViewport,
  forceMounted = false,
  rowKey,
  memberKeys,
  heightKeys = NO_KEYS,
  heightCache = null,
  estimatedHeight,
  children,
}: LazyMessageRowProps) {
  const [isNearViewport, setIsNearViewport] = useState(initiallyNearViewport);
  const measuredHeightRef = useRef<number | null>(null);
  const elementRef = useRef<HTMLDivElement | null>(null);
  const heightKeysRef = useRef(heightKeys);
  heightKeysRef.current = heightKeys;
  const heightCacheRef = useRef(heightCache);
  heightCacheRef.current = heightCache;

  const record = useCallback((height: number) => {
    if (!(height > 0)) return;
    measuredHeightRef.current = height;
    heightCacheRef.current?.set(heightKeysRef.current, height);
  }, []);

  const handleNearViewportChange = useCallback((nextIsNearViewport: boolean) => {
    if (!nextIsNearViewport) {
      // Measured now, while the content is still in the DOM (state applies on
      // the next render), so the placeholder that replaces it occupies exactly
      // the same space.
      record(elementRef.current?.getBoundingClientRect().height ?? 0);
    }
    setIsNearViewport(nextIsNearViewport);
  }, [record]);

  useEffect(() => {
    const element = elementRef.current;
    if (!lazyRows || !element) return undefined;
    return lazyRows.observe(element, handleNearViewportChange);
  }, [lazyRows, handleNearViewportChange]);

  const isMounted = lazyRows === null || forceMounted || isNearViewport;

  // Capture asynchronous size changes too (images and expanded tool output).
  // Fractional CSS pixels avoid accumulating rounding errors across long lists.
  useLayoutEffect(() => {
    const element = elementRef.current;
    if (!isMounted || !element) return;
    const measure = () => record(element.getBoundingClientRect().height);
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(element);
    return () => observer?.disconnect();
  }, [isMounted, record]);

  const placeholderHeight = isMounted
    ? undefined
    : measuredHeightRef.current
      ?? heightCache?.get(heightKeys)
      ?? estimatedHeight
      ?? ESTIMATED_ROW_HEIGHT_PX;

  return (
    <div
      ref={elementRef}
      data-transcript-row
      data-row-key={rowKey}
      data-row-members={memberKeys && memberKeys.length > 0 ? memberKeys.map(encodeURIComponent).join(' ') : undefined}
      className="flow-root"
      data-message-timestamp={timestamp || undefined}
      style={placeholderHeight === undefined ? undefined : { height: placeholderHeight }}
    >
      {isMounted ? children : null}
    </div>
  );
}
