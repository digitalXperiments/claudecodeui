import { CheckCircle2, Link2, Loader2, Plus, UserRound, XCircle } from 'lucide-react';
import { useState } from 'react';

import { cn } from '../../../../../../lib/utils';
import { Button } from '../../../../../../shared/view/ui';
import type { BotCommitment, BotCommitmentInput, BotGoal } from '../../../../types/botRuntime';
import SegmentedControl from '../../../../ui/SegmentedControl';

import {
  buildCommitmentInput, COMMITMENT_FILTERS, commitmentIsActionable, countCommitments, filterCommitments, type CommitmentFilter,
} from './goals';
import { formatDue, localInputToIso, toLocalInputValue } from './runtimeFormat';
import TaintedBadge from './TaintedBadge';

const fieldClass = 'w-full rounded-lg border border-border bg-background px-3 py-2 text-xs outline-none focus:border-primary focus:ring-2 focus:ring-primary/10';
const labelClass = 'mb-1 block text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground';

const STATUS_TONE: Record<string, string> = {
  open: 'bg-primary/10 text-primary',
  fired: 'bg-amber-500/10 text-amber-700 dark:text-amber-300',
  done: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
  cancelled: 'bg-muted text-muted-foreground',
};

function CommitmentForm({ onCreate, onCancel }: { onCreate: (input: BotCommitmentInput) => Promise<void>; onCancel: () => void }) {
  const [description, setDescription] = useState('');
  // Default to tomorrow at the same time so the picker opens on a sensible future value.
  const [dueLocal, setDueLocal] = useState(() => toLocalInputValue(Date.now() + 24 * 60 * 60 * 1000));
  const [waitingOn, setWaitingOn] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const built = buildCommitmentInput({ description, dueLocal, waitingOn }, localInputToIso);
    if (!built.ok) { setError(built.error); return; }
    setBusy(true);
    setError(null);
    try {
      await onCreate(built.input);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to add the commitment.');
      setBusy(false);
    }
  };

  return (
    <form className="space-y-3 rounded-xl border border-primary/30 bg-card p-4" aria-label="New commitment" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <div>
        <label className={labelClass} htmlFor="commitment-description">Commitment</label>
        <input id="commitment-description" value={description} onChange={(event) => setDescription(event.target.value)} maxLength={500} placeholder="e.g. Follow up with Sam about the contract" className={fieldClass} autoFocus />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className={labelClass} htmlFor="commitment-due">Due</label>
          <input id="commitment-due" type="datetime-local" value={dueLocal} onChange={(event) => setDueLocal(event.target.value)} className={fieldClass} />
        </div>
        <div>
          <label className={labelClass} htmlFor="commitment-waiting">Waiting on (optional)</label>
          <input id="commitment-waiting" value={waitingOn} onChange={(event) => setWaitingOn(event.target.value)} maxLength={200} placeholder="Person, team, or system" className={fieldClass} />
        </div>
      </div>
      {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
      <div className="flex justify-end gap-2">
        <Button type="button" size="sm" variant="ghost" onClick={onCancel} disabled={busy}>Cancel</Button>
        <Button type="submit" size="sm" disabled={busy}>{busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}Add commitment</Button>
      </div>
    </form>
  );
}

