import type { SessionActivity } from '../../hooks/useSessionProtection';
import { useSessionStatusBarTelemetry } from './useSessionStatusBarTelemetry';
import BurnRateMeter from './BurnRateMeter';
import ContextPressureGauge from './ContextPressureGauge';
import SessionHeartbeat from './SessionHeartbeat';

export interface SessionStatusBarProps {
  sessionId: string | null;
  activity: SessionActivity | null;
  subscribe?: (callback: (data: unknown) => void) => () => void;
  sendMessage?: (data: unknown) => void;
  workspaceName?: string;
  workspacePath?: string;
  projectId?: string | null;
  className?: string;
}

export default function SessionStatusBar({
  sessionId,
  activity,
  subscribe,
  sendMessage,
  workspaceName = 'CloudCLI',
  workspacePath,
  projectId,
  className = '',
}: SessionStatusBarProps) {
  const { spend, context, heartbeat } = useSessionStatusBarTelemetry({
    sessionId,
    activity,
    subscribe,
    sendMessage,
    projectId,
  });

  return (
    <div
      role="status"
      aria-label="Workspace status"
      className={`flex h-7 shrink-0 items-center justify-between border-t border-border/60 bg-muted/35 px-3 text-[11px] text-muted-foreground select-none ${className}`}
      style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}
    >
      {/* Left signals strip */}
      <div className="flex min-w-0 items-center gap-2 sm:gap-2.5">
        {/* Signal 1: Burn Rate & Session Spend */}
        <BurnRateMeter telemetry={spend} />

        <span className="text-border/70 select-none text-[10px]">|</span>

        {/* Signal 2: Context Pressure Gauge */}
        <ContextPressureGauge telemetry={context} />

        <span className="text-border/70 select-none text-[10px]">|</span>

        {/* Signal 3: Stall & Tool Heartbeat */}
        <SessionHeartbeat telemetry={heartbeat} />
      </div>

      {/* Right workspace / project indicator */}
      <div className="flex shrink-0 items-center gap-2 pl-2">
        <span
          className="max-w-[30vw] truncate font-medium text-muted-foreground/80 hover:text-foreground transition-colors"
          title={workspacePath}
        >
          {workspaceName}
        </span>
      </div>
    </div>
  );
}
