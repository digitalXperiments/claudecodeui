import { useCallback, useEffect, useRef, useState } from 'react';

import { shouldTemporarilyCollapseContext } from './botStudioReducers';

const STORAGE_KEY = 'cloudcli:bot-studio-layout';
const HANDLE_WIDTH = 8;
const MIN_CENTRE_WIDTH = 480;
const MIN_ROSTER_WIDTH = 220;
const MIN_CONTEXT_WIDTH = 320;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

type LayoutState = { rosterWidth: number; contextWidth: number; rosterOpen: boolean; contextOpen: boolean };
const DEFAULT_LAYOUT: LayoutState = { rosterWidth: 280, contextWidth: 400, rosterOpen: true, contextOpen: true };

export function maxRosterWidth(containerWidth: number, contextWidth: number, contextOpen = true): number {
  if (containerWidth <= 0) return Number.MAX_SAFE_INTEGER;
  return Math.max(MIN_ROSTER_WIDTH, containerWidth - MIN_CENTRE_WIDTH - (contextOpen ? HANDLE_WIDTH + contextWidth : 0) - HANDLE_WIDTH);
}

export function maxContextWidth(containerWidth: number, rosterWidth: number, rosterOpen = true): number {
  if (containerWidth <= 0) return Number.MAX_SAFE_INTEGER;
  return Math.max(MIN_CONTEXT_WIDTH, containerWidth - MIN_CENTRE_WIDTH - (rosterOpen ? HANDLE_WIDTH + rosterWidth : 0) - HANDLE_WIDTH);
}

function fitWidths(containerWidth: number, rosterWidth: number, contextWidth: number, rosterOpen: boolean, contextOpen: boolean): Pick<LayoutState, 'rosterWidth' | 'contextWidth'> {
  if (containerWidth <= 0) return { rosterWidth, contextWidth };

  let nextRosterWidth = clamp(rosterWidth, MIN_ROSTER_WIDTH, maxRosterWidth(containerWidth, contextWidth, contextOpen));
  let nextContextWidth = clamp(contextWidth, MIN_CONTEXT_WIDTH, maxContextWidth(containerWidth, nextRosterWidth, rosterOpen));

  // If the minimum context width would squeeze the roster, give the roster the
  // remaining space while keeping the centre at its hard 480px minimum.
  if (rosterOpen && contextOpen && nextContextWidth === MIN_CONTEXT_WIDTH) {
    const rosterMaxWithMinimumContext = Math.max(MIN_ROSTER_WIDTH, containerWidth - MIN_CENTRE_WIDTH - (HANDLE_WIDTH * 2) - MIN_CONTEXT_WIDTH);
    nextRosterWidth = clamp(nextRosterWidth, MIN_ROSTER_WIDTH, rosterMaxWithMinimumContext);
    nextContextWidth = clamp(nextContextWidth, MIN_CONTEXT_WIDTH, maxContextWidth(containerWidth, nextRosterWidth, rosterOpen));
  }

  return { rosterWidth: nextRosterWidth, contextWidth: nextContextWidth };
}

function readLayout(): LayoutState {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') as Partial<LayoutState>;
    return {
      rosterWidth: Math.max(stored.rosterWidth ?? DEFAULT_LAYOUT.rosterWidth, MIN_ROSTER_WIDTH),
      contextWidth: Math.max(stored.contextWidth ?? DEFAULT_LAYOUT.contextWidth, MIN_CONTEXT_WIDTH),
      rosterOpen: stored.rosterOpen ?? true,
      contextOpen: stored.contextOpen ?? true,
    };
  } catch {
    return DEFAULT_LAYOUT;
  }
}

