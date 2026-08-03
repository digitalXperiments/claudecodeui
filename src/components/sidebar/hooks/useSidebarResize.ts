import { useCallback, useEffect, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';

import {
  readSidebarPanelWidth,
  writeSidebarPanelWidth,
  SIDEBAR_PANEL_MIN_WIDTH,
  SIDEBAR_PANEL_MAX_WIDTH,
} from '../utils/utils';

/** Minimum width left for the chat window while resizing the sidebar. */
const MIN_CHAT_WIDTH = 400;

/**
 * Resizable sidebar width (desktop). The Projects/Sessions column width is
 * controlled by dragging the separator between the sidebar and the chat view,
 * mirroring splitter behavior in VS Code/DataGrip. Persists across reloads.
 */
export const useSidebarResize = (isMobile: boolean) => {
  const [panelWidth, setPanelWidth] = useState(() => readSidebarPanelWidth());
  const [isResizing, setIsResizing] = useState(false);
  const sidebarRef = useRef<HTMLDivElement | null>(null);
  const widthRef = useRef(panelWidth);
  const dragStartRef = useRef<{ startWidth: number; startClientX: number } | null>(null);

  const handleResizeStart = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      if (isMobile) {
        return;
      }

      dragStartRef.current = { startWidth: widthRef.current, startClientX: event.clientX };
      setIsResizing(true);
      event.preventDefault();
    },
    [isMobile],
  );

  useEffect(() => {
    if (!isResizing) {
      return;
    }

    const handleMouseMove = (event: globalThis.MouseEvent) => {
      const sidebarEl = sidebarRef.current;
      const dragStart = dragStartRef.current;
      if (!sidebarEl || !dragStart) {
        return;
      }

      const containerWidth = sidebarEl.parentElement?.getBoundingClientRect().width ?? window.innerWidth;
      const maxWidth = Math.min(
        SIDEBAR_PANEL_MAX_WIDTH,
        Math.max(SIDEBAR_PANEL_MIN_WIDTH, containerWidth - MIN_CHAT_WIDTH),
      );
      // Track the delta from the initial press so the sidebar doesn't jump
      // when the drag starts inside the grab handle.
      const nextWidth = dragStart.startWidth + (event.clientX - dragStart.startClientX);
      const clampedWidth = Math.min(maxWidth, Math.max(SIDEBAR_PANEL_MIN_WIDTH, nextWidth));

      widthRef.current = clampedWidth;
      setPanelWidth(clampedWidth);
    };

    const handleMouseUp = () => {
      setIsResizing(false);
      dragStartRef.current = null;
      writeSidebarPanelWidth(widthRef.current);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [isResizing]);

  return {
    panelWidth,
    isResizing,
    sidebarRef,
    handleResizeStart,
  };
};
