import { AlertTriangle, Check, Copy, FlaskConical, Pencil, Trash2 } from 'lucide-react';

import type { BotTrigger } from '../../../../types/botRuntime';
import Toggle from '../../../../ui/Toggle';
import { Chip } from '../panel/Panel';
import { relativeTime } from '../panel/time';
import { useCopy } from '../panel/useAsyncAction';

import { kindIcon } from './kindIcons';
import { KIND_LABELS, summarizeTrigger, triggerHealth, webhookPath, webhookUrl } from './triggerForm';

export default function TriggerRow({ trigger, now, busy, onToggle, onEdit, onDelete, onTest }: {
  trigger: BotTrigger;
  now: number;
  busy: boolean;
  onToggle: (enabled: boolean) => void;
  onEdit: () => void;
  onDelete: () => void;
  onTest: () => void;
}) {
  const Icon = kindIcon(trigger.kind);
  const health = triggerHealth(trigger);
  const { copied, copy } = useCopy();
  const isWebhook = trigger.kind === 'webhook';
  const url = isWebhook ? webhookUrl(trigger.trigger_id, typeof window === 'undefined' ? '' : window.location.origin) : '';
  const editable = trigger.kind !== 'manual' && !['peer_message', 'ask_bot', 'commitment_due', 'operator_message'].includes(trigger.kind);
  return (
    <li className="rounded-xl border border-border/70 bg-card p-3">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary"><Icon className="h-4 w-4" aria-hidden="true" /></span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <p className="text-xs font-semibold">{KIND_LABELS[trigger.kind] ?? trigger.kind}</p>
            {!trigger.enabled ? <Chip>Paused</Chip> : null}
            <span className="text-[10px] text-muted-foreground">Last fired {trigger.last_fired_at ? relativeTime(trigger.last_fired_at, now) : 'never'}</span>
          </div>
          <p className="mt-0.5 break-words text-[11px] text-muted-foreground">{summarizeTrigger(trigger)}</p>
          {isWebhook ? (
            <div className="mt-1.5 flex items-center gap-1.5">
              <code className="min-w-0 truncate rounded bg-muted/50 px-1.5 py-0.5 font-mono text-[10px]" title={url}>{webhookPath(trigger.trigger_id)}</code>
              <button type="button" onClick={() => void copy(url)} aria-label="Copy webhook URL" className="icon-button h-6 w-6">
                {copied === url ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
              </button>
            </div>
          ) : null}
          {health.error ? (
            <p role="alert" className="mt-1.5 flex items-start gap-1.5 rounded-lg bg-destructive/10 px-2 py-1.5 text-[11px] text-destructive">
              <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
              <span className="min-w-0 break-words">Last poll failed{health.errorAt ? ` ${relativeTime(health.errorAt, now)}` : ''}: {health.error}</span>
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Toggle checked={trigger.enabled} onChange={onToggle} label={`${trigger.enabled ? 'Pause' : 'Enable'} ${KIND_LABELS[trigger.kind] ?? trigger.kind} trigger`} disabled={busy} />
        </div>
      </div>
      <div className="mt-2 flex flex-wrap justify-end gap-1.5">
        <button type="button" className="button min-h-8" onClick={onTest} disabled={busy} title="Fires a labelled sample event through the real path; the bot will wake.">
          <FlaskConical className="h-3.5 w-3.5" aria-hidden="true" />Test fire
        </button>
        {editable ? <button type="button" className="button min-h-8" onClick={onEdit} disabled={busy}><Pencil className="h-3.5 w-3.5" aria-hidden="true" />Edit</button> : null}
        <button type="button" className="button min-h-8 text-destructive hover:bg-destructive/10" onClick={onDelete} disabled={busy} aria-label={`Delete ${KIND_LABELS[trigger.kind] ?? trigger.kind} trigger`}>
          <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />Delete
        </button>
      </div>
    </li>
  );
}