export function useBotStudioLayout() {
  const [layout, setLayout] = useState<LayoutState>(readLayout);
  const [containerWidth, setContainerWidth] = useState(0);
  const [centerWidth, setCenterWidth] = useState(0);
  const [contextTemporarilyCollapsed, setContextTemporarilyCollapsed] = useState(false);
  const [containerElement, setContainerElement] = useState<HTMLDivElement | null>(null);
  const [centerElement, setCenterElement] = useState<HTMLElement | null>(null);
  const containerRef = useCallback((node: HTMLDivElement | null) => setContainerElement(node), []);
  const centerRef = useCallback((node: HTMLElement | null) => setCenterElement(node), []);
  const resizeRef = useRef<{ target: 'roster' | 'context'; startX: number; startWidth: number } | null>(null);

  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(layout)); } catch { /* storage is optional */ }
  }, [layout]);

  useEffect(() => {
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(() => {
      if (containerElement) setContainerWidth(containerElement.getBoundingClientRect().width);
      if (centerElement) setCenterWidth(centerElement.getBoundingClientRect().width);
    });
    if (containerElement) observer.observe(containerElement);
    if (centerElement) observer.observe(centerElement);
    if (containerElement) setContainerWidth(containerElement.getBoundingClientRect().width);
    if (centerElement) setCenterWidth(centerElement.getBoundingClientRect().width);
    return () => observer.disconnect();
  }, [centerElement, containerElement]);

  useEffect(() => {
    if (containerWidth <= 0) return;
    setLayout((current) => {
      const fitted = fitWidths(containerWidth, current.rosterWidth, current.contextWidth, current.rosterOpen, current.contextOpen);
      if (fitted.rosterWidth === current.rosterWidth && fitted.contextWidth === current.contextWidth) return current;
      return { ...current, ...fitted };
    });
  }, [containerWidth]);

  const toggleRoster = useCallback(() => {
    setLayout((current) => {
      const rosterOpen = !current.rosterOpen;
      return { ...current, rosterOpen, ...fitWidths(containerWidth, current.rosterWidth, current.contextWidth, rosterOpen, current.contextOpen) };
    });
  }, [containerWidth]);
  const toggleContext = useCallback(() => {
    const wasTemporarilyCollapsed = contextTemporarilyCollapsed;
    setContextTemporarilyCollapsed(false);
    setLayout((current) => {
      const contextOpen = wasTemporarilyCollapsed ? true : !current.contextOpen;
      return { ...current, contextOpen, ...fitWidths(containerWidth, current.rosterWidth, current.contextWidth, current.rosterOpen, contextOpen) };
    });
  }, [containerWidth, contextTemporarilyCollapsed]);
  const temporarilyCollapseContext = useCallback(() => setContextTemporarilyCollapsed(true), []);
  const restoreContext = useCallback(() => setContextTemporarilyCollapsed(false), []);
  const startResize = useCallback((target: 'roster' | 'context', event: React.PointerEvent) => {
    event.preventDefault();
    const width = target === 'roster' ? layout.rosterWidth : layout.contextWidth;
    resizeRef.current = { target, startX: event.clientX, startWidth: width };
  }, [layout.contextWidth, layout.rosterWidth]);

  useEffect(() => {
    const move = (event: PointerEvent) => {
      const active = resizeRef.current;
      if (!active) return;
      setLayout((current) => {
        const delta = event.clientX - active.startX;
        const next = active.target === 'roster'
          ? clamp(active.startWidth + delta, MIN_ROSTER_WIDTH, maxRosterWidth(containerWidth, current.contextWidth, current.contextOpen))
          : clamp(active.startWidth - delta, MIN_CONTEXT_WIDTH, maxContextWidth(containerWidth, current.rosterWidth, current.rosterOpen));
        return active.target === 'roster' ? { ...current, rosterWidth: next } : { ...current, contextWidth: next };
      });
    };
    const stop = () => { resizeRef.current = null; };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop);
    return () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', stop); };
  }, [containerWidth]);

  return {
    ...layout,
    centerWidth,
    centerRef,
    containerRef,
    contextTemporarilyCollapsed,
    shouldTemporarilyCollapseContext,
    toggleRoster,
    toggleContext,
    temporarilyCollapseContext,
    restoreContext,
    startResize,
  };
}
