import { AlertTriangle, RotateCcw, X } from 'lucide-react';

import { cn } from '../../../../../../lib/utils';

import { channelLabel } from './runtimeFormat';
import TaintedBadge from './TaintedBadge';
import { isOptimistic, threadAlignment, type ThreadEntry } from './thread';

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });

function timeOf(value: string): string {
  const time = Date.parse(value);
  return Number.isFinite(time) ? timeFormat.format(new Date(time)) : '';
}

export default function ThreadBubble({ entry, onRetry, onDismiss }: { entry: ThreadEntry; onRetry?: (entry: ThreadEntry) => void; onDismiss?: (entry: ThreadEntry) => void }) {
  const align = threadAlignment(entry.role);
  const pending = isOptimistic(entry);
  const failed = pending && entry.failed === true;

  if (align === 'center') {
    return (
      <li className="flex justify-center">
        <p className="max-w-[85%] whitespace-pre-wrap break-words rounded-full bg-muted/60 px-3 py-1 text-center text-[11px] text-muted-foreground">{entry.body}</p>
      </li>
    );
  }

  const mine = align === 'right';
  return (
    <li className={cn('flex flex-col gap-1', mine ? 'items-end' : 'items-start')}>
      <div
        className={cn(
          'max-w-[85%] whitespace-pre-wrap break-words rounded-2xl px-3.5 py-2 text-sm sm:max-w-[75%]',
          mine ? 'rounded-br-md bg-primary text-primary-foreground' : 'rounded-bl-md border border-border/70 bg-card text-foreground',
          pending && !failed && 'opacity-70',
          failed && 'border border-destructive/60 bg-destructive/10 text-foreground',
        )}
      >
        {entry.body}
      </div>
      <div className={cn('flex flex-wrap items-center gap-1.5 px-1 text-[10px] text-muted-foreground', mine && 'flex-row-reverse')}>
        <span className="rounded-full bg-muted px-1.5 py-0.5" title={`Sent via ${channelLabel(entry.channel)}`}>{channelLabel(entry.channel)}</span>
        <span>{failed ? 'Not sent' : pending ? 'Sending…' : timeOf(entry.created_at)}</span>
        {!mine && entry.meta?.tainted === true ? <TaintedBadge /> : null}
        {failed ? (
          <>
            <AlertTriangle className="h-3 w-3 text-destructive" aria-hidden="true" />
            <button type="button" onClick={() => onRetry?.(entry)} aria-label="Retry sending message" className="inline-flex items-center gap-0.5 rounded text-destructive hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><RotateCcw className="h-3 w-3" />Retry</button>
            <button type="button" onClick={() => onDismiss?.(entry)} aria-label="Discard unsent message" className="inline-flex items-center gap-0.5 rounded hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><X className="h-3 w-3" />Discard</button>
          </>
        ) : null}
      </div>
    </li>
  );
}
