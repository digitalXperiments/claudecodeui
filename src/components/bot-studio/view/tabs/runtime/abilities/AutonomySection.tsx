import { Check, ShieldAlert, ShieldCheck } from 'lucide-react';
import { useState } from 'react';

import { botRuntimeApi } from '../../../../api/botRuntimeApi';
import { normalizeAutonomy, type BotAbilities, type BotAutonomy } from '../../../../types/botRuntime';
import { cn } from '../../../../../../lib/utils';
import { ErrorLine, SkeletonRows, WarnLine } from '../panel/Panel';
import { useAsyncAction } from '../panel/useAsyncAction';

import AbilityCard from './AbilityCard';
import AutonomyPicker from './AutonomyPicker';
import { autonomyChoice, enforcementLine, permissionModeReason, permissionModeWords, plainSections, type PlainSection } from './abilitiesModel';

const LIST_TONES: Record<PlainSection['tone'], { box: string; dot: string }> = {
  ok: { box: 'border-emerald-500/25 bg-emerald-500/[0.05]', dot: 'bg-emerald-500' },
  ask: { box: 'border-amber-500/30 bg-amber-500/[0.06]', dot: 'bg-amber-500' },
  never: { box: 'border-red-500/25 bg-red-500/[0.05]', dot: 'bg-red-500' },
};

export function PlainLists({ plain }: { plain: unknown }) {
  return (
    <div className="grid gap-3 md:grid-cols-3">
      {plainSections(plain).map((section) => (
        <div key={section.key} className={cn('rounded-xl border p-3', LIST_TONES[section.tone].box)}>
          <p className="text-xs font-semibold text-foreground">{section.title}</p>
          {section.items.length ? (
            <ul className="mt-2 space-y-1.5">
              {section.items.map((item) => (
                <li key={item} className="flex items-start gap-2 text-[11px] leading-relaxed text-muted-foreground"><span className={cn('mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full', LIST_TONES[section.tone].dot)} aria-hidden="true" />{item}</li>
              ))}
            </ul>
          ) : <p className="mt-2 text-[11px] text-muted-foreground">{section.empty}</p>}
        </div>
      ))}
    </div>
  );
}

/** Section 1: the autonomy picker, what it means right now, and how firmly the gate holds. */
export default function AutonomySection({ botId, abilities, permissionMode, onChanged, onOpenPipeline }: {
  botId: string;
  abilities: BotAbilities | null;
  permissionMode: string;
  onChanged: () => void;
  onOpenPipeline: () => void;
}) {
  const action = useAsyncAction();
  const [saved, setSaved] = useState<string | null>(null);
  const change = async (next: BotAutonomy) => {
    setSaved(null);
    let message: string | undefined;
    const ok = await action.run('autonomy', async () => { message = (await botRuntimeApi.runtime.changeAutonomy(botId, next)).message; });
    if (ok) { setSaved(message || `Saved. This bot is now ${autonomyChoice(next).label}.`); onChanged(); }
  };
  const level = abilities?.enforcement.level ?? null;
  const enforced = level === 'enforced';
  const autonomy = normalizeAutonomy(abilities?.autonomy);
  const reason = abilities ? permissionModeReason(autonomy, level, abilities.provider) : null;
  return (
    <AbilityCard id="autonomy" number={1} title="How much it can do alone" description="Pick how far this bot may go before it has to stop and ask you. You can change this at any time.">
      {!abilities ? <SkeletonRows count={2} /> : (
        <>
          <AutonomyPicker value={autonomy} onChange={(next) => void change(next)} disabled={action.busy} />
          <ErrorLine message={action.error} />
          {saved ? <p role="status" className="flex items-center gap-1.5 text-[11px] text-emerald-700 dark:text-emerald-300"><Check className="h-3.5 w-3.5" aria-hidden="true" />{saved}</p> : null}
          <div>
            <p className="mb-2 text-xs font-semibold">What that means for this bot right now</p>
            <PlainLists plain={abilities.plain} />
          </div>
          <p className={cn('flex items-start gap-2 rounded-lg px-3 py-2 text-xs', enforced ? 'bg-emerald-500/10 text-emerald-800 dark:text-emerald-200' : 'bg-amber-500/10 text-amber-800 dark:text-amber-200')} role="status">
            {enforced ? <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" /> : <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />}
            <span>{enforcementLine(abilities.provider, level)}{abilities.enforcement.detail ? <span className="mt-0.5 block text-[10px] opacity-80">{abilities.enforcement.detail}</span> : null}</span>
          </p>
          {reason ? (
            <WarnLine strong={autonomy === 'bypass'}>
              {reason} Right now the provider setting is <strong>{permissionMode || 'default'}</strong>: {permissionModeWords(permissionMode)}{' '}
              <button type="button" className="underline" onClick={onOpenPipeline}>Change it on the Pipeline tab</button>.
            </WarnLine>
          ) : null}
        </>
      )}
    </AbilityCard>
  );
}
