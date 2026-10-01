import { useMemo, useState } from 'react';
import { Loader2 } from 'lucide-react';

import { botRuntimeApi } from '../../../../api/botRuntimeApi';
import type { BotTrigger } from '../../../../types/botRuntime';
import { ErrorLine } from '../panel/Panel';
import { errorText } from '../panel/useAsyncAction';

import TriggerFields from './TriggerFields';
import {
  draftFromTrigger, emptyDraft, mergeConfig, validateDraft,
  type EditableKind, type TriggerDraft,
} from './triggerForm';

/** Create (trigger = null) or edit a trigger. The kind is fixed once created. */
export default function TriggerEditor({ botId, trigger, onSaved, onCancel }: {
  botId: string;
  trigger: BotTrigger | null;
  onSaved: (trigger: BotTrigger) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<TriggerDraft>(() => (trigger ? draftFromTrigger(trigger) : emptyDraft('cron')));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const change = (patch: Partial<TriggerDraft>) => setDraft((current) => ({ ...current, ...patch }));
  const problem = useMemo(() => validateDraft(draft), [draft]);

  const save = async () => {
    if (problem) {
      setError(problem);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const config = mergeConfig(trigger?.config ?? null, draft);
      const saved = trigger
        ? await botRuntimeApi.triggers.update(botId, trigger.trigger_id, { config, enabled: draft.enabled })
        : await botRuntimeApi.triggers.create(botId, { kind: draft.kind, config, enabled: draft.enabled });
      onSaved(saved);
    } catch (caught) {
      setError(errorText(caught, 'Could not save the trigger.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className="space-y-3 rounded-xl border border-primary/30 bg-card p-4" onSubmit={(event) => { event.preventDefault(); void save(); }} aria-label={trigger ? 'Edit trigger' : 'New trigger'}>
      <TriggerFields
        draft={draft}
        trigger={trigger}
        onChange={change}
        onKindChange={(kind: EditableKind) => setDraft({ ...emptyDraft(kind), enabled: draft.enabled })}
      />

      {error ? <ErrorLine message={error} /> : problem ? <p className="text-[11px] text-muted-foreground" aria-live="polite">{problem}</p> : null}
      <div className="flex justify-end gap-2">
        <button type="button" className="button" onClick={onCancel} disabled={saving}>Cancel</button>
        <button type="submit" className="button button-primary" disabled={saving || Boolean(problem)}>
          {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
          {trigger ? 'Save changes' : 'Create trigger'}
        </button>
      </div>
    </form>
  );
}
