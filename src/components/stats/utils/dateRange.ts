/**
 * Date-range presets and UTC day-sequence helpers for the Stats dashboard.
 * All buckets from the server are UTC day keys (YYYY-MM-DD); ranges are
 * resolved to inclusive ISO-8601 bounds before hitting the API.
 */

import { parseUtcDay } from './format';

export type StatsRangeKey = '7d' | '30d' | '90d' | 'all' | 'custom';

export type ResolvedStatsRange = {
  from?: string;
  to?: string;
};

export const STATS_RANGE_OPTIONS: Array<{ key: StatsRangeKey; label: string }> = [
  { key: '7d', label: '7D' },
  { key: '30d', label: '30D' },
  { key: '90d', label: '90D' },
  { key: 'all', label: 'All time' },
  { key: 'custom', label: 'Custom' },
];

function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function toDayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Resolve a preset/custom selection to inclusive API bounds. */
export function resolveStatsRange(
  key: StatsRangeKey,
  customFrom?: string,
  customTo?: string,
  now: Date = new Date(),
): ResolvedStatsRange {
  if (key === 'all') return {};
  if (key === 'custom') {
    const fromDay = customFrom ? parseUtcDay(customFrom) : null;
    const toDay = customTo ? parseUtcDay(customTo) : null;
    const range: ResolvedStatsRange = {};
    if (fromDay) range.from = startOfUtcDay(fromDay).toISOString();
    // End of the selected day (inclusive bound on created_at).
    if (toDay) range.to = new Date(startOfUtcDay(toDay).getTime() + 86_399_999).toISOString();
    return range;
  }
  const days = key === '7d' ? 7 : key === '30d' ? 30 : 90;
  const from = startOfUtcDay(now);
  from.setUTCDate(from.getUTCDate() - (days - 1));
  return { from: from.toISOString(), to: now.toISOString() };
}

/** Short human label for the active range ("Aug 4 – Aug 11, 2026", "All time"). */
export function describeStatsRange(key: StatsRangeKey, range: ResolvedStatsRange): string {
  if (key === 'all' || (!range.from && !range.to)) return 'All time';
  const fmt = (iso: string) =>
    new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const fromLabel = range.from ? fmt(range.from) : '…';
  const toLabel = range.to
    ? new Date(range.to).toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      })
    : 'now';
  return `${fromLabel} – ${toLabel}`;
}

/**
 * Densify sparse server buckets into a continuous UTC day sequence so charts
 * render zero-usage days as gaps. Range-limited views fill the whole window;
 * unbounded views fill between the first and last active day.
 */
export function fillDailyGaps<T extends { day: string }>(
  buckets: T[],
  range: ResolvedStatsRange,
  makeEmpty: (day: string) => T,
): T[] {
  if (buckets.length === 0) return [];
  const byDay = new Map(buckets.map((bucket) => [bucket.day, bucket]));

  const first = buckets[0].day;
  const last = buckets[buckets.length - 1].day;
  const startKey = range.from ? toDayKey(startOfUtcDay(new Date(range.from))) : first;
  const endKey = range.to ? toDayKey(startOfUtcDay(new Date(range.to))) : last;

  const start = parseUtcDay(startKey < first ? startKey : first) ?? parseUtcDay(first);
  const end = parseUtcDay(endKey > last ? endKey : last) ?? parseUtcDay(last);
  if (!start || !end) return buckets;

  // Safety bound: never emit more than ~5 years of daily buckets.
  const MAX_DAYS = 1862;
  const dense: T[] = [];
  const cursor = new Date(start);
  while (cursor <= end && dense.length < MAX_DAYS) {
    const key = toDayKey(cursor);
    dense.push(byDay.get(key) ?? makeEmpty(key));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dense;
}
