import { Loader2, Plus, Target } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';

import { Button } from '../../../../../shared/view/ui';
import type { McSection } from '../../../../mission-control/api/missionControlApi';
import { botRuntimeApi } from '../../../api/botRuntimeApi';
import { removeGoal, upsertCommitment, upsertGoal } from '../../../hooks/botRuntimeReducers';
import { useBotRuntime } from '../../../hooks/useBotRuntime';
import type { BotCommitmentInput } from '../../../types/botRuntime';
import InlineToast from '../../../ui/InlineToast';
import Skeleton from '../../../ui/Skeleton';

import CommitmentsPanel from './parts/CommitmentsPanel';
import GoalCard from './parts/GoalCard';
import GoalForm from './parts/GoalForm';
import { moveGoal, nextSortOrder } from './parts/goals';
import { useNow } from './parts/useNow';

const GOAL_SECTIONS = ['goals' as const, 'commitments' as const];

export function GoalsTab({ botId }: { botId: string; section: McSection }) {
  const runtime = useBotRuntime(botId, { sections: GOAL_SECTIONS });
  const { patchSection, refresh } = runtime;
  const now = useNow(true, 30_000);
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ message: string; tone: 'success' | 'error' } | null>(null);

  const goals = runtime.goals;
  const goalsState = runtime.sectionState.goals.state;
  const fail = useCallback((caught: unknown, fallback: string) => setToast({ message: caught instanceof Error ? caught.message : fallback, tone: 'error' }), []);

  const move = useCallback(async (goalId: string, direction: 'up' | 'down') => {
    const patches = moveGoal(goals, goalId, direction);
    if (patches.length === 0) return;
    setBusy(true);
    // Optimistic reorder; a failure refetches the authoritative order.
    patchSection('goals', (current) => {
      let next = current;
      for (const patch of patches) {
        const goal = next.find((entry) => entry.goal_id === patch.goalId);
        if (goal) next = upsertGoal(next, { ...goal, sort_order: patch.sort_order });
      }
      return next;
    });
    try {
      const saved = await Promise.all(patches.map((patch) => botRuntimeApi.goals.update(botId, patch.goalId, { sort_order: patch.sort_order })));
      patchSection('goals', (current) => saved.reduce((next, goal) => upsertGoal(next, goal), current));
    } catch (caught) {
      fail(caught, 'Unable to reorder goals.');
      void refresh('goals');
    } finally {
      setBusy(false);
    }
  }, [botId, fail, goals, patchSection, refresh]);

  const createGoal = async (patch: { statement?: string; success_criteria?: string; horizon?: string | null }) => {
    const created = await botRuntimeApi.goals.create(botId, {
      statement: patch.statement ?? '',
      ...(patch.success_criteria ? { success_criteria: patch.success_criteria } : {}),
      ...(patch.horizon ? { horizon: patch.horizon } : {}),
      sort_order: nextSortOrder(goals),
    });
    patchSection('goals', (current) => upsertGoal(current, created));
    setCreating(false);
  };

  const deleteGoal = async (goalId: string, statement: string) => {
    if (!window.confirm(`Delete goal “${statement}”?`)) return;
    setBusy(true);
    try {
      await botRuntimeApi.goals.remove(botId, goalId);
      patchSection('goals', (current) => removeGoal(current, goalId));
    } catch (caught) {
      fail(caught, 'Unable to delete the goal.');
    } finally {
      setBusy(false);
    }
  };

  const commitmentActions = useMemo(() => ({
    create: async (input: BotCommitmentInput) => {
      const created = await botRuntimeApi.commitments.create(botId, input);
      patchSection('commitments', (current) => upsertCommitment(current, created));
    },
    complete: async (commitment: { commitment_id: string }) => {
      const updated = await botRuntimeApi.commitments.complete(botId, commitment.commitment_id);
      patchSection('commitments', (current) => upsertCommitment(current, updated));
    },
    cancel: async (commitment: { commitment_id: string }) => {
      const updated = await botRuntimeApi.commitments.cancel(botId, commitment.commitment_id);
      patchSection('commitments', (current) => upsertCommitment(current, updated));
    },
  }), [botId, patchSection]);

  return (
    <div className="space-y-8 p-4 sm:p-6">
      <InlineToast message={toast?.message ?? null} tone={toast?.tone} onDismiss={() => setToast(null)} />

      <section className="space-y-3" aria-label="Goals">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">Goals</h2>
          <span className="text-[11px] text-muted-foreground">The bot plans against these. Order sets priority (top first).</span>
          <Button size="sm" variant="outline" className="ml-auto" onClick={() => { setCreating((open) => !open); setEditingId(null); }} aria-expanded={creating}><Plus className="h-3.5 w-3.5" />Add goal</Button>
        </div>
        {creating ? <GoalForm onCancel={() => setCreating(false)} onSubmit={createGoal} /> : null}
        {goalsState === 'error' ? <p role="alert" className="text-xs text-destructive">{runtime.error('goals') ?? 'Unable to load goals.'}</p> : null}
        {(goalsState === 'loading' || goalsState === 'idle') && goals.length === 0 ? <div className="space-y-2" aria-busy="true"><Skeleton className="h-24 w-full" /><Skeleton className="h-24 w-full" /></div> : null}
        {goalsState === 'ready' && goals.length === 0 && !creating ? (
          <div className="rounded-xl border border-dashed border-border p-6 text-center">
            <Target className="mx-auto h-5 w-5 text-muted-foreground" aria-hidden="true" />
            <p className="mt-2 text-sm font-medium">No goals yet</p>
            <p className="mt-1 text-xs text-muted-foreground">Give the bot something to work toward. It will plan against active goals and report progress here.</p>
          </div>
        ) : null}
        <div className="space-y-2">
          {goals.map((goal, index) => (editingId === goal.goal_id ? (
            <GoalForm
              key={goal.goal_id}
              goal={goal}
              onCancel={() => setEditingId(null)}
              onSubmit={async (patch) => {
                const updated = await botRuntimeApi.goals.update(botId, goal.goal_id, patch);
                patchSection('goals', (current) => upsertGoal(current, updated));
                setEditingId(null);
              }}
            />
          ) : (
            <GoalCard
              key={goal.goal_id}
              goal={goal}
              index={index}
              total={goals.length}
              now={now}
              busy={busy}
              onMove={(direction) => void move(goal.goal_id, direction)}
              onEdit={() => { setEditingId(goal.goal_id); setCreating(false); }}
              onDelete={() => void deleteGoal(goal.goal_id, goal.statement)}
            />
          )))}
        </div>
        {busy ? <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground" role="status"><Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />Saving…</p> : null}
      </section>

      <CommitmentsPanel
        commitments={runtime.commitments}
        goals={goals}
        now={now}
        loading={runtime.isLoading('commitments') || runtime.sectionState.commitments.state === 'idle'}
        error={runtime.sectionState.commitments.state === 'error' ? runtime.error('commitments') : null}
        onCreate={commitmentActions.create}
        onComplete={commitmentActions.complete}
        onCancel={commitmentActions.cancel}
      />
    </div>
  );
}

export default GoalsTab;
