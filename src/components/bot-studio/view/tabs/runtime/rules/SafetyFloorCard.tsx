import { Lock } from 'lucide-react';

import { BOT_SAFETY_FLOOR } from '../../../../types/botRuntime';
import { Chip, Panel } from '../panel/Panel';

import { RISK_DESCRIPTIONS, riskTone } from './ruleHelpers';

/** Static explainer for the safety floor. */
export default function SafetyFloorCard() {
  return (
    <Panel
      title="Safety floor"
      description="Some actions always ask you first, unless you explicitly loosen them for one bot. Everything else follows your rules, then the defaults."
    >
      <ul className="grid gap-2 sm:grid-cols-2">
        {BOT_SAFETY_FLOOR.map((risk) => (
          <li key={risk} className="flex items-start gap-2 rounded-lg border border-border/60 bg-background px-3 py-2">
            <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600" aria-hidden="true" />
            <span className="min-w-0 text-xs">
              <Chip className={riskTone(risk)}>{risk}</Chip>
              <span className="mt-0.5 block text-[11px] text-muted-foreground">{RISK_DESCRIPTIONS[risk]} Asks by default.</span>
            </span>
          </li>
        ))}
      </ul>
      <ul className="mt-3 list-inside list-disc space-y-1 text-[11px] text-muted-foreground">
        <li>A global "allow" rule can never cover these; only a rule scoped to one bot can.</li>
        <li>If the bot has read untrusted content (email, web, webhooks) this run, risky calls ask even when a rule allows them, unless the rule says otherwise.</li>
        <li>Reads and drafts are allowed by default; unclassified tools ask.</li>
      </ul>
    </Panel>
  );
}
