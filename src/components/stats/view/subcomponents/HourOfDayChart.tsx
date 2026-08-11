import { useMemo, useState } from 'react';

import type { StatsHourBucket } from '../../api/statsApi';
import { formatHourUtc } from '../../utils/format';

type HourOfDayChartProps = {
  /** 24 buckets, hours 0-23 (UTC). */
  hours: StatsHourBucket[];
};

const CHART_HEIGHT = 96;

/**
 * Runs started per hour of day (UTC). Bars are labeled with text values on
 * selection so the chart never relies on color alone.
 */
export default function HourOfDayChart({ hours }: HourOfDayChartProps) {
  const [selectedHour, setSelectedHour] = useState<number | null>(null);

  const maxRuns = useMemo(() => Math.max(1, ...hours.map((bucket) => bucket.runs)), [hours]);
  const totalRuns = useMemo(() => hours.reduce((sum, bucket) => sum + bucket.runs, 0), [hours]);

  if (hours.length === 0) return null;

  const barWidth = 100 / hours.length;
  const selected = selectedHour != null ? hours[selectedHour] : null;

  return (
    <figure className="flex min-w-0 flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <figcaption className="text-xs font-medium text-foreground">Runs by hour of day</figcaption>
        <span className="text-[11px] text-muted-foreground/70">UTC</span>
      </div>
      <svg
        viewBox={`0 0 100 ${CHART_HEIGHT}`}
        preserveAspectRatio="none"
        className="h-24 w-full"
        role="img"
        aria-label={`Runs started per hour (UTC), peaking at ${maxRuns} runs in one hour`}
      >
        {hours.map((bucket, index) => {
          const height = (bucket.runs / maxRuns) * (CHART_HEIGHT - 6);
          const x = index * barWidth + 0.15;
          const width = Math.max(0.5, barWidth - 0.3);
          const isSelected = index === selectedHour;
          return (
            <g
              key={bucket.hour}
              onMouseEnter={() => setSelectedHour(index)}
              onClick={() => setSelectedHour(index)}
              className="cursor-pointer"
            >
              <title>
                {`${formatHourUtc(bucket.hour)} UTC — ${bucket.runs} run${bucket.runs === 1 ? '' : 's'} started`}
              </title>
              <rect
                x={x}
                y={0}
                width={width}
                height={CHART_HEIGHT}
                className={isSelected ? 'fill-accent/60' : 'fill-transparent hover:fill-accent/30'}
              />
              {height > 0 ? (
                <rect
                  x={x}
                  y={CHART_HEIGHT - height}
                  width={width}
                  height={height}
                  className="fill-emerald-500"
                  opacity={isSelected ? 1 : 0.85}
                />
              ) : null}
            </g>
          );
        })}
      </svg>
      <div className="flex justify-between text-[10px] text-muted-foreground/80">
        {[0, 6, 12, 18, 23].map((hour) => (
          <span key={hour}>{formatHourUtc(hour)}</span>
        ))}
      </div>
      <div className="min-h-5 text-[11px] text-muted-foreground" aria-live="polite">
        {selected ? (
          <span>
            <span className="font-medium text-foreground">
              {formatHourUtc(selected.hour)} – {formatHourUtc((selected.hour + 1) % 24)} UTC
            </span>
            {' · '}
            {selected.runs} run{selected.runs === 1 ? '' : 's'} started
            {totalRuns > 0 ? ` (${Math.round((selected.runs / totalRuns) * 100)}%)` : ''}
          </span>
        ) : (
          <span className="text-muted-foreground/70">Hover or tap a bar for details</span>
        )}
      </div>
    </figure>
  );
}
