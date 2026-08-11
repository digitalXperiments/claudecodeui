/**
 * Number/duration/date formatting for the Stats dashboard.
 * Compact forms for cards and charts; exact forms for tooltips/titles.
 */

/** Compact token count: 1.2M / 34.5k / 812. Em-dash for null. */
export function formatTokens(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1_000)}k`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}

/** Exact token count with thousand separators, for tooltips/titles. */
export function formatTokensExact(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return Math.round(n).toLocaleString();
}

/** USD cost; shows cents, or sub-cent precision for tiny amounts. */
export function formatCost(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  if (n > 0 && n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

/** Wall-clock duration: 45s / 12m 30s / 3h 12m / 2d 4h. */
export function formatDurationMs(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remSeconds = seconds % 60;
  if (minutes < 60) return remSeconds ? `${minutes}m ${remSeconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  if (hours < 24) return remMinutes ? `${hours}h ${remMinutes}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours ? `${days}d ${remHours}h` : `${days}d`;
}

/** Ratio 0..1 → "68%". Em-dash for null. */
export function formatPercent(ratio: number | null | undefined): string {
  if (ratio == null || !Number.isFinite(ratio)) return '—';
  return `${Math.round(ratio * 100)}%`;
}

/** "2026-08-11" (UTC day key) → "Aug 11" short chart label. */
export function formatDayShort(day: string): string {
  const date = parseUtcDay(day);
  if (!date) return day;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

/** "2026-08-11" (UTC day key) → "Tue, Aug 11, 2026" tooltip label. */
export function formatDayLong(day: string): string {
  const date = parseUtcDay(day);
  if (!date) return day;
  return date.toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/** Parse a YYYY-MM-DD UTC day key; null when malformed. */
export function parseUtcDay(day: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!match) return null;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return Number.isFinite(date.getTime()) ? date : null;
}

/** Hour 0-23 → "14:00" UTC label. */
export function formatHourUtc(hour: number): string {
  return `${String(hour).padStart(2, '0')}:00`;
}
