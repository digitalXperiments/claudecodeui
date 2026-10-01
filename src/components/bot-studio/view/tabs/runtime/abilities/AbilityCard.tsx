import type { ReactNode } from 'react';

/** One numbered section of the Abilities tab: a plain-language title, one sentence of explanation, then the controls. */
export default function AbilityCard({ id, number, title, description, actions, children }: {
  id: string;
  number: number;
  title: string;
  description: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section id={`abilities-${id}`} aria-labelledby={`abilities-${id}-title`} className="scroll-mt-4 rounded-2xl border border-border/70 bg-card p-4 shadow-sm sm:p-5">
      <header className="flex flex-wrap items-start gap-3">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary" aria-hidden="true">{number}</span>
        <div className="min-w-0 flex-[1_1_16rem]">
          <h3 id={`abilities-${id}-title`} className="text-sm font-semibold">{title}</h3>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{description}</p>
        </div>
        {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
      </header>
      <div className="mt-4 space-y-4">{children}</div>
    </section>
  );
}
