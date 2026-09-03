import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import type { ChatMessage } from '../../types/types';
import type { LazyRowObserver } from '../../hooks/useLazyRowObserver';

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
 * The placeholder reuses the row's last measured height, so scrolling back
 * through previously seen content changes no scroll geometry at all; rows
 * never yet measured use an estimate and rely on browser scroll anchoring
 * while they settle.
 *
 * This deliberately does NOT use `content-visibility: auto` — its
 * contain-intrinsic-size re-estimates heights while streaming/tool rows grow,
 * which caused whole-pane flicker (see the comment in src/index.css). Here
 * heights are only ever *measured* while content is really in the DOM.
 */

/** Placeholder height for rows that have never been measured. */
const ESTIMATED_ROW_HEIGHT_PX = 100;

type LazyMessageRowProps = {
  lazyRows: LazyRowObserver | null;
  /** Mirrors the row's own `data-message-timestamp`, present even while unmounted. */
  timestamp: ChatMessage['timestamp'] | undefined;
  /**
   * Rows near the tail render their content on first commit so the initial
   * scroll-to-bottom measures real heights; everything older starts as a
   * placeholder and mounts when scrolled toward.
   */
  initiallyNearViewport: boolean;
  /**
   * Live rows (streaming reply, growing thinking block, running tool, pending
   * permission prompt, the in-flight tail) always keep their content mounted,
   * even when scrolled far away, so they can keep growing and stay interactive.
   */
  forceMounted?: boolean;
  children: ReactNode;
};

export default function LazyMessageRow({
  lazyRows,
  timestamp,
  initiallyNearViewport,
  forceMounted = false,
  children,
}: LazyMessageRowProps) {
  const [isNearViewport, setIsNearViewport] = useState(initiallyNearViewport);
  const measuredHeightRef = useRef<number | null>(null);
  const elementRef = useRef<HTMLDivElement | null>(null);

  const handleNearViewportChange = useCallback((nextIsNearViewport: boolean) => {
    if (!nextIsNearViewport) {
      // Measured now, while the content is still in the DOM (state applies on
      // the next render), so the placeholder that replaces it occupies exactly
      // the same space.
      const height = elementRef.current?.offsetHeight ?? 0;
      if (height > 0) {
        measuredHeightRef.current = height;
      }
    }
    setIsNearViewport(nextIsNearViewport);
  }, []);

  useEffect(() => {
    const element = elementRef.current;
    if (!lazyRows || !element) return undefined;
    return lazyRows.observe(element, handleNearViewportChange);
  }, [lazyRows, handleNearViewportChange]);

  const isMounted = lazyRows === null || forceMounted || isNearViewport;

  // A row mounted only because it is live can keep growing without any
  // further intersection callback. Refresh its recorded height each commit so
  // that when the force is released (run finishes) the placeholder that may
  // replace it still matches the space it occupied.
  useLayoutEffect(() => {
    if (forceMounted && !isNearViewport && elementRef.current) {
      const height = elementRef.current.offsetHeight;
      if (height > 0) {
        measuredHeightRef.current = height;
      }
    }
  });

  return (
    <div
      ref={elementRef}
      data-message-timestamp={timestamp || undefined}
      style={isMounted ? undefined : { height: measuredHeightRef.current ?? ESTIMATED_ROW_HEIGHT_PX }}
    >
      {isMounted ? children : null}
    </div>
  );
}
