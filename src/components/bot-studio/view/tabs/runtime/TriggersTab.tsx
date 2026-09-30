import { useCallback, useState } from 'react';
import { Plus, RefreshCw } from 'lucide-react';

import type { McSection } from '../../../../mission-control/api/missionControlApi';
import { botRuntimeApi } from '../../../api/botRuntimeApi';
import { removeById, upsertEvent, upsertTrigger } from '../../../hooks/botRuntimeReducers';
import { useBotRuntime } from '../../../hooks/useBotRuntime';
import type { BotTrigger } from '../../../types/botRuntime';
import InlineToast from '../../../ui/InlineToast';

import { ErrorLine, EmptyLine, Panel, SkeletonRows } from './panel/Panel';
import { useAsyncAction } from './panel/useAsyncAction';
import { useNow } from './panel/useNow';
import RecentEvents from './triggers/RecentEvents';
import TriggerEditor from './triggers/TriggerEditor';
import TriggerRow from './triggers/TriggerRow';
import { KIND_LABELS } from './triggers/triggerForm';

const SECTIONS = ['triggers' as const, 'events' as const];

type Editing = { mode: 'closed' } | { mode: 'new' } | { mode: 'edit'; triggerId: string };

/** Everything that can wake this bot: triggers (schedules, webhooks, watchers, automation filters) and the events they produced. */
export function TriggersTab({ botId, section }: { botId: string; section: McSection }) {
  const runtime = useBotRuntime(botId, { sections: SECTIONS });
  const { patchSection, refresh } = runtime;
  const now = useNow();
  const action = useAsyncAction();
  const [editing, setEditing] = useState<Editing>({ mode: 'closed' });
  const [toast, setToast] = useState<{ message: string; tone: 'success' | 'error' } | null>(null);

  const triggers = runtime.triggers;
  const loading = runtime.isLoading('triggers') && triggers.length === 0;
  const loadError = runtime.error('triggers');
  const editingTrigger = editing.mode === 'edit' ? triggers.find((entry) => entry.trigger_id === editing.triggerId) ?? null : null;

  const saved = useCallback((trigger: BotTrigger) => {
    patchSection('triggers', (current) => upsertTrigger(current, trigger));
    setEditing({ mode: 'closed' });
    setToast({ message: 'Trigger saved.', tone: 'success' });
  }, [patchSection]);

  const toggle = (trigger: BotTrigger, enabled: boolean) => void action.run(trigger.trigger_id, async () => {
    const next = await botRuntimeApi.triggers.update(botId, trigger.trigger_id, { enabled });
    patchSection('triggers', (current) => upsertTrigger(current, next));
  });

  const remove = (trigger: BotTrigger) => {
    if (!window.confirm(`Delete this ${KIND_LABELS[trigger.kind] ?? trigger.kind} trigger?`)) return;
    void action.run(trigger.trigger_id, async () => {
      await botRuntimeApi.triggers.remove(botId, trigger.trigger_id);
      patchSection('triggers', (current) => removeById(current, trigger.trigger_id, (entry) => entry.trigger_id));
      if (editing.mode === 'edit' && editing.triggerId === trigger.trigger_id) setEditing({ mode: 'closed' });
    });
  };

  const testFire = (trigger: BotTrigger) => void action.run(trigger.trigger_id, async () => {
    const event = await botRuntimeApi.triggers.test(botId, trigger.trigger_id);
    patchSection('events', (current) => upsertEvent(current, event));
    setToast({ message: 'Sample event sent. The bot will wake.', tone: 'success' });
  });

  return (
    <div className="bot-studio-controls max-w-4xl space-y-5 overflow-y-auto p-4 sm:p-6">
      <div>
        <h2 className="text-sm font-semibold">Triggers</h2>
        <p className="mt-1 text-xs text-muted-foreground">Every reason this bot wakes up. Many signals close together become one wake-up (the coalesce window).</p>
      </div>

      {!section.enabled ? <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">This bot is paused, so triggers will queue events but not wake it until you resume it.</p> : null}
      <InlineToast message={toast?.message ?? null} tone={toast?.tone} onDismiss={() => setToast(null)} />
      <ErrorLine message={action.error} />

      <Panel
        title="Wake triggers"
        description="Schedules, signed webhooks, watchers and automation filters."
        actions={(
          <>
            <button type="button" className="button min-h-8" onClick={() => void refresh('triggers')} aria-label="Refresh triggers"><RefreshCw className="h-3.5 w-3.5" aria-hidden="true" /></button>
            <button type="button" className="button button-primary min-h-8" onClick={() => setEditing({ mode: 'new' })} disabled={editing.mode === 'new'}><Plus className="h-3.5 w-3.5" aria-hidden="true" />Add trigger</button>
          </>
        )}
      >
        <div className="space-y-2">
          {editing.mode === 'new' ? <TriggerEditor botId={botId} trigger={null} onSaved={saved} onCancel={() => setEditing({ mode: 'closed' })} /> : null}
          {editing.mode === 'edit' && editingTrigger ? <TriggerEditor key={editingTrigger.trigger_id} botId={botId} trigger={editingTrigger} onSaved={saved} onCancel={() => setEditing({ mode: 'closed' })} /> : null}
          {loading ? <SkeletonRows /> : null}
          {loadError && triggers.length === 0 ? <ErrorLine message={loadError} /> : null}
          {!loading && !loadError && triggers.length === 0 && editing.mode !== 'new' ? <EmptyLine>No triggers yet. Without one this bot only runs when you wake it.</EmptyLine> : null}
          {triggers.length > 0 ? (
            <ul className="space-y-2">
              {triggers.map((trigger) => (
                <TriggerRow
                  key={trigger.trigger_id}
                  trigger={trigger}
                  now={now}
                  busy={action.isBusy(trigger.trigger_id)}
                  onToggle={(enabled) => toggle(trigger, enabled)}
                  onEdit={() => setEditing({ mode: 'edit', triggerId: trigger.trigger_id })}
                  onDelete={() => remove(trigger)}
                  onTest={() => testFire(trigger)}
                />
              ))}
            </ul>
          ) : null}
        </div>
      </Panel>

      <Panel title="Recent events" description="What arrived, who it came from, and whether the bot has handled it.">
        {runtime.isLoading('events') && runtime.events.length === 0 ? <SkeletonRows count={2} /> : <RecentEvents events={runtime.events} now={now} />}
      </Panel>
    </div>
  );
}
