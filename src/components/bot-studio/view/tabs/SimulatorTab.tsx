import { useState } from 'react';
import { FlaskConical, Loader2, RotateCcw } from 'lucide-react';

import type { McItem } from '../../../mission-control/api/missionControlApi';
import { Button } from '../../../../shared/view/ui';
import { botStudioApi, type BotTickSimulation } from '../../api/botStudioApi';
import type { Bot } from '../../types';

function exampleOutput(bot: Bot): string {
  if (bot.mode === 'fire_and_forget') {
    return 'Example result: the bot completed its task and returned this summary.';
  }
  return JSON.stringify([{
    title: 'Example finding',
    summary: 'A sample item to check the bot’s inbox and approval rules.',
    body: { note: 'Replace this with a realistic bot result.' },
    dedupeKey: 'example-source-1',
    confidence: 0.8,
  }], null, 2);
}

function outputFromItem(item: McItem): string {
  return JSON.stringify([{
    title: item.title,
    summary: item.summary,
    body: item.body,
    source: item.source,
    dedupeKey: item.dedupe_key,
    confidence: item.confidence,
  }], null, 2);
}

function nextStepLabel(value: BotTickSimulation['drafts'][number]): string {
  if (value.reason) return value.reason;
  if (value.nextStep === 'auto_approve') return 'Would attempt automatic approval';
  if (value.nextStep === 'resolved') return 'Would log a resolved result';
  return 'Would queue for review';
}

export default function SimulatorTab({ bot, items }: { bot: Bot; items: McItem[] }) {
  const [output, setOutput] = useState(() => exampleOutput(bot));
  const [simulation, setSimulation] = useState<BotTickSimulation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const latestItem = items[0];

  const simulate = async () => {
    setBusy(true);
    setError(null);
    setSimulation(null);
    try {
      setSimulation(await botStudioApi.simulateTick(bot.section_id, output));
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Unable to simulate this tick.');
    } finally {
      setBusy(false);
    }
  };

  return <div className="mx-auto max-w-3xl space-y-5 p-4 sm:p-6">
    <div className="flex items-start gap-3">
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary"><FlaskConical className="h-4 w-4" /></div>
      <div><h3 className="text-sm font-semibold">Tick simulator</h3><p className="mt-1 text-xs leading-5 text-muted-foreground">Paste a sample bot response to see which items would enter the inbox and which would be skipped. This preview uses the bot’s current rules and existing inbox items.</p></div>
    </div>

    <section className="rounded-xl border border-border/70 bg-card p-4">
      <div className="flex flex-wrap items-center justify-between gap-2"><label htmlFor="bot-simulator-output" className="text-xs font-semibold">Sample bot response</label><div className="flex gap-1">{latestItem && bot.mode === 'review' ? <Button size="sm" variant="ghost" onClick={() => { setOutput(outputFromItem(latestItem)); setSimulation(null); setError(null); }}>Use latest inbox item</Button> : null}<Button size="sm" variant="ghost" onClick={() => { setOutput(exampleOutput(bot)); setSimulation(null); setError(null); }}><RotateCcw className="h-3 w-3" />Reset example</Button></div></div>
      <p className="mt-1 text-[11px] leading-4 text-muted-foreground">{bot.mode === 'review' ? 'Use the JSON array the bot would return from a tick. Change the dedupeKey to try a new source; reuse one to see the duplicate check.' : 'Use the text the bot would return from a tick.'}</p>
      <textarea id="bot-simulator-output" value={output} onChange={(event) => { setOutput(event.target.value); setSimulation(null); setError(null); }} spellCheck={false} className="mt-3 min-h-56 w-full resize-y rounded-lg border border-border bg-background px-3 py-2 font-mono text-xs leading-5 outline-none focus:border-primary focus:ring-2 focus:ring-primary/10" />
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2"><p className="text-[10px] leading-4 text-muted-foreground">No provider or tools are called; no inbox item or run is created.</p><Button size="sm" onClick={() => void simulate()} disabled={busy || !output.trim()}>{busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FlaskConical className="h-3.5 w-3.5" />}Simulate tick</Button></div>
    </section>

    {error ? <div role="alert" className="rounded-lg border border-destructive/25 bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</div> : null}
    {simulation ? <section className="space-y-3" aria-live="polite">
      <div className="rounded-xl border border-border/70 bg-card p-4"><p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">Projected tick</p><p className="mt-1 text-sm font-medium">{simulation.message}</p>{simulation.status === 'ready' ? <div className="mt-3 flex flex-wrap gap-2 text-[10px] tabular-nums text-muted-foreground"><span className="rounded-full bg-primary/10 px-2 py-1 text-primary">{simulation.counts.wouldCreate} new</span><span className="rounded-full bg-muted px-2 py-1">{simulation.counts.skipped} skipped</span>{simulation.counts.invalid ? <span className="rounded-full bg-amber-500/10 px-2 py-1 text-amber-700 dark:text-amber-300">{simulation.counts.invalid} invalid</span> : null}{simulation.counts.filtered ? <span className="rounded-full bg-amber-500/10 px-2 py-1 text-amber-700 dark:text-amber-300">{simulation.counts.filtered} filtered by bot rules</span> : null}</div> : null}</div>
      {simulation.drafts.map((draft, index) => <article key={`${draft.dedupeKey ?? 'result'}-${index}`} className="rounded-xl border border-border/70 bg-card p-4"><div className="flex flex-wrap items-start justify-between gap-2"><div className="min-w-0"><p className="text-xs font-semibold">{draft.title}</p><p className="mt-1 text-[11px] leading-4 text-muted-foreground">{draft.summary || 'No summary provided.'}</p></div><span className={`rounded-full px-2 py-1 text-[10px] font-medium ${draft.outcome === 'would_create' || draft.outcome === 'would_log' ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' : 'bg-muted text-muted-foreground'}`}>{draft.outcome === 'would_create' ? 'New item' : draft.outcome === 'would_log' ? 'Result log' : 'Skipped'}</span></div><p className="mt-3 text-[11px] text-muted-foreground">{nextStepLabel(draft)}</p>{draft.dedupeKey ? <p className="mt-1 truncate font-mono text-[10px] text-muted-foreground" title={draft.dedupeKey}>Source key · {draft.dedupeKey}</p> : null}<details className="mt-3"><summary className="cursor-pointer text-[10px] font-medium text-primary">Inspect sample body</summary><pre className="mt-2 max-h-52 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-muted/50 p-3 text-[10px] leading-4">{JSON.stringify(draft.body, null, 2)}</pre></details></article>)}
    </section> : null}
  </div>;
}
