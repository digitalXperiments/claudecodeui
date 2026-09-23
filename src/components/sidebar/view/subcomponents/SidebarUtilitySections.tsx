import { useCallback, useState, type ReactNode } from 'react';
import { ChevronDown, Gauge, Waypoints } from 'lucide-react';

import { cn } from '../../../../lib/utils';
import ProviderUsageLegend from '../../../chat/view/subcomponents/ProviderUsageLegend';
import AgentRelayActivityControl, { type AgentRelaySummary } from '../../../chat/view/subcomponents/AgentRelayActivityControl';

function UtilitySection({
  title,
  icon,
  defaultExpanded = false,
  keepMounted = false,
  grow = true,
  children,
}: {
  title: ReactNode;
  icon: ReactNode;
  defaultExpanded?: boolean;
  keepMounted?: boolean;
  grow?: boolean;
  children: ReactNode;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);

  return (
    <section className={cn('flex min-h-0 flex-col border-t border-border/60', expanded && (grow ? 'max-h-[36%] flex-1' : 'max-h-[42%]'))}>
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        className="flex flex-shrink-0 items-center gap-1.5 px-3 py-2 text-left hover:bg-accent/60"
        aria-expanded={expanded}
      >
        <ChevronDown className={cn('h-3.5 w-3.5 text-muted-foreground transition-transform', !expanded && '-rotate-90')} />
        <span className="text-muted-foreground">{icon}</span>
        <span className="text-xs font-semibold uppercase tracking-wide text-foreground">{title}</span>
      </button>
      {expanded || keepMounted ? (
        <div className={cn('min-h-0 overflow-hidden', grow && 'flex flex-1', !expanded && 'hidden')}>
          {children}
        </div>
      ) : null}
    </section>
  );
}

export default function SidebarUtilitySections({
  projectId,
  sessionId,
}: {
  projectId: string | null;
  sessionId: string | null;
}) {
  const [relaySummary, setRelaySummary] = useState<AgentRelaySummary>({ activeCount: 0, approvalCount: 0, jobCount: 0 });
  const handleRelaySummary = useCallback((summary: AgentRelaySummary) => setRelaySummary(summary), []);

  return (
    <>
      <UtilitySection title="Usage" icon={<Gauge className="h-3.5 w-3.5" />} defaultExpanded keepMounted grow={false}>
        <ProviderUsageLegend embedded />
      </UtilitySection>
      <UtilitySection
        title={(
          <span className="flex min-w-0 items-center gap-1.5">
            <span>Relay</span>
            {relaySummary.activeCount > 0 ? <span className="rounded-full bg-primary px-1.5 text-[9px] font-semibold text-primary-foreground" aria-label={`${relaySummary.activeCount} active relay workers`}>{relaySummary.activeCount}</span> : null}
            {relaySummary.approvalCount > 0 ? <span className="rounded-full bg-amber-500 px-1.5 text-[9px] font-semibold text-white" aria-label={`${relaySummary.approvalCount} pending relay approvals`}>{relaySummary.approvalCount}</span> : null}
          </span>
        )}
        icon={<Waypoints className="h-3.5 w-3.5" />}
        keepMounted
      >
        <AgentRelayActivityControl projectId={projectId} sessionId={sessionId} embedded onSummaryChange={handleRelaySummary} />
      </UtilitySection>
    </>
  );
}
