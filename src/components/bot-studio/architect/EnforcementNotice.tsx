import { Loader2, ShieldAlert, ShieldCheck } from 'lucide-react';

import type { BotEnforcementPreview } from '../types/botRuntime';

import { enforcementCopy } from './enforcement';

export type EnforcementState = { data: BotEnforcementPreview | null; loading: boolean; error: string | null };

/** How firmly the action gate would govern a bot on this provider, in plain words. */
export default function EnforcementNotice({ provider, state }: { provider: string; state: EnforcementState }) {
  const { data, loading, error } = state;
  if (!data) {
    return (
      <div className="rounded-xl border border-border/60 bg-muted/20 p-4 text-xs text-muted-foreground" role="status" aria-live="polite">
        {loading ? <span className="inline-flex items-center gap-2"><Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />Checking how firmly the action gate covers {provider}…</span> : null}
        {!loading && error ? `Could not check enforcement for ${provider} (${error}). You can see it on the bot's Rules tab after you create it.` : null}
      </div>
    );
  }
  const copy = enforcementCopy(provider, data.level);
  const enforced = data.level === 'enforced';
  const off = data.level === 'off';
  return (
    <div className={`rounded-xl border p-4 ${enforced ? 'border-emerald-500/25 bg-emerald-500/[0.07]' : off ? 'border-red-500/40 bg-red-500/[0.08]' : 'border-amber-500/30 bg-amber-500/[0.08]'}`} role="status" aria-live="polite">
      <p className="flex items-center gap-2 text-xs font-semibold text-foreground">
        {enforced ? <ShieldCheck className="h-4 w-4 text-emerald-600" aria-hidden="true" /> : <ShieldAlert className="h-4 w-4 text-amber-600" aria-hidden="true" />}
        Action gate: {copy.headline}
      </p>
      <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">{copy.detail}</p>
      {data.detail ? <p className="mt-1.5 text-[10px] leading-relaxed text-muted-foreground/80">{data.detail}</p> : null}
    </div>
  );
}
