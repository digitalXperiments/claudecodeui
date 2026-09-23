import { useCallback, useEffect, useState } from 'react';

import { botStudioApi, type BotException } from '../api/botStudioApi';

export default function ExceptionsView({ onOpen }: { onOpen: (entry: BotException) => void }) {
  const [entries, setEntries] = useState<BotException[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    setLoading(true);
    try { setEntries(await botStudioApi.listExceptions()); setError(null); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to load exceptions.'); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  const groups: Array<{ kind: BotException['kind']; label: string; action: string }> = [
    { kind: 'failed_tick', label: 'Failed ticks', action: 'Inspect run' },
    { kind: 'failed_item', label: 'Failed actions', action: 'Review item' },
    { kind: 'stale_approval', label: 'Waiting over 24 hours', action: 'Review approval' },
  ];
  return <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6"><div className="flex items-start justify-between gap-3"><div><h2 className="text-base font-semibold">Exceptions</h2><p className="mt-1 text-xs text-muted-foreground">Current failed ticks, failed actions, and approvals waiting over 24 hours.</p></div><button type="button" onClick={() => void refresh()} disabled={loading} className="rounded-lg border border-border px-3 py-2 text-xs">Refresh</button></div>
    {error ? <p role="alert" className="mt-4 text-xs text-destructive">{error}</p> : null}
    {loading && !entries.length ? <p className="mt-6 text-xs text-muted-foreground">Loading exceptions…</p> : null}
    {!loading && !entries.length && !error ? <p className="mt-6 rounded-xl border border-dashed border-border p-6 text-center text-xs text-muted-foreground">No open exceptions. Failed ticks clear after a later successful tick; resolved items leave this queue.</p> : null}
    {groups.map((group) => { const current = entries.filter((entry) => entry.kind === group.kind); return current.length ? <section key={group.kind} className="mt-6 space-y-2"><h3 className="text-xs font-semibold">{group.label} · {current.length}</h3>{current.map((entry) => <button key={entry.id} type="button" onClick={() => onOpen(entry)} className="block w-full rounded-xl border border-border bg-card p-4 text-left hover:border-primary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><div className="flex justify-between gap-3"><div className="min-w-0"><p className="text-xs font-semibold">{entry.botTitle} · {entry.title}</p><p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{entry.detail}</p></div><span className="shrink-0 text-[11px] text-primary">{group.action}</span></div><p className="mt-2 text-[11px] text-muted-foreground">{new Date(entry.at).toLocaleString()}</p></button>)}</section> : null; })}
  </div>;
}
