import type { ReactNode } from 'react';
import { Loader2, Monitor, MousePointerClick, PanelLeft, RefreshCw, Smartphone, Tablet } from 'lucide-react';

import { Button, Pill, PillBar } from '../../../shared/view/ui';
import type { StudioPreviewFrame } from '../types';

type StudioPreviewChromeProps = {
  title: string;
  subtitle?: string;
  frame: StudioPreviewFrame;
  selectMode: boolean;
  busy?: boolean;
  generating?: boolean;
  onFrameChange: (frame: StudioPreviewFrame) => void;
  onSelectModeChange: (enabled: boolean) => void;
  onRefresh?: () => void;
  onToggleLibrary?: () => void;
  children: ReactNode;
};

const FRAMES: Array<{ id: StudioPreviewFrame; label: string; icon: typeof Monitor }> = [
  { id: 'mobile', label: 'Mobile', icon: Smartphone },
  { id: 'tablet', label: 'Tablet', icon: Tablet },
  { id: 'desktop', label: 'Desktop', icon: Monitor },
];

export default function StudioPreviewChrome({
  title,
  subtitle,
  frame,
  selectMode,
  busy = false,
  generating = false,
  onFrameChange,
  onSelectModeChange,
  onRefresh,
  onToggleLibrary,
  children,
}: StudioPreviewChromeProps) {
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-studio-pane="preview-chrome">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">{title}</div>
          {subtitle ? <div className="truncate text-xs text-muted-foreground">{subtitle}</div> : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {onToggleLibrary ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={onToggleLibrary}
              aria-label="Toggle library panel"
              title="Toggle library panel"
            >
              <PanelLeft className="h-3.5 w-3.5" />
            </Button>
          ) : null}
          <PillBar>
            {FRAMES.map((entry) => {
              const Icon = entry.icon;
              return (
                <Pill
                  key={entry.id}
                  isActive={frame === entry.id}
                  onClick={() => onFrameChange(entry.id)}
                >
                  <Icon className="h-3.5 w-3.5" />
                  {entry.label}
                </Pill>
              );
            })}
          </PillBar>
          <Button
            size="sm"
            variant={selectMode ? 'default' : 'secondary'}
            onClick={() => onSelectModeChange(!selectMode)}
            aria-pressed={selectMode}
            title="Click an element in the preview to target the next refinement"
          >
            <MousePointerClick className="mr-1 h-3.5 w-3.5" />
            {selectMode ? 'Selecting…' : 'Select element'}
          </Button>
          {onRefresh ? (
            <Button size="sm" variant="ghost" onClick={onRefresh} aria-label="Refresh preview">
              {busy || generating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            </Button>
          ) : null}
        </div>
      </div>
      {selectMode ? (
        <p className="border-b border-primary/20 bg-primary/5 px-4 py-1.5 text-xs text-muted-foreground">
          Click any element in the preview to seed it into the next refinement prompt.
        </p>
      ) : null}
      <div className="min-h-0 flex-1 overflow-hidden bg-muted/30 p-4">{children}</div>
    </div>
  );
}
