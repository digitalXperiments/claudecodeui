import { useCallback, useEffect } from 'react';
import { CircleAlert, X } from 'lucide-react';

import { Button } from '../../../../shared/view/ui';
import { useWebSocket } from '../../../../contexts/WebSocketContext';
import { interruptsApi } from '../../../interrupts/api/interruptsApi';
import InterruptQueueSection from '../../../interrupts/view/InterruptQueueSection';

type NeedsYouPanelProps = {
  open: boolean;
  onClose: () => void;
  onCountChange?: (count: number) => void;
};

export default function NeedsYouPanel({
  open,
  onClose,
  onCountChange,
}: NeedsYouPanelProps) {
  const refreshCount = useCallback(async () => {
    try {
      onCountChange?.(await interruptsApi.count());
    } catch {
      // The action-center badge is best-effort; the open panel shows request errors.
    }
  }, [onCountChange]);

  // Keep the badge current even before the drawer has ever been opened.
  useEffect(() => {
    void refreshCount();
    const timer = window.setInterval(() => void refreshCount(), 30_000);
    return () => window.clearInterval(timer);
  }, [refreshCount]);

  const { subscribe } = useWebSocket();
  useEffect(() => subscribe((event) => {
    if (event.kind === 'interrupt_created' || event.kind === 'interrupt_updated') {
      void refreshCount();
    }
  }), [refreshCount, subscribe]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[10000] flex justify-end bg-background/40 backdrop-blur-[1px] md:bg-transparent md:backdrop-blur-none">
      <button
        type="button"
        className="absolute inset-0 cursor-default"
        aria-label="Close Needs you"
        onClick={onClose}
      />
      <div className="relative z-10 flex h-full w-full max-w-md flex-col border-l border-border bg-background shadow-2xl">
        <div className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
          <div className="flex min-w-0 items-start gap-2.5">
            <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
            <div>
              <h2 className="text-sm font-semibold text-foreground">Needs you</h2>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Permissions, approvals, and setup issues waiting for a decision.
              </p>
            </div>
          </div>
          <Button variant="ghost" size="sm" className="h-8 w-8 shrink-0 p-0" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <InterruptQueueSection onCountChange={onCountChange} onNavigateAway={onClose} />
        </div>
      </div>
    </div>
  );
}
