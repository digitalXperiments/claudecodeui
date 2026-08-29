import { useEffect, useState } from 'react';
import { Activity, Bot, Gauge, Loader2, Timer } from 'lucide-react';

import { authenticatedFetch } from '../../../utils/api';
import { useWebSocket } from '../../../contexts/WebSocketContext';

export type SwarmActivityAgent = {
  memberId: string;
  runId: string | null;
  stepId: string | null;
  label: string | null;
  kind: string | null;
  provider: string | null;
  model: string | null;
  startedAtMs: number | null;
  elapsedMs: number | null;
  tokens: number;
  costUsd: number;
};

export type SwarmActivity = {
  swarmId: string;
  projectId: string;
  status: string;
  runningCount: number;
  agents: SwarmActivityAgent[];
  waves: Array<{ wave: number; total: number; done: number; running: number; failed: number; queued: number }>;
  totals: { stepsTotal: number; stepsDone: number; stepsFailed: number };
  wallClockRemainingMs: number | null;
  spendUsd: number;
};

function formatElapsed(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes >= 60) {
    return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  }
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

const ACTIVE_STATUSES = new Set(['queued', 'planning', 'running', 'handing_off']);

/**
 * Live "what is happening right now" strip (PRD swarm-studio-v2 G7):
 * running-agent count + cards and a wave progress timeline, polled cheaply
 * from /api/swarm/:id/activity instead of refetching the whole swarm.
 */
export default function SwarmActivityStrip({
  swarmId,
  status,
  onAgentSelect,
  selectedMemberId,
}: {
  swarmId: string;
  status: string;
  /** Click an agent card to open its live output feed. */
  onAgentSelect?: (agent: SwarmActivityAgent) => void;
  selectedMemberId?: string | null;
}) {
  const [activity, setActivity] = useState<SwarmActivity | null>(null);
  const [, setTick] = useState(0);
  const { subscribe } = useWebSocket();
  const active = ACTIVE_STATUSES.has(status);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    const load = () => {
      authenticatedFetch(`/api/swarm/${encodeURIComponent(swarmId)}/activity`, {
        signal: controller.signal,
      })
        .then(async (res) => {
          if (!res.ok) throw new Error('failed');
          return (await res.json()) as { activity?: SwarmActivity };
        })
        .then((payload) => {
          if (!cancelled && payload.activity) setActivity(payload.activity);
        })
        .catch(() => {
          /* transient poll failure — keep last snapshot */
        });
    };
    load();
    if (!active) return () => {
      cancelled = true;
      controller.abort();
    };
    const id = window.setInterval(load, 2500);
    const unsubscribe = subscribe((event) => {
      if (event.kind === 'swarm_updated') load();
    });
    return () => {
      cancelled = true;
      controller.abort();
      window.clearInterval(id);
      unsubscribe?.();
    };
  }, [swarmId, active, subscribe]);

  // Re-render every second while agents run so elapsed timers tick.
  useEffect(() => {
    if (!activity || activity.runningCount === 0) return;
    const id = window.setInterval(() => setTick((t) => t + 1), 1000);
    return () => window.clearInterval(id);
  }, [activity?.runningCount]);

  if (!activity) return null;

  const doneRatio =
    activity.totals.stepsTotal > 0
      ? activity.totals.stepsDone / activity.totals.stepsTotal
      : 0;

  return (
    <div className="rounded-xl border border-border/50 bg-muted/20 p-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex items-center gap-1.5 text-[12px] font-semibold text-foreground">
          {activity.runningCount > 0 ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin text-sky-500" aria-hidden />
          ) : (
            <Activity className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
          )}
          {activity.runningCount > 0
            ? `${activity.runningCount} agent${activity.runningCount === 1 ? '' : 's'} running`
            : active
              ? 'Dispatching…'
              : 'Idle'}
        </div>
        <div className="text-[11px] text-muted-foreground">
          {activity.totals.stepsDone}/{activity.totals.stepsTotal} steps done
          {activity.totals.stepsFailed > 0 ? ` · ${activity.totals.stepsFailed} failed` : ''}
        </div>
        <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
          <Gauge className="h-3 w-3" aria-hidden />${activity.spendUsd.toFixed(4)}
        </div>
        {activity.wallClockRemainingMs != null ? (
          <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
            <Timer className="h-3 w-3" aria-hidden />
            {formatElapsed(activity.wallClockRemainingMs)} left
          </div>
        ) : null}
        <div className="ml-auto hidden h-1.5 w-40 overflow-hidden rounded-full bg-border/60 sm:block">
          <div
            className="h-full rounded-full bg-emerald-500 transition-all duration-500"
            style={{ width: `${Math.round(doneRatio * 100)}%` }}
          />
        </div>
      </div>

      {activity.agents.length > 0 ? (
        <div className="mt-2.5 grid gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
          {activity.agents.map((agent) => (
            <button
              key={agent.memberId}
              type="button"
              onClick={() => onAgentSelect?.(agent)}
              title="View live output"
              className={`flex items-center gap-2 rounded-lg border px-2 py-1.5 text-left transition-colors ${
                selectedMemberId === agent.memberId
                  ? 'border-sky-500/60 bg-sky-500/15'
                  : 'border-sky-500/25 bg-sky-500/5 hover:bg-sky-500/10'
              }`}
            >
              <Bot className="h-3.5 w-3.5 shrink-0 text-sky-500" aria-hidden />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[11px] font-medium text-foreground">
                  {agent.label || agent.kind || 'Agent'}
                  {agent.stepId ? (
                    <span className="ml-1 font-normal text-muted-foreground">· {agent.stepId}</span>
                  ) : null}
                </div>
                <div className="truncate text-[10px] text-muted-foreground">
                  {[agent.provider, agent.model].filter(Boolean).join('/') || 'auto'}
                  {agent.elapsedMs != null ? ` · ${formatElapsed(agent.elapsedMs)}` : ''}
                  {agent.tokens > 0 ? ` · ${agent.tokens.toLocaleString()} tok` : ''}
                </div>
              </div>
              <Loader2 className="h-3 w-3 shrink-0 animate-spin text-sky-400" aria-hidden />
            </button>
          ))}
        </div>
      ) : null}

      {activity.waves.length > 0 ? (
        <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
          {activity.waves.map((wave) => {
            const waveDone = wave.done / Math.max(wave.total, 1);
            return (
              <div
                key={wave.wave}
                title={`Wave ${wave.wave}: ${wave.done}/${wave.total} done${wave.failed ? `, ${wave.failed} failed` : ''}${wave.queued ? `, ${wave.queued} queued` : ''}`}
                className="flex h-6 items-center gap-1.5 overflow-hidden rounded-md border border-border/60 bg-background px-1.5"
              >
                <span className="text-[10px] text-muted-foreground">W{wave.wave}</span>
                <span className="relative h-1.5 w-10 overflow-hidden rounded-full bg-border/60">
                  <span
                    className={`absolute inset-y-0 left-0 rounded-full ${wave.failed > 0 ? 'bg-amber-500' : 'bg-emerald-500'}`}
                    style={{ width: `${Math.round(waveDone * 100)}%` }}
                  />
                </span>
                <span className="text-[10px] tabular-nums text-muted-foreground">
                  {wave.done}/{wave.total}
                </span>
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
