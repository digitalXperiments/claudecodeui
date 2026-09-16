import { useEffect, useMemo, useState } from 'react';
import { RotateCcw, Save } from 'lucide-react';

import type { Bot } from '../../types';
import { Button } from '../../../../shared/view/ui';

type BriefTabProps = { bot: Bot; onSave: (patch: { produce_prompt: string; resolve_prompt: string }) => Promise<void>; onDirtyChange?: (dirty: boolean) => void };

export default function BriefTab({ bot, onSave, onDirtyChange }: BriefTabProps) {
  const [produce, setProduce] = useState(bot.produce_prompt);
  const [resolve, setResolve] = useState(bot.resolve_prompt);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const dirty = useMemo(() => produce !== bot.produce_prompt || resolve !== bot.resolve_prompt, [bot.produce_prompt, bot.resolve_prompt, produce, resolve]);
  useEffect(() => { setProduce(bot.produce_prompt); setResolve(bot.resolve_prompt); }, [bot.produce_prompt, bot.resolve_prompt]);
  useEffect(() => onDirtyChange?.(dirty), [dirty, onDirtyChange]);
  const discard = () => { setProduce(bot.produce_prompt); setResolve(bot.resolve_prompt); setNote('Changes discarded.'); };
  const save = async () => { setBusy(true); setNote(null); try { await onSave({ produce_prompt: produce, resolve_prompt: resolve }); setNote('Brief saved.'); } catch (error) { setNote(error instanceof Error ? error.message : 'Unable to save brief.'); } finally { setBusy(false); } };
  return <div className="max-w-3xl space-y-6 p-4 sm:p-6">
    <div><p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">Brief</p><p className="mt-1 text-xs leading-5 text-muted-foreground">Keep the brief concrete: context first, then the decision the bot should make each tick.</p></div>
    <label className="block"><span className="text-sm font-semibold">What to look for each tick</span><span className="mt-1 block text-xs text-muted-foreground">Brief · what to look for each tick</span><textarea aria-label="What to look for each tick" value={produce} onChange={(event) => setProduce(event.target.value)} className="mt-2 min-h-44 w-full resize-y rounded-xl border border-border bg-card px-3 py-3 text-sm leading-6 outline-none focus:border-primary focus:ring-2 focus:ring-primary/20" /></label>
    <label className="block"><span className="text-sm font-semibold">How to resolve an approved item</span><span className="mt-1 block text-xs text-muted-foreground">Brief · how to resolve an approved item</span><textarea aria-label="How to resolve an approved item" value={resolve} onChange={(event) => setResolve(event.target.value)} className="mt-2 min-h-44 w-full resize-y rounded-xl border border-border bg-card px-3 py-3 text-sm leading-6 outline-none focus:border-primary focus:ring-2 focus:ring-primary/20" /></label>
    {dirty ? <p className="rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">Unsaved changes will be lost if you leave this tab.</p> : null}
    <div className="flex flex-wrap items-center gap-2"><Button onClick={() => void save()} disabled={busy || !dirty}><Save className="h-3.5 w-3.5" />{busy ? 'Saving…' : 'Save brief'}</Button><Button variant="ghost" onClick={discard} disabled={!dirty || busy}><RotateCcw className="h-3.5 w-3.5" />Discard</Button>{note ? <span className="text-xs text-muted-foreground" role="status">{note}</span> : null}</div>
  </div>;
}
