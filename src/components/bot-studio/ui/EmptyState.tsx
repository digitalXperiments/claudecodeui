import type { ReactNode } from 'react';

export default function EmptyState({ icon, title, description, action }: { icon?: ReactNode; title: string; description?: string; action?: ReactNode }) {
  return <div className="flex min-h-40 flex-col items-center justify-center rounded-xl border border-dashed border-border/70 bg-card/30 p-6 text-center"><div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-primary">{icon}</div><h2 className="mt-3 text-sm font-semibold">{title}</h2>{description ? <p className="mt-1 max-w-sm text-xs leading-5 text-muted-foreground">{description}</p> : null}{action ? <div className="mt-4">{action}</div> : null}</div>;
}
