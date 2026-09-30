import { ShieldAlert } from 'lucide-react';

import { cn } from '../../../../../../lib/utils';

/** Marks data the bot derived after seeing untrusted (external) input. */
export default function TaintedBadge({ label = 'saw untrusted input', className, title }: { label?: string; className?: string; title?: string }) {
  return (
    <span
      title={title ?? 'This came from a session that saw untrusted input; treat it with care.'}
      className={cn('inline-flex shrink-0 items-center gap-1 rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-300', className)}
    >
      <ShieldAlert className="h-3 w-3" aria-hidden="true" />
      {label}
    </span>
  );
}
