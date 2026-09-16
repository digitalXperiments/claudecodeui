import { X } from 'lucide-react';

export default function InlineToast({ message, tone = 'default', onDismiss }: { message: string | null; tone?: 'default' | 'error' | 'success'; onDismiss?: () => void }) {
  if (!message) return null;
  const toneClass = tone === 'error' ? 'border-destructive/30 bg-destructive/10 text-destructive' : tone === 'success' ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' : 'border-border bg-card text-foreground';
  return <div role="status" className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-xs shadow-sm ${toneClass}`}><span className="min-w-0 flex-1">{message}</span>{onDismiss ? <button type="button" onClick={onDismiss} aria-label="Dismiss notification" className="rounded p-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><X className="h-3.5 w-3.5" /></button> : null}</div>;
}
