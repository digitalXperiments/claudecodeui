import { Loader2 } from 'lucide-react';
import { useState } from 'react';

import { Button } from '../../../../../../shared/view/ui';
import type { BotGoal, BotGoalStatus } from '../../../../types/botRuntime';

import { buildGoalPatch, goalToDraft, GOAL_STATUSES, type GoalDraft } from './goals';

const fieldClass = 'w-full rounded-lg border border-border bg-background px-3 py-2 text-xs outline-none focus:border-primary focus:ring-2 focus:ring-primary/10';
const labelClass = 'mb-1 block text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground';

type Patch = Extract<ReturnType<typeof buildGoalPatch>, { ok: true }>['patch'];

/** Create (no `goal`) or edit a goal. Editing also exposes progress percent and the latest note. */
export default function GoalForm({ goal, onSubmit, onCancel }: { goal?: BotGoal; onSubmit: (patch: Patch) => Promise<void>; onCancel: () => void }) {
  const [draft, setDraft] = useState<GoalDraft>(() => goalToDraft(goal));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const idBase = `goal-${goal?.goal_id ?? 'new'}`;
  const set = <K extends keyof GoalDraft>(key: K, value: GoalDraft[K]) => setDraft((current) => ({ ...current, [key]: value }));

  const submit = async () => {
    const built = buildGoalPatch(draft, goal);
    if (!built.ok) { setError(built.error); return; }
    if (goal && Object.keys(built.patch).length === 0) { onCancel(); return; }
    setBusy(true);
    setError(null);
    try {
      await onSubmit(built.patch);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to save the goal.');
      setBusy(false);
    }
  };

  return (
    <form className="space-y-3 rounded-xl border border-primary/30 bg-card p-4" onSubmit={(event) => { event.preventDefault(); void submit(); }} aria-label={goal ? 'Edit goal' : 'New goal'}>
      <div>
        <label className={labelClass} htmlFor={`${idBase}-statement`}>Goal</label>
        <input id={`${idBase}-statement`} value={draft.statement} onChange={(event) => set('statement', event.target.value)} maxLength={500} placeholder="What should this bot be working toward?" className={fieldClass} autoFocus />
      </div>
      <div>
        <label className={labelClass} htmlFor={`${idBase}-criteria`}>Success criteria</label>
        <textarea id={`${idBase}-criteria`} value={draft.successCriteria} onChange={(event) => set('successCriteria', event.target.value)} rows={2} maxLength={2000} placeholder="How will you both know it is done?" className={`${fieldClass} resize-y`} />
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <div>
          <label className={labelClass} htmlFor={`${idBase}-horizon`}>Horizon</label>
          <input id={`${idBase}-horizon`} value={draft.horizon} onChange={(event) => set('horizon', event.target.value)} maxLength={100} placeholder="e.g. this quarter" className={fieldClass} />
        </div>
        {goal ? (
          <>
            <div>
              <label className={labelClass} htmlFor={`${idBase}-status`}>Status</label>
              <select id={`${idBase}-status`} value={draft.status} onChange={(event) => set('status', event.target.value as BotGoalStatus)} className={fieldClass}>
                {GOAL_STATUSES.map((entry) => <option key={entry.value} value={entry.value}>{entry.label}</option>)}
              </select>
            </div>
            <div>
              <label className={labelClass} htmlFor={`${idBase}-percent`}>Progress %</label>
              <input id={`${idBase}-percent`} type="number" min={0} max={100} value={draft.percent} onChange={(event) => set('percent', event.target.value)} className={fieldClass} />
            </div>
          </>
        ) : null}
      </div>
      {goal ? (
        <div>
          <label className={labelClass} htmlFor={`${idBase}-note`}>Latest progress note</label>
          <textarea id={`${idBase}-note`} value={draft.note} onChange={(event) => set('note', event.target.value)} rows={2} maxLength={1000} placeholder="Notes you write here are marked as trusted." className={`${fieldClass} resize-y`} />
        </div>
      ) : null}
      {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
      <div className="flex justify-end gap-2">
        <Button type="button" size="sm" variant="ghost" onClick={onCancel} disabled={busy}>Cancel</Button>
        <Button type="submit" size="sm" disabled={busy}>{busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}{goal ? 'Save goal' : 'Add goal'}</Button>
      </div>
    </form>
  );
}
