import React, { useEffect, useId, useRef, useState } from 'react';
import { ChevronRight } from 'lucide-react';

import { cn } from '../../../../lib/utils';

import { ToolStatusBadge } from './ToolStatusBadge';
import type { ToolStatus } from './ToolStatusBadge';

interface GenericToolDisplayProps {
  toolName: string;
  preview: string;
  parameters: string;
  result?: string;
  hasResult: boolean;
  status: ToolStatus;
}

/**
 * Compact fallback for provider-specific and newly introduced tools. Input and
 * output intentionally share one disclosure so an unknown tool never consumes
 * two transcript rows just to show "Parameters" and "Details".
 */
export const GenericToolDisplay: React.FC<GenericToolDisplayProps> = ({
  toolName,
  preview,
  parameters,
  result = '',
  hasResult,
  status,
}) => {
  const detailsId = useId();
  const isFailure = status === 'error' || status === 'denied';
  const hasDetails = Boolean(parameters) || hasResult;
  const [open, setOpen] = useState(() => hasDetails && isFailure);
  const autoAppliedRef = useRef(hasDetails && isFailure);

  // Results commonly arrive after the input row mounts. Reveal the first
  // failure automatically, then leave disclosure state under user control.
  useEffect(() => {
    if (!autoAppliedRef.current && hasDetails && isFailure) {
      autoAppliedRef.current = true;
      setOpen(true);
    }
  }, [hasDetails, isFailure]);

  return (
    <div
      className={cn(
        'my-0.5 overflow-hidden border-l-2 bg-muted/10',
        isFailure ? 'border-l-red-500 dark:border-l-red-400' : 'border-l-border',
      )}
    >
      <button
        type="button"
        className={cn(
          'flex w-full items-center gap-1.5 px-2.5 py-1 text-left text-xs outline-none transition-colors',
          hasDetails && 'hover:bg-muted/30 focus-visible:ring-1 focus-visible:ring-ring',
        )}
        aria-expanded={hasDetails ? open : undefined}
        aria-controls={hasDetails ? detailsId : undefined}
        disabled={!hasDetails}
        onClick={() => setOpen((current) => !current)}
      >
        <ChevronRight
          className={cn(
            'h-3 w-3 flex-shrink-0 text-muted-foreground transition-transform',
            open && 'rotate-90',
            !hasDetails && 'opacity-0',
          )}
          aria-hidden
        />
        <span className="flex-shrink-0 font-medium text-foreground">{toolName}</span>
        <span className="flex-shrink-0 text-[10px] text-muted-foreground">/</span>
        <span className="min-w-0 flex-1 truncate font-mono text-muted-foreground">{preview}</span>
        {status !== 'completed' && <ToolStatusBadge status={status} className="flex-shrink-0" />}
      </button>

      {hasDetails && (
        <div
          id={detailsId}
          hidden={!open}
          aria-hidden={!open}
          className="border-t border-border/50 bg-background/50 px-3 py-2"
        >
          {parameters && (
            <section aria-label={`${toolName} parameters`}>
              <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                Parameters
              </div>
              <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words font-mono text-xs text-foreground/80">
                {parameters}
              </pre>
            </section>
          )}

          {hasResult && (
            <section
              aria-label={`${toolName} result`}
              className={cn(parameters && 'mt-3 border-t border-border/50 pt-2')}
            >
              <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                Result
              </div>
              <pre
                className={cn(
                  'max-h-80 overflow-auto whitespace-pre-wrap break-words font-mono text-xs',
                  isFailure ? 'text-red-600 dark:text-red-400' : 'text-foreground/80',
                )}
              >
                {result || 'No output'}
              </pre>
            </section>
          )}
        </div>
      )}
    </div>
  );
};
