import { Eye, ExternalLink, Lock, RefreshCw, Send } from 'lucide-react';
import type { McAction, McItem } from '../../mission-control/api/missionControlApi';
import ArticleDraftCard from '../../mission-control/view/subcomponents/ArticleDraftCard';
import { getActionSemantics } from '../../mission-control/utils/actionSemantics';
import { isXArticleBody } from '../../mission-control/utils/xArticle';
import { actionIsSendLike, formatAge, itemHasDraft, type Bot } from '../types';
import StatusPill from '../ui/StatusPill';
import { Button } from '../../../shared/view/ui';

function sourceExcerpt(item: McItem): string {
  const source = item.source ?? {};
  for (const key of ['excerpt', 'text', 'content', 'url', 'title']) {
    if (typeof source[key] === 'string' && source[key].trim()) return source[key].trim();
  }
  return 'No source excerpt was provided.';
}

function draftText(item: McItem): string | null {
  const draft = item.body?.draft ?? item.body?.reply;
  return typeof draft === 'string' && draft.trim() ? draft.trim() : null;
}

export default function InboxItemCard({ item, bot, selected, checked, onSelect, onCheck, onAction, onPreview, onRetry, onWork, onGenerateAssets }: {
  item: McItem;
  bot?: Bot;
  selected: boolean;
  checked: boolean;
  onSelect: () => void;
  onCheck: (checked: boolean) => void;
  onAction: (item: McItem, action: McAction, body?: Record<string, unknown>) => void;
  onPreview: (item: McItem, action?: McAction) => void;
  onRetry: (item: McItem) => void;
  onWork: (item: McItem) => void;
  onGenerateAssets: (force: boolean) => Promise<{ generated: number; skipped: number; failed: number; messages: string[] }>;
}) {
  const actionable = item.status === 'pending' || item.status === 'failed';
  const draft = draftText(item);
  return <article className={`rounded-xl border bg-card p-4 transition-shadow hover:shadow-sm ${selected ? 'border-primary/50 shadow-sm' : 'border-border/70'}`} onClick={onSelect}>
    <div className="flex items-start gap-3"><input type="checkbox" checked={checked} onChange={(event) => onCheck(event.target.checked)} onClick={(event) => event.stopPropagation()} aria-label={`Select ${item.title}`} className="mt-1 h-3.5 w-3.5 accent-primary" /><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary">{bot?.icon || '🤖'} {bot?.title ?? item.section_id}</span><StatusPill status={item.status} /><span className="ml-auto text-[10px] text-muted-foreground">{formatAge(item.created_at)}</span></div><h3 className="mt-2 break-words text-sm font-semibold">{item.title}</h3><p className="mt-1 line-clamp-2 text-xs leading-5 text-muted-foreground">{item.summary || 'No summary provided.'}</p></div></div>
    <div className="mt-3"><div className="mb-1 flex justify-between text-[10px] text-muted-foreground"><span>Confidence</span><span>{Math.round((item.confidence ?? 0) * 100)}%</span></div><div className="h-1.5 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-primary transition-all" style={{ width: `${Math.max(0, Math.min(100, (item.confidence ?? 0) * 100))}%` }} /></div></div>
    <div className="mt-3 rounded-lg border border-dashed border-amber-500/40 bg-amber-500/5 p-3"><p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-amber-700 dark:text-amber-300">Source · untrusted content</p><p className="mt-1 line-clamp-2 break-words text-xs text-muted-foreground">{sourceExcerpt(item)}</p></div>
    {isXArticleBody(item.body) ? <div className="mt-3" onClick={(event) => event.stopPropagation()}><ArticleDraftCard article={item.body} itemId={item.item_id} onGenerateAssets={onGenerateAssets} /></div> : draft ? <div className="mt-3 rounded-lg border border-primary/20 bg-primary/5 p-3"><p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-primary">Draft preview</p><p className="mt-1 line-clamp-3 whitespace-pre-wrap text-xs leading-5">{draft}</p></div> : null}
    {item.error ? <p className="mt-3 rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">{item.error}</p> : null}
    <div className="mt-3 flex flex-wrap items-center gap-1.5" onClick={(event) => event.stopPropagation()}>{actionable ? item.actions.map((action) => { const semantics = getActionSemantics(action, item.title, { hasDraft: itemHasDraft(item) }); const locked = bot?.autonomy === 'propose' && actionIsSendLike(action); return <Button key={action.id} size="sm" variant={action.kind === 'approve' ? 'default' : action.kind === 'dismiss' ? 'ghost' : 'outline'} disabled={item.status === 'resolving'} onClick={() => onAction(item, action)} title={locked ? 'Propose mode: approval is required before this remote action' : semantics.detail}>{locked ? <Lock className="h-3 w-3" /> : action.kind === 'approve' ? <Send className="h-3 w-3" /> : null}{semantics.label}</Button>; }) : null}<Button size="sm" variant="ghost" onClick={() => onPreview(item, item.actions[0])}><Eye className="h-3 w-3" />Preview</Button>{item.status === 'failed' ? <Button size="sm" variant="ghost" onClick={() => onRetry(item)}><RefreshCw className="h-3 w-3" />Retry</Button> : null}<Button size="sm" variant="ghost" onClick={() => onWork(item)}><ExternalLink className="h-3 w-3" />Work this</Button></div>
  </article>;
}
