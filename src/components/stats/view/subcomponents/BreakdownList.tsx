import { useState, type ReactNode } from 'react';

import { cn } from '../../../../lib/utils';
import { formatCost, formatPercent, formatTokens, formatTokensExact } from '../../utils/format';

export type BreakdownRow = {
  key: string;
  label: string;
  /** Secondary muted label (e.g. provider name on model rows). */
  sublabel?: string;
  tokens: number;
  runs: number;
  costUsd?: number | null;
  conversations?: number;
  /** Renders the label as an explicit "Unknown …" placeholder. */
  isUnknown?: boolean;
};

type BreakdownListProps = {
  title: string;
  icon?: ReactNode;
  rows: BreakdownRow[];
  /** Denominator for the share percentage (usually overview.totalTokens). */
  totalTokens: number;
  emptyText: string;
  /** Rows shown before the "show more" toggle. */
  maxRows?: number;
  /** Currently applied filter key (Looker-style cross-filter). */
  selectedKey?: string | null;
  /** Click a row to filter the dashboard; click again to clear. */
  onSelect?: (row: BreakdownRow) => void;
};

const BAR_COLORS = [
  'bg-sky-500',
  'bg-violet-500',
  'bg-emerald-500',
  'bg-amber-500',
  'bg-rose-500',
  'bg-cyan-500',
  'bg-fuchsia-500',
  'bg-lime-600',
];

/**
 * Horizontal-bar breakdown (providers / models / sources). Every row carries
 * text labels and exact numbers; the colored bar only reinforces magnitude.
 */
export default function BreakdownList({
  title,
  icon,
  rows,
  totalTokens,
  emptyText,
  maxRows = 8,
  selectedKey,
  onSelect,
}: BreakdownListProps) {
  const [expanded, setExpanded] = useState(false);

  const visible = expanded ? rows : rows.slice(0, maxRows);
  const hiddenCount = rows.length - visible.length;
  const maxTokens = Math.max(1, ...rows.map((row) => row.tokens));

  return (
    <section className="flex min-w-0 flex-col gap-2">
      <h3 className="flex items-center gap-1.5 text-xs font-medium text-foreground">
        {icon}
        {title}
      </h3>
      {rows.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
          {emptyText}
        </p>
      ) : (
        <div className="flex flex-col gap-1">
          {visible.map((row, index) => {
            const share = totalTokens > 0 ? row.tokens / totalTokens : 0;
            const barColor = BAR_COLORS[index % BAR_COLORS.length];
            const detailParts = [
              `${formatTokensExact(row.tokens)} tokens`,
              `${row.runs} run${row.runs === 1 ? '' : 's'}`,
            ];
            if (row.conversations != null && row.conversations > 0) {
              detailParts.push(
                `${row.conversations} conversation${row.conversations === 1 ? '' : 's'}`,
              );
            }
            if (row.costUsd != null && row.costUsd > 0) {
              detailParts.push(formatCost(row.costUsd));
            }
            const isSelected = selectedKey != null && selectedKey === row.key;
            const isDimmed = selectedKey != null && selectedKey !== row.key;
            const interactive = Boolean(onSelect);
            return (
              <div
                key={row.key}
                role={interactive ? 'button' : undefined}
                tabIndex={interactive ? 0 : undefined}
                onClick={interactive ? () => onSelect?.(row) : undefined}
                onKeyDown={
                  interactive
                    ? (event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          onSelect?.(row);
                        }
                      }
                    : undefined
                }
                className={cn(
                  'rounded-lg px-2 py-1.5',
                  interactive && 'cursor-pointer hover:bg-accent/40',
                  isSelected && 'bg-primary/10 ring-1 ring-primary/30',
                  isDimmed && 'opacity-50',
                )}
                title={
                  interactive
                    ? `${isSelected ? 'Clear filter: ' : 'Filter dashboard to '}${row.label}`
                    : `${row.label} — ${detailParts.join(' · ')}`
                }
                aria-pressed={interactive ? isSelected : undefined}
              >
                <div className="flex items-baseline justify-between gap-2">
                  <div className="flex min-w-0 items-baseline gap-1.5">
                    <span
                      className={cn(
                        'truncate text-xs font-medium',
                        row.isUnknown ? 'italic text-muted-foreground' : 'text-foreground',
                      )}
                    >
                      {row.label}
                    </span>
                    {row.sublabel ? (
                      <span className="truncate text-[10px] text-muted-foreground">
                        {row.sublabel}
                      </span>
                    ) : null}
                  </div>
                  <div className="flex shrink-0 items-baseline gap-2 tabular-nums">
                    <span className="text-[11px] font-medium text-foreground">
                      {formatTokens(row.tokens)}
                    </span>
                    <span className="w-9 text-right text-[10px] text-muted-foreground">
                      {totalTokens > 0 ? formatPercent(share) : '—'}
                    </span>
                  </div>
                </div>
                <div
                  className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-muted"
                  role="img"
                  aria-label={`${row.label}: ${formatPercent(share)} of tokens`}
                >
                  <div
                    className={cn('h-full rounded-full', barColor)}
                    style={{ width: `${Math.max(row.tokens > 0 ? 2 : 0, (row.tokens / maxTokens) * 100)}%` }}
                  />
                </div>
                <div className="mt-0.5 text-[10px] text-muted-foreground/80">
                  {detailParts.join(' · ')}
                </div>
              </div>
            );
          })}
          {rows.length > maxRows ? (
            <button
              type="button"
              className="mt-1 self-start rounded-md px-2 py-1 text-[11px] font-medium text-primary hover:bg-accent/60"
              onClick={() => setExpanded((value) => !value)}
            >
              {expanded ? 'Show less' : `Show ${hiddenCount} more`}
            </button>
          ) : null}
        </div>
      )}
    </section>
  );
}
