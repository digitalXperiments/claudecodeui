import { ShieldAlert, ShieldCheck } from 'lucide-react';

import { botRuntimeApi } from '../../../../api/botRuntimeApi';
import { Chip, ErrorLine, Panel, SkeletonRows } from '../panel/Panel';
import { useRemote } from '../panel/useRemote';

import { describeEnforcement } from './ruleHelpers';

/** Whether the gate is enforced or only advisory for this bot's providers, and why. */
export default function EnforcementCard({ botId }: { botId: string }) {
  const { data, error, loading } = useRemote(() => botRuntimeApi.runtime.enforcement(botId), botId);
  const view = data ? describeEnforcement(data) : null;
  const enforced = view?.level === 'enforced';
  return (
    <Panel
      title="Enforcement"
      description="How firmly the action gate governs this bot. It depends on which provider runs each phase."
      tone={view && !enforced ? 'warn' : 'default'}
      actions={view ? (
        <Chip className={enforced ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' : 'bg-amber-500/10 text-amber-700 dark:text-amber-300'}>
          {enforced ? <ShieldCheck className="mr-1 h-3 w-3" aria-hidden="true" /> : <ShieldAlert className="mr-1 h-3 w-3" aria-hidden="true" />}
          {enforced ? 'Enforced' : 'Advisory'}
        </Chip>
      ) : null}
    >
      {loading && !view ? <SkeletonRows count={1} /> : null}
      <ErrorLine message={error} />
      {view ? (
        <div className="space-y-2 text-xs">
          <p className="font-medium">{view.headline}</p>
          {view.notes.map((note) => <p key={note} className="text-amber-800 dark:text-amber-200">{note}</p>)}
          <ul className="divide-y divide-border/50 rounded-lg border border-border/60">
            {view.phases.map((phase) => (
              <li key={phase.phase} className="flex flex-wrap items-start gap-2 px-3 py-2">
                <span className="w-16 shrink-0 font-medium capitalize">{phase.phase}</span>
                <Chip className={phase.level === 'enforced' ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' : 'bg-amber-500/10 text-amber-700 dark:text-amber-300'}>{phase.level}</Chip>
                <span className="min-w-0 flex-1 text-[11px] text-muted-foreground">{phase.explanation}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </Panel>
  );
}
