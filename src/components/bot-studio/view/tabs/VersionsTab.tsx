import { useEffect, useState } from 'react';

import { botStudioApi, type BotRun, type BotVersionHistory } from '../../api/botStudioApi';

type Version = BotVersionHistory['versions'][number];

function display(value: unknown): string {
  if (value == null || value === '') return '—';
  if (typeof value === 'string') return value;
  return JSON.stringify(value, null, 2);
}

function date(value: string): string {
  return new Date(value).toLocaleString();
}

function score(version: Version) {
  const s = version.scorecard;
  return [
    ['Ticks', String(s.ticks)],
    ['Success', s.successRate == null ? '—' : `${Math.round(s.successRate * 100)}%`],
    ['Failed', String(s.failed)],
    ['Cost', s.totalCostUsd == null ? '—' : `$${s.totalCostUsd.toFixed(3)}`],
    ['Tokens', s.totalTokens == null ? '—' : s.totalTokens.toLocaleString()],
  ];
}

export default function VersionsTab({ sectionId, onSelectRun }: { sectionId: string; onSelectRun?: (run: BotRun) => void }) {
  const [history, setHistory] = useState<BotVersionHistory | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [left, setLeft] = useState<number | null>(null);
  const [right, setRight] = useState<number | null>(null);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    void botStudioApi.getVersionHistory(sectionId).then((value) => {
      if (!alive) return;
      setHistory(value);
      setLeft(value.versions[0]?.version ?? null);
      setRight(value.versions[1]?.version ?? null);
      setError(null);
    }).catch((reason: unknown) => {
      if (alive) setError(reason instanceof Error ? reason.message : 'Could not load versions.');
    }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [sectionId]);

  if (loading) return <p className="p-6 text-sm text-muted-foreground">Loading version history…</p>;
  if (error) return <p className="p-6 text-sm text-destructive">{error}</p>;
  const versions = history?.versions ?? [];
  const selectedLeft = versions.find((version) => version.version === left);
  const selectedRight = versions.find((version) => version.version === right);
  const keys = selectedLeft && selectedRight
    ? Array.from(new Set([...Object.keys(selectedLeft.config), ...Object.keys(selectedRight.config)]))
      .filter((key) => JSON.stringify(selectedLeft.config[key]) !== JSON.stringify(selectedRight.config[key]))
    : [];

  return <div className="space-y-5 p-4 sm:p-6">
    <div>
      <h3 className="text-sm font-semibold">Version history</h3>
      <p className="mt-1 text-xs text-muted-foreground">A version is saved when the bot’s configuration changes. Pausing or reordering does not create one.</p>
      {history?.unversionedRuns ? <p className="mt-2 text-xs text-amber-600">{history.unversionedRuns} older tick{history.unversionedRuns === 1 ? ' is' : 's are'} unversioned and excluded from these scorecards.</p> : null}
    </div>
    <div className="space-y-3">
      {versions.map((version) => <section key={version.version} className="rounded-xl border border-border bg-card p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div><h4 className="text-sm font-semibold">Version {version.version} <span className="text-xs font-normal text-muted-foreground">· {version.origin}</span></h4><p className="text-xs text-muted-foreground">{date(version.createdAt)} · {display(version.config.provider)} / {display(version.config.model)}</p></div>
          {version.scorecard.latestRunAt ? <span className="text-xs text-muted-foreground">Last tick {date(version.scorecard.latestRunAt)}</span> : <span className="text-xs text-muted-foreground">No ticks yet</span>}
        </div>
        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-5">{score(version).map(([label, value]) => <div key={label} className="rounded-lg bg-muted/40 px-3 py-2"><p className="text-[11px] text-muted-foreground">{label}</p><p className="text-sm font-semibold">{value}</p></div>)}</div>
        {version.scorecard.ticks > 0 ? <p className="mt-2 text-[11px] text-muted-foreground">{version.scorecard.aborted} aborted · {version.scorecard.active} active · cost known for {version.scorecard.runsWithCost}/{version.scorecard.ticks} ticks · tokens known for {version.scorecard.runsWithTokens}/{version.scorecard.ticks}</p> : null}
        {version.scorecard.recentRuns.length ? <div className="mt-3 flex flex-wrap gap-2">{version.scorecard.recentRuns.map((run) => <button key={run.runId} type="button" onClick={() => onSelectRun?.({ run_id: run.runId, status: run.status })} className="rounded-lg border border-border px-2 py-1 text-xs hover:border-primary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" title="Open run story">{run.status} · {date(run.createdAt)}</button>)}</div> : null}
      </section>)}
    </div>
    {versions.length > 1 ? <section className="rounded-xl border border-border bg-card p-4">
      <h4 className="text-sm font-semibold">Compare versions</h4>
      <div className="mt-3 flex flex-wrap gap-2">{[left, right].map((selected, index) => <select key={index} value={selected ?? ''} onChange={(event) => (index === 0 ? setLeft : setRight)(Number(event.target.value))} className="rounded-lg border border-border bg-background px-2 py-1 text-xs" aria-label={index === 0 ? 'First version' : 'Second version'}>{versions.map((version) => <option key={version.version} value={version.version}>Version {version.version}</option>)}</select>)}</div>
      {left === right ? <p className="mt-3 text-xs text-muted-foreground">Choose two different versions.</p> : keys.length ? <div className="mt-3 space-y-3">{keys.map((key) => <div key={key} className="rounded-lg border border-border/70 p-3"><p className="mb-2 text-xs font-medium">{key.replace(/_/g, ' ')}</p><div className="grid gap-2 sm:grid-cols-2"><pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/40 p-2 text-[11px]">v{left}: {display(selectedLeft?.config[key])}</pre><pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/40 p-2 text-[11px]">v{right}: {display(selectedRight?.config[key])}</pre></div></div>)}</div> : <p className="mt-3 text-xs text-muted-foreground">No configuration differences.</p>}
    </section> : null}
    <p className="text-[11px] text-muted-foreground">Success rate counts completed ticks only. Cost and token totals include only ticks with recorded usage.</p>
  </div>;
}
