import { useState } from 'react';

import { missionControlApi, type CreateMcSectionInput, type McSectionWorkshopDraft, type McSectionWorkshopMessage } from '../../../mission-control/api/missionControlApi';
import type { Bot } from '../../types';

import { buildIterationPatch, type IterationField } from './iteratePatch';

const FIELDS: Array<{ key: IterationField; label: string; draft: keyof McSectionWorkshopDraft }> = [
  { key: 'title', label: 'Name', draft: 'title' },
  { key: 'produce_prompt', label: 'Produce brief', draft: 'producePrompt' },
  { key: 'resolve_prompt', label: 'Resolve brief', draft: 'resolvePrompt' },
  { key: 'schedule_cron', label: 'Schedule', draft: 'scheduleCron' },
];

export default function IterateTab({ bot, onSave }: { bot: Bot; onSave: (patch: Partial<CreateMcSectionInput>) => Promise<void> }) {
  const [request, setRequest] = useState('');
  const [turns, setTurns] = useState<McSectionWorkshopMessage[]>([]);
  const [reply, setReply] = useState('');
  const [draft, setDraft] = useState<McSectionWorkshopDraft | null>(null);
  const [selected, setSelected] = useState<IterationField[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const changes = draft ? FIELDS.filter(({ key, draft: draftKey }) => (draft[draftKey] ?? null) !== (bot[key] ?? null)) : [];
  const ask = async () => {
    if (!request.trim()) return;
    const nextTurns: McSectionWorkshopMessage[] = [...turns, { role: 'user', content: request.trim() }];
    setBusy(true); setError(null); setDraft(null); setSelected([]);
    try {
      const result = await missionControlApi.draftSection({
        provider: bot.provider, model: bot.model, projectId: bot.project_id,
        messages: nextTurns,
        currentDraft: { title: bot.title, scope: bot.scope, mode: bot.mode, scheduleCron: bot.schedule_cron, producePrompt: bot.produce_prompt, resolvePrompt: bot.resolve_prompt, createKanbanTask: bot.create_kanban_task, recommendedMcpServers: bot.produce_tools },
        availableMcpServers: [...new Set([...bot.produce_tools, ...bot.resolve_tools])],
      });
      setReply(result.reply); setTurns([...nextTurns, { role: 'assistant', content: result.reply }]); setRequest('');
      if (result.ready && result.draft) { setDraft(result.draft); setSelected(FIELDS.filter(({ key, draft: draftKey }) => (result.draft![draftKey] ?? null) !== (bot[key] ?? null)).map(({ key }) => key)); }
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Architect could not propose a revision.'); }
    finally { setBusy(false); }
  };
  const apply = async () => {
    if (!draft || !selected.length) return;
    const patch = buildIterationPatch(draft, selected);
    setBusy(true); setError(null);
    try { await onSave(patch); setDraft(null); setSelected([]); setReply('Selected changes saved as a new bot version.'); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to save changes.'); }
    finally { setBusy(false); }
  };
  return <div className="max-w-4xl space-y-5 p-4 sm:p-6">
    <div><h3 className="text-sm font-semibold">Iterate with Architect</h3><p className="mt-1 text-xs text-muted-foreground">Describe a change. Review each suggested field before applying it as a new version. Tools, permissions, autonomy, and actions stay untouched.</p></div>
    <div className="rounded-xl border border-border bg-card p-4"><textarea aria-label="Describe a bot change" value={request} onChange={(event) => setRequest(event.target.value)} rows={4} maxLength={4000} placeholder="For example: make the summary shorter and exclude automated notifications…" className="w-full rounded-lg border border-border bg-background p-3 text-xs outline-none focus:border-primary" /><div className="mt-2 flex justify-end"><button type="button" disabled={busy || !request.trim()} onClick={() => void ask()} className="rounded-lg bg-primary px-3 py-2 text-xs font-medium text-primary-foreground disabled:opacity-50">{busy ? 'Working…' : 'Propose revision'}</button></div></div>
    {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
    {reply ? <div className="whitespace-pre-wrap rounded-xl border border-border bg-card p-4 text-xs">{reply.replace(/```mission-section[\s\S]*?```/i, '').trim()}</div> : null}
    {draft ? <section className="space-y-3 rounded-xl border border-border bg-card p-4"><h4 className="text-xs font-semibold">Review proposed changes</h4>{changes.length ? changes.map(({ key, label, draft: draftKey }) => <label key={key} className="block rounded-lg border border-border/70 p-3"><span className="flex items-center gap-2 text-xs font-medium"><input type="checkbox" checked={selected.includes(key)} onChange={(event) => setSelected((current) => event.target.checked ? [...current, key] : current.filter((field) => field !== key))} className="accent-primary" />{label}</span><div className="mt-2 grid gap-2 sm:grid-cols-2"><div><p className="text-[10px] text-muted-foreground">Current</p><pre className="mt-1 max-h-52 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/30 p-2 text-[11px]">{bot[key] || '—'}</pre></div><div><p className="text-[10px] text-muted-foreground">Proposed</p><pre className="mt-1 max-h-52 overflow-auto whitespace-pre-wrap break-words rounded bg-primary/5 p-2 text-[11px]">{draft[draftKey] || '—'}</pre></div></div></label>) : <p className="text-xs text-muted-foreground">No supported configuration changes were proposed.</p>}<p className="text-[11px] text-muted-foreground">Other Architect suggestions are not applied here. Review Tools and Outputs separately for capability changes.</p><button type="button" disabled={busy || !selected.length} onClick={() => void apply()} className="rounded-lg bg-primary px-3 py-2 text-xs font-medium text-primary-foreground disabled:opacity-50">Apply {selected.length} selected change{selected.length === 1 ? '' : 's'}</button></section> : null}
  </div>;
}
