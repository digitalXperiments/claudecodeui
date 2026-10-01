import type { BotTrigger } from '../../../../types/botRuntime';
import ScheduleEditor from '../../ScheduleEditor';
import { Field } from '../panel/Panel';

import NlSchedulePreview from './NlSchedulePreview';
import WatchFields from './WatchFields';
import WebhookInfo from './WebhookInfo';
import {
  DEFAULT_COALESCE_MS, EDITABLE_KINDS, KIND_HINTS, KIND_LABELS, MAX_COALESCE_MS,
  type EditableKind, type IntervalUnit, type TriggerDraft,
} from './triggerForm';

const AUTOMATION_KINDS: EditableKind[] = ['run_completed', 'kanban_event', 'interrupt_created'];

/**
 * The editable body of a trigger (kind picker, per-kind fields, coalescing, enabled). Shared by the
 * Triggers tab editor (which saves through the API) and the Bot Architect wizard (which only builds
 * a draft). `kinds` narrows the picker; `hideKind` drops the picker when the caller already chose one.
 */
export default function TriggerFields({ draft, onChange, onKindChange, trigger = null, kinds = EDITABLE_KINDS, hideKind = false }: {
  draft: TriggerDraft;
  onChange: (patch: Partial<TriggerDraft>) => void;
  /** Called with the chosen kind; the caller replaces the draft (fields do not carry across kinds). */
  onKindChange: (kind: EditableKind) => void;
  /** The saved trigger when editing (kind locked, webhook URL shown); null when creating. */
  trigger?: BotTrigger | null;
  kinds?: readonly EditableKind[];
  hideKind?: boolean;
}) {
  const change = onChange;
  const mirrored = trigger?.config.mirrored_from === 'schedule_cron';
  return (
    <>
      <div className="flex flex-wrap items-end gap-3">
        {hideKind ? null : (
          <Field label="Kind" className="w-56">
            <select aria-label="Trigger kind" className="field h-9" value={draft.kind} disabled={Boolean(trigger)} onChange={(event) => onKindChange(event.target.value as EditableKind)}>
              {kinds.map((kind) => <option key={kind} value={kind}>{KIND_LABELS[kind]}</option>)}
            </select>
          </Field>
        )}
        <p className="min-w-0 flex-1 pb-2 text-[11px] text-muted-foreground">{KIND_HINTS[draft.kind]}</p>
      </div>

      {draft.kind === 'cron' ? (
        <div className="space-y-2">
          {mirrored ? <p className="rounded-lg bg-muted/50 px-3 py-2 text-[11px] text-muted-foreground">This trigger mirrors the bot's own schedule; changing the schedule in Pipeline overwrites it.</p> : null}
          <ScheduleEditor cron={draft.cron} onChange={(cron) => change({ cron })} />
          <Field label="Timezone (optional)" hint="An IANA name such as Asia/Dubai. Empty uses the server's timezone." className="max-w-xs">
            <input aria-label="Timezone" className="field h-9" placeholder="Server timezone" value={draft.timezone} onChange={(event) => change({ timezone: event.target.value })} />
          </Field>
        </div>
      ) : null}

      {draft.kind === 'nl_schedule' ? (
        <div className="space-y-2">
          <Field label="Describe the schedule">
            <input aria-label="Schedule in plain language" className="field h-9" placeholder="weekdays at 9am except fridays" value={draft.text} onChange={(event) => change({ text: event.target.value })} />
          </Field>
          <Field label="Timezone (optional)" className="max-w-xs">
            <input aria-label="Timezone" className="field h-9" placeholder="Server timezone" value={draft.timezone} onChange={(event) => change({ timezone: event.target.value })} />
          </Field>
          <NlSchedulePreview text={draft.text} timezone={draft.timezone} />
        </div>
      ) : null}

      {draft.kind === 'interval' ? (
        <Field label="Every" hint="At least one minute." className="max-w-xs">
          <div className="flex gap-1.5">
            <input aria-label="Interval" type="number" min="1" step="any" className="field h-9 w-24" value={draft.everyValue} onChange={(event) => change({ everyValue: event.target.value })} />
            <select aria-label="Interval unit" className="field h-9" value={draft.everyUnit} onChange={(event) => change({ everyUnit: event.target.value as IntervalUnit })}>
              <option value="minutes">minutes</option>
              <option value="hours">hours</option>
              <option value="days">days</option>
            </select>
          </div>
        </Field>
      ) : null}

      {draft.kind === 'webhook' ? (
        <div className="space-y-2">
          <Field label="Signing secret name" hint="Create the secret in Settings → Secrets first, then type its name here. The value is never shown or sent from this page.">
            <input aria-label="Signing secret name" className="field h-9 font-mono text-xs" placeholder="GITHUB_WEBHOOK_SECRET" value={draft.secretRef} onChange={(event) => change({ secretRef: event.target.value })} />
          </Field>
          <WebhookInfo triggerId={trigger?.trigger_id ?? null} />
        </div>
      ) : null}

      {draft.kind === 'watch' ? <WatchFields draft={draft} onChange={change} /> : null}

      {draft.kind === 'run_completed' ? (
        <div className="grid gap-2 sm:grid-cols-3">
          <Field label="Status (optional)"><input aria-label="Run status" className="field h-9" placeholder="failed" value={draft.status} onChange={(event) => change({ status: event.target.value })} /></Field>
          <Field label="Source (optional)"><input aria-label="Run source" className="field h-9" placeholder="mission_control" value={draft.source} onChange={(event) => change({ source: event.target.value })} /></Field>
          <Field label="Project id (optional)"><input aria-label="Project id" className="field h-9" value={draft.projectId} onChange={(event) => change({ projectId: event.target.value })} /></Field>
        </div>
      ) : null}

      {draft.kind === 'kanban_event' ? (
        <div className="grid gap-2 sm:grid-cols-2">
          <Field label="Event (optional)"><input aria-label="Board event" className="field h-9" placeholder="task_moved" value={draft.event} onChange={(event) => change({ event: event.target.value })} /></Field>
          <Field label="Project id (optional)"><input aria-label="Project id" className="field h-9" value={draft.projectId} onChange={(event) => change({ projectId: event.target.value })} /></Field>
        </div>
      ) : null}

      {draft.kind === 'interrupt_created' ? (
        <div className="grid gap-2 sm:grid-cols-2">
          <Field label="Interrupt kind (optional)"><input aria-label="Interrupt kind" className="field h-9" placeholder="approval" value={draft.interruptKind} onChange={(event) => change({ interruptKind: event.target.value })} /></Field>
          <Field label="Severity (optional)"><input aria-label="Severity" className="field h-9" placeholder="high" value={draft.severity} onChange={(event) => change({ severity: event.target.value })} /></Field>
        </div>
      ) : null}

      <div className="grid gap-3 border-t border-border/60 pt-3 sm:grid-cols-2">
        <Field label="Coalesce window (ms)" hint={`Events arriving within this window become one wake-up. Empty = ${DEFAULT_COALESCE_MS} ms, max ${MAX_COALESCE_MS}.`}>
          <input aria-label="Coalesce window" type="number" min="0" max={MAX_COALESCE_MS} className="field h-9" placeholder={String(DEFAULT_COALESCE_MS)} value={draft.coalesceMs} onChange={(event) => change({ coalesceMs: event.target.value })} />
        </Field>
        <div className="space-y-2 pt-1">
          {AUTOMATION_KINDS.includes(draft.kind) ? (
            <label className="flex items-start gap-2 text-xs">
              <input type="checkbox" className="mt-0.5" checked={draft.allowBotOrigin} onChange={(event) => change({ allowBotOrigin: event.target.checked })} />
              <span>Also wake for things bots did<span className="block text-[10px] text-muted-foreground">Off by default so two bots cannot wake each other in a loop.</span></span>
            </label>
          ) : null}
          <label className="flex items-center gap-2 text-xs">
            <input type="checkbox" checked={draft.enabled} onChange={(event) => change({ enabled: event.target.checked })} />
            Enabled
          </label>
        </div>
      </div>
    </>
  );
}
