import { useCallback, useEffect, useRef, useState } from 'react';

const STORAGE_KEY = 'cloudcli:bot-studio-layout';
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

type LayoutState = { rosterWidth: number; contextWidth: number; rosterOpen: boolean; contextOpen: boolean };
const DEFAULT_LAYOUT: LayoutState = { rosterWidth: 280, contextWidth: 400, rosterOpen: true, contextOpen: true };

function readLayout(): LayoutState {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') as Partial<LayoutState>;
    return {
      rosterWidth: clamp(stored.rosterWidth ?? DEFAULT_LAYOUT.rosterWidth, 220, 360),
      contextWidth: clamp(stored.contextWidth ?? DEFAULT_LAYOUT.contextWidth, 320, 560),
      rosterOpen: stored.rosterOpen ?? true,
      contextOpen: stored.contextOpen ?? true,
    };
  } catch {
    return DEFAULT_LAYOUT;
  }
}

export function useBotStudioLayout() {
  const [layout, setLayout] = useState<LayoutState>(readLayout);
  const resizeRef = useRef<{ target: 'roster' | 'context'; startX: number; startWidth: number } | null>(null);

  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(layout)); } catch { /* storage is optional */ }
  }, [layout]);

  const toggleRoster = useCallback(() => setLayout((current) => ({ ...current, rosterOpen: !current.rosterOpen })), []);
  const toggleContext = useCallback(() => setLayout((current) => ({ ...current, contextOpen: !current.contextOpen })), []);
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
          ? clamp(active.startWidth + delta, 220, 360)
          : clamp(active.startWidth - delta, 320, 560);
        return active.target === 'roster' ? { ...current, rosterWidth: next } : { ...current, contextWidth: next };
      });
    };
    const stop = () => { resizeRef.current = null; };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop);
    return () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', stop); };
  }, []);

  return { ...layout, toggleRoster, toggleContext, startResize };
}
