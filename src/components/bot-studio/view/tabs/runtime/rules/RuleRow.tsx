import { Pencil, Trash2 } from 'lucide-react';

import type { BotRule } from '../../../../types/botRuntime';
import { Chip } from '../panel/Panel';
import { expiryCountdown } from '../panel/time';

import { createdFromLabel, decisionTone, isFloorRisk, riskTone, summarizeRuleMatch } from './ruleHelpers';

export default function RuleRow({ rule, now, busy, onEdit, onDelete }: { rule: BotRule; now: number; busy: boolean; onEdit: () => void; onDelete: () => void }) {
  const summary = summarizeRuleMatch(rule.match);
  const expiry = expiryCountdown(rule.expires_at, now);
  return (
    <li className={`rounded-xl border border-border/70 bg-card p-3 ${expiry.expired ? 'opacity-60' : ''}`}>
      <div className="flex flex-wrap items-center gap-1.5">
        <Chip className={decisionTone(rule.decision)}>{rule.decision}</Chip>
        <span className="min-w-0 break-all font-mono text-[11px] font-medium">{summary.target}</span>
        <Chip className={rule.scope === 'global' ? 'bg-sky-500/10 text-sky-700 dark:text-sky-300' : undefined} title={rule.scope === 'global' ? 'Applies to every bot' : 'Applies to this bot only'}>
          {rule.scope === 'global' ? 'Global' : 'This bot'}
        </Chip>
        {summary.matchesEverything ? <Chip className="bg-amber-500/10 text-amber-700 dark:text-amber-300" title="No filters: matches every tool call">matches everything</Chip> : null}
      </div>
      {summary.risks.length > 0 || summary.predicates.length > 0 || summary.allowWhenTainted ? (
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          {summary.risks.map((risk) => <Chip key={risk} className={riskTone(risk)} title={isFloorRisk(risk) ? 'Safety-floor risk' : undefined}>risk · {risk}</Chip>)}
          {summary.predicates.map((predicate) => <code key={predicate} className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px]">{predicate}</code>)}
          {summary.allowWhenTainted ? <Chip className="bg-violet-500/10 text-violet-700 dark:text-violet-300" title="The rule still applies after the run read untrusted content">even after untrusted input</Chip> : null}
        </div>
      ) : null}
      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-muted-foreground">
        <span>{createdFromLabel(rule.created_from)}</span>
        {rule.priority ? <span>priority {rule.priority}</span> : null}
        <span className={expiry.soon ? 'font-medium text-amber-700 dark:text-amber-300' : ''}>{expiry.label}</span>
        {rule.note ? <span className="min-w-0 break-words italic">{rule.note}</span> : null}
      </div>
      <div className="mt-2 flex justify-end gap-1.5">
        <button type="button" className="button min-h-8" onClick={onEdit} disabled={busy}><Pencil className="h-3.5 w-3.5" aria-hidden="true" />Edit</button>
        <button type="button" className="button min-h-8 text-destructive hover:bg-destructive/10" onClick={onDelete} disabled={busy} aria-label={`Delete ${rule.decision} rule for ${summary.target}`}><Trash2 className="h-3.5 w-3.5" aria-hidden="true" />Delete</button>
      </div>
    </li>
  );
}
