import { Loader2, Lock } from 'lucide-react';

import { BOT_SAFETY_FLOOR } from '../types/botRuntime';
import { RISK_DESCRIPTIONS, floorCheck } from '../view/tabs/runtime/rules/ruleHelpers';

import EnforcementNotice, { type EnforcementState } from './EnforcementNotice';
import { useToolRisks } from './hooks';
import { Callout, FieldLabel, SwitchRow } from './parts';
import type { RuntimeDraft } from './runtimeDraft';
import { describeAllowChoice, floorItemsByServer, isAllowed, toggleAllow } from './toolRisk';

const PERMISSION_MODE_WORDS: Record<string, string> = {
  default: 'The provider asks before acting where it can.',
  acceptEdits: 'File edits are accepted without asking; other actions still ask.',
  bypassPermissions: "The provider's own permission prompts are skipped, because a bot has nobody to answer them.",
  plan: 'Read-only: the agent plans but changes nothing.',
};

/**
 * Guardrails for the runtime v2 wizard: the safety floor, enforcement, what the bot may do without
 * asking, a spending budget and the dry-run recommendation. Create-only parts (`configurable`)
 * are inputs; when editing, the rules and budget live on the bot's own tabs.
 */
export default function GuardrailsPanel({ provider, enforcement, servers, runtime, onChange, dryRun, onDryRun, permissionMode, configurable }: {
  provider: string;
  enforcement: EnforcementState;
  servers: string[];
  runtime: RuntimeDraft;
  onChange: (patch: Partial<RuntimeDraft>) => void;
  dryRun: boolean;
  onDryRun: (next: boolean) => void;
  permissionMode: string;
  /** Create flow: rules and budget are collected here. Edit flow: they are managed on the Rules tab. */
  configurable: boolean;
}) {
  const risks = useToolRisks(servers, configurable);
  const groups = floorItemsByServer(risks.items);
  const { allow } = runtime.rules;
  const budget = runtime.budget;
  const setBudget = (patch: Partial<RuntimeDraft['budget']['draft']>) => onChange({ budget: { ...budget, draft: { ...budget.draft, ...patch } } });
  const loosened = allow.length > 0
    ? floorCheck({ scope: 'bot', decision: 'allow', risks: Array.from(new Set(allow.map((choice) => choice.risk))) }).message
    : null;

  return (
    <div className="space-y-5">
      <div className="rounded-xl border border-border/60 p-4">
        <p className="text-xs font-semibold text-foreground">The safety floor</p>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">These actions always ask you first, no matter what a rule or the model says, unless you allow them for this one bot below. Everything else follows your rules, then sensible defaults (reads and drafts go ahead; unclassified tools ask).</p>
        <ul className="mt-3 grid gap-2 sm:grid-cols-2">
          {BOT_SAFETY_FLOOR.map((risk) => (
            <li key={risk} className="flex items-start gap-2 rounded-lg border border-border/50 bg-background px-3 py-2 text-[11px]">
              <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600" aria-hidden="true" />
              <span><span className="font-medium text-foreground">{risk.replace('_', ' ')}</span><span className="block text-muted-foreground">{RISK_DESCRIPTIONS[risk]}</span></span>
            </li>
          ))}
        </ul>
      </div>

      <EnforcementNotice provider={provider} state={enforcement} />

      {configurable ? (
        <section className="space-y-3" aria-labelledby="architect-rules-heading">
          <div>
            <h3 id="architect-rules-heading" className="text-sm font-semibold text-foreground">What may this bot do without asking?</h3>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">Nothing is allowed by default. Each choice below becomes a rule for this bot only; you can change or remove it later on the Rules tab.</p>
          </div>
          <SwitchRow title="Never allow deleting" description="A rule that denies anything classified as delete, even if you approve other things later." checked={runtime.rules.neverDelete} onChange={(neverDelete) => onChange({ rules: { ...runtime.rules, neverDelete } })} />
          <SwitchRow title="Never allow purchases" description="A rule that denies anything that spends money." checked={runtime.rules.neverPurchase} onChange={(neverPurchase) => onChange({ rules: { ...runtime.rules, neverPurchase } })} />

          {servers.length === 0 ? <Callout>Attach MCP servers in the Tools step and the actions each one can take will appear here, so you can allow specific ones without asking.</Callout> : null}
          {risks.loading ? <p className="flex items-center gap-2 text-xs text-muted-foreground" role="status"><Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />Checking what the attached tools can do…</p> : null}
          {Object.entries(risks.errors).map(([server, message]) => <p key={server} role="alert" className="text-xs text-amber-700 dark:text-amber-300">{server}: {message} Its actions will simply ask.</p>)}
          {servers.length > 0 && !risks.loading && groups.length === 0 ? <Callout tone="ok">None of the attached tools can send, publish, delete, buy or change production, so there is nothing to approve in advance.</Callout> : null}

          {groups.map((group) => (
            <fieldset key={group.server} className="rounded-xl border border-border/60 p-3">
              <legend className="px-1 text-[11px] font-semibold text-foreground">{group.server.replace(/^claude\.ai\s+/i, '')}: these ask first</legend>
              <div className="space-y-1.5">
                {group.items.map((item) => (
                  <label key={item.tool} className="flex items-start gap-2 rounded-lg px-2 py-1.5 text-xs hover:bg-muted/40">
                    <input type="checkbox" className="mt-0.5" checked={isAllowed(allow, item.server, item.tool)} onChange={(event) => onChange({ rules: { ...runtime.rules, allow: toggleAllow(allow, item, event.target.checked) } })} />
                    <span className="min-w-0"><span className="font-medium text-foreground">Allow {describeAllowChoice(item)} without asking</span>{item.description ? <span className="block truncate text-[10px] text-muted-foreground">{item.description}</span> : null}</span>
                  </label>
                ))}
              </div>
            </fieldset>
          ))}
          {loosened ? <p role="alert" className="rounded-xl border border-amber-500/30 bg-amber-500/[0.08] px-3 py-2 text-xs text-amber-800 dark:text-amber-200">{loosened}</p> : null}
        </section>
      ) : (
        <Callout>Rules and budget for an existing bot are managed on its Rules tab.</Callout>
      )}

      {configurable ? (
        <section className="space-y-3 rounded-xl border border-border/60 p-4" aria-labelledby="architect-budget-heading">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h3 id="architect-budget-heading" className="text-sm font-semibold text-foreground">Budget</h3>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">Caps on what this bot can spend and how often it wakes. Near a limit it can be moved to a cheaper model; at the limit it stops waking until the limit resets. Leave a box empty for no limit.</p>
            </div>
            <button type="button" role="switch" aria-checked={budget.enabled} aria-label="Set a budget" className={`toggle ${budget.enabled ? 'toggle-on' : ''}`} onClick={() => onChange({ budget: { ...budget, enabled: !budget.enabled } })}><span /></button>
          </div>
          {budget.enabled ? (
            <div className="grid gap-3 sm:grid-cols-3">
              <div><FieldLabel>Per day ($)</FieldLabel><input className="field" type="number" min="0" step="any" inputMode="decimal" aria-label="Daily spend limit in dollars" value={budget.draft.dailyUsd} placeholder="No limit" onChange={(event) => setBudget({ dailyUsd: event.target.value })} /></div>
              <div><FieldLabel>Per month ($)</FieldLabel><input className="field" type="number" min="0" step="any" inputMode="decimal" aria-label="Monthly spend limit in dollars" value={budget.draft.monthlyUsd} placeholder="No limit" onChange={(event) => setBudget({ monthlyUsd: event.target.value })} /></div>
              <div><FieldLabel>Wake-ups per hour</FieldLabel><input className="field" type="number" min="0" step="1" inputMode="numeric" aria-label="Maximum wake-ups per hour" value={budget.draft.maxWakes} placeholder="No limit" onChange={(event) => setBudget({ maxWakes: event.target.value })} /></div>
            </div>
          ) : <p className="text-xs text-amber-700 dark:text-amber-300">Without a budget a noisy trigger can run the bot, and spend, as often as it fires.</p>}
        </section>
      ) : null}

      <SwitchRow
        title="Start with a dry run (recommended)"
        description="Wake-ups create items for you to review, but approving them resolves nothing and starts no work. Run a few, then switch it off when the results look right."
        checked={dryRun}
        onChange={onDryRun}
      />

      <div className="rounded-xl border border-border/60 bg-muted/20 p-4">
        <p className="text-xs font-semibold text-foreground">Provider permission mode</p>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{PERMISSION_MODE_WORDS[permissionMode] ?? `Set to ${permissionMode}.`} With runtime v2 the action gate, not this setting, decides which tools can run, so this only matters where the gate can merely advise (see above). Change it in the Agent step.</p>
      </div>
    </div>
  );
}
