/** Pure formatting helpers shared by the Bot Runtime v2 tabs (Activity, Thread, Goals). */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function toTime(value: string | null | undefined): number | null {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

function spanLabel(ms: number): string {
  if (ms < MINUTE) return `${Math.max(1, Math.round(ms / 1000))}s`;
  if (ms < HOUR) return `${Math.floor(ms / MINUTE)}m`;
  if (ms < DAY) return `${Math.floor(ms / HOUR)}h`;
  return `${Math.floor(ms / DAY)}d`;
}

/** "5m ago" / "in 2h" / "just now". Differences under 30s read as "just now". */
export function formatRelativeTime(value: string | null | undefined, now: number = Date.now()): string {
  const time = toTime(value);
  if (time === null) return 'unknown time';
  const diff = time - now;
  if (Math.abs(diff) < 30_000) return 'just now';
  return diff < 0 ? `${spanLabel(-diff)} ago` : `in ${spanLabel(diff)}`;
}

export type DueInfo = { label: string; overdue: boolean; soon: boolean };

/** Relative due label for a commitment: "due in 3h", "overdue 2d". `soon` = within 24h and not overdue. */
export function formatDue(value: string | null | undefined, now: number = Date.now()): DueInfo {
  const time = toTime(value);
  if (time === null) return { label: 'no due date', overdue: false, soon: false };
  const diff = time - now;
  if (Math.abs(diff) < 30_000) return { label: 'due now', overdue: false, soon: true };
  if (diff < 0) return { label: `overdue ${spanLabel(-diff)}`, overdue: true, soon: false };
  return { label: `due in ${spanLabel(diff)}`, overdue: false, soon: diff <= DAY };
}

/** USD with enough precision for sub-cent agent runs. */
export function formatCostUsd(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—';
  if (value === 0) return '$0.00';
  if (value < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}

/** Elapsed ms for an episode; a still-running one counts up to `now`. Null when it cannot be computed. */
export function episodeDurationMs(
  episode: { started_at: string; finished_at: string | null },
  now: number = Date.now(),
): number | null {
  const start = toTime(episode.started_at);
  if (start === null) return null;
  const end = toTime(episode.finished_at) ?? now;
  return Math.max(0, end - start);
}

const TRIGGER_LABELS: Record<string, string> = {
  cron: 'Schedule',
  interval: 'Interval',
  nl_schedule: 'Schedule',
  webhook: 'Webhook',
  kanban_event: 'Kanban',
  run_completed: 'Run finished',
  interrupt_created: 'Approval',
  watch: 'Watch',
  peer_message: 'Peer bot',
  ask_bot: 'Ask bot',
  commitment_due: 'Commitment due',
  operator_message: 'Operator message',
  manual: 'Manual wake',
};

/** Split the server's comma-joined `trigger_kinds` into de-duplicated, human labels. */
export function triggerKindLabels(kinds: string | null | undefined): string[] {
  const seen = new Set<string>();
  const labels: string[] = [];
  for (const raw of (kinds ?? '').split(',')) {
    const key = raw.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    labels.push(TRIGGER_LABELS[key] ?? key.replace(/[-_]+/g, ' ').replace(/^./, (c) => c.toUpperCase()));
  }
  return labels;
}

const CHANNEL_LABELS: Record<string, string> = { inapp: 'In-app', telegram: 'Telegram', slack: 'Slack' };

export function channelLabel(channel: string | null | undefined): string {
  const key = (channel ?? '').trim().toLowerCase();
  if (!key) return 'In-app';
  return CHANNEL_LABELS[key] ?? key.replace(/^./, (c) => c.toUpperCase());
}

/** Convert a `datetime-local` input value (local wall time) to an ISO string; null when empty/invalid. */
export function localInputToIso(value: string): string | null {
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

/** Format epoch ms as a `datetime-local` input value in local time (used for sensible defaults). */
export function toLocalInputValue(time: number): string {
  const date = new Date(time);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function shortDateTime(value: string | null | undefined): string {
  const time = toTime(value);
  if (time === null) return '—';
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(time));
}
