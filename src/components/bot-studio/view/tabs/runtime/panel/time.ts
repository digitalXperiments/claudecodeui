/** Small pure time helpers shared by the runtime tabs. `now` is injectable for tests. */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "just now", "5m ago", "3h ago", "2d ago" (or "in 5m" for a future time). */
export function relativeTime(value: string | null | undefined, now = Date.now()): string {
  if (!value) return 'never';
  const at = Date.parse(value);
  if (!Number.isFinite(at)) return 'unknown';
  const delta = now - at;
  const abs = Math.abs(delta);
  const text = abs < MINUTE ? null : abs < HOUR ? `${Math.floor(abs / MINUTE)}m` : abs < DAY ? `${Math.floor(abs / HOUR)}h` : `${Math.floor(abs / DAY)}d`;
  if (!text) return 'just now';
  return delta >= 0 ? `${text} ago` : `in ${text}`;
}

export type Expiry = { expired: boolean; label: string; soon: boolean };

/** Countdown for a rule expiry. `null` expiry means the rule never expires. */
export function expiryCountdown(expiresAt: string | null | undefined, now = Date.now()): Expiry {
  if (!expiresAt) return { expired: false, label: 'Never expires', soon: false };
  const at = Date.parse(expiresAt);
  if (!Number.isFinite(at)) return { expired: false, label: 'Unknown expiry', soon: false };
  const left = at - now;
  if (left <= 0) return { expired: true, label: 'Expired', soon: false };
  if (left < HOUR) return { expired: false, label: `Expires in ${Math.max(1, Math.ceil(left / MINUTE))}m`, soon: true };
  if (left < DAY) return { expired: false, label: `Expires in ${Math.floor(left / HOUR)}h ${Math.floor((left % HOUR) / MINUTE)}m`, soon: true };
  const days = Math.floor(left / DAY);
  return { expired: false, label: `Expires in ${days}d ${Math.floor((left % DAY) / HOUR)}h`, soon: false };
}

/** Short local date-time for table rows. */
export function shortDateTime(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
