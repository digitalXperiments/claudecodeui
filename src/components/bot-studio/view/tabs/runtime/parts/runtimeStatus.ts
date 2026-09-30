/** One-line summary of the global runtime status as it applies to a single bot. */
export function describeRuntimeStatus(
  status: { enabled: boolean; running: string[]; queuedWakes: number; queuedEvents: number; runtime_running?: boolean; forced_off?: boolean } | null,
  botId: string,
): { tone: 'running' | 'queued' | 'idle' | 'disabled' | 'unknown'; label: string } {
  if (!status) return { tone: 'unknown', label: 'Runtime status unavailable' };
  if (!status.enabled) return { tone: 'disabled', label: 'Runtime is disabled' };
  if (status.forced_off) return { tone: 'disabled', label: 'Runtime is forced off on this server (CLOUDCLI_BOTS_RUNTIME=off) — events queue but the bot will not wake' };
  if (status.runtime_running === false) return { tone: 'disabled', label: 'Runtime is not running on this server — check the server log' };
  const queued = status.queuedWakes + status.queuedEvents;
  if (status.running.includes(botId)) {
    return { tone: 'running', label: queued > 0 ? `Running now · ${queued} queued across all bots` : 'Running now' };
  }
  if (queued > 0) return { tone: 'queued', label: `Idle · ${queued} queued across all bots (${status.queuedWakes} wake${status.queuedWakes === 1 ? '' : 's'}, ${status.queuedEvents} event${status.queuedEvents === 1 ? '' : 's'})` };
  return { tone: 'idle', label: 'Idle · nothing queued' };
}
