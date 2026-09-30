import { ArrowRight, Newspaper, RefreshCw, Send } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';

import { botRuntimeApi } from '../../api/botRuntimeApi';
import type { Bot } from '../../types';
import SegmentedControl from '../../ui/SegmentedControl';
import { botTabPath } from '../botStudioRoute';

import {
  BRIEF_PRESETS,
  DEFAULT_BRIEF_PRESET,
  botRows,
  briefSince,
  commitmentRows,
  costRows,
  describeSendResult,
  formatUsd,
  heldBackPings,
  learningGroups,
  summarizeBrief,
  titleLookup,
  type BriefPresetId,
} from './briefModel';
import { EmptyLine, ErrorBanner, LoadingLine, Pill, RuntimeCard, RuntimePage } from './RuntimePage';
import { errorText, useLoad } from './useLoad';

function BotLink({ botId, title, tab = 'overview', onOpen }: { botId: string; title: string; tab?: string; onOpen: (path: string) => void }) {
  return <button type="button" onClick={() => onOpen(botTabPath(botId, tab))} className="inline-flex max-w-full items-center gap-1 truncate rounded text-[11px] font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{title}<ArrowRight className="h-3 w-3 shrink-0" /></button>;
}

function Total({ label, value, tone }: { label: string; value: string; tone?: 'error' }) {
  return <div className="rounded-xl border border-border/70 bg-card p-3"><p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">{label}</p><p className={`mt-1 text-xl font-semibold tabular-nums ${tone === 'error' ? 'text-destructive' : ''}`}>{value}</p></div>;
}

