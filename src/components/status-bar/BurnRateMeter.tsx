import { Coins, Flame, ArrowUpRight } from 'lucide-react';
import StatusBarPopover from './StatusBarPopover';
import type { SessionSpendTelemetry } from './types';
import { formatCurrency, formatVelocity } from './statusBarHelpers';

interface BurnRateMeterProps {
  telemetry: SessionSpendTelemetry;
  className?: string;
}

export default function BurnRateMeter({ telemetry, className = '' }: BurnRateMeterProps) {
  const { spentUsd, lastTurnCostUsd, burnRateUsdPerMin, runCount, totalTokens, verdict } = telemetry;

  const softCap = verdict?.softUsd ?? null;
  const hardCap = verdict?.hardUsd ?? null;
  const effectiveCap = hardCap ?? softCap;

  let capProgress = 0;
  if (effectiveCap && effectiveCap > 0) {
    capProgress = Math.min(100, Math.round((spentUsd / effectiveCap) * 100));
  }

  const isNearingCap = verdict?.soft || verdict?.hard || (effectiveCap != null && capProgress >= 80);
  const isCapped = verdict?.hard || (effectiveCap != null && spentUsd >= effectiveCap);

  const popoverContent = (
    <div className="w-64 space-y-2.5 p-3 text-xs">
      <div className="flex items-center gap-1.5 border-b border-border/60 pb-2 font-semibold text-foreground">
        <Coins className="h-4 w-4 text-primary" />
        <span>Session Spend & Velocity</span>
      </div>

      <div className="grid grid-cols-2 gap-x-2 gap-y-1 rounded-lg bg-muted/40 p-2 text-[11px]">
        <span className="text-muted-foreground">Total Spent:</span>
        <span className="text-right font-medium tabular-nums text-foreground">{formatCurrency(spentUsd)}</span>

        <span className="text-muted-foreground">Burn Rate:</span>
        <span className="text-right font-medium tabular-nums text-foreground">
          {burnRateUsdPerMin > 0 ? `~${formatVelocity(burnRateUsdPerMin)}/min` : '$0.00/min'}
        </span>

        <span className="text-muted-foreground">Latest Turn:</span>
        <span className="text-right font-medium tabular-nums text-foreground">{formatCurrency(lastTurnCostUsd)}</span>

        <span className="text-muted-foreground">Completed Turns:</span>
        <span className="text-right font-medium tabular-nums text-foreground">{runCount}</span>

        <span className="text-muted-foreground">Total Tokens:</span>
        <span className="text-right font-medium tabular-nums text-foreground">{totalTokens.toLocaleString()}</span>

        {effectiveCap != null && (
          <>
            <span className="text-muted-foreground">Budget Cap:</span>
            <span className="text-right font-medium tabular-nums text-foreground">
              {formatCurrency(effectiveCap)} ({capProgress}%)
            </span>
          </>
        )}
      </div>

      {isCapped ? (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-2 text-[10px] text-destructive font-medium">
          Hard budget cap reached. New provider calls may be restricted.
        </div>
      ) : isNearingCap ? (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-2 text-[10px] text-amber-600 dark:text-amber-400 font-medium">
          Approaching configured spend cap.
        </div>
      ) : null}
    </div>
  );

  return (
    <StatusBarPopover content={popoverContent} delay={150}>
      <div
        className={`inline-flex items-center gap-1.5 cursor-default transition-colors hover:text-foreground ${className}`}
        aria-label={`Session spend ${formatCurrency(spentUsd)}`}
      >
        <Coins className={`h-3 w-3 shrink-0 ${isCapped ? 'text-destructive' : isNearingCap ? 'text-amber-500' : 'text-primary/80'}`} />
        <span className="font-medium tabular-nums tracking-tight text-foreground">
          {formatCurrency(spentUsd)}
        </span>

        {/* Spend cap progress bar if cap configured */}
        {effectiveCap != null && (
          <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
            <span>/{formatCurrency(effectiveCap)}</span>
            <span className="inline-block h-1.5 w-6 overflow-hidden rounded-full bg-muted">
              <span
                className={`block h-full transition-all duration-300 ${
                  isCapped ? 'bg-destructive' : isNearingCap ? 'bg-amber-500' : 'bg-primary'
                }`}
                style={{ width: `${capProgress}%` }}
              />
            </span>
          </span>
        )}

        {/* Burn Rate Velocity */}
        {burnRateUsdPerMin > 0 && (
          <span className="hidden sm:inline-flex items-center gap-0.5 text-[10px] text-muted-foreground/90">
            <Flame className="h-2.5 w-2.5 text-amber-500/80 shrink-0" />
            <span className="tabular-nums">~{formatVelocity(burnRateUsdPerMin)}/m</span>
          </span>
        )}

        {/* Turn Cost */}
        {lastTurnCostUsd > 0 && (
          <span className="hidden md:inline-flex items-center gap-0.5 text-[10px] text-muted-foreground/75">
            <ArrowUpRight className="h-2.5 w-2.5 shrink-0 opacity-70" />
            <span>turn {formatCurrency(lastTurnCostUsd)}</span>
          </span>
        )}
      </div>
    </StatusBarPopover>
  );
}
