const ACTIVE_RUN_STATUSES = new Set(['queued', 'starting', 'running', 'waiting_permission', 'waiting_approval']);

/** Whether a tick is still in flight (not yet succeeded/failed/aborted/timed out). */
export function isRunActive(status: string): boolean {
  return ACTIVE_RUN_STATUSES.has(status.toLowerCase());
}

export function formatDuration(durationMs: number | null | undefined): string {
  if (durationMs == null || !Number.isFinite(durationMs)) return '—';
  const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, '0')}m`;
}
