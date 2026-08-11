import { useMemo, useState } from 'react';

import type { StatsDayBucket } from '../../api/statsApi';
import {
  formatCost,
  formatDayLong,
  formatDayShort,
  formatTokensExact,
} from '../../utils/format';

type UsageOverTimeChartProps = {
  /** Dense day sequence (gaps already zero-filled), ascending. */
  days: StatsDayBucket[];
};

const CHART_HEIGHT = 160;
const BAR_GAP = 2;

/**
 * Stacked input/output token bars per UTC day. Hover or tap a bar to pin its
 * details in the strip below; every bar also carries a native <title> and the
 * full series is available as a data table for screen readers.
 */
export default function UsageOverTimeChart({ days }: UsageOverTimeChartProps) {
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);

  const maxTokens = useMemo(() => Math.max(1, ...days.map((day) => day.tokens)), [days]);
  const hasAnyTokens = days.some((day) => day.tokens > 0);

  if (days.length === 0) return null;

  const selected = selectedIndex != null ? days[selectedIndex] : null;
  const barWidth = 100 / days.length;

  // Sparse-axis labels: first, middle, last day.
  const labelIndexes = [...new Set([0, Math.floor((days.length - 1) / 2), days.length - 1])];

  return (
    <figure className="flex min-w-0 flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <figcaption className="text-xs font-medium text-foreground">Token usage over time</figcaption>
        <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-sm bg-sky-500" aria-hidden="true" />
            Input tokens
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-sm bg-violet-500" aria-hidden="true" />
            Output tokens
          </span>
          <span className="hidden text-muted-foreground/70 sm:inline">Days are UTC</span>
        </div>
      </div>

      {!hasAnyTokens ? (
        <p className="rounded-lg border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
          Runs happened in this range, but none reported token usage.
        </p>
      ) : (
        <>
          <svg
            viewBox={`0 0 100 ${CHART_HEIGHT}`}
            preserveAspectRatio="none"
            className="h-40 w-full"
            role="img"
            aria-label={`Daily token usage, up to ${formatTokensExact(maxTokens)} tokens per day`}
          >
            {days.map((day, index) => {
              const totalHeight = (day.tokens / maxTokens) * (CHART_HEIGHT - 8);
              const outputHeight =
                day.tokens > 0 ? (day.outputTokens / day.tokens) * totalHeight : 0;
              const inputHeight = totalHeight - outputHeight;
              const x = index * barWidth + BAR_GAP / 2 / 10;
              const width = Math.max(0.5, barWidth - BAR_GAP / 10);
              const isSelected = index === selectedIndex;
              return (
                <g
                  key={day.day}
                  onMouseEnter={() => setSelectedIndex(index)}
                  onClick={() => setSelectedIndex(index)}
                  className="cursor-pointer"
                >
                  <title>
                    {`${formatDayLong(day.day)} — ${formatTokensExact(day.tokens)} tokens (${formatTokensExact(day.inputTokens)} in / ${formatTokensExact(day.outputTokens)} out), ${day.runs} runs`}
                  </title>
                  {/* Full-height hit area so zero-days stay selectable. */}
                  <rect
                    x={x}
                    y={0}
                    width={width}
                    height={CHART_HEIGHT}
                    className={
                      isSelected ? 'fill-accent/60' : 'fill-transparent hover:fill-accent/30'
                    }
                  />
                  {inputHeight > 0 ? (
                    <rect
                      x={x}
                      y={CHART_HEIGHT - inputHeight - outputHeight}
                      width={width}
                      height={inputHeight}
                      className="fill-sky-500"
                      opacity={isSelected ? 1 : 0.85}
                    />
                  ) : null}
                  {outputHeight > 0 ? (
                    <rect
                      x={x}
                      y={CHART_HEIGHT - outputHeight}
                      width={width}
                      height={outputHeight}
                      className="fill-violet-500"
                      opacity={isSelected ? 1 : 0.85}
                    />
                  ) : null}
                </g>
              );
            })}
          </svg>

          <div className="flex justify-between text-[10px] text-muted-foreground/80">
            {labelIndexes.map((index) => (
              <span key={index}>{formatDayShort(days[index].day)}</span>
            ))}
          </div>

          <div className="min-h-5 text-[11px] text-muted-foreground" aria-live="polite">
            {selected ? (
              <span>
                <span className="font-medium text-foreground">{formatDayLong(selected.day)}</span>
                {' · '}
                {formatTokensExact(selected.tokens)} tokens ({formatTokensExact(selected.inputTokens)} in /{' '}
                {formatTokensExact(selected.outputTokens)} out)
                {' · '}
                {selected.runs} run{selected.runs === 1 ? '' : 's'}
                {selected.conversations > 0
                  ? ` · ${selected.conversations} conversation${selected.conversations === 1 ? '' : 's'}`
                  : ''}
                {selected.costUsd > 0 ? ` · ${formatCost(selected.costUsd)}` : ''}
              </span>
            ) : (
              <span className="text-muted-foreground/70">Hover or tap a bar for details</span>
            )}
          </div>

          <details className="text-[11px] text-muted-foreground">
            <summary className="cursor-pointer select-none">View as data table</summary>
            <div className="mt-1 max-h-48 overflow-y-auto rounded-lg border border-border">
              <table className="w-full text-left">
                <thead className="sticky top-0 bg-muted text-[10px] uppercase tracking-wide">
                  <tr>
                    <th className="px-2 py-1 font-medium">Day (UTC)</th>
                    <th className="px-2 py-1 text-right font-medium">Input</th>
                    <th className="px-2 py-1 text-right font-medium">Output</th>
                    <th className="px-2 py-1 text-right font-medium">Total</th>
                    <th className="px-2 py-1 text-right font-medium">Runs</th>
                  </tr>
                </thead>
                <tbody>
                  {days.map((day) => (
                    <tr key={day.day} className="border-t border-border/50 tabular-nums">
                      <td className="px-2 py-1">{day.day}</td>
                      <td className="px-2 py-1 text-right">{formatTokensExact(day.inputTokens)}</td>
                      <td className="px-2 py-1 text-right">{formatTokensExact(day.outputTokens)}</td>
                      <td className="px-2 py-1 text-right">{formatTokensExact(day.tokens)}</td>
                      <td className="px-2 py-1 text-right">{day.runs}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </>
      )}
    </figure>
  );
}
