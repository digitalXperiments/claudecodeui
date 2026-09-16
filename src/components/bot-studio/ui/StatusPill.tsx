import { cn } from '../../../lib/utils';

const tones: Record<string, string> = {
  pending: 'bg-amber-500/10 text-amber-700 dark:text-amber-300',
  queued: 'bg-amber-500/10 text-amber-700 dark:text-amber-300',
  resolving: 'bg-primary/10 text-primary',
  running: 'bg-primary/10 text-primary',
  processing: 'bg-primary/10 text-primary',
  succeeded: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
  completed: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
  resolved: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
  failed: 'bg-destructive/10 text-destructive',
  noop: 'bg-muted text-muted-foreground',
  skipped: 'bg-muted text-muted-foreground',
  dismissed: 'bg-muted text-muted-foreground',
  expired: 'bg-muted text-muted-foreground',
  dry_run: 'bg-violet-500/10 text-violet-700 dark:text-violet-300',
  propose: 'bg-amber-500/10 text-amber-700 dark:text-amber-300',
  act: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
};
export default function StatusPill({ status }: { status: string }) {
  const normalized = status.toLowerCase();
  const pulse = normalized === 'running' || normalized === 'processing' || normalized === 'resolving';
  return <span aria-label={`Status: ${status.replace(/_/g, ' ')}`} className={cn('inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[10px] font-medium capitalize', tones[normalized] ?? tones.dismissed, pulse && 'animate-pulse')}>{status.replace(/_/g, ' ')}</span>;
}
