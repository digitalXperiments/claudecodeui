import { useState } from 'react';
import { Brain, Check, Copy, Loader2, ShieldCheck, Sparkles, Target, Wand2, X, type LucideIcon } from 'lucide-react';

import type { BotProposal } from '../../../../types/botRuntime';
import StatusPill from '../../../../ui/StatusPill';
import { Chip, WarnLine } from '../panel/Panel';
import { relativeTime } from '../panel/time';
import { useCopy } from '../panel/useAsyncAction';

import {
  PROPOSAL_KIND_HINTS, PROPOSAL_KIND_LABELS, canEditProposalBody, confidencePercent, confidenceTone,
  evidenceRefs, proposalFloorWarning, ruleProposalSummary,
} from './learningHelpers';

const KIND_ICONS: Record<string, LucideIcon> = { memory: Brain, rule: ShieldCheck, new_skill: Sparkles, skill_patch: Wand2, goal: Target };
const CONFIDENCE_BARS = { high: 'bg-emerald-500', medium: 'bg-amber-500', low: 'bg-muted-foreground/50' } as const;
const EVIDENCE_LABELS = { episode: 'episode', decision: 'gate call', item: 'item', other: 'ref' } as const;

export default function ProposalCard({ proposal, now, busy, knownEpisodes, knownDecisions, onApprove, onReject }: {
  proposal: BotProposal;
  now: number;
  busy: boolean;
  knownEpisodes: string[];
  knownDecisions: string[];
  onApprove: (editedBody?: string) => void;
  onReject: () => void;
}) {
  const Icon = KIND_ICONS[proposal.kind] ?? Brain;
  const floorWarning = proposalFloorWarning(proposal);
  const ruleSummary = ruleProposalSummary(proposal);
  const editable = canEditProposalBody(proposal.kind);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(proposal.body);
  const { copied, copy } = useCopy();
  const pct = confidencePercent(proposal.confidence);
  const tone = confidenceTone(proposal.confidence);
  const refs = evidenceRefs(proposal.evidence, { episodes: knownEpisodes, decisions: knownDecisions });
  const pending = proposal.status === 'proposed';

  const approve = () => {
    if (floorWarning && !window.confirm(`${floorWarning}\n\nApprove this rule anyway?`)) return;
    onApprove(editing && draft.trim() !== proposal.body.trim() ? draft : undefined);
  };

  return (
    <li className={`rounded-xl border p-3 ${floorWarning && pending ? 'border-amber-500/40 bg-amber-500/5' : 'border-border/70 bg-card'}`}>
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary"><Icon className="h-4 w-4" aria-hidden="true" /></span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <Chip title={PROPOSAL_KIND_HINTS[proposal.kind]}>{PROPOSAL_KIND_LABELS[proposal.kind] ?? proposal.kind}</Chip>
            {!pending ? <StatusPill status={proposal.status} /> : null}
            <span className="text-[10px] text-muted-foreground">{relativeTime(proposal.created_at, now)}</span>
            <span className="ml-auto flex items-center gap-1.5 text-[10px] text-muted-foreground" title="How sure the reflector is">
              confidence {pct}%
              <span className="h-1.5 w-14 overflow-hidden rounded-full bg-muted" aria-hidden="true"><span className={`block h-full rounded-full ${CONFIDENCE_BARS[tone]}`} style={{ width: `${pct}%` }} /></span>
            </span>
          </div>
          <p className="mt-1.5 text-xs font-semibold">{proposal.title}</p>
          {ruleSummary ? <p className="mt-0.5 font-mono text-[11px] text-muted-foreground">{ruleSummary}</p> : null}
          {editing ? (
            <textarea aria-label="Edit proposal text" className="field mt-2 min-h-24 w-full text-xs" value={draft} onChange={(event) => setDraft(event.target.value)} />
          ) : proposal.body ? <p className="mt-1 whitespace-pre-wrap break-words text-[11px] leading-relaxed text-muted-foreground">{proposal.body}</p> : null}
          {floorWarning ? <div className="mt-2"><WarnLine strong>{floorWarning}</WarnLine></div> : null}
          {refs.length > 0 ? (
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <span className="text-[10px] text-muted-foreground">Evidence</span>
              {refs.slice(0, 12).map((ref) => (
                <button key={ref.id} type="button" onClick={() => void copy(ref.id)} title={`${EVIDENCE_LABELS[ref.kind]} ${ref.id} (click to copy)`} className="inline-flex items-center gap-1 rounded-full border border-border/70 bg-background px-2 py-0.5 font-mono text-[10px] text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  <span className="font-sans">{EVIDENCE_LABELS[ref.kind]}</span>{ref.short}
                  {copied === ref.id ? <Check className="h-2.5 w-2.5" /> : <Copy className="h-2.5 w-2.5 opacity-50" />}
                </button>
              ))}
              {refs.length > 12 ? <span className="text-[10px] text-muted-foreground">+{refs.length - 12} more</span> : null}
            </div>
          ) : null}
        </div>
      </div>
      {pending ? (
        <div className="mt-2 flex flex-wrap justify-end gap-1.5">
          {editable ? <button type="button" className="button min-h-8" disabled={busy} onClick={() => { setEditing((value) => !value); setDraft(proposal.body); }}>{editing ? 'Cancel edit' : 'Edit first'}</button> : null}
          <button type="button" className="button min-h-8 text-destructive hover:bg-destructive/10" disabled={busy} onClick={onReject}><X className="h-3.5 w-3.5" aria-hidden="true" />Reject</button>
          <button type="button" className={`button min-h-8 ${floorWarning ? 'border-destructive bg-destructive text-white hover:bg-destructive/90' : 'button-primary'}`} disabled={busy || (editing && !draft.trim())} onClick={approve}>
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" aria-hidden="true" />}
            {editing ? 'Approve with edits' : floorWarning ? 'Approve anyway' : 'Approve'}
          </button>
        </div>
      ) : null}
    </li>
  );
}
