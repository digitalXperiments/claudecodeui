import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { RefreshCw } from 'lucide-react';

import { botRuntimeApi } from '../../../../api/botRuntimeApi';
import type { BotGateDecisionFilter, BotGateDecisionView, BotGateOutcome, BotRuleDecision } from '../../../../types/botRuntime';
import { Chip, EmptyLine, ErrorLine, Panel, SkeletonRows } from '../panel/Panel';
import { relativeTime, shortDateTime } from '../panel/time';
import { useRemote } from '../panel/useRemote';

import { decidedByLabel, decisionTone, isPendingAsk, outcomeLabel, riskTone } from './ruleHelpers';

const OUTCOMES: Array<BotGateOutcome | 'pending'> = ['pending', 'executed', 'approved', 'rejected', 'denied', 'expired', 'error'];

/**
 * Recent gate decisions with filters. `live` is the section kept fresh by websocket events; when no
 * filter is set it is shown as is, otherwise the filtered query reruns whenever `live` changes.
 */
export default function GateLog({ botId, live, now }: { botId: string; live: BotGateDecisionView[]; now: number }) {
  const [decision, setDecision] = useState<BotRuleDecision | ''>('');
  const [outcome, setOutcome] = useState<BotGateOutcome | 'pending' | ''>('');
  const filtered = Boolean(decision || outcome);
  const filter: BotGateDecisionFilter = useMemo(() => ({ limit: 100, ...(decision ? { decision } : {}), ...(outcome ? { outcome } : {}) }), [decision, outcome]);
  const remote = useRemote(() => botRuntimeApi.gate.decisions(botId, filter), `${botId}|${decision}|${outcome}`, { enabled: filtered });
  const { reload } = remote;
  useEffect(() => {
    if (filtered) void reload();
  }, [live, filtered, reload]);
  const rows = filtered ? remote.data ?? [] : live;
  const pending = rows.filter(isPendingAsk);

  return (
    <Panel
      title="Gate decisions"
      description="Every gated tool call this bot made, what the gate decided and why."
      actions={(
        <>
          <select aria-label="Filter by decision" className="field h-8 w-auto py-0 text-xs" value={decision} onChange={(event) => setDecision(event.target.value as BotRuleDecision | '')}>
            <option value="">Any decision</option>
            <option value="allow">Allow</option>
            <option value="ask">Ask</option>
            <option value="deny">Deny</option>
          </select>
          <select aria-label="Filter by outcome" className="field h-8 w-auto py-0 text-xs" value={outcome} onChange={(event) => setOutcome(event.target.value as BotGateOutcome | 'pending' | '')}>
            <option value="">Any outcome</option>
            {OUTCOMES.map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
          {filtered ? <button type="button" className="button min-h-8" onClick={() => void reload()} aria-label="Refresh decisions"><RefreshCw className="h-3.5 w-3.5" aria-hidden="true" /></button> : null}
        </>
      )}
    >
      {pending.length > 0 ? (
        <p role="status" className="mb-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">
          {pending.length} call{pending.length === 1 ? ' is' : 's are'} waiting for your approval. Approve from Needs you in the sidebar, or see <Link to="/bots/brief" className="font-medium underline">Awaiting you in the brief</Link>.
        </p>
      ) : null}
      {filtered && remote.loading && !remote.data ? <SkeletonRows count={2} /> : null}
      <ErrorLine message={filtered ? remote.error : null} />
      {rows.length === 0 && !(filtered && remote.loading) ? <EmptyLine>{filtered ? 'No decisions match these filters.' : 'No gated tool calls yet.'}</EmptyLine> : null}
      {rows.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[40rem] text-left text-xs">
            <thead className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
              <tr><th className="py-1.5 pr-3 font-medium">Time</th><th className="pr-3 font-medium">Tool</th><th className="pr-3 font-medium">Risk</th><th className="pr-3 font-medium">Decision</th><th className="pr-3 font-medium">Decided by</th><th className="pr-3 font-medium">Outcome</th></tr>
            </thead>
            <tbody className="divide-y divide-border/50 align-top">
              {rows.map((row) => (
                <tr key={row.decision_id} className={isPendingAsk(row) ? 'bg-amber-500/5' : undefined}>
                  <td className="whitespace-nowrap py-2 pr-3 text-muted-foreground" title={shortDateTime(row.created_at)}>{relativeTime(row.created_at, now)}</td>
                  <td className="max-w-64 py-2 pr-3">
                    <span className="block truncate font-mono text-[11px] font-medium" title={`${row.server}.${row.tool}`}>{row.server ? `${row.server}.` : ''}{row.tool}</span>
                    {row.args_summary ? <span className="block truncate font-mono text-[10px] text-muted-foreground" title={row.args_summary}>{row.args_summary}</span> : null}
                    {row.reason ? <span className="block text-[10px] text-muted-foreground">{row.reason}</span> : null}
                  </td>
                  <td className="py-2 pr-3"><Chip className={riskTone(row.risk)}>{row.risk}</Chip></td>
                  <td className="py-2 pr-3"><Chip className={decisionTone(row.decision)}>{row.decision}</Chip></td>
                  <td className="py-2 pr-3 text-muted-foreground">{decidedByLabel(row.decided_by)}</td>
                  <td className="py-2 pr-3 capitalize">{outcomeLabel(row)}{row.interrupt_id && isPendingAsk(row) ? <span className="block font-mono text-[10px] normal-case text-muted-foreground" title="Interrupt id">{row.interrupt_id.slice(0, 8)}</span> : null}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </Panel>
  );
}
