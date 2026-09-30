import type { BotEvent } from '../../../../types/botRuntime';
import StatusPill from '../../../../ui/StatusPill';
import { Chip, EmptyLine } from '../panel/Panel';
import { relativeTime } from '../panel/time';

import { TRUST_LABELS, describeEvent } from './triggerForm';

const TRUST_TONES: Record<BotEvent['trust'], string> = {
  operator: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
  internal: 'bg-sky-500/10 text-sky-700 dark:text-sky-300',
  external: 'bg-amber-500/10 text-amber-700 dark:text-amber-300',
};

const TRUST_TITLES: Record<BotEvent['trust'], string> = {
  operator: 'Came from you.',
  internal: 'Came from CloudCLI itself (a schedule, a board event, another run).',
  external: 'Came from outside (a webhook, a feed, a file). The bot reads it but it cannot authorize risky actions on its own.',
};

export default function RecentEvents({ events, now }: { events: BotEvent[]; now: number }) {
  if (events.length === 0) return <EmptyLine>No events yet. Use Test fire on a trigger to see one arrive.</EmptyLine>;
  return (
    <ul className="divide-y divide-border/50 rounded-xl border border-border/70 bg-card">
      {events.map((event) => (
        <li key={event.event_id} className="flex flex-wrap items-center gap-2 px-3 py-2 text-xs">
          <span className="min-w-0 flex-1 truncate" title={describeEvent(event)}>{describeEvent(event)}</span>
          <Chip className={TRUST_TONES[event.trust]} title={TRUST_TITLES[event.trust]}>{TRUST_LABELS[event.trust] ?? event.trust}</Chip>
          <StatusPill status={event.status} />
          <span className="w-16 shrink-0 text-right text-[10px] text-muted-foreground">{relativeTime(event.received_at, now)}</span>
        </li>
      ))}
    </ul>
  );
}
