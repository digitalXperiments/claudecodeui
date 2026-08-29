import { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, Gauge } from 'lucide-react';

import { authenticatedFetch } from '../../../utils/api';

export type SwarmMetrics = {
  swarmId: string;
  stepsTotal: number;
  stepsSucceeded: number;
  stepsFailed: number;
  stepsNeedsChanges: number;
  retries: number;
  retryRate: number;
  /** Share of elapsed wall-clock with ≥2 agents working (0–1). */
  parallelRatio: number;
  avgConcurrent: number;
  maxConcurrent: number;
  wallClockMs: number | null;
  dispatchCycles: number;
  scopeViolations: number;
  budgetStops: number;
  mailboxNotes: number;
  failureTaxonomy: Record<string, number>;
  firstTrySuccessRate: number | null;
};

function formatMs(ms: number | null): string {
  if (ms == null) return '—';
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1000);
  return minutes >= 1 ? `${minutes}m ${String(seconds).padStart(2, '0')}s` : `${seconds}s`;
}

/**
 * Evaluation panel (PRD swarm-studio-v2 measurement loop): did this swarm
 * actually run like a dynamic workflow? Parallel ratio is the headline —
 * share of wall-clock time with ≥2 agents executing.
 */
export default function SwarmMetricsPanel({ swarmId }: { swarmId: string }) {
  const [open, setOpen] = useState(false);
  const [metrics, setMetrics] = useState<SwarmMetrics | null>(null);

  useEffect(() => {
    if (!open || metrics) return;
    let cancelled = false;
    authenticatedFetch(`/api/swarm/${encodeURIComponent(swarmId)}/metrics`)
      .then(async (res) => {
        if (!res.ok) throw new Error('failed');
        return (await res.json()) as { metrics?: SwarmMetrics };
      })
      .then((payload) => {
        if (!cancelled && payload.metrics) setMetrics(payload.metrics);
      })
      .catch(() => {
        /* keep collapsed silently */
      });
    return () => {
      cancelled = true;
    };
  }, [open, swarmId, metrics]);

  const ratioPct = metrics ? Math.round(metrics.parallelRatio * 100) : null;
  const ratioColor =
    ratioPct == null
      ? ''
      : ratioPct >= 50
        ? 'bg-emerald-500'
        : ratioPct >= 25
          ? 'bg-amber-500'
          : 'bg-red-500';

  return (
    <div className="rounded-xl border border-border/50 bg-muted/20">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] font-semibold text-foreground"
        aria-expanded={open}
      >
        <Gauge className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
        Effectiveness metrics
        {open ? (
          <ChevronDown className="ml-auto h-3.5 w-3.5 text-muted-foreground" />
        ) : (
          <ChevronRight className="ml-auto h-3.5 w-3.5 text-muted-foreground" />
        )}
      </button>
      {open ? (
        !metrics ? (
          <p className="px-3 pb-3 text-[11px] text-muted-foreground">Loading…</p>
        ) : (
          <div className="space-y-3 px-3 pb-3">
            <div>
              <div className="flex items-center justify-between text-[11px]">
                <span className="text-muted-foreground">Parallel ratio</span>
                <span className="font-semibold text-foreground">{ratioPct}%</span>
              </div>
              <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-border/60">
                <div
                  className={`h-full rounded-full transition-all ${ratioColor}`}
                  style={{ width: `${ratioPct ?? 0}%` }}
                />
              </div>
              <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground">
                Share of wall-clock time with ≥2 agents working simultaneously.
                ≥50% is healthy fan-out; &lt;25% means the goal serialized.
              </p>
            </div>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[11px] sm:grid-cols-3">
              {[
                ['Wall clock', formatMs(metrics.wallClockMs)],
                ['Avg concurrent', String(metrics.avgConcurrent)],
                ['Peak concurrent', String(metrics.maxConcurrent)],
                ['Steps', `${metrics.stepsSucceeded}/${metrics.stepsTotal} done`],
                ['First-try success', metrics.firstTrySuccessRate != null ? `${Math.round(metrics.firstTrySuccessRate * 100)}%` : '—'],
                ['Retry rate', `${Math.round(metrics.retryRate * 100)}%`],
                ['Dispatch cycles', String(metrics.dispatchCycles)],
                ['Scope serializations', String(metrics.scopeViolations)],
                ['Mailbox notes', String(metrics.mailboxNotes)],
              ].map(([label, value]) => (
                <div key={label} className="flex items-center justify-between gap-2">
                  <span className="text-muted-foreground">{label}</span>
                  <span className="font-medium tabular-nums text-foreground">{value}</span>
                </div>
              ))}
            </div>
            {metrics.stepsFailed > 0 ? (
              <div className="text-[11px]">
                <span className="text-muted-foreground">Failures:</span>{' '}
                {Object.entries(metrics.failureTaxonomy)
                  .filter(([, count]) => count > 0)
                  .map(([kind, count]) => `${kind}: ${count}`)
                  .join(' · ') || `total ${metrics.stepsFailed}`}
              </div>
            ) : null}
            {metrics.budgetStops > 0 ? (
              <div className="text-[10px] text-amber-600 dark:text-amber-400">
                Budget stop fired ({metrics.budgetStops}) — remaining work was reported unresolved.
              </div>
            ) : null}
          </div>
        )
      ) : null}
    </div>
  );
}
