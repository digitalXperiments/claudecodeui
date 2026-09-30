import { AlertTriangle, Terminal, Brain, Radio } from 'lucide-react';
import StatusBarPopover from './StatusBarPopover';
import type { SessionHeartbeatTelemetry } from './types';

interface SessionHeartbeatProps {
  telemetry: SessionHeartbeatTelemetry;
  className?: string;
}

export default function SessionHeartbeat({
  telemetry,
  className = '',
}: SessionHeartbeatProps) {
  const {
    phase,
    toolName,
    elapsedSeconds,
    idleSeconds,
    isStalled,
    lastRunDurationSeconds,
  } = telemetry;

  const isProcessing = phase !== 'idle';

  const popoverContent = (
    <div className="w-64 space-y-2.5 p-3 text-xs">
      <div className="flex items-center gap-1.5 border-b border-border/60 pb-2 font-semibold text-foreground">
        <Radio className="h-4 w-4 text-primary" />
        <span>Agent Activity & Heartbeat</span>
      </div>

      <div className="grid grid-cols-2 gap-x-2 gap-y-1 rounded-lg bg-muted/40 p-2 text-[11px]">
        <span className="text-muted-foreground">State:</span>
        <span className="text-right font-medium text-foreground capitalize">{phase}</span>

        {toolName && (
          <>
            <span className="text-muted-foreground">Active Tool:</span>
            <span className="text-right font-mono text-[11px] text-foreground truncate" title={toolName}>
              {toolName}
            </span>
          </>
        )}

        {isProcessing && (
          <>
            <span className="text-muted-foreground">Turn Elapsed:</span>
            <span className="text-right font-medium tabular-nums text-foreground">{elapsedSeconds}s</span>

            <span className="text-muted-foreground">Silent For:</span>
            <span className={`text-right font-medium tabular-nums ${isStalled ? 'text-amber-500' : 'text-foreground'}`}>
              {idleSeconds}s
            </span>
          </>
        )}

        {!isProcessing && lastRunDurationSeconds != null && (
          <>
            <span className="text-muted-foreground">Last Turn Took:</span>
            <span className="text-right font-medium tabular-nums text-foreground">{lastRunDurationSeconds}s</span>
          </>
        )}
      </div>

      {isStalled ? (
        <div className="flex items-start gap-1.5 rounded-lg border border-amber-500/30 bg-amber-500/10 p-2 text-[10px] text-amber-600 dark:text-amber-400">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>No provider tokens or tool activity for {idleSeconds}s.</span>
        </div>
      ) : isProcessing ? (
        <div className="rounded-lg bg-primary/10 p-2 text-[10px] text-muted-foreground text-center">
          Turn in flight. Events actively monitored.
        </div>
      ) : null}
    </div>
  );

  return (
    <div className={`inline-flex items-center gap-1.5 text-[11px] ${className}`}>
      <StatusBarPopover content={popoverContent} delay={150}>
        <div className="inline-flex items-center gap-1.5 cursor-default">
          {/* Heartbeat Status Pip */}
          {isStalled ? (
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-500 opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-amber-500" />
            </span>
          ) : isProcessing ? (
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-500 opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
            </span>
          ) : (
            <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/40" />
          )}

          {/* Phase & Elapsed Display */}
          {isStalled ? (
            <span className="flex items-center gap-1 text-amber-500 font-medium">
              <AlertTriangle className="h-2.5 w-2.5 shrink-0" />
              <span>stalled {idleSeconds}s</span>
              {toolName && <span className="hidden sm:inline opacity-80">· {toolName}</span>}
            </span>
          ) : phase === 'tool' ? (
            <span className="flex items-center gap-1 text-foreground/90">
              <Terminal className="h-2.5 w-2.5 text-primary/80 shrink-0" />
              <span className="truncate max-w-[120px]">{toolName || 'tool'}</span>
              <span className="tabular-nums opacity-60 font-mono text-[10px]">{elapsedSeconds}s</span>
            </span>
          ) : phase === 'thinking' ? (
            <span className="flex items-center gap-1 text-foreground/90">
              <Brain className="h-2.5 w-2.5 text-primary/80 shrink-0" />
              <span>thinking</span>
              <span className="tabular-nums opacity-60 font-mono text-[10px]">{elapsedSeconds}s</span>
            </span>
          ) : phase === 'streaming' ? (
            <span className="flex items-center gap-1 text-foreground/90">
              <Radio className="h-2.5 w-2.5 text-primary/80 shrink-0" />
              <span>streaming</span>
              <span className="tabular-nums opacity-60 font-mono text-[10px]">{elapsedSeconds}s</span>
            </span>
          ) : (
            <span className="text-muted-foreground">idle</span>
          )}
        </div>
      </StatusBarPopover>
    </div>
  );
}
