import { Check } from 'lucide-react';

import { CRON_PRESETS, cronSummary, presetForCron, validateCron } from '../detail/cron';

/** Cron presets plus a custom five-field expression; empty means Manual only. Controlled. */
export default function ScheduleEditor({ cron, onChange }: { cron: string; onChange: (cron: string) => void }) {
  const error = validateCron(cron);
  const active = presetForCron(cron)?.id;
  return <div className="space-y-2">
    <p className="text-xs font-semibold">Schedule</p>
    <div className="flex flex-wrap gap-1.5">{CRON_PRESETS.map((preset) => <button key={preset.id} type="button" onClick={() => onChange(preset.cron ?? '')} title={preset.description} aria-pressed={active === preset.id} className={`inline-flex items-center gap-1 rounded-lg border px-2.5 py-1.5 text-[11px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${active === preset.id ? 'border-primary/50 bg-primary/10 text-primary' : 'border-border/70 bg-background text-muted-foreground hover:text-foreground'}`}>{active === preset.id ? <Check className="h-3 w-3" /> : null}{preset.label}</button>)}</div>
    <input aria-label="Cron schedule" value={cron} onChange={(event) => onChange(event.target.value)} placeholder="0 9 * * 1-5 · empty = Manual only" className="h-9 w-full rounded-lg border border-border bg-background px-3 font-mono text-xs outline-none focus:border-primary focus:ring-2 focus:ring-primary/20" />
    {error ? <p className="text-[11px] text-destructive" role="alert">{error}</p> : <p className="text-[11px] text-muted-foreground">{cronSummary(cron)}</p>}
  </div>;
}
