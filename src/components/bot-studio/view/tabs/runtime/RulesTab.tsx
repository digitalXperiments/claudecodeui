import type { McSection } from '../../../../mission-control/api/missionControlApi';
import type { DetailFocus, DetailTab } from '../../detail/detailTabs';
import { useBotRuntime } from '../../../hooks/useBotRuntime';

import BudgetCard from './rules/BudgetCard';
import EnforcementCard from './rules/EnforcementCard';
import FailoverCard from './rules/FailoverCard';
import GateLog from './rules/GateLog';
import RulesPanel from './rules/RulesPanel';
import SafetyFloorCard from './rules/SafetyFloorCard';
import { useNow } from './panel/useNow';

const SECTIONS = ['gateDecisions' as const, 'budget' as const];

/** What this bot may do on its own: enforcement, the safety floor, rules, decisions, budget, credentials and failover. */
export function RulesTab({ botId, section, onOpenTab }: { botId: string; section: McSection; onOpenTab?: (tab: DetailTab, focus?: DetailFocus) => void }) {
  const runtime = useBotRuntime(botId, { sections: SECTIONS });
  const now = useNow();

  return (
    <div className="bot-studio-controls max-w-4xl space-y-5 overflow-y-auto p-4 sm:p-6">
      <div>
        <h2 className="text-sm font-semibold">Rules and limits</h2>
        <p className="mt-1 text-xs text-muted-foreground">Fine-tune single actions, and set what this bot can spend. The big choices, how much it may do alone, which apps it can use and its logins, are on the Abilities tab.</p>
        <button type="button" className="button mt-2" onClick={() => onOpenTab?.('abilities', 'autonomy')}>Open Abilities</button>
      </div>
      <EnforcementCard botId={botId} />
      <SafetyFloorCard />
      <RulesPanel botId={botId} now={now} />
      <GateLog botId={botId} live={runtime.gateDecisions} now={now} />
      <BudgetCard botId={botId} status={runtime.budget} loading={runtime.isLoading('budget')} loadError={runtime.error('budget')} onSaved={() => void runtime.refresh('budget')} />
      <p className="rounded-xl border border-border/70 bg-card p-4 text-[11px] text-muted-foreground">Logins and keys for this bot moved to <button type="button" className="underline hover:text-foreground" onClick={() => onOpenTab?.('abilities', 'accounts')}>Abilities → Accounts &amp; logins</button>.</p>
      <FailoverCard botId={botId} primary={section.provider} />
    </div>
  );
}
