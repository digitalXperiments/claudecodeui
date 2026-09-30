import { useSchedulePreview } from './useSchedulePreview';

/** The compiled cron, plain-language description and exclusions, shown back for confirmation. */
export default function NlSchedulePreview({ text, timezone }: { text: string; timezone: string }) {
  const state = useSchedulePreview(text, timezone);
  if (state.status === 'idle') {
    return <p className="text-[11px] text-muted-foreground">Try "every 15 minutes", "weekdays at 9am except fridays" or "first day of the month at 8".</p>;
  }
  if (state.status === 'loading') return <p className="text-[11px] text-muted-foreground" aria-live="polite">Compiling…</p>;
  if (state.status === 'error') return <p role="alert" className="text-[11px] text-destructive">{state.message}</p>;
  const { preview } = state;
  return (
    <div className="space-y-1 rounded-lg border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-xs" aria-live="polite">
      <p className="font-medium">{preview.description || 'Compiled schedule'}</p>
      <p className="text-muted-foreground">Cron <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">{preview.cron}</code>{preview.timezone ? ` · ${preview.timezone}` : ''}</p>
      {preview.exclusions.map((line) => <p key={line} className="text-muted-foreground">{line}</p>)}
      <p className="text-[10px] text-muted-foreground">Confirm this is what you meant before saving; the schedule is compiled without a model, so it will not change.</p>
    </div>
  );
}
