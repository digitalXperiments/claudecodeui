import type { ReactNode } from 'react';

import { cn } from '../../../../../../lib/utils';

/** A titled card used by the Triggers, Rules and Learning tabs. */
export function Panel({ title, description, actions, tone = 'default', children, id }: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  tone?: 'default' | 'warn';
  children?: ReactNode;
  id?: string;
}) {
  return (
    <section id={id} className={cn('rounded-xl border p-4', tone === 'warn' ? 'border-amber-500/30 bg-amber-500/5' : 'border-border/70 bg-card')}>
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-xs font-semibold">{title}</h3>
          {description ? <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">{description}</p> : null}
        </div>
        {actions ? <div className="flex shrink-0 flex-wrap items-center gap-1.5">{actions}</div> : null}
      </header>
      {children ? <div className="mt-3">{children}</div> : null}
    </section>
  );
}

export function ErrorLine({ message }: { message: string | null }) {
  if (!message) return null;
  return <p role="alert" className="rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">{message}</p>;
}

export function WarnLine({ children, strong = false }: { children: ReactNode; strong?: boolean }) {
  return (
    <p role="alert" className={cn('rounded-lg border px-3 py-2 text-xs', strong ? 'border-destructive/40 bg-destructive/10 font-medium text-destructive' : 'border-amber-500/30 bg-amber-500/10 text-amber-800 dark:text-amber-200')}>
      {children}
    </p>
  );
}

export function Chip({ className, title, children }: { className?: string; title?: string; children: ReactNode }) {
  return <span title={title} className={cn('inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[10px] font-medium', className ?? 'bg-muted text-muted-foreground')}>{children}</span>;
}

export function EmptyLine({ children }: { children: ReactNode }) {
  return <p className="rounded-lg border border-dashed border-border/70 px-3 py-4 text-center text-xs text-muted-foreground">{children}</p>;
}

export function Field({ label, hint, children, className }: { label: string; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <label className={cn('block min-w-0 text-[11px] text-muted-foreground', className)}>
      {label}
      <div className="mt-1 text-foreground">{children}</div>
      {hint ? <span className="mt-1 block text-[10px] leading-snug text-muted-foreground">{hint}</span> : null}
    </label>
  );
}

export function SkeletonRows({ count = 3 }: { count?: number }) {
  return (
    <div aria-hidden="true" className="space-y-2">
      {Array.from({ length: count }, (_, index) => <div key={index} className="h-12 animate-pulse rounded-lg bg-muted" />)}
    </div>
  );
}
