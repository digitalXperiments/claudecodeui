import { useState } from 'react';
import { ArrowDownToLine, Loader2 } from 'lucide-react';

import { Button } from '../../../shared/view/ui';
import { botStudioApi } from '../api/botStudioApi';

import type { ImportViewProps } from './contracts';

export default function ImportView({ onImported }: ImportViewProps) {
  const [path, setPath] = useState('');
  const [report, setReport] = useState<Awaited<ReturnType<typeof botStudioApi.importFromLegacy>> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const importSections = async () => { setBusy(true); setError(null); try { setReport(await botStudioApi.importFromLegacy(path.trim() || undefined)); onImported?.(); } catch (nextError) { setError(nextError instanceof Error ? nextError.message : 'Import failed'); } finally { setBusy(false); } };
  return <section className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6"><div className="mx-auto max-w-3xl"><p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">Migration</p><h2 className="mt-1 text-lg font-semibold">Import from Action Centre</h2><p className="mt-2 text-sm leading-6 text-muted-foreground">Bring legacy Mission Control sections into Bot Studio. Existing sections and items stay in place; review the report before enabling a bot.</p><div className="mt-5 rounded-xl border border-border/70 bg-card p-4"><label htmlFor="legacy-path" className="text-xs font-medium">Legacy data path <span className="font-normal text-muted-foreground">(optional)</span></label><div className="mt-2 flex gap-2"><input id="legacy-path" value={path} onChange={(event) => setPath(event.target.value)} placeholder="Use the default path" className="h-9 min-w-0 flex-1 rounded-lg border border-border bg-background px-3 text-xs outline-none focus:border-primary" /><Button onClick={() => void importSections()} disabled={busy}>{busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ArrowDownToLine className="h-3.5 w-3.5" />}Import</Button></div>{error ? <p className="mt-2 text-xs text-destructive">{error}</p> : null}</div>{report ? <div className="mt-5 overflow-hidden rounded-xl border border-border/70 bg-card"><div className="border-b border-border/70 px-4 py-3 text-xs font-semibold">Migration report · {report.imported} imported · {report.skipped} skipped</div><div className="grid gap-3 p-4 text-xs sm:grid-cols-3"><div><p className="text-muted-foreground">Path</p><p className="mt-1 break-all">{report.path || '—'}</p></div><div><p className="text-muted-foreground">Sections</p><p className="mt-1">{report.sections.length}</p></div><div><p className="text-muted-foreground">Errors</p><p className="mt-1">{report.errors.length}</p></div></div>{report.errors.length ? <ul className="border-t border-border/70 p-4 text-xs text-destructive">{report.errors.map((entry) => <li key={entry}>{entry}</li>)}</ul> : null}</div> : null}</div></section>;
}
