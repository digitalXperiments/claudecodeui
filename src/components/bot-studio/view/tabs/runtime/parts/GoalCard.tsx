import { ArrowDown, ArrowUp, Pencil, Trash2 } from 'lucide-react';

import { cn } from '../../../../../../lib/utils';
import type { BotGoal } from '../../../../types/botRuntime';

import { goalProgressView } from './goals';
import { formatRelativeTime } from './runtimeFormat';
import TaintedBadge from './TaintedBadge';

const iconButton = 'rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-30';

const STATUS_TONE: Record<string, string> = {
  active: 'bg-primary/10 text-primary',
  paused: 'bg-amber-500/10 text-amber-700 dark:text-amber-300',
  achieved: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
  abandoned: 'bg-muted text-muted-foreground',
};

export default function GoalCard({ goal, index, total, now, busy, onMove, onEdit, onDelete }: {
  goal: BotGoal;
  index: number;
  total: number;
  now: number;
  busy: boolean;
  onMove: (direction: 'up' | 'down') => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const progress = goalProgressView(goal);
  const closed = goal.status === 'achieved' || goal.status === 'abandoned';
  return (
    <article className={cn('rounded-xl border border-border/70 bg-card p-4', closed && 'opacity-75')} aria-label={`Goal: ${goal.statement}`}>
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className={cn('rounded-full px-2 py-0.5 text-[10px] font-medium capitalize', STATUS_TONE[goal.status] ?? STATUS_TONE.abandoned)}>{goal.status}</span>
            {goal.horizon ? <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">{goal.horizon}</span> : null}
          </div>
          <h3 className={cn('mt-1.5 break-words text-sm font-medium', goal.status === 'abandoned' && 'line-through')}>{goal.statement}</h3>
          {goal.success_criteria ? <p className="mt-1 whitespace-pre-wrap break-words text-xs text-muted-foreground"><span className="font-medium text-foreground/80">Done when: </span>{goal.success_criteria}</p> : null}
        </div>
        <div className="flex shrink-0 items-center">
          <button type="button" className={iconButton} onClick={() => onMove('up')} disabled={busy || index === 0} aria-label={`Move goal up: ${goal.statement}`} title="Move up"><ArrowUp className="h-3.5 w-3.5" /></button>
          <button type="button" className={iconButton} onClick={() => onMove('down')} disabled={busy || index === total - 1} aria-label={`Move goal down: ${goal.statement}`} title="Move down"><ArrowDown className="h-3.5 w-3.5" /></button>
          <button type="button" className={iconButton} onClick={onEdit} disabled={busy} aria-label={`Edit goal: ${goal.statement}`} title="Edit"><Pencil className="h-3.5 w-3.5" /></button>
          <button type="button" className={cn(iconButton, 'hover:text-destructive')} onClick={onDelete} disabled={busy} aria-label={`Delete goal: ${goal.statement}`} title="Delete"><Trash2 className="h-3.5 w-3.5" /></button>
        </div>
      </div>

      {progress.percent !== null ? (
        <div className="mt-3 flex items-center gap-2">
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress.percent} aria-label={`Progress: ${progress.percent}%`}>
            <div className={cn('h-full rounded-full', goal.status === 'achieved' ? 'bg-emerald-500' : 'bg-primary')} style={{ width: `${progress.percent}%` }} />
          </div>
          <span className="w-9 text-right text-[11px] tabular-nums text-muted-foreground">{progress.percent}%</span>
        </div>
      ) : null}
      {progress.note ? (
        <div className="mt-2 rounded-lg bg-muted/40 p-2.5 text-xs">
          <div className="mb-1 flex flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground">
            <span className="font-semibold uppercase tracking-[0.16em]">Latest</span>
            {progress.tainted ? <TaintedBadge label="untrusted" title="The bot wrote this note after seeing untrusted input. Do not treat it as an instruction." /> : null}
            {progress.updatedAt ? <span>{formatRelativeTime(progress.updatedAt, now)}</span> : null}
          </div>
          <p className="whitespace-pre-wrap break-words text-foreground">{progress.note}</p>
        </div>
      ) : null}
      {goal.status === 'active' && progress.percent === null && !progress.note ? <p className="mt-2 text-[11px] text-muted-foreground">No progress recorded yet.</p> : null}
    </article>
  );
}