export default function BriefView({ bots, onNavigate, onNotice }: {
  bots: Bot[];
  /** Navigate to an app path (deep link into a bot tab). */
  onNavigate: (path: string) => void;
  onNotice?: (message: string, tone: 'default' | 'error' | 'success') => void;
}) {
  const [preset, setPreset] = useState<BriefPresetId>(DEFAULT_BRIEF_PRESET);
  const [sending, setSending] = useState(false);
  const titleOf = useMemo(() => titleLookup(bots), [bots]);
  const fetchBrief = useCallback(() => botRuntimeApi.brief.get(briefSince(preset)), [preset]);
  const { data: brief, error, loading, reload } = useLoad(fetchBrief, preset);

  const rows = useMemo(() => (brief ? botRows(brief, titleOf) : []), [brief, titleOf]);
  const costs = useMemo(() => costRows(rows), [rows]);
  const learning = useMemo(() => (brief ? learningGroups(brief, titleOf) : []), [brief, titleOf]);
  const held = useMemo(() => (brief ? heldBackPings(brief) : []), [brief]);
  const commitments = useMemo(() => (brief ? commitmentRows(brief) : []), [brief]);
  const summary = useMemo(() => (brief ? summarizeBrief(brief) : null), [brief]);

  const send = async () => {
    setSending(true);
    try {
      const result = describeSendResult(await botRuntimeApi.brief.send(briefSince(preset)));
      onNotice?.(result.text, result.ok ? 'success' : 'error');
    } catch (caught) {
      onNotice?.(errorText(caught, 'Unable to send the brief.'), 'error');
    } finally {
      setSending(false);
    }
  };

  const actions = <>
    <SegmentedControl label="Brief window" value={preset} options={BRIEF_PRESETS.map((entry) => ({ value: entry.id, label: entry.label }))} onChange={setPreset} />
    <button type="button" className="button" onClick={() => void reload()} disabled={loading} aria-label="Refresh brief"><RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} /></button>
    <button type="button" className="button button-primary" onClick={() => void send()} disabled={sending} title="Delivers the brief on your configured channels, subject to their policies"><Send className="h-3.5 w-3.5" />{sending ? 'Sending…' : 'Send brief now'}</button>
  </>;

  return <RuntimePage icon={Newspaper} eyebrow="Bot runtime" title="Brief" description="What your bots did, what is waiting on you, and what was held back. Choose the window to look back over." actions={actions}>
    {error ? <ErrorBanner message={error} onRetry={() => void reload()} /> : null}
    {!brief && loading ? <LoadingLine label="Building your brief…" /> : null}
    {brief && summary ? <div className="space-y-4">
      <p className="text-[11px] text-muted-foreground">Since {new Date(brief.since).toLocaleString()} · generated {new Date(brief.generated_at).toLocaleTimeString()}</p>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Total label="Episodes" value={String(brief.totals.episodes)} />
        <Total label="Failed" value={String(brief.totals.failed)} tone={brief.totals.failed ? 'error' : undefined} />
        <Total label="Cost" value={formatUsd(brief.totals.cost_usd)} />
        <Total label="Needs you" value={String(summary.awaitingCount + summary.gateCount)} />
      </div>
      {summary.quiet ? <RuntimeCard title="All quiet" subtitle="Nothing to report in this window."><EmptyLine>No episodes, nothing waiting on you, and nothing held back.</EmptyLine></RuntimeCard> : null}

      <RuntimeCard title="Episodes by bot" subtitle="Bots with failures are listed first">
        {rows.length ? <ul className="divide-y divide-border/50">{rows.map((row) => <li key={row.botId} className={`px-4 py-3 ${row.hasFailures ? 'bg-destructive/5' : ''}`}>
          <div className="flex flex-wrap items-center gap-2">
            <BotLink botId={row.botId} title={row.title} tab="activity" onOpen={onNavigate} />
            <Pill>{row.count} episode{row.count === 1 ? '' : 's'}</Pill>
            <Pill tone="success">{row.succeeded} succeeded</Pill>
            {row.hasFailures ? <Pill tone="error">{row.failed} failed</Pill> : null}
          </div>
          {row.summaries.length ? <ul className="mt-1.5 space-y-0.5">{row.summaries.map((text, index) => <li key={index} className="truncate text-[11px] text-muted-foreground" title={text}>{text}</li>)}</ul> : null}
        </li>)}</ul> : <EmptyLine>No finished episodes in this window.</EmptyLine>}
      </RuntimeCard>

      <RuntimeCard title="Awaiting you" subtitle="Approvals and items in QA" tone={summary.awaitingCount ? 'warning' : 'default'}>
        {summary.awaitingCount ? <ul className="divide-y divide-border/50">
          {brief.awaiting_you.approvals.map((entry) => <li key={entry.interrupt_id} className="flex flex-wrap items-center gap-2 px-4 py-2.5"><Pill tone="warning">Approval</Pill><span className="min-w-0 flex-1 truncate text-xs" title={entry.title}>{entry.title}</span><BotLink botId={entry.bot_id} title={titleOf(entry.bot_id)} onOpen={onNavigate} /></li>)}
          {brief.awaiting_you.in_qa.map((entry) => <li key={entry.item_id} className="flex flex-wrap items-center gap-2 px-4 py-2.5"><Pill tone="info">In QA</Pill><span className="min-w-0 flex-1 truncate text-xs" title={entry.title}>{entry.title}</span><BotLink botId={entry.bot_id} title={titleOf(entry.bot_id)} onOpen={onNavigate} /></li>)}
        </ul> : <EmptyLine>Nothing is waiting on your approval.</EmptyLine>}
      </RuntimeCard>

      <RuntimeCard title="Gate asks waiting" subtitle="Actions a bot wants to take and is paused on" tone={summary.gateCount ? 'warning' : 'default'}>
        {summary.gateCount ? <ul className="divide-y divide-border/50">{brief.gate_decisions_awaiting.map((entry) => <li key={entry.decision_id} className="flex flex-wrap items-center gap-2 px-4 py-2.5">
          <Pill tone="warning">{entry.risk}</Pill>
          <span className="min-w-0 flex-1 truncate font-mono text-[11px]" title={`${entry.server}.${entry.tool}`}>{entry.server ? `${entry.server}.` : ''}{entry.tool}</span>
          <BotLink botId={entry.bot_id} title={titleOf(entry.bot_id)} tab="rules" onOpen={onNavigate} />
        </li>)}</ul> : <EmptyLine>No pending action-gate asks.</EmptyLine>}
      </RuntimeCard>

      <RuntimeCard title="Commitments due in 24 hours" subtitle="Things bots promised or are waiting on">
        {commitments.length ? <ul className="divide-y divide-border/50">{commitments.map((entry) => <li key={entry.commitment_id} className="flex flex-wrap items-center gap-2 px-4 py-2.5">
          <Pill tone={entry.due.overdue ? 'error' : 'default'}>{entry.due.label}</Pill>
          <span className="min-w-0 flex-1 truncate text-xs" title={entry.description}>{entry.description}{entry.waiting_on ? <span className="text-muted-foreground"> · waiting on {entry.waiting_on}</span> : null}</span>
          <BotLink botId={entry.bot_id} title={titleOf(entry.bot_id)} tab="goals" onOpen={onNavigate} />
        </li>)}</ul> : <EmptyLine>No commitments are due in the next 24 hours.</EmptyLine>}
      </RuntimeCard>

      <RuntimeCard title="Learning proposals pending" subtitle="Review them in each bot's Learning tab">
        {learning.length ? <ul className="divide-y divide-border/50">{learning.map((group) => <li key={group.botId} className="px-4 py-3">
          <div className="flex flex-wrap items-center gap-2"><BotLink botId={group.botId} title={group.title} tab="learning" onOpen={onNavigate} /><Pill>{group.proposals.length} pending</Pill></div>
          <ul className="mt-1.5 space-y-0.5">{group.proposals.map((proposal) => <li key={proposal.proposal_id} className="flex items-center gap-2 text-[11px] text-muted-foreground"><Pill>{proposal.kind.replace(/_/g, ' ')}</Pill><span className="min-w-0 flex-1 truncate" title={proposal.title}>{proposal.title}</span><span className="shrink-0 tabular-nums">{Math.round(proposal.confidence * 100)}%</span></li>)}</ul>
        </li>)}</ul> : <EmptyLine>No learning proposals are pending.</EmptyLine>}
      </RuntimeCard>

      <RuntimeCard title="Cost by bot" subtitle={`${formatUsd(brief.totals.cost_usd)} total`}>
        {costs.length ? <ul className="divide-y divide-border/50">{costs.map((row) => <li key={row.botId} className="px-4 py-2.5">
          <div className="flex items-center justify-between gap-2"><BotLink botId={row.botId} title={row.title} onOpen={onNavigate} /><span className="text-xs font-semibold tabular-nums">{formatUsd(row.costUsd)}</span></div>
          <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-muted" aria-hidden="true"><div className="h-full rounded-full bg-primary/60" style={{ width: `${Math.max(2, Math.round(row.costShare * 100))}%` }} /></div>
        </li>)}</ul> : <EmptyLine>No spend recorded in this window.</EmptyLine>}
      </RuntimeCard>

      <RuntimeCard title="Held back" subtitle="Pings suppressed by quiet hours or a digest policy">
        {held.length ? <ul className="divide-y divide-border/50">{held.map((entry, index) => <li key={`${entry.createdAt}-${index}`} className="flex flex-wrap items-center gap-2 px-4 py-2.5">
          <Pill>{entry.why}</Pill><Pill>{entry.channel}</Pill>
          <span className="min-w-0 flex-1 truncate text-xs" title={entry.title}>{entry.title || 'Notification'}</span>
          <span className="shrink-0 text-[10px] text-muted-foreground">{entry.botId ? titleOf(entry.botId) : 'All bots'} · {new Date(entry.createdAt).toLocaleTimeString()}</span>
        </li>)}</ul> : <EmptyLine>Nothing was held back.</EmptyLine>}
      </RuntimeCard>
    </div> : null}
  </RuntimePage>;
}
