import { useEffect, useMemo, useState } from 'react';
import { Bot as BotIcon, ChevronRight, Eye, FileJson, ExternalLink, X } from 'lucide-react';

import type { BotRun } from '../api/botStudioApi';
import { actionIsSendLike, formatAge, itemHasDraft } from '../types';
import StatusPill from '../ui/StatusPill';
import { Button } from '../../../shared/view/ui';
import { getActionSemantics } from '../../mission-control/utils/actionSemantics';
import { isXArticleBody } from '../../mission-control/utils/xArticle';
import ArticleDraftCard from '../../mission-control/view/subcomponents/ArticleDraftCard';

import type { ContextPaneProps } from './contracts';

type ExtendedContextPaneProps = ContextPaneProps & {
  /** Optional until the shell wires the run-selection contract through. */
  run?: BotRun | null;
  onSelectRun?: (run: BotRun) => void;
  onAction?: (item: NonNullable<ContextPaneProps['item']>, action: NonNullable<ContextPaneProps['item']>['actions'][number], body?: Record<string, unknown>) => void;
};

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function sourceExcerpt(item: NonNullable<ContextPaneProps['item']>): string {
  for (const key of ['excerpt', 'text', 'content', 'title']) {
    const value = stringValue(item.source?.[key]);
    if (value) return value;
  }
  return 'No source excerpt was provided.';
}

function sourceUrl(item: NonNullable<ContextPaneProps['item']>): string | null {
  const value = stringValue(item.source?.url);
  return value && /^https?:\/\//i.test(value) ? value : null;
}

function runIdForItem(item: NonNullable<ContextPaneProps['item']>): string | null {
  return stringValue(item.body.run_id) ?? stringValue(item.body.runId) ?? stringValue(item.body.produced_by_run_id);
}

function runDetail(run: BotRun, onSelectRun?: (run: BotRun) => void) {
  return <div className="space-y-4 p-4">
    <div><p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">Tick detail</p><div className="mt-2 flex items-center gap-2"><StatusPill status={run.status} /><span className="text-xs text-muted-foreground">{run.kind || 'produce'} · {run.trigger || 'manual'}</span></div></div>
    <dl className="grid grid-cols-2 gap-x-3 gap-y-3 text-xs"><div><dt className="text-[10px] text-muted-foreground">Started</dt><dd className="mt-0.5">{run.started_at ? formatAge(run.started_at) : '—'}</dd></div><div><dt className="text-[10px] text-muted-foreground">Duration</dt><dd className="mt-0.5">{run.duration_ms != null ? `${Math.round(run.duration_ms)}ms` : '—'}</dd></div><div><dt className="text-[10px] text-muted-foreground">Tokens</dt><dd className="mt-0.5">{run.tokens?.toLocaleString() ?? '—'}</dd></div><div><dt className="text-[10px] text-muted-foreground">Cost</dt><dd className="mt-0.5">{run.cost_usd != null ? `$${run.cost_usd.toFixed(4)}` : '—'}</dd></div></dl>
    {run.error_summary ? <p className="rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive" role="alert">{run.error_summary}</p> : null}
    {run.item_id ? <p className="rounded-lg border border-border/70 bg-card px-3 py-2 text-xs">Produced inbox item <span className="font-mono text-[10px]">{run.item_id}</span></p> : null}
    {onSelectRun ? <Button size="sm" variant="ghost" onClick={() => onSelectRun(run)}>Open run <ChevronRight className="h-3 w-3" /></Button> : null}
  </div>;
}

