import type { LucideIcon } from 'lucide-react';
import { AlertTriangle, Loader2 } from 'lucide-react';
import type { ReactNode } from 'react';

import { cn } from '../../../../lib/utils';

/** Page frame shared by the Brief / Channels / Teams views. */
export function RuntimePage({ icon: Icon, eyebrow, title, description, actions, children }: {
  icon: LucideIcon;
  eyebrow: string;
  title: string;
  description: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return <section className="bot-studio-controls min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
    <div className="mx-auto max-w-5xl">
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-primary"><Icon className="h-4 w-4" /><p className="text-[10px] font-semibold uppercase tracking-[0.16em]">{eyebrow}</p></div>
          <h2 className="mt-1 text-xl font-semibold">{title}</h2>
          <p className="mt-1 max-w-2xl text-xs text-muted-foreground">{description}</p>
        </div>
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
      {children}
    </div>
  </section>;
}

export function RuntimeCard({ title, subtitle, action, tone = 'default', children, className }: {
  title: string;
  subtitle?: string;
  action?: ReactNode;
  tone?: 'default' | 'warning' | 'error';
  children: ReactNode;
  className?: string;
}) {
  const border = tone === 'error' ? 'border-destructive/40' : tone === 'warning' ? 'border-amber-500/40' : 'border-border/70';
  return <div className={cn('overflow-hidden rounded-xl border bg-card', border, className)}>
    <div className="flex items-center justify-between gap-2 border-b border-border/70 px-4 py-3">
      <div className="min-w-0"><p className="text-xs font-semibold">{title}</p>{subtitle ? <p className="mt-0.5 text-[10px] text-muted-foreground">{subtitle}</p> : null}</div>
      {action}
    </div>
    {children}
  </div>;
}

export function ErrorBanner({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return <div role="alert" className="mb-3 flex items-start gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">
    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
    <span className="min-w-0 flex-1 break-words">{message}</span>
    {onRetry ? <button type="button" onClick={onRetry} className="shrink-0 rounded underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">Retry</button> : null}
  </div>;
}

export function LoadingLine({ label }: { label: string }) {
  return <div role="status" className="flex items-center gap-2 px-4 py-6 text-xs text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" />{label}</div>;
}

export function EmptyLine({ children }: { children: ReactNode }) {
  return <p className="px-4 py-5 text-center text-[11px] text-muted-foreground">{children}</p>;
}

export function Pill({ tone = 'default', children }: { tone?: 'default' | 'success' | 'warning' | 'error' | 'info'; children: ReactNode }) {
  const toneClass = tone === 'success'
    ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
    : tone === 'warning'
      ? 'bg-amber-500/10 text-amber-700 dark:text-amber-300'
      : tone === 'error'
        ? 'bg-destructive/10 text-destructive'
        : tone === 'info'
          ? 'bg-sky-500/10 text-sky-700 dark:text-sky-300'
          : 'bg-muted text-muted-foreground';
  return <span className={cn('inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[10px] font-medium', toneClass)}>{children}</span>;
}

/** Labelled form control. `children` is the input; `hint` renders below it. */
export function Field({ label, hint, children, className }: { label: string; hint?: ReactNode; children: ReactNode; className?: string }) {
  return <label className={cn('block space-y-1', className)}>
    <span className="block text-[11px] font-medium text-foreground">{label}</span>
    {children}
    {hint ? <span className="block text-[10px] leading-snug text-muted-foreground">{hint}</span> : null}
  </label>;
}
