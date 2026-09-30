import { useState } from 'react';
import { Loader2, Pencil, Plus, Trash2 } from 'lucide-react';

import { botRuntimeApi } from '../../../../api/botRuntimeApi';
import { Chip, EmptyLine, ErrorLine, Panel, SkeletonRows } from '../panel/Panel';
import { relativeTime } from '../panel/time';
import { useAsyncAction } from '../panel/useAsyncAction';
import { useRemote } from '../panel/useRemote';

import { MAX_PROFILE_VALUE, sortProfile, validateProfileEntry } from './learningHelpers';

/** Global key/value preferences every bot reads (for example "Jira comments: bullet points"). */
export default function ProfilePanel({ now }: { now: number }) {
  const { data, error, loading, setData } = useRemote(() => botRuntimeApi.profile.list(), 'profile');
  const action = useAsyncAction();
  const [key, setKey] = useState('');
  const [value, setValue] = useState('');
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const entries = sortProfile(data ?? []);

  const reset = () => { setKey(''); setValue(''); setEditingKey(null); setFormError(null); };

  const save = async () => {
    const problem = validateProfileEntry(key, value);
    if (problem) return setFormError(problem);
    setFormError(null);
    const ok = await action.run('save', async () => {
      const entry = await botRuntimeApi.profile.set(key.trim(), value.trim());
      setData((current) => sortProfile([...(current ?? []).filter((item) => item.key !== entry.key), entry]));
    });
    if (ok) reset();
  };

  const remove = (entryKey: string) => {
    if (!window.confirm(`Remove "${entryKey}"? Every bot stops seeing it.`)) return;
    void action.run(entryKey, async () => {
      await botRuntimeApi.profile.remove(entryKey);
      setData((current) => (current ?? []).filter((item) => item.key !== entryKey));
      if (editingKey === entryKey) reset();
    });
  };

  return (
    <Panel
      title="Operator preferences"
      description="Facts and preferences about you that every bot reads. They are shared across all bots, not just this one, so edit with that in mind."
      actions={<Chip className="bg-sky-500/10 text-sky-700 dark:text-sky-300">Shared by all bots</Chip>}
    >
      <div className="space-y-3">
        {loading && !data ? <SkeletonRows count={2} /> : null}
        <ErrorLine message={error} />
        {data && entries.length === 0 ? <EmptyLine>No preferences yet. Approved memory proposals about you can land here too.</EmptyLine> : null}
        {entries.length > 0 ? (
          <ul className="divide-y divide-border/50 rounded-lg border border-border/60">
            {entries.map((entry) => (
              <li key={entry.key} className="flex items-start gap-2 px-3 py-2 text-xs">
                <div className="min-w-0 flex-1">
                  <p className="font-medium">{entry.key}</p>
                  <p className="mt-0.5 break-words text-muted-foreground">{entry.value}</p>
                  <p className="mt-0.5 text-[10px] text-muted-foreground">{entry.source} · {relativeTime(entry.updated_at, now)}</p>
                </div>
                <button type="button" className="icon-button h-7 w-7" aria-label={`Edit ${entry.key}`} onClick={() => { setKey(entry.key); setValue(entry.value); setEditingKey(entry.key); setFormError(null); }}><Pencil className="h-3.5 w-3.5" /></button>
                <button type="button" className="icon-button h-7 w-7 text-destructive" aria-label={`Remove ${entry.key}`} disabled={action.isBusy(entry.key)} onClick={() => remove(entry.key)}><Trash2 className="h-3.5 w-3.5" /></button>
              </li>
            ))}
          </ul>
        ) : null}
        <form className="space-y-2 rounded-lg border border-border/60 bg-background p-3" onSubmit={(event) => { event.preventDefault(); void save(); }} aria-label={editingKey ? 'Edit preference' : 'Add preference'}>
          <div className="grid gap-2 sm:grid-cols-[12rem_1fr]">
            <input aria-label="Preference key" className="field h-9" placeholder="Jira comments" value={key} disabled={Boolean(editingKey)} onChange={(event) => setKey(event.target.value)} />
            <input aria-label="Preference value" className="field h-9" placeholder="Bullet points, no greetings" maxLength={MAX_PROFILE_VALUE} value={value} onChange={(event) => setValue(event.target.value)} />
          </div>
          <ErrorLine message={formError ?? action.error} />
          <div className="flex justify-end gap-2">
            {editingKey ? <button type="button" className="button" onClick={reset}>Cancel</button> : null}
            <button type="submit" className="button button-primary" disabled={action.isBusy('save')}>{action.isBusy('save') ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : editingKey ? null : <Plus className="h-3.5 w-3.5" aria-hidden="true" />}{editingKey ? 'Save preference' : 'Add preference'}</button>
          </div>
        </form>
      </div>
    </Panel>
  );
}
