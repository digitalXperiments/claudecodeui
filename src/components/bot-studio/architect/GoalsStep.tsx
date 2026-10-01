import { Lightbulb, Plus, Trash2 } from 'lucide-react';

import { Callout, FieldLabel } from './parts';
import {
  GOAL_LIMITS, MAX_GOALS, newGoalId, suggestGoal, type GoalDraftItem, type RuntimeDraft,
} from './runtimeDraft';

/** Optional goals with success criteria, plus one suggestion derived from the purpose text. */
export default function GoalsStep({ title, purpose, runtime, onChange }: {
  title: string;
  purpose: string;
  runtime: RuntimeDraft;
  onChange: (patch: Partial<RuntimeDraft>) => void;
}) {
  const { goals } = runtime;
  const suggestion = suggestGoal(title, purpose);
  const alreadyUsed = suggestion ? goals.some((goal) => goal.statement.trim() === suggestion.statement) : false;
  const showSuggestion = Boolean(suggestion) && !alreadyUsed && !runtime.goalSuggestionDismissed && goals.length < MAX_GOALS;
  const update = (id: string, patch: Partial<GoalDraftItem>) => onChange({ goals: goals.map((goal) => (goal.id === id ? { ...goal, ...patch } : goal)) });

  return (
    <div className="space-y-5">
      {showSuggestion && suggestion ? (
        <div className="rounded-xl border border-primary/25 bg-primary/[0.05] p-4">
          <p className="flex items-center gap-2 text-xs font-semibold text-foreground"><Lightbulb className="h-4 w-4 text-primary" aria-hidden="true" />A starting point from your purpose</p>
          <p className="mt-2 text-sm text-foreground">{suggestion.statement}</p>
          <p className="mt-1 text-xs text-muted-foreground">Success looks like: {suggestion.successCriteria}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" className="button button-primary min-h-8" onClick={() => onChange({ goals: [...goals, { id: newGoalId(goals), statement: suggestion.statement, successCriteria: suggestion.successCriteria, horizon: '' }] })}>Use this goal</button>
            <button type="button" className="button min-h-8" onClick={() => onChange({ goalSuggestionDismissed: true })}>No thanks</button>
          </div>
          <p className="mt-2 text-[10px] text-muted-foreground">Written from the first sentence of your purpose with simple rules; no model was asked. Edit it freely after adding.</p>
        </div>
      ) : null}

      {goals.length === 0 ? <p className="rounded-lg border border-dashed border-border/70 px-3 py-4 text-center text-xs text-muted-foreground">No goals yet. That is fine: the bot still follows its brief. Goals just tell it what good looks like over time.</p> : null}

      <ol className="space-y-3">
        {goals.map((goal, index) => (
          <li key={goal.id} className="space-y-3 rounded-xl border border-border/60 bg-background p-4">
            <div className="flex items-center justify-between gap-2">
              <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">Goal {index + 1}</p>
              <button type="button" className="icon-button" aria-label={`Remove goal ${index + 1}`} onClick={() => onChange({ goals: goals.filter((entry) => entry.id !== goal.id) })}><Trash2 className="h-4 w-4" /></button>
            </div>
            <div>
              <FieldLabel>What should the bot work toward?</FieldLabel>
              <input className="field" aria-label={`Goal ${index + 1} statement`} value={goal.statement} maxLength={GOAL_LIMITS.statement} placeholder="Keep the support inbox triaged within an hour" onChange={(event) => update(goal.id, { statement: event.target.value })} />
            </div>
            <div>
              <FieldLabel detail="how you will both know it is done">Success criteria</FieldLabel>
              <textarea className="field min-h-20 resize-y" aria-label={`Goal ${index + 1} success criteria`} value={goal.successCriteria} maxLength={GOAL_LIMITS.criteria} placeholder="No urgent ticket waits longer than an hour; I rarely correct a label." onChange={(event) => update(goal.id, { successCriteria: event.target.value })} />
            </div>
            <div className="max-w-xs">
              <FieldLabel detail="optional">Horizon</FieldLabel>
              <input className="field" aria-label={`Goal ${index + 1} horizon`} value={goal.horizon} maxLength={GOAL_LIMITS.horizon} placeholder="e.g. this quarter" onChange={(event) => update(goal.id, { horizon: event.target.value })} />
            </div>
          </li>
        ))}
      </ol>

      <button type="button" className="button" disabled={goals.length >= MAX_GOALS} onClick={() => onChange({ goals: [...goals, { id: newGoalId(goals), statement: '', successCriteria: '', horizon: '' }] })}><Plus className="h-4 w-4" aria-hidden="true" />Add a goal</button>
      <Callout title="What goals do">The bot sees its goals at every wake-up and reports progress against them. You can add, reorder or retire goals any time on the bot's Goals tab. Empty goals are skipped.</Callout>
    </div>
  );
}
