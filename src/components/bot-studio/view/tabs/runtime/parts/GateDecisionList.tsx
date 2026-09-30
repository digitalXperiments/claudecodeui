import { cn } from '../../../../../../lib/utils';
import type { BotGateDecision } from '../../../../types/botRuntime';

import { summarizeArgs } from './episodes';
import { formatRelativeTime } from './runtimeFormat';

const DECISION_TONE: Record<string, string> = {
  allow: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
  ask: 'bg-amber-500/10 text-amber-700 dark:text-amber-300',
  deny: 'bg-destructive/10 text-destructive',
};

export default function GateDecisionList({ decisions, now }: { decisions: BotGateDecision[]; now: number }) {
  if (decisions.length === 0) return <p className="text-xs text-muted-foreground">No gated tool calls in this episode.</p>;
  return (
    <ul className="space-y-1.5">
      {decisions.map((decision) => {
        const args = summarizeArgs(decision.args);
        return (
          <li key={decision.decision_id} className="rounded-lg border border-border/70 bg-background p-2.5 text-xs">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="font-mono text-[11px] font-medium">{decision.server ? `${decision.server}.` : ''}{decision.tool}</span>
              <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] capitalize text-muted-foreground">risk · {decision.risk}</span>
              <span className={cn('rounded-full px-2 py-0.5 text-[10px] font-medium capitalize', DECISION_TONE[decision.decision] ?? 'bg-muted text-muted-foreground')}>{decision.decision}</span>
              <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">by {decision.decided_by}</span>
              <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] capitalize text-muted-foreground">{decision.outcome ?? 'pending'}</span>
              <span className="ml-auto text-[10px] text-muted-foreground">{formatRelativeTime(decision.created_at, now)}</span>
            </div>
            {args ? <p className="mt-1.5 break-words font-mono text-[11px] text-muted-foreground">{args}</p> : null}
            {decision.reason ? <p className="mt-1 text-[11px] text-muted-foreground">{decision.reason}</p> : null}
          </li>
        );
      })}
    </ul>
  );
}
