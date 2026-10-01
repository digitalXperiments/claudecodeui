import { AlertTriangle, Check, CircleDashed, Loader2, RotateCw } from 'lucide-react';

import type { BotTrigger } from '../types/botRuntime';
import WebhookInfo from '../view/tabs/runtime/triggers/WebhookInfo';

import {
  setupMessage, summarizeSetup, type SetupState, type SetupStatus, type SetupTask,
} from './setupPlan';

const STATUS_COPY: Record<SetupStatus, string> = {
  pending: 'Waiting',
  running: 'Working…',
  done: 'Done',
  failed: 'Did not finish',
  blocked: 'Left paused',
};

function StatusIcon({ status }: { status: SetupStatus }) {
  if (status === 'done') return <Check className="h-4 w-4 text-emerald-600" aria-hidden="true" />;
  if (status === 'running') return <Loader2 className="h-4 w-4 animate-spin text-primary" aria-hidden="true" />;
  if (status === 'failed' || status === 'blocked') return <AlertTriangle className="h-4 w-4 text-amber-600" aria-hidden="true" />;
  return <CircleDashed className="h-4 w-4 text-muted-foreground" aria-hidden="true" />;
}

/** Per-step setup progress after the bot is created, with a clear partial-failure state and a retry. */
export default function SetupProgress({ tasks, state, botEnabled, busy, onRetry }: {
  tasks: SetupTask[];
  state: SetupState;
  botEnabled: boolean;
  busy: boolean;
  onRetry: () => void;
}) {
  if (tasks.length === 0) return null;
  const summary = summarizeSetup(tasks, state);
  const unfinished = summary.failed + summary.blocked > 0;
  return (
    <div className="mt-4 space-y-3" aria-label="Setup progress">
      <p role="status" aria-live="polite" className={`text-xs ${unfinished && !busy ? 'font-medium text-amber-800 dark:text-amber-200' : 'text-foreground'}`}>{setupMessage(tasks, state, botEnabled)}</p>
      <ul className="divide-y divide-border/50 rounded-xl border border-border/60 bg-background">
        {tasks.map((task) => {
          const current = state[task.id]?.status ?? 'pending';
          const trigger = task.call.type === 'trigger' && task.call.input.kind === 'webhook' && current === 'done' ? (state[task.id]?.result as BotTrigger | undefined) : undefined;
          return (
            <li key={task.id} className="px-3 py-2.5">
              <div className="flex items-start gap-2.5">
                <StatusIcon status={current} />
                <div className="min-w-0 flex-1">
                  <p className="break-words text-xs font-medium text-foreground">{task.label}</p>
                  <p className={`text-[11px] ${current === 'failed' || current === 'blocked' ? 'text-amber-800 dark:text-amber-200' : 'text-muted-foreground'}`}>{STATUS_COPY[current]}{state[task.id]?.error ? `: ${state[task.id]?.error}` : ''}</p>
                </div>
              </div>
              {trigger?.trigger_id ? <div className="mt-2 pl-6"><WebhookInfo triggerId={trigger.trigger_id} /></div> : null}
            </li>
          );
        })}
      </ul>
      {unfinished ? (
        <button type="button" className="button" disabled={busy} onClick={onRetry}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <RotateCw className="h-4 w-4" aria-hidden="true" />}
          Retry remaining ({summary.failed + summary.blocked})
        </button>
      ) : null}
    </div>
  );
}
