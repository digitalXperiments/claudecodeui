import { useMemo, useState } from 'react';
import { Check, Clipboard, Loader2, Package, RefreshCw } from 'lucide-react';
import { authenticatedFetch } from '../../utils/api';
import { Button } from '../../shared/view/ui';

type PackItem = { kind: string; uri: string; title: string; excerpt: string; score: number };
type Pack = { pack_id: string; goal: string; estimatedTokens: number; items: PackItem[]; warnings: string[] };

type ContextPackPanelProps = {
  projectId: string;
  taskId: string;
  title: string;
  sessionId: string | null;
};

async function readError(response: Response, fallback: string): Promise<string> {
  try {
    const payload = (await response.json()) as { error?: { message?: string }; message?: string };
    return payload.error?.message ?? payload.message ?? fallback;
  } catch {
    return fallback;
  }
}

export default function ContextPackPanel({ projectId, taskId, title, sessionId }: ContextPackPanelProps) {
  const [pack, setPack] = useState<Pack | null>(null);
  const [included, setIncluded] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [attached, setAttached] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selectedCount = useMemo(() => included.size, [included]);

  const build = async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await authenticatedFetch(`/api/projects/${encodeURIComponent(projectId)}/context-packs`, {
        method: 'POST',
        body: JSON.stringify({ goal: title, taskId, budgetTokens: 4000 }),
      });
      if (!response.ok) throw new Error(await readError(response, `Context pack failed (${response.status})`));
      const payload = (await response.json()) as { pack?: Pack };
      if (!payload.pack) throw new Error('No context pack was returned.');
      setPack(payload.pack);
      setIncluded(new Set(payload.pack.items.map((item) => item.uri)));
      setAttached(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Failed to build context pack.');
    } finally {
      setBusy(false);
    }
  };

  const attach = async () => {
    if (!pack || !sessionId) return;
    setBusy(true);
    setError(null);
    try {
      const response = await authenticatedFetch(`/api/sessions/${encodeURIComponent(sessionId)}/attach-pack`, {
        method: 'POST',
        body: JSON.stringify({ packId: pack.pack_id }),
      });
      if (!response.ok) throw new Error(await readError(response, `Attach failed (${response.status})`));
      setAttached(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Failed to attach context pack.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-2 border-t border-border pt-3">
      <div className="flex items-center justify-between"><span className="flex items-center gap-1 text-xs font-medium text-muted-foreground"><Package className="h-3 w-3" />Context pack</span><Button size="sm" variant="outline" onClick={() => void build()} disabled={busy}><RefreshCw className={busy ? 'h-3 w-3 animate-spin' : 'h-3 w-3'} />{pack ? 'Rebuild' : 'Build context'}</Button></div>
      {error && <p className="text-xs text-destructive">{error}</p>}
      {pack && <div className="space-y-2 rounded-md border border-border/60 p-2"><div className="flex items-center justify-between text-[11px] text-muted-foreground"><span>{pack.items.length} ranked items · ~{pack.estimatedTokens} tokens</span><span>{selectedCount} included</span></div><div className="max-h-40 space-y-1 overflow-y-auto">{pack.items.map((item) => <label key={item.uri} className="flex gap-2 text-[11px] text-foreground"><input type="checkbox" checked={included.has(item.uri)} onChange={() => setIncluded((current) => { const next = new Set(current); if (next.has(item.uri)) next.delete(item.uri); else next.add(item.uri); return next; })} /><span className="min-w-0"><span className="block truncate font-medium">{item.title}</span><span className="block truncate text-muted-foreground">{item.uri}</span></span></label>)}</div>{pack.warnings.length > 0 && <p className="text-[10px] text-amber-600">{pack.warnings[0]}</p>}<Button size="sm" variant={attached ? 'secondary' : 'default'} onClick={() => void attach()} disabled={busy || attached || !sessionId}><Clipboard className="h-3 w-3" />{attached ? <><Check className="h-3 w-3" />Attached</> : 'Attach to session'}</Button>{!sessionId && <p className="text-[10px] text-muted-foreground">Run this task once to attach a pack to its session.</p>}</div>}
    </div>
  );
}
