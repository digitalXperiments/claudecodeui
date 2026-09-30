import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';

import { botRuntimeApi } from '../../../../api/botRuntimeApi';
import type { BotBudgetStatus } from '../../../../types/botRuntime';
import { ErrorLine, Field, Panel, SkeletonRows } from '../panel/Panel';
import { useAsyncAction } from '../panel/useAsyncAction';

import { budgetDraftFromBudget, budgetInputFromDraft, budgetMeters, budgetStateText, type BudgetDraft, type MeterTone } from './ruleHelpers';

const BAR_TONES: Record<MeterTone, string> = { none: 'bg-muted-foreground/30', ok: 'bg-emerald-500', soft: 'bg-amber-500', hard: 'bg-destructive' };
const STATE_TONES: Record<MeterTone, string> = { none: 'text-muted-foreground', ok: 'text-emerald-700 dark:text-emerald-300', soft: 'text-amber-700 dark:text-amber-300', hard: 'text-destructive' };

function BudgetMeters({ status }: { status: BotBudgetStatus }) {
  const state = budgetStateText(status);
  return (
    <div className="space-y-2.5">
      <p className={`text-xs font-medium ${STATE_TONES[state.tone]}`} role="status">{state.text}</p>
      {budgetMeters(status).map(({ id, label, meter, format }) => (
        <div key={id}>
          <div className="flex items-baseline justify-between gap-2 text-[11px]">
            <span className="text-muted-foreground">{label}</span>
            <span className="font-medium">{format(meter.used)}{meter.cap === null ? <span className="font-normal text-muted-foreground"> · no limit</span> : <span className="font-normal text-muted-foreground"> of {format(meter.cap)} · {meter.percent}%</span>}</span>
          </div>
          <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(100, meter.percent)}>
            <div className={`h-full rounded-full transition-all ${BAR_TONES[meter.tone]}`} style={{ width: `${Math.round(meter.ratio * 100)}%` }} />
          </div>
        </div>
      ))}
    </div>
  );
}

/** Status meters plus the editor for the per-bot budget. `status` comes from the live runtime section. */
export default function BudgetCard({ botId, status, loading, loadError, onSaved }: {
  botId: string;
  status: BotBudgetStatus | null;
  loading: boolean;
  loadError: string | null;
  onSaved: () => void;
}) {
  const action = useAsyncAction();
  const [draft, setDraft] = useState<BudgetDraft>(() => budgetDraftFromBudget(status?.budget ?? null));
  const [dirty, setDirty] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // Follow server changes until the operator starts editing.
  const budgetKey = JSON.stringify(status?.budget ?? null);
  useEffect(() => {
    if (!dirty) setDraft(budgetDraftFromBudget(status?.budget ?? null));
  }, [budgetKey, dirty, status?.budget]);

  const change = (patch: Partial<BudgetDraft>) => {
    setDirty(true);
    setSaved(false);
    setDraft((current) => ({ ...current, ...patch }));
  };

  const save = async () => {
    const input = budgetInputFromDraft(draft);
    if ('error' in input) {
      setFormError(input.error);
      return;
    }
    setFormError(null);
    const ok = await action.run('save', () => botRuntimeApi.budget.put(botId, input));
    if (ok) {
      setDirty(false);
      setSaved(true);
      onSaved();
    }
  };

  return (
    <Panel title="Budget" description="Limits on spend, actions and wake-ups. Past the soft limit the bot is downgraded to cheaper work; at the limit it stops until the window resets. Empty means no limit.">
      <div className="grid gap-4 lg:grid-cols-2">
        <div>
          {loading && !status ? <SkeletonRows count={3} /> : null}
          {status ? <BudgetMeters status={status} /> : null}
          <ErrorLine message={loadError} />
        </div>
        <form className="space-y-2" onSubmit={(event) => { event.preventDefault(); void save(); }} aria-label="Budget limits">
          <div className="grid gap-2 sm:grid-cols-2">
            <Field label="Daily spend (USD)"><input aria-label="Daily spend limit" type="number" min="0" step="any" className="field h-9" value={draft.dailyUsd} onChange={(event) => change({ dailyUsd: event.target.value })} /></Field>
            <Field label="Monthly spend (USD)"><input aria-label="Monthly spend limit" type="number" min="0" step="any" className="field h-9" value={draft.monthlyUsd} onChange={(event) => change({ monthlyUsd: event.target.value })} /></Field>
            <Field label="Actions per day"><input aria-label="Daily action limit" type="number" min="0" step="1" className="field h-9" value={draft.dailyActions} onChange={(event) => change({ dailyActions: event.target.value })} /></Field>
            <Field label="Wakes per hour"><input aria-label="Wakes per hour limit" type="number" min="0" step="1" className="field h-9" value={draft.maxWakes} onChange={(event) => change({ maxWakes: event.target.value })} /></Field>
          </div>
          <Field label="Soft limit at (% of each cap)" className="max-w-48"><input aria-label="Soft limit percent" type="number" min="1" max="100" step="1" className="field h-9" value={draft.softPercent} onChange={(event) => change({ softPercent: event.target.value })} /></Field>
          <ErrorLine message={formError ?? action.error} />
          <div className="flex items-center justify-end gap-2">
            {saved ? <span className="text-[11px] text-emerald-700 dark:text-emerald-300" role="status">Saved</span> : null}
            <button type="submit" className="button button-primary" disabled={action.busy || !dirty}>{action.busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}Save limits</button>
          </div>
        </form>
      </div>
    </Panel>
  );
}