export default function CommitmentsPanel({ commitments, goals, now, loading, error, onCreate, onComplete, onCancel }: {
  commitments: BotCommitment[];
  goals: BotGoal[];
  now: number;
  loading: boolean;
  error: string | null;
  onCreate: (input: BotCommitmentInput) => Promise<void>;
  onComplete: (commitment: BotCommitment) => Promise<void>;
  onCancel: (commitment: BotCommitment) => Promise<void>;
}) {
  const [filter, setFilter] = useState<CommitmentFilter>('open');
  const [creating, setCreating] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const counts = countCommitments(commitments);
  const visible = filterCommitments(commitments, filter);
  const goalName = (goalId: string | null) => (goalId ? goals.find((goal) => goal.goal_id === goalId)?.statement ?? null : null);

  const act = async (commitment: BotCommitment, action: (c: BotCommitment) => Promise<void>) => {
    setBusyId(commitment.commitment_id);
    setActionError(null);
    try {
      await action(commitment);
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : 'Action failed.');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <section className="space-y-3" aria-label="Commitments">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">Commitments</h2>
        <SegmentedControl
          value={filter}
          onChange={setFilter}
          label="Filter commitments by status"
          options={COMMITMENT_FILTERS.map((entry) => ({ value: entry.value, label: entry.label, count: counts[entry.value] }))}
        />
        <Button size="sm" variant="outline" className="ml-auto" onClick={() => setCreating((open) => !open)} aria-expanded={creating}><Plus className="h-3.5 w-3.5" />Add commitment</Button>
      </div>
      {creating ? <CommitmentForm onCancel={() => setCreating(false)} onCreate={async (input) => { await onCreate(input); setCreating(false); }} /> : null}
      {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
      {actionError ? <p role="alert" className="text-xs text-destructive">{actionError}</p> : null}
      {loading && commitments.length === 0 ? <p className="text-xs text-muted-foreground" aria-busy="true">Loading commitments…</p> : null}
      {!loading && visible.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border p-4 text-center text-xs text-muted-foreground">
          {commitments.length === 0 ? 'No commitments. The bot records follow-ups here when it promises something or waits on someone.' : `No ${filter === 'all' ? '' : `${filter} `}commitments.`}
        </p>
      ) : null}
      <ul className="space-y-2">
        {visible.map((commitment) => {
          const due = formatDue(commitment.due_at, now);
          const actionable = commitmentIsActionable(commitment);
          const linkedGoal = goalName(commitment.goal_id);
          const busy = busyId === commitment.commitment_id;
          return (
            <li key={commitment.commitment_id} className="rounded-xl border border-border/70 bg-card p-3">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className={cn('rounded-full px-2 py-0.5 text-[10px] font-medium capitalize', STATUS_TONE[commitment.status] ?? STATUS_TONE.cancelled)}>{commitment.status}</span>
                {actionable ? <span className={cn('rounded-full px-2 py-0.5 text-[10px]', due.overdue ? 'bg-destructive/10 text-destructive' : due.soon ? 'bg-amber-500/10 text-amber-700 dark:text-amber-300' : 'bg-muted text-muted-foreground')} title={new Date(commitment.due_at).toLocaleString()}>{due.label}</span> : <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground" title={new Date(commitment.due_at).toLocaleString()}>was due {new Date(commitment.due_at).toLocaleDateString()}</span>}
                {commitment.tainted ? <TaintedBadge label="untrusted" title="The bot made this commitment after seeing untrusted input." /> : null}
                {commitment.waiting_on ? <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground"><UserRound className="h-3 w-3" aria-hidden="true" />Waiting on {commitment.waiting_on}</span> : null}
                {commitment.item_id ? <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 font-mono text-[10px] text-muted-foreground" title={`Linked item ${commitment.item_id}`}><Link2 className="h-3 w-3" aria-hidden="true" />{commitment.item_id.slice(0, 8)}</span> : null}
              </div>
              <p className="mt-1.5 break-words text-xs text-foreground">{commitment.description}</p>
              {linkedGoal ? <p className="mt-1 truncate text-[10px] text-muted-foreground" title={linkedGoal}>Goal: {linkedGoal}</p> : null}
              {actionable ? (
                <div className="mt-2 flex gap-2">
                  <Button size="sm" variant="outline" className="h-8" disabled={busy} onClick={() => void act(commitment, onComplete)} aria-label={`Mark done: ${commitment.description}`}><CheckCircle2 className="h-3.5 w-3.5" />Complete</Button>
                  <Button size="sm" variant="ghost" className="h-8" disabled={busy} onClick={() => void act(commitment, onCancel)} aria-label={`Cancel commitment: ${commitment.description}`}><XCircle className="h-3.5 w-3.5" />Cancel</Button>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
