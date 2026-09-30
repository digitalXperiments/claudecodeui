import { useEffect, useMemo, useState } from 'react';
import { Loader2, Plus, X } from 'lucide-react';

import { botRuntimeApi } from '../../../../api/botRuntimeApi';
import type { BotRisk, BotRiskPreview, BotRule, BotRuleArgPredicate, BotRuleScope } from '../../../../types/botRuntime';
import { Chip, ErrorLine, Field, WarnLine } from '../panel/Panel';
import { errorText } from '../panel/useAsyncAction';

import {
  ALL_RISKS, EXPIRY_CHOICES, RISK_DESCRIPTIONS, canClassifyTool, draftFromRule, emptyRuleDraft, floorCheck,
  riskTone, ruleInputFromDraft, rulePatchFromDraft, validateRuleDraft, type RuleDraft,
} from './ruleHelpers';

const OPS: Array<{ value: BotRuleArgPredicate['op']; label: string }> = [
  { value: 'eq', label: 'equals' },
  { value: 'contains', label: 'contains' },
  { value: 'regex', label: 'matches regex' },
  { value: 'in', label: 'is one of' },
];

/** Debounced GET /risk/classify for the server and tool typed so far. */
function useRiskPreview(server: string, tool: string): { preview: BotRiskPreview | null; error: string | null } {
  const [state, setState] = useState<{ preview: BotRiskPreview | null; error: string | null }>({ preview: null, error: null });
  useEffect(() => {
    if (!canClassifyTool(tool)) {
      setState({ preview: null, error: null });
      return undefined;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      botRuntimeApi.gate.classify(tool.trim(), server.trim())
        .then((preview) => { if (!cancelled) setState({ preview, error: null }); })
        .catch((caught: unknown) => { if (!cancelled) setState({ preview: null, error: errorText(caught, 'Could not classify the tool.') }); });
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [server, tool]);
  return state;
}

/** Create or edit a rule. Scope is fixed when editing. `botId` is the bot whose page this is. */
export default function RuleForm({ botId, rule, onSaved, onCancel }: {
  botId: string;
  rule: BotRule | null;
  onSaved: (rule: BotRule, warnings: string[]) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<RuleDraft>(() => (rule ? draftFromRule(rule) : emptyRuleDraft('bot')));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const change = (patch: Partial<RuleDraft>) => setDraft((current) => ({ ...current, ...patch }));
  const { preview, error: previewError } = useRiskPreview(draft.server, draft.tool);
  const problem = useMemo(() => validateRuleDraft(draft), [draft]);
  const floor = floorCheck({ scope: draft.scope, decision: draft.decision, risks: draft.risks, classifiedFloor: preview?.floor });

  const save = async () => {
    if (problem) {
      setError(problem);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const result = rule
        ? await botRuntimeApi.gate.updateRule(rule.rule_id, rulePatchFromDraft(draft, rule))
        : await botRuntimeApi.gate.createRule(ruleInputFromDraft(draft, draft.scope === 'bot' ? botId : null));
      onSaved(result.rule, result.warnings ?? []);
    } catch (caught) {
      setError(errorText(caught, 'Could not save the rule.'));
    } finally {
      setSaving(false);
    }
  };

  const toggleRisk = (risk: BotRisk) => change({ risks: draft.risks.includes(risk) ? draft.risks.filter((entry) => entry !== risk) : [...draft.risks, risk] });
  const setPredicate = (index: number, patch: Partial<RuleDraft['predicates'][number]>) =>
    change({ predicates: draft.predicates.map((entry, i) => (i === index ? { ...entry, ...patch } : entry)) });

  return (
    <form className="space-y-3 rounded-xl border border-primary/30 bg-card p-4" aria-label={rule ? 'Edit rule' : 'New rule'} onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <div className="grid gap-2 sm:grid-cols-3">
        <Field label="Applies to">
          <select aria-label="Rule scope" className="field h-9" value={draft.scope} disabled={Boolean(rule)} onChange={(event) => change({ scope: event.target.value as BotRuleScope })}>
            <option value="bot">This bot only</option>
            <option value="global">Every bot (global)</option>
          </select>
        </Field>
        <Field label="Decision">
          <select aria-label="Rule decision" className="field h-9" value={draft.decision} onChange={(event) => change({ decision: event.target.value as RuleDraft['decision'] })}>
            <option value="allow">Allow without asking</option>
            <option value="ask">Ask me first</option>
            <option value="deny">Deny</option>
          </select>
        </Field>
        <Field label="Expires">
          <select aria-label="Rule expiry" className="field h-9" value={draft.expiry} onChange={(event) => change({ expiry: event.target.value as RuleDraft['expiry'] })}>
            {rule?.expires_at ? <option value="keep">Keep current expiry</option> : null}
            {EXPIRY_CHOICES.map((choice) => <option key={choice.value} value={choice.value}>{choice.label}</option>)}
          </select>
        </Field>
      </div>

      <div className="grid gap-2 sm:grid-cols-2">
        <Field label="MCP server (optional)" hint="A name or a glob such as jira*. Empty = any server.">
          <input aria-label="Rule server" className="field h-9 font-mono text-xs" value={draft.server} onChange={(event) => change({ server: event.target.value })} />
        </Field>
        <Field label="Tool (optional)" hint="A name or glob such as send_*. Empty = any tool.">
          <input aria-label="Rule tool" className="field h-9 font-mono text-xs" value={draft.tool} onChange={(event) => change({ tool: event.target.value })} />
        </Field>
      </div>

      <div aria-live="polite" className="min-h-5 text-[11px]">
        {preview ? (
          <span className="flex flex-wrap items-center gap-1.5">
            <span className="text-muted-foreground">This tool is classified as</span>
            <Chip className={riskTone(preview.risk)}>{preview.risk}</Chip>
            {preview.floor ? <Chip className="bg-amber-500/10 text-amber-700 dark:text-amber-300">safety floor</Chip> : null}
            <span className="text-muted-foreground">Without a rule it would {preview.default_decision === 'ask' ? 'ask you' : 'run without asking'}.</span>
          </span>
        ) : previewError ? <span className="text-destructive">{previewError}</span> : <span className="text-muted-foreground">Type a concrete tool name to preview its risk.</span>}
      </div>

      <fieldset>
        <legend className="text-[11px] text-muted-foreground">Only when the call is classified as (optional)</legend>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {ALL_RISKS.map((risk) => (
            <button key={risk} type="button" aria-pressed={draft.risks.includes(risk)} title={RISK_DESCRIPTIONS[risk]} onClick={() => toggleRisk(risk)}
              className={`rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${draft.risks.includes(risk) ? 'border-primary/50 bg-primary/10 text-primary' : 'border-border/70 bg-background text-muted-foreground hover:text-foreground'}`}>
              {risk}
            </button>
          ))}
        </div>
      </fieldset>

      <div className="space-y-1.5">
        <div className="flex items-center justify-between gap-2">
          <p className="text-[11px] text-muted-foreground">Only when the arguments match (optional)</p>
          <button type="button" className="button min-h-8" onClick={() => change({ predicates: [...draft.predicates, { path: '', op: 'eq', value: '' }] })} disabled={draft.predicates.length >= 10}><Plus className="h-3.5 w-3.5" aria-hidden="true" />Add condition</button>
        </div>
        {draft.predicates.map((predicate, index) => (
          <div key={index} className="grid gap-1.5 sm:grid-cols-[1fr_9rem_1fr_auto]">
            <input aria-label={`Condition ${index + 1} argument path`} className="field h-9 font-mono text-xs" placeholder="to  or  options.channel" value={predicate.path} onChange={(event) => setPredicate(index, { path: event.target.value })} />
            <select aria-label={`Condition ${index + 1} operator`} className="field h-9" value={predicate.op} onChange={(event) => setPredicate(index, { op: event.target.value as BotRuleArgPredicate['op'] })}>
              {OPS.map((op) => <option key={op.value} value={op.value}>{op.label}</option>)}
            </select>
            <input aria-label={`Condition ${index + 1} value`} className="field h-9 font-mono text-xs" placeholder={predicate.op === 'in' ? 'a, b, c' : predicate.op === 'regex' ? '^.+@eyewa\\.com$' : 'value'} value={predicate.value} onChange={(event) => setPredicate(index, { value: event.target.value })} />
            <button type="button" className="icon-button" aria-label={`Remove condition ${index + 1}`} onClick={() => change({ predicates: draft.predicates.filter((_, i) => i !== index) })}><X className="h-4 w-4" /></button>
          </div>
        ))}
        {draft.predicates.length > 0 ? <p className="text-[10px] text-muted-foreground">Values are typed: 5 is a number, "5" (quoted) is text, true/false/null are literals. Every condition must match.</p> : null}
      </div>

      <div className="grid gap-2 sm:grid-cols-[8rem_1fr]">
        <Field label="Priority" hint="Higher wins.">
          <input aria-label="Rule priority" type="number" className="field h-9" placeholder="0" value={draft.priority} onChange={(event) => change({ priority: event.target.value })} />
        </Field>
        <Field label="Note (optional)">
          <input aria-label="Rule note" className="field h-9" maxLength={500} value={draft.note} onChange={(event) => change({ note: event.target.value })} />
        </Field>
      </div>

      <label className="flex items-start gap-2 text-xs">
        <input type="checkbox" className="mt-0.5" checked={draft.allowWhenTainted} onChange={(event) => change({ allowWhenTainted: event.target.checked })} />
        <span>Keep applying after the run read untrusted content<span className="block text-[10px] text-muted-foreground">Off by default: after reading an email or web page the bot's risky calls ask, even when a rule allows them.</span></span>
      </label>

      {floor.message ? <WarnLine strong={floor.level === 'warn' || floor.level === 'blocked'}>{floor.message}</WarnLine> : null}
      {error ? <ErrorLine message={error} /> : problem && floor.level !== 'blocked' ? <p className="text-[11px] text-muted-foreground">{problem}</p> : null}
      <div className="flex justify-end gap-2">
        <button type="button" className="button" onClick={onCancel} disabled={saving}>Cancel</button>
        <button type="submit" className={`button ${floor.level === 'warn' ? 'border-destructive bg-destructive text-white hover:bg-destructive/90' : 'button-primary'}`} disabled={saving || Boolean(problem)}>
          {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
          {floor.level === 'warn' ? 'I understand, save rule' : rule ? 'Save rule' : 'Create rule'}
        </button>
      </div>
    </form>
  );
}
