import type { ReactNode } from 'react';

import { cn } from '../../../../lib/utils';

type KpiCardProps = {
  icon: ReactNode;
  label: string;
  value: string;
  /** Secondary line under the value (muted). */
  sub?: string;
  /** Exact/verbose value for the native tooltip. */
  title?: string;
};

/** Single headline metric card for the Stats dashboard. */
export default function KpiCard({ icon, label, value, sub, title }: KpiCardProps) {
  return (
    <div
      className="flex min-w-0 flex-col gap-1.5 rounded-xl border border-border bg-card p-3 shadow-sm sm:p-4"
      title={title}
    >
      <div className="flex items-center gap-1.5 text-muted-foreground">
        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
          {icon}
        </span>
        <span className="truncate text-[11px] font-medium uppercase tracking-wide">{label}</span>
      </div>
      <div className={cn('truncate text-xl font-semibold tabular-nums text-foreground sm:text-2xl')}>
        {value}
      </div>
      {sub ? <div className="truncate text-[11px] text-muted-foreground">{sub}</div> : null}
    </div>
  );
}
