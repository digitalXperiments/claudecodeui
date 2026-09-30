import { useEffect, useState } from 'react';

import type { McItem } from '../../../mission-control/api/missionControlApi';
import { botStudioApi, type BotMemory } from '../../api/botStudioApi';

export default function MemoryTab({ sectionId, items }: { sectionId: string; items: McItem[] }) {
  const [memories, setMemories] = useState<BotMemory[]>([]);
  const [content, setContent] = useState('');
  const [sourceItemId, setSourceItemId] = useState('');
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void botStudioApi.listMemories(sectionId).then((next) => { if (alive) setMemories(next); }).catch((reason: unknown) => { if (alive) setError(reason instanceof Error ? reason.message : 'Unable to load memory.'); });
    return () => { alive = false; };
  }, [sectionId]);
  const propose = async () => {
    setBusy(true); setError(null);
    try {
      const memory = await botStudioApi.proposeMemory(sectionId, content, sourceItemId || undefined);
      setMemories((current) => [memory, ...current]); setContent(''); setSourceItemId('');
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to propose memory.'); }
    finally { setBusy(false); }
  };
  const review = async (memory: BotMemory, status: BotMemory['status']) => {
    setBusy(true); setError(null);
    try {
      const updated = await botStudioApi.reviewMemory(sectionId, memory.memoryId, status, drafts[memory.memoryId] ?? memory.content);
      setMemories((current) => current.map((entry) => entry.memoryId === updated.memoryId ? updated : entry));
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to review memory.'); }
    finally { setBusy(false); }
  };
  const groups: Array<{ status: BotMemory['status']; title: string }> = [
    { status: 'proposed', title: 'Proposed · review before use' },
    { status: 'approved', title: 'Approved · included in future ticks' },
    { status: 'rejected', title: 'Rejected · not used' },
  ];
  return <div className="max-w-4xl space-y-5 p-4 sm:p-6">
    <div><h3 className="text-sm font-semibold">Bot memory</h3><p className="mt-1 text-xs text-muted-foreground">Curate a small set of facts or preferences for future produce ticks. Only approved notes enter the prompt; no bot can promote its own memory.</p></div>
    <section className="space-y-3 rounded-xl border border-border bg-card p-4">
      <h4 className="text-xs font-semibold">Propose a memory</h4>
      <select aria-label="Memory source item" value={sourceItemId} onChange={(event) => { const id = event.target.value; setSourceItemId(id); const item = items.find((entry) => entry.item_id === id); if (item) setContent(`${item.title}: ${item.summary}`.slice(0, 1000)); }} className="w-full rounded-lg border border-border bg-background px-3 py-2 text-xs"><option value="">Manual note · no source item</option>{items.slice(0, 100).map((item) => <option key={item.item_id} value={item.item_id}>{item.title}</option>)}</select>
      <textarea aria-label="Proposed memory" value={content} onChange={(event) => setContent(event.target.value)} maxLength={1000} rows={4} placeholder="A durable fact or preference this bot should remember…" className="w-full rounded-lg border border-border bg-background p-3 text-xs outline-none focus:border-primary" />
      <div className="flex items-center justify-between"><span className="text-[11px] text-muted-foreground">{content.length}/1000 · proposal is not active until approved</span><button type="button" disabled={busy || !content.trim()} onClick={() => void propose()} className="rounded-lg bg-primary px-3 py-2 text-xs font-medium text-primary-foreground disabled:opacity-50">Propose</button></div>
    </section>
    {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
    {groups.map((group) => { const entries = memories.filter((memory) => memory.status === group.status); return <section key={group.status} className="space-y-2"><h4 className="text-xs font-semibold">{group.title} · {entries.length}</h4>{entries.length ? entries.map((memory) => <div key={memory.memoryId} className="rounded-xl border border-border bg-card p-3"><textarea aria-label={`Memory ${memory.memoryId}`} value={drafts[memory.memoryId] ?? memory.content} onChange={(event) => setDrafts((current) => ({ ...current, [memory.memoryId]: event.target.value }))} maxLength={1000} rows={3} className="w-full resize-y rounded-lg border border-border bg-background p-2 text-xs outline-none focus:border-primary" /><p className="mt-1 text-[11px] text-muted-foreground">{memory.sourceItemId ? `From inbox item ${memory.sourceItemId}` : 'Manual note'} · {new Date(memory.updatedAt).toLocaleString()}</p><div className="mt-2 flex flex-wrap gap-2">{group.status !== 'approved' ? <button type="button" disabled={busy} onClick={() => void review(memory, 'approved')} className="rounded-lg bg-primary px-2.5 py-1.5 text-xs text-primary-foreground">Approve</button> : <button type="button" disabled={busy || (drafts[memory.memoryId] ?? memory.content) === memory.content} onClick={() => void review(memory, 'approved')} className="rounded-lg border border-border px-2.5 py-1.5 text-xs disabled:opacity-50">Save edit</button>}{group.status !== 'rejected' ? <button type="button" disabled={busy} onClick={() => void review(memory, 'rejected')} className="rounded-lg border border-border px-2.5 py-1.5 text-xs">{group.status === 'approved' ? 'Revoke' : 'Reject'}</button> : null}</div></div>) : <p className="rounded-lg border border-dashed border-border p-3 text-xs text-muted-foreground">None.</p>}</section>; })}
  </div>;
}
