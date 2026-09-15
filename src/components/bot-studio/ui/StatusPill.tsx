import { cn } from '../../../lib/utils';

const tones: Record<string, string> = { pending: 'bg-amber-500/10 text-amber-700 dark:text-amber-300', resolving: 'bg-sky-500/10 text-sky-700 dark:text-sky-300', resolved: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300', failed: 'bg-destructive/10 text-destructive', dismissed: 'bg-muted text-muted-foreground', expired: 'bg-muted text-muted-foreground' };
export default function StatusPill({ status }: { status: string }) { return <span className={cn('rounded-full px-2 py-0.5 text-[10px] font-medium capitalize', tones[status] ?? tones.dismissed)}>{status.replace(/_/g, ' ')}</span>; }
