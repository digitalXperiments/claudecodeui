import { X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent, ReactNode } from 'react';

type DesktopWorkbenchPaneProps = {
  navigation: ReactNode;
  children: ReactNode;
  onClose: () => void;
};

const MIN_PANE_WIDTH = 360;
const MIN_CHAT_WIDTH = 420;

export default function DesktopWorkbenchPane({ navigation, children, onClose }: DesktopWorkbenchPaneProps) {
  const [width, setWidth] = useState(() => {
    const stored = Number(localStorage.getItem('cloudcli:desktop-workbench-width'));
    return Number.isFinite(stored) && stored >= MIN_PANE_WIDTH ? stored : 680;
  });
  const [isResizing, setIsResizing] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const beginResize = (event: ReactMouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsResizing(true);
  };

  useEffect(() => {
    if (!isResizing) return;

    const handleMove = (event: MouseEvent) => {
      const parent = containerRef.current?.parentElement;
      if (!parent) return;
      const bounds = parent.getBoundingClientRect();
      const nextWidth = Math.min(
        Math.max(bounds.right - event.clientX, MIN_PANE_WIDTH),
        Math.max(MIN_PANE_WIDTH, bounds.width - MIN_CHAT_WIDTH),
      );
      setWidth(nextWidth);
    };
    const handleUp = () => {
      setIsResizing(false);
      localStorage.setItem('cloudcli:desktop-workbench-width', String(Math.round(width)));
    };

    document.addEventListener('mousemove', handleMove);
    document.addEventListener('mouseup', handleUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    return () => {
      document.removeEventListener('mousemove', handleMove);
      document.removeEventListener('mouseup', handleUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [isResizing, width]);

  return (
    <div
      ref={containerRef}
      className="relative flex h-full min-w-[360px] flex-shrink-0 flex-col overflow-hidden border-l border-border bg-background"
      style={{ width: `${width}px`, maxWidth: `calc(100% - ${MIN_CHAT_WIDTH}px)` }}
    >
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize workbench"
        onMouseDown={beginResize}
        className="group absolute inset-y-0 -left-1 z-20 w-2 cursor-col-resize"
      >
        <div className="absolute inset-y-0 left-1 w-px bg-border transition-colors group-hover:bg-primary" />
      </div>
      <div className="flex min-h-10 flex-shrink-0 items-center gap-2 border-b border-border px-2">
        <div className="scrollbar-hide min-w-0 flex-1 overflow-x-auto">{navigation}</div>
        <button
          type="button"
          onClick={onClose}
          className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          aria-label="Close workbench"
          title="Close workbench"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="flex min-h-0 flex-1 overflow-hidden">{children}</div>
    </div>
  );
}
