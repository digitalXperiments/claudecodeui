import type { ReactNode } from 'react';

/** Small presentational pieces shared by the architect's steps (kept free of wizard state). */

export function FieldLabel({ children, detail }: { children: ReactNode; detail?: string }) {
  return (
    <div className="mb-1.5 flex items-baseline justify-between gap-3">
      <label className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">{children}</label>
      {detail ? <span className="text-[10px] text-muted-foreground/75">{detail}</span> : null}
    </div>
  );
}

export function StepPanel({ eyebrow, title, description, children }: { eyebrow: string; title: string; description: string; children: ReactNode }) {
  return <section className="space-y-6"><div><p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-primary">{eyebrow}</p><h2 className="mt-2 text-2xl font-semibold tracking-tight">{title}</h2><p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">{description}</p></div><div className="space-y-5">{children}</div></section>;
}

const TONES = {
  info: 'border-primary/20 bg-primary/[0.05]',
  warn: 'border-amber-500/30 bg-amber-500/[0.08]',
  ok: 'border-emerald-500/25 bg-emerald-500/[0.07]',
  plain: 'border-border/60 bg-muted/20',
} as const;

/** A titled explanatory box. `role="note"` so assistive tech announces it as supporting text. */
export function Callout({ title, tone = 'plain', children }: { title?: string; tone?: keyof typeof TONES; children: ReactNode }) {
  return (
    <div role="note" className={`rounded-xl border p-4 text-xs leading-relaxed text-muted-foreground ${TONES[tone]}`}>
      {title ? <p className="mb-1 text-xs font-semibold text-foreground">{title}</p> : null}
      {children}
    </div>
  );
}

/** A labelled on/off row used for the many yes/no choices (a real switch, labelled for screen readers). */
export function SwitchRow({ title, description, checked, onChange, disabled = false }: { title: string; description?: ReactNode; checked: boolean; onChange: (next: boolean) => void; disabled?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-4 rounded-xl border border-border/60 bg-muted/20 p-4">
      <div className="min-w-0">
        <p className="text-xs font-semibold text-foreground">{title}</p>
        {description ? <div className="mt-1 text-[11px] leading-relaxed text-muted-foreground">{description}</div> : null}
      </div>
      <button type="button" role="switch" aria-checked={checked} aria-label={title} disabled={disabled} className={`toggle ${checked ? 'toggle-on' : ''}`} onClick={() => onChange(!checked)}><span /></button>
    </div>
  );
}
