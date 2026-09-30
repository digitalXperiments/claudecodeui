import { useMemo } from 'react';

import type { McSection } from '../../../../mission-control/api/missionControlApi';
import { useBotRuntime } from '../../../hooks/useBotRuntime';

import BudgetCard from './rules/BudgetCard';
import CredentialsCard from './rules/CredentialsCard';
import EnforcementCard from './rules/EnforcementCard';
import FailoverCard from './rules/FailoverCard';
import GateLog from './rules/GateLog';
import RulesPanel from './rules/RulesPanel';
import SafetyFloorCard from './rules/SafetyFloorCard';
import { useNow } from './panel/useNow';

const SECTIONS = ['gateDecisions' as const, 'budget' as const];

/** What this bot may do on its own: enforcement, the safety floor, rules, decisions, budget, credentials and failover. */
export function RulesTab({ botId, section }: { botId: string; section: McSection }) {
  const runtime = useBotRuntime(botId, { sections: SECTIONS });
  const now = useNow();
  const serverSuggestions = useMemo(() => [...new Set([...(section.produce_tools ?? []), ...(section.resolve_tools ?? [])])], [section.produce_tools, section.resolve_tools]);

  return (
    <div className="bot-studio-controls max-w-4xl space-y-5 overflow-y-auto p-4 sm:p-6">
      <div>
        <h2 className="text-sm font-semibold">Rules and limits</h2>
        <p className="mt-1 text-xs text-muted-foreground">Decide what this bot can do without asking, what it can spend, and which accounts it uses.</p>
      </div>
      <EnforcementCard botId={botId} />
      <SafetyFloorCard />
      <RulesPanel botId={botId} now={now} />
      <GateLog botId={botId} live={runtime.gateDecisions} now={now} />
      <BudgetCard botId={botId} status={runtime.budget} loading={runtime.isLoading('budget')} loadError={runtime.error('budget')} onSaved={() => void runtime.refresh('budget')} />
      <CredentialsCard botId={botId} serverSuggestions={serverSuggestions} now={now} />
      <FailoverCard botId={botId} primary={section.provider} />
    </div>
  );
}
