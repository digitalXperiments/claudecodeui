import Toggle from '../../ui/Toggle';

import { urgencyLabel, validateQuietHours, type PolicyDraft } from './channelsModel';
import { Field } from './RuntimePage';

/** Notification policy form. `global` also shows the morning-brief schedule (global channels only). */
export default function PolicyEditor({ draft, onChange, global }: { draft: PolicyDraft; onChange: (next: PolicyDraft) => void; global: boolean }) {
  const set = <K extends keyof PolicyDraft>(key: K, value: PolicyDraft[K]) => onChange({ ...draft, [key]: value });
  const quietError = draft.quietEnabled ? validateQuietHours(draft.quietStart, draft.quietEnd, draft.quietTz) : null;
  return <fieldset className="space-y-4 rounded-lg border border-border/70 p-3">
    <legend className="px-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">Notification policy</legend>

    <div>
      <div className="flex items-center justify-between gap-3">
        <div><p className="text-xs font-medium">Quiet hours</p><p className="text-[10px] text-muted-foreground">Hold pings during this window; they show up in the brief instead.</p></div>
        <Toggle checked={draft.quietEnabled} onChange={(value) => set('quietEnabled', value)} label="Enable quiet hours" />
      </div>
      {draft.quietEnabled ? <div className="mt-2 grid gap-2 sm:grid-cols-3">
        <Field label="Start"><input type="time" className="field" value={draft.quietStart} onChange={(event) => set('quietStart', event.target.value)} /></Field>
        <Field label="End"><input type="time" className="field" value={draft.quietEnd} onChange={(event) => set('quietEnd', event.target.value)} /></Field>
        <Field label="Time zone" hint="IANA name; blank uses the server's zone."><input className="field" value={draft.quietTz} placeholder="Asia/Dubai" onChange={(event) => set('quietTz', event.target.value)} /></Field>
        {quietError ? <p role="alert" className="text-[11px] text-destructive sm:col-span-3">{quietError}</p> : null}
      </div> : null}
    </div>

    <div className="grid gap-3 sm:grid-cols-2">
      <Field label="Max pings per day" hint="Blank means no limit; 0 silences this channel."><input type="number" min={0} step={1} className="field" value={draft.maxPings} placeholder="No limit" onChange={(event) => set('maxPings', event.target.value)} /></Field>
      <Field label={`Minimum urgency: ${Math.round(draft.minUrgency * 100)}% (${urgencyLabel(draft.minUrgency)})`} hint="Less urgent pings are held back.">
        <input type="range" min={0} max={1} step={0.05} value={draft.minUrgency} onChange={(event) => set('minUrgency', Number(event.target.value))} className="w-full accent-primary" />
      </Field>
    </div>

    <div className="flex items-center justify-between gap-3">
      <div><p className="text-xs font-medium">Digest only</p><p className="text-[10px] text-muted-foreground">Send nothing live; everything waits for the brief.</p></div>
      <Toggle checked={draft.digest} onChange={(value) => set('digest', value)} label="Digest only" />
    </div>

    {global ? <div className="grid gap-2 sm:grid-cols-2">
      <Field label="Morning brief at" hint="Daily, HH:MM. The first global channel that sets this schedules the brief."><input type="time" className="field" value={draft.briefAt} onChange={(event) => set('briefAt', event.target.value)} /></Field>
      <Field label="Brief time zone" hint="IANA name; blank uses the server's zone."><input className="field" value={draft.briefTz} placeholder="Asia/Dubai" onChange={(event) => set('briefTz', event.target.value)} /></Field>
    </div> : null}
  </fieldset>;
}
