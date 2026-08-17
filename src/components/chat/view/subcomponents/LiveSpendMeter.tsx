import { useEffect, useState } from 'react';
import { Coins } from 'lucide-react';

import { authenticatedFetch } from '../../../../utils/api';
import { cn } from '../../../../lib/utils';

type SpendVerdict = {
  spentUsd: number;
  softUsd: number | null;
  hardUsd: number | null;
  soft: boolean;
  hard: boolean;
};

type LiveSpendMeterProps = {
  sessionId?: string | null;
  spentUsd?: number | null;
  className?: string;
};

export default function LiveSpendMeter({ sessionId, spentUsd, className }: LiveSpendMeterProps) {
  const [verdict, setVerdict] = useState<SpendVerdict | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      if (typeof spentUsd === 'number') {
        try {
          const res = await authenticatedFetch('/api/features');
          const data = await res.json().catch(() => ({}));
          const softUsd = data?.features?.spendSoftCostUsd ?? null;
          const hardUsd = data?.features?.spendHardCostUsd ?? null;
          if (!cancelled) {
            setVerdict({
              spentUsd,
              softUsd,
              hardUsd,
              soft: softUsd != null && spentUsd >= softUsd,
              hard: hardUsd != null && spentUsd >= hardUsd,
            });
          }
        } catch {
          if (!cancelled) {
            setVerdict({
              spentUsd,
              softUsd: null,
              hardUsd: null,
              soft: false,
              hard: false,
            });
          }
        }
        return;
      }
      if (!sessionId) {
        setVerdict(null);
        return;
      }
      try {
        const res = await authenticatedFetch(
          `/api/runs/live-usage?sessionId=${encodeURIComponent(sessionId)}`,
        );
        const data = await res.json();
        if (!cancelled && data?.verdict) {
          setVerdict(data.verdict as SpendVerdict);
        }
      } catch {
        // Meter is best-effort.
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), 15_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [sessionId, spentUsd]);

  if (!verdict || verdict.spentUsd <= 0) {
    return null;
  }

  const cap = verdict.hardUsd ?? verdict.softUsd;
  const ratio = cap ? Math.min(1, verdict.spentUsd / cap) : 0;

  return (
    <div
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] tabular-nums',
        verdict.hard
          ? 'border-red-500/40 bg-red-500/10 text-red-600 dark:text-red-300'
          : verdict.soft
            ? 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300'
            : 'border-border/70 bg-muted/40 text-muted-foreground',
        className,
      )}
      title={
        verdict.hard
          ? `Hard cap $${verdict.hardUsd?.toFixed(0)} — next seat will pause`
          : verdict.soft
            ? `Soft cap $${verdict.softUsd?.toFixed(0)} — next seat will cheapen`
            : `Live spend on this session`
      }
    >
      <Coins className="h-3 w-3" />
      ${verdict.spentUsd.toFixed(2)}
      {cap ? (
        <span className="text-[10px] opacity-70">/ ${cap.toFixed(0)}</span>
      ) : null}
      {cap ? (
        <span className="h-1 w-10 overflow-hidden rounded-full bg-black/10 dark:bg-white/10">
          <span
            className={cn(
              'block h-full',
              verdict.hard ? 'bg-red-500' : verdict.soft ? 'bg-amber-500' : 'bg-emerald-500',
            )}
            style={{ width: `${Math.max(8, ratio * 100)}%` }}
          />
        </span>
      ) : null}
    </div>
  );
}
