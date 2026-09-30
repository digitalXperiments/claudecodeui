import { useMemo, useState } from 'react';
import { Loader2, Sparkles } from 'lucide-react';

import { botRuntimeApi } from '../../../../api/botRuntimeApi';
import { upsertProposal } from '../../../../hooks/botRuntimeReducers';
import type { BotEpisode, BotGateDecisionView, BotProposal } from '../../../../types/botRuntime';
import SegmentedControl from '../../../../ui/SegmentedControl';
import { EmptyLine, ErrorLine, Panel, SkeletonRows } from '../panel/Panel';
import { useAsyncAction } from '../panel/useAsyncAction';

import ProposalCard from './ProposalCard';
import { PROPOSAL_TABS, proposalCounts, proposalsForTab, type ProposalTab } from './learningHelpers';

/** What the reflector suggests, grouped by decision. Approving applies it; nothing changes until you do. */
export default function ProposalsInbox({ botId, proposals, loading, loadError, episodes, decisions, now, patch, onChanged }: {
  botId: string;
  proposals: BotProposal[];
  loading: boolean;
  loadError: string | null;
  episodes: BotEpisode[];
  decisions: BotGateDecisionView[];
  now: number;
  patch: (update: (current: BotProposal[]) => BotProposal[]) => void;
  /** Called after an approval, which may have created rules, memories or skills. */
  onChanged: () => void;
}) {
  const [tab, setTab] = useState<ProposalTab>('proposed');
  const [notice, setNotice] = useState<string | null>(null);
  const action = useAsyncAction();
  const counts = useMemo(() => proposalCounts(proposals), [proposals]);
  const visible = useMemo(() => proposalsForTab(proposals, tab), [proposals, tab]);
  const knownEpisodes = useMemo(() => episodes.map((episode) => episode.episode_id), [episodes]);
  const knownDecisions = useMemo(() => decisions.map((decision) => decision.decision_id), [decisions]);

  const reflect = async () => {
    setNotice(null);
    await action.run('reflect', async () => {
      const created = await botRuntimeApi.learning.reflect(botId);
      patch((current) => created.reduce((list, proposal) => upsertProposal(list, proposal), current));
      setNotice(created.length ? `The reflector suggested ${created.length} change${created.length === 1 ? '' : 's'}.` : 'Nothing new to suggest from recent activity.');
      setTab('proposed');
    });
  };

  const decide = (proposal: BotProposal, approve: boolean, editedBody?: string) => void action.run(proposal.proposal_id, async () => {
    const next = approve ? await botRuntimeApi.learning.approve(botId, proposal.proposal_id, editedBody) : await botRuntimeApi.learning.reject(botId, proposal.proposal_id);
    patch((current) => upsertProposal(current, next));
    if (approve) onChanged();
  });

  return (
    <Panel
      title="Proposals"
      description="Suggested memories, rules and skills drawn from what you approved, dismissed and sent back."
      actions={<button type="button" className="button min-h-8" onClick={() => void reflect()} disabled={action.isBusy('reflect')} title="Runs the reflector over recent activity. It calls a model, so it can take a moment.">{action.isBusy('reflect') ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />}Reflect now</button>}
    >
      <div className="space-y-3">
        <SegmentedControl label="Proposal status" value={tab} onChange={setTab} options={PROPOSAL_TABS.map((entry) => ({ value: entry.value, label: entry.label, count: counts[entry.value] }))} />
        <ErrorLine message={action.error} />
        {notice ? <p role="status" className="text-xs text-muted-foreground">{notice}</p> : null}
        {loading && proposals.length === 0 ? <SkeletonRows /> : null}
        {loadError && proposals.length === 0 ? <ErrorLine message={loadError} /> : null}
        {!loading && visible.length === 0 ? <EmptyLine>{tab === 'proposed' ? 'Nothing waiting. Use Reflect now to look for patterns in recent activity.' : `No ${tab} proposals.`}</EmptyLine> : null}
        {visible.length > 0 ? (
          <ul className="space-y-2">
            {visible.map((proposal) => (
              <ProposalCard
                key={proposal.proposal_id}
                proposal={proposal}
                now={now}
                busy={action.isBusy(proposal.proposal_id)}
                knownEpisodes={knownEpisodes}
                knownDecisions={knownDecisions}
                onApprove={(editedBody) => decide(proposal, true, editedBody)}
                onReject={() => decide(proposal, false)}
              />
            ))}
          </ul>
        ) : null}
      </div>
    </Panel>
  );
}
