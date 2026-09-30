import { Cpu, AlertTriangle, CheckCircle2 } from 'lucide-react';
import StatusBarPopover from './StatusBarPopover';
import type { ContextPressureTelemetry } from './types';
import { formatTokenCount } from './statusBarHelpers';

interface ContextPressureGaugeProps {
  telemetry: ContextPressureTelemetry;
  className?: string;
  onClick?: () => void;
}

export default function ContextPressureGauge({
  telemetry,
  className = '',
  onClick,
}: ContextPressureGaugeProps) {
  const { usedTokens, contextWindow, percent, inputTokens, outputTokens, model } = telemetry;

  const hasData = usedTokens > 0 || (percent != null && percent > 0);
  const displayPercent = percent != null ? Math.min(100, Math.max(0, percent)) : null;

  // Thresholds: Warning at 70%, Critical at 85%
  const isCritical = displayPercent != null && displayPercent >= 85;
  const isWarning = displayPercent != null && displayPercent >= 70 && !isCritical;

  const meterColor = isCritical
    ? 'bg-destructive'
    : isWarning
      ? 'bg-amber-500'
      : 'bg-emerald-500/80';

  const textColor = isCritical
    ? 'text-destructive font-medium'
    : isWarning
      ? 'text-amber-500 font-medium'
      : 'text-foreground/90';

  const popoverContent = (
    <div className="w-72 space-y-2.5 p-3 text-xs">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border/60 pb-2">
        <div className="flex items-center gap-1.5 font-semibold text-foreground">
          <Cpu className="h-4 w-4 text-primary" />
          <span>Context Pressure</span>
        </div>
        {model ? (
          <span
            className="max-w-[120px] truncate rounded bg-muted/80 px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground"
            title={model}
          >
            {model}
          </span>
        ) : null}
      </div>

      {/* Progress Bar & Occupancy */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between text-[11px]">
          <span className="text-muted-foreground">Occupancy</span>
          <span
            className={`font-semibold tabular-nums ${
              isCritical ? 'text-destructive' : isWarning ? 'text-amber-500' : 'text-foreground'
            }`}
          >
            {displayPercent != null ? `${displayPercent}%` : hasData ? 'Active' : '0%'}
          </span>
        </div>
        <div className="h-2 w-full overflow-hidden rounded-full bg-muted/80">
          <div
            className={`h-full transition-all duration-300 ${meterColor}`}
            style={{ width: `${Math.min(100, Math.max(displayPercent ?? 0, hasData ? 2 : 0))}%` }}
          />
        </div>
      </div>

      {/* Details Grid */}
      <div className="grid grid-cols-2 gap-x-2 gap-y-1 rounded-lg bg-muted/40 p-2 text-[11px]">
        <span className="text-muted-foreground">Used Tokens:</span>
        <span className="text-right font-medium tabular-nums text-foreground">
          {usedTokens > 0 ? usedTokens.toLocaleString() : '0'}
        </span>

        <span className="text-muted-foreground">Window Max:</span>
        <span className="text-right font-medium tabular-nums text-foreground">
          {contextWindow > 0 ? contextWindow.toLocaleString() : '—'}
        </span>

        {contextWindow > 0 && (
          <>
            <span className="text-muted-foreground">Free Headroom:</span>
            <span className="text-right font-medium tabular-nums text-foreground">
              {Math.max(0, contextWindow - usedTokens).toLocaleString()}
            </span>
          </>
        )}

        {inputTokens != null && inputTokens > 0 && (
          <>
            <span className="text-muted-foreground">Input Tokens:</span>
            <span className="text-right font-medium tabular-nums text-foreground">
              {inputTokens.toLocaleString()}
            </span>
          </>
        )}

        {outputTokens != null && outputTokens > 0 && (
          <>
            <span className="text-muted-foreground">Output Tokens:</span>
            <span className="text-right font-medium tabular-nums text-foreground">
              {outputTokens.toLocaleString()}
            </span>
          </>
        )}
      </div>

      {/* Advisories / Status banners */}
      {isCritical ? (
        <div className="flex items-start gap-1.5 rounded-lg border border-destructive/30 bg-destructive/10 p-2 text-[11px] text-destructive">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>Context window nearly full (&gt;85%). Use /compact or start a fresh session to prevent degradation.</span>
        </div>
      ) : isWarning ? (
        <div className="flex items-start gap-1.5 rounded-lg border border-amber-500/30 bg-amber-500/10 p-2 text-[11px] text-amber-600 dark:text-amber-400">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>Context pressure elevated (&gt;70%). Consider compacting soon.</span>
        </div>
      ) : hasData ? (
        <div className="flex items-center justify-center gap-1.5 text-[10px] text-muted-foreground">
          <CheckCircle2 className="h-3 w-3 text-emerald-500" />
          <span>Context headroom healthy</span>
        </div>
      ) : (
        <div className="flex items-center justify-center gap-1.5 text-[10px] text-muted-foreground">
          <CheckCircle2 className="h-3 w-3 text-emerald-500" />
          <span>Fresh session · 100% capacity available</span>
        </div>
      )}
    </div>
  );

  return (
    <StatusBarPopover content={popoverContent} delay={150}>
      <button
        type="button"
        onClick={onClick}
        className={`inline-flex items-center gap-1.5 text-[11px] transition-colors hover:text-foreground focus:outline-none ${className}`}
        aria-label={
          displayPercent != null
            ? `Context window ${displayPercent}% full (${formatTokenCount(usedTokens)} tokens)`
            : `Context window ${formatTokenCount(usedTokens)} tokens`
        }
      >
        <Cpu
          className={`h-3 w-3 shrink-0 ${
            isCritical ? 'text-destructive' : isWarning ? 'text-amber-500' : 'text-muted-foreground'
          }`}
        />

        <span className={`tabular-nums ${textColor}`}>
          {displayPercent != null
            ? `ctx ${displayPercent}%`
            : hasData
              ? `ctx ${formatTokenCount(usedTokens)}`
              : 'ctx 0%'}
        </span>

        {/* Hairline meter bar */}
        <span className="hidden sm:inline-block h-1.5 w-6 overflow-hidden rounded-full bg-muted/70 align-middle">
          <span
            className={`block h-full transition-all duration-300 ${meterColor}`}
            style={{ width: `${Math.min(100, Math.max(displayPercent ?? 0, 4))}%` }}
          />
        </span>

        {isWarning && (
          <span className="hidden md:inline text-[10px] text-amber-500 font-normal">
            · compact soon
          </span>
        )}
        {isCritical && (
          <span className="hidden md:inline text-[10px] text-destructive font-medium animate-pulse">
            · full
          </span>
        )}
      </button>
    </StatusBarPopover>
  );
}
