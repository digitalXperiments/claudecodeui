import { useEffect, useRef, useState } from 'react';
import { Loader2, Radio, X } from 'lucide-react';

import { runsApi } from '../../runs/api/runsApi';
import { describeEvent } from '../../runs/view/RunsView';
import type { RunEvent } from '../../runs/types';

/**
 * Live output feed for a single swarm member's child run: incrementally polls
 * normalized run events and renders them as a compact timeline (PRD
 * swarm-studio-v2 phase 3 — "what is this agent doing right now?").
 */
export default function SwarmAgentActivity({
  runId,
  label,
  running,
  onClose,
}: {
  runId: string;
  label: string;
  running: boolean;
  onClose: () => void;
}) {
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const lastSeqRef = useRef(0);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    lastSeqRef.current = 0;
    setEvents([]);
    setLoading(true);

    const load = async () => {
      try {
        const batch = await runsApi.events(runId, lastSeqRef.current || undefined);
        if (cancelled) return;
        if (batch.length > 0) {
          lastSeqRef.current = Math.max(...batch.map((event) => event.seq), lastSeqRef.current);
          setEvents((current) => {
            const seen = new Set(current.map((event) => event.event_id));
            return [...current, ...batch.filter((event) => !seen.has(event.event_id))].sort(
              (a, b) => a.seq - b.seq,
            );
          });
        }
      } catch {
        /* transient poll failure */
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void load();
    const id = window.setInterval(load, running ? 2000 : 8000);
    return () => {
      cancelled = true;
      controller.abort();
      window.clearInterval(id);
    };
  }, [runId, running]);

  // Keep the newest events in view while streaming.
  useEffect(() => {
    if (running) bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [events.length, running]);

  return (
    <div className="rounded-xl border border-border/50 bg-background/70">
      <div className="flex items-center gap-2 border-b border-border/40 px-3 py-2">
        {running ? (
          <Radio className="h-3.5 w-3.5 animate-pulse text-sky-500" aria-hidden />
        ) : (
          <Radio className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
        )}
        <span className="text-[12px] font-semibold text-foreground">{label}</span>
        <span className="text-[10px] text-muted-foreground">· live output</span>
        {loading && events.length === 0 ? (
          <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" aria-hidden />
        ) : null}
        <button
          type="button"
          onClick={onClose}
          className="ml-auto rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          aria-label="Close live output"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="max-h-72 space-y-1 overflow-y-auto px-3 py-2">
        {events.length === 0 && !loading ? (
          <p className="py-4 text-center text-[11px] text-muted-foreground">No events yet.</p>
        ) : null}
        {events.map((event) => {
          const described = describeEvent(event);
          const severityClass =
            event.severity === 'error'
              ? 'text-red-600 dark:text-red-400'
              : event.severity === 'warn'
                ? 'text-amber-600 dark:text-amber-400'
                : 'text-foreground/90';
          return (
            <div key={event.event_id} className="rounded-md px-1.5 py-1 hover:bg-muted/40">
              <div className={`flex items-baseline gap-2 text-[11px] ${severityClass}`}>
                <span className="shrink-0 tabular-nums text-muted-foreground">
                  {new Date(event.ts).toLocaleTimeString()}
                </span>
                <span className="font-medium">{described.label}</span>
              </div>
              {described.detail ? (
                <p className="ml-[calc(3.5rem)] truncate text-[10px] text-muted-foreground" title={described.detail}>
                  {described.detail}
                </p>
              ) : null}
              {described.kv.length > 0 ? (
                <div className="ml-[calc(3.5rem)] flex flex-wrap gap-x-3 text-[10px] text-muted-foreground">
                  {described.kv.map((pair) => (
                    <span key={pair.k}>
                      <span className="font-medium">{pair.k}:</span> {pair.v}
                    </span>
                  ))}
                </div>
              ) : null}
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