export default function ContextPane({ item, bot, preview, operatorContext, onOperatorContextChange, onBodyChange, onClose, run, onSelectRun, onAction }: ExtendedContextPaneProps) {
  const [bodyDraft, setBodyDraft] = useState('');
  const [draftText, setDraftText] = useState('');
  const [bodyError, setBodyError] = useState<string | null>(null);

  useEffect(() => {
    const body = item?.body ?? {};
    setBodyDraft(item ? JSON.stringify(body, null, 2) : '');
    const draft = body.draft ?? body.reply;
    setDraftText(typeof draft === 'string' ? draft : '');
    setBodyError(null);
  }, [item]);

  const article = item && isXArticleBody(item.body) ? item.body : null;
  const itemRunId = item ? runIdForItem(item) : null;
  const memory = item ? stringValue(item.body.memory) ?? stringValue(item.body.memories) : null;
  const bodyHasDraft = item ? itemHasDraft(item) : false;

  const bodyFromEditor = (): Record<string, unknown> | null => {
    try {
      const parsed: unknown = JSON.parse(bodyDraft);
      if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error('Body must be a JSON object.');
      return parsed as Record<string, unknown>;
    } catch (error) {
      setBodyError(error instanceof Error ? error.message : 'Body must be a JSON object.');
      return null;
    }
  };

  const saveBody = () => {
    const parsed = bodyFromEditor();
    if (!parsed) return;
    onBodyChange(parsed);
    const nextDraft = parsed.draft ?? parsed.reply;
    setDraftText(typeof nextDraft === 'string' ? nextDraft : '');
    setBodyError(null);
  };

  const updateDraft = (value: string) => {
    if (!item) return;
    setDraftText(value);
    const current = bodyFromEditor() ?? { ...item.body };
    const draftKey = Object.prototype.hasOwnProperty.call(current, 'reply') && !Object.prototype.hasOwnProperty.call(current, 'draft') ? 'reply' : 'draft';
    const nextBody = { ...current, [draftKey]: value };
    setBodyDraft(JSON.stringify(nextBody, null, 2));
    onBodyChange(nextBody);
    setBodyError(null);
  };

  const actionBody = useMemo<Record<string, unknown> | undefined>(() => {
    let parsed: Record<string, unknown>;
    try {
      const value: unknown = JSON.parse(bodyDraft);
      if (!value || Array.isArray(value) || typeof value !== 'object') return undefined;
      parsed = value as Record<string, unknown>;
    } catch {
      return undefined;
    }
    const next = { ...parsed };
    if (operatorContext.trim()) next.operatorContext = operatorContext.trim();
    else delete next.operatorContext;
    return next;
  }, [bodyDraft, operatorContext]);

  if (run) return <aside className="flex min-h-0 flex-col border-t border-border/70 bg-card/30 xl:border-t-0"><div className="flex items-center justify-between border-b border-border/70 px-4 py-3"><p className="text-sm font-semibold">Run {run.run_id}</p>{onClose ? <Button size="sm" variant="ghost" onClick={onClose} aria-label="Close context pane"><X className="h-3.5 w-3.5" /></Button> : null}</div><div className="min-h-0 flex-1 overflow-y-auto">{runDetail(run, onSelectRun)}</div></aside>;
  if (!item) return <aside className="flex min-h-0 flex-col border-t border-border/70 bg-card/30 xl:border-t-0"><div className="flex flex-1 flex-col items-center justify-center p-8 text-center"><div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-primary"><BotIcon className="h-4 w-4" /></div><p className="mt-3 text-sm font-medium">Context pane</p><p className="mt-1 max-w-xs text-xs leading-5 text-muted-foreground">Select an inbox item to inspect its evidence, draft, and next action.</p></div></aside>;

  return <aside className="flex min-h-0 flex-col border-t border-border/70 bg-card/30 xl:border-t-0">
    <div className="flex shrink-0 items-start gap-2 border-b border-border/70 px-4 py-3"><div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">{bot?.icon || '🤖'}</div><div className="min-w-0 flex-1"><p className="truncate text-sm font-semibold">{item.title}</p><div className="mt-1 flex flex-wrap items-center gap-2"><StatusPill status={item.status} /><span className="text-[10px] text-muted-foreground">{formatAge(item.created_at)} · {Math.round((item.confidence ?? 0) * 100)}% confidence</span></div><p className="mt-1 truncate font-mono text-[10px] text-muted-foreground" title={item.dedupe_key}>Dedupe · {item.dedupe_key || 'none'}</p></div>{onClose ? <Button size="sm" variant="ghost" onClick={onClose} aria-label="Close context pane"><X className="h-3.5 w-3.5" /></Button> : null}</div>
    <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
      <section><p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">Why the bot thinks so</p><p className="mt-1 text-xs leading-5 text-muted-foreground">{item.summary || 'The bot produced this item during a tick.'}</p>{memory ? <p className="mt-2 rounded-lg bg-muted/50 px-3 py-2 text-xs leading-5 text-muted-foreground"><span className="font-medium text-foreground">Memory · </span>{memory}</p> : null}{operatorContext ? <p className="mt-2 rounded-lg border border-primary/20 bg-primary/5 px-3 py-2 text-xs leading-5"><span className="font-medium text-primary">Operator context · </span>{operatorContext}</p> : null}</section>

      <section className="rounded-xl border border-dashed border-amber-500/40 bg-amber-500/5 p-3"><div className="flex items-center justify-between gap-2"><p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-amber-700 dark:text-amber-300">Source · untrusted content</p>{sourceUrl(item) ? <a href={sourceUrl(item) ?? undefined} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[10px] font-medium text-amber-700 underline-offset-2 hover:underline dark:text-amber-300">Open original <ExternalLink className="h-3 w-3" /></a> : null}</div><p className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap break-words text-xs leading-5 text-muted-foreground">{sourceExcerpt(item)}</p></section>

      {article ? <ArticleDraftCard article={article} itemId={item.item_id} onGenerateAssets={async () => ({ generated: 0, skipped: 0, failed: 0, messages: ['Render assets from the inbox card.'] })} /> : bodyHasDraft ? <section><label htmlFor="bot-draft" className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">Draft</label><textarea id="bot-draft" value={draftText} onChange={(event) => updateDraft(event.target.value)} className="mt-2 min-h-28 w-full resize-y rounded-xl border border-border bg-background px-3 py-2 text-xs leading-5 outline-none focus:border-primary focus:ring-2 focus:ring-primary/10" /></section> : null}

      <section><label htmlFor="bot-steering-note" className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">Steering note</label><textarea id="bot-steering-note" value={operatorContext} onChange={(event) => onOperatorContextChange(event.target.value)} placeholder="Add facts, corrections, tone, or the outcome you want…" className="mt-2 min-h-20 w-full resize-y rounded-xl border border-border bg-background px-3 py-2 text-xs leading-5 outline-none focus:border-primary focus:ring-2 focus:ring-primary/10" /><p className="mt-1 text-[10px] text-muted-foreground">Included in the next action body.</p></section>

      <section><div className="flex items-center justify-between"><p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground"><FileJson className="mr-1 inline h-3 w-3" />Edit before approve</p><Button size="sm" variant="ghost" onClick={saveBody}>Apply</Button></div><textarea value={bodyDraft} onChange={(event) => { setBodyDraft(event.target.value); setBodyError(null); }} className="mt-2 min-h-40 w-full resize-y rounded-xl border border-border bg-background px-3 py-2 font-mono text-[10px] leading-4 outline-none focus:border-primary focus:ring-2 focus:ring-primary/10" aria-label="Edit item body JSON" aria-invalid={Boolean(bodyError)} />{bodyError ? <p className="mt-1 text-[10px] text-destructive" role="alert">{bodyError}</p> : null}</section>

      <section className="rounded-xl border border-primary/25 bg-primary/5 p-3"><div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-primary"><Eye className="h-3 w-3" />Preview result</div><p className="mt-1 text-[10px] text-muted-foreground">Nothing is executed yet.</p>{preview ? <pre className="mt-2 max-h-52 overflow-auto whitespace-pre-wrap break-words text-[10px] leading-4 text-muted-foreground">{JSON.stringify(preview, null, 2)}</pre> : <p className="mt-2 text-xs text-muted-foreground">Preview an action from the inbox card to see its result here.</p>}</section>

      {onAction ? <section><p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">Actions</p><div className="flex flex-wrap gap-1.5">{item.actions.map((action) => { const locked = bot?.autonomy === 'propose' && actionIsSendLike(action); const semantics = getActionSemantics(action, item.title, { hasDraft: itemHasDraft(item) }); return <Button key={action.id} size="sm" variant={action.kind === 'approve' ? 'default' : action.kind === 'dismiss' ? 'ghost' : 'outline'} disabled={item.status === 'resolving' || locked} title={locked ? 'Held in Propose mode: review before sending' : semantics.detail} onClick={() => onAction(item, action, actionBody)}>{locked ? '🔒 ' : ''}{semantics.label}</Button>; })}</div></section> : null}

      <section><p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">Timeline</p><ol className="mt-2 space-y-2 border-l border-border pl-3 text-xs text-muted-foreground"><li><span className="font-medium text-foreground">Produced</span> · {formatAge(item.created_at)}{itemRunId ? <> · run <button type="button" className="font-mono text-primary hover:underline" onClick={() => onSelectRun?.({ run_id: itemRunId, status: 'completed', item_id: item.item_id })}>{itemRunId}</button></> : null}</li>{item.resolved_at ? <li><span className="font-medium text-foreground">{item.status === 'dismissed' ? 'Dismissed' : 'Resolved'}</span> · {formatAge(item.resolved_at)} by you</li> : null}</ol></section>
    </div>
  </aside>;
}
