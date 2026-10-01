import { Pencil, Plus, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';

import TriggerFields from '../view/tabs/runtime/triggers/TriggerFields';
import {
  KIND_LABELS, configFromDraft, summarizeTrigger, validateDraft, type TriggerDraft,
} from '../view/tabs/runtime/triggers/triggerForm';

import { Callout, FieldLabel } from './parts';
import { MAX_EXTRA_TRIGGERS } from './runtimeDraft';
import { COALESCING_EXPLANATION, WAKE_PRESETS, type WakePreset } from './wakePresets';

type Editing = { index: number | null; draft: TriggerDraft; presetLabel: string };

/**
 * The wake-up list the user builds: schedule-like and event-driven triggers beyond the section's own
 * schedule. Nothing is saved here; the drafts are created after the bot exists.
 */
export default function WakeUps({ triggers, onChange, scheduleActive = false }: { triggers: TriggerDraft[]; onChange: (next: TriggerDraft[]) => void; /** The section schedule above is on (not "only when I message it"). */ scheduleActive?: boolean }) {
  const [editing, setEditing] = useState<Editing | null>(null);
  const problem = useMemo(() => (editing ? validateDraft(editing.draft) : null), [editing]);
  const full = triggers.length >= MAX_EXTRA_TRIGGERS;

  const startNew = (preset: WakePreset) => setEditing({ index: null, draft: preset.make(), presetLabel: preset.label });
  const commit = () => {
    if (!editing || problem) return;
    onChange(editing.index === null ? [...triggers, editing.draft] : triggers.map((entry, i) => (i === editing.index ? editing.draft : entry)));
    setEditing(null);
  };

  return (
    <div className="space-y-3">
      <div>
        <FieldLabel detail={`up to ${MAX_EXTRA_TRIGGERS}`}>More ways to wake it up</FieldLabel>
        <p className="text-[11px] leading-relaxed text-muted-foreground">Add as many as you like. The schedule above and every wake-up below can each start the bot.</p>
      </div>

      {triggers.length === 0 && !editing ? <p className="rounded-lg border border-dashed border-border/70 px-3 py-3 text-center text-xs text-muted-foreground">No extra wake-ups yet. The bot wakes on its schedule above and whenever you message it.</p> : null}

      {triggers.length > 0 ? (
        <ul className="space-y-2" aria-label="Wake-ups you added">
          {triggers.map((draft, index) => (
            <li key={index} className="flex items-start gap-3 rounded-xl border border-border/60 bg-background p-3">
              <div className="min-w-0 flex-1">
                <p className="text-xs font-semibold text-foreground">{KIND_LABELS[draft.kind] ?? draft.kind}{draft.enabled ? '' : ' (off)'}</p>
                <p className="mt-0.5 break-words text-[11px] text-muted-foreground">{summarizeTrigger({ kind: draft.kind, config: configFromDraft(draft) })}</p>
              </div>
              <button type="button" className="icon-button" aria-label={`Edit wake-up ${index + 1}`} onClick={() => setEditing({ index, draft, presetLabel: KIND_LABELS[draft.kind] ?? draft.kind })}><Pencil className="h-4 w-4" /></button>
              <button type="button" className="icon-button" aria-label={`Remove wake-up ${index + 1}`} onClick={() => { onChange(triggers.filter((_, i) => i !== index)); setEditing(null); }}><Trash2 className="h-4 w-4" /></button>
            </li>
          ))}
        </ul>
      ) : null}

      {scheduleActive && triggers.some((draft) => draft.kind === 'nl_schedule' && draft.enabled) ? (
        <p role="note" className="rounded-lg border border-amber-500/30 bg-amber-500/[0.08] px-3 py-2 text-xs text-amber-800 dark:text-amber-200">A plain-English schedule runs in addition to the schedule above. Choose "Only when I message it" above if it should be the only one.</p>
      ) : null}

      {editing ? (
        <form className="space-y-3 rounded-xl border border-primary/30 bg-card p-4" aria-label={editing.index === null ? 'New wake-up' : 'Edit wake-up'} onSubmit={(event) => { event.preventDefault(); commit(); }}>
          <p className="text-xs font-semibold text-foreground">{editing.presetLabel}</p>
          <TriggerFields
            draft={editing.draft}
            hideKind
            onChange={(patch) => setEditing((current) => (current ? { ...current, draft: { ...current.draft, ...patch } } : current))}
            onKindChange={() => undefined}
          />
          {problem ? <p className="text-[11px] text-muted-foreground" aria-live="polite">{problem}</p> : null}
          <div className="flex justify-end gap-2">
            <button type="button" className="button" onClick={() => setEditing(null)}>Cancel</button>
            <button type="submit" className="button button-primary" disabled={Boolean(problem)}>{editing.index === null ? 'Add to list' : 'Update'}</button>
          </div>
        </form>
      ) : (
        <div role="group" aria-label="Add a wake-up" className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {WAKE_PRESETS.map((preset) => (
            <button key={preset.id} type="button" disabled={full} className="choice" onClick={() => startNew(preset)}>
              <Plus className="h-4 w-4" aria-hidden="true" />{preset.label}<span>{preset.description}</span>
            </button>
          ))}
        </div>
      )}

      <Callout title="How wake-ups are combined">{COALESCING_EXPLANATION} Everything a webhook or watcher delivers is treated as untrusted: the bot reads it, but it cannot authorize risky actions on its own.</Callout>
    </div>
  );
}
