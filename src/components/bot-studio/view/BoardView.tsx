import { useEffect, useMemo, useState, type DragEvent } from 'react';
import { Check, CornerUpLeft, ExternalLink, Eye, Play, RefreshCw, Send, SquareArrowOutUpRight, X } from 'lucide-react';

import type { McAction, McItem } from '../../mission-control/api/missionControlApi';
import { getActionSemantics } from '../../mission-control/utils/actionSemantics';
import { Button } from '../../../shared/view/ui';
import { formatAge, itemFailedInWork, itemHasDraft, itemWorkSession, routeWorkProject, type Bot } from '../types';
import StatusPill from '../ui/StatusPill';
import BotIcon from '../ui/BotIcon';

import {
  approveActionFor,
  BOARD_COLUMNS,
  BOARD_FILTER_ALL,
  BOARD_FILTER_WORK,
  boardColumnFor,
  boardDropFor,
  buildBoard,
  defaultBoardBotFilter,
  dismissActionFor,
  type BoardColumn,
} from './board/boardSelectors';

export interface BoardViewProps {
  items: McItem[];
  bots: Bot[];
  projects: Array<{ projectId: string; displayName: string }>;
  search: string;
  /** Open the item in the inbox context pane. */
  onOpenItem: (item: McItem) => void;
  onAction: (item: McItem, action: McAction) => void;
  /** Open the item's existing work session. */
  onOpenSession: (item: McItem) => void;
  onStartWork: (item: McItem) => void;
  onAcceptWork: (item: McItem) => void;
  onSendBack: (item: McItem, message: string) => void;
  onRetryWork: (item: McItem) => void;
  onRetry: (item: McItem) => void;
}

function firstUrl(values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && /^https?:\/\//i.test(value.trim())) return value.trim();
  }
  return null;
}

type CardProps = Omit<BoardViewProps, 'items' | 'bots' | 'search'> & {
  item: McItem;
  bot?: Bot;
  column: BoardColumn;
  sendingBack: boolean;
  onSendBackOpen: (open: boolean) => void;
  onDragStart: () => void;
  onDragEnd: () => void;
};

function BoardCard({ item, bot, column, projects, sendingBack, onSendBackOpen, onDragStart, onDragEnd, onOpenItem, onAction, onOpenSession, onStartWork, onAcceptWork, onSendBack, onRetryWork, onRetry }: CardProps) {
  const [feedback, setFeedback] = useState('');
  useEffect(() => { if (!sendingBack) setFeedback(''); }, [sendingBack]);
  const session = itemWorkSession(item);
  const projectId = session?.projectId ?? (column === 'ready' ? routeWorkProject(item, bot?.work_profile) : null);
  const projectName = projectId ? projects.find((project) => project.projectId === projectId)?.displayName ?? 'Missing project' : null;
  const client = typeof item.body.client === 'string' && item.body.client.trim() ? item.body.client.trim() : null;
  const sourceUrl = firstUrl([item.body.url, item.body.trelloUrl, item.body.sourcePermalink, item.body.jiraUrl]);
  const resultUrl = item.result ? firstUrl([item.result.url]) : null;
  const resultLabel = item.result && typeof item.result.jiraKey === 'string' && item.result.jiraKey ? item.result.jiraKey : 'Result';
  const approve = approveActionFor(item);
  const dismiss = dismissActionFor(item);
  const failedInWork = itemFailedInWork(item);
  const draggable = column === 'approval' || column === 'ready' || column === 'in_qa';
  const stop = (event: { stopPropagation: () => void }) => event.stopPropagation();
  const submitFeedback = () => { if (!feedback.trim()) return; onSendBack(item, feedback.trim()); onSendBackOpen(false); };
  const openSession = session ? <Button size="sm" variant="ghost" onClick={() => onOpenSession(item)}><SquareArrowOutUpRight className="h-3 w-3" />Open session</Button> : null;
  const review = <Button size="sm" variant="ghost" onClick={() => onOpenItem(item)}><Eye className="h-3 w-3" />Review</Button>;
  return <article role="listitem" draggable={draggable} onDragStart={(event) => { event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', item.item_id); onDragStart(); }} onDragEnd={onDragEnd} className={`rounded-xl border border-border/70 bg-card p-3 shadow-sm transition-shadow hover:shadow ${draggable ? 'cursor-grab active:cursor-grabbing' : ''}`}>
    <button type="button" onClick={() => onOpenItem(item)} className="block w-full rounded-lg text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" title="Open in inbox">
      <span className="flex min-w-0 items-center gap-1.5 text-[10px] text-muted-foreground"><BotIcon icon={bot?.icon} size={12} /><span className="min-w-0 flex-1 truncate">{bot?.title ?? item.section_id}</span>{column === 'in_progress' ? <StatusPill status={item.status} /> : null}<span className="shrink-0">{formatAge(item.updated_at)}</span></span>
      <span className="mt-1.5 line-clamp-2 break-words text-xs font-semibold text-foreground">{item.title}</span>
      {client || projectName ? <span className="mt-1.5 flex flex-wrap gap-1">{client ? <span className="max-w-full truncate rounded-full bg-primary/10 px-2 py-0.5 text-[10px] text-primary">{client}</span> : null}{projectName ? <span className="max-w-full truncate rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground" title={session ? 'Work session project' : 'Routed project'}>{session ? '' : '→ '}{projectName}</span> : null}</span> : null}
      {session ? <span className="mt-1 block truncate text-[10px] text-muted-foreground">{session.provider}{session.model ? ` · ${session.model}` : ''}</span> : null}
      {column === 'blocked' && item.error ? <span className="mt-1.5 line-clamp-2 break-words text-[10px] text-destructive">{item.error}</span> : null}
    </button>
    {sourceUrl || resultUrl ? <div className="mt-1.5 flex flex-wrap gap-2 text-[10px]">{sourceUrl ? <a href={sourceUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">Source <ExternalLink className="h-3 w-3" /></a> : null}{resultUrl ? <a href={resultUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-emerald-700 underline-offset-2 hover:underline dark:text-emerald-300">{resultLabel} <ExternalLink className="h-3 w-3" /></a> : null}</div> : null}
    <div className="mt-2 flex flex-wrap items-center gap-1" onClick={stop}>
      {column === 'approval' ? (approve ? <><Button size="sm" onClick={() => onAction(item, approve)} title={getActionSemantics(approve, item.title, { hasDraft: itemHasDraft(item) }).detail}><Send className="h-3 w-3" />{getActionSemantics(approve, item.title, { hasDraft: itemHasDraft(item) }).label}</Button>{dismiss ? <Button size="sm" variant="ghost" onClick={() => onAction(item, dismiss)}><X className="h-3 w-3" />Deny</Button> : null}</> : review) : null}
      {column === 'ready' ? <><Button size="sm" onClick={() => onStartWork(item)} title={projectName ? `Start work in ${projectName}` : 'Choose a project in the inbox'}><Play className="h-3 w-3" />Start work</Button>{dismiss ? <Button size="sm" variant="ghost" onClick={() => onAction(item, dismiss)}>Dismiss</Button> : null}</> : null}
      {column === 'in_progress' || column === 'done' ? openSession : null}
      {column === 'in_qa' ? <>{openSession}<Button size="sm" onClick={() => onAcceptWork(item)}><Check className="h-3 w-3" />Accept</Button><Button size="sm" variant="outline" onClick={() => onSendBackOpen(!sendingBack)} aria-expanded={sendingBack}><CornerUpLeft className="h-3 w-3" />Send back</Button>{dismiss ? <Button size="sm" variant="ghost" onClick={() => onAction(item, dismiss)}>Dismiss</Button> : null}</> : null}
      {column === 'blocked' ? (failedInWork ? <>{openSession}{session ? <Button size="sm" variant="outline" onClick={() => onRetryWork(item)}><RefreshCw className="h-3 w-3" />Retry work</Button> : <Button size="sm" onClick={() => onStartWork(item)}><Play className="h-3 w-3" />Start work</Button>}{dismiss ? <Button size="sm" variant="ghost" onClick={() => onAction(item, dismiss)}>Dismiss</Button> : null}</> : <><Button size="sm" variant="outline" onClick={() => onRetry(item)}><RefreshCw className="h-3 w-3" />Retry</Button>{review}</>) : null}
    </div>
    {sendingBack ? <div className="mt-2" onClick={stop}><textarea autoFocus aria-label={`Feedback for ${item.title}`} value={feedback} onChange={(event) => setFeedback(event.target.value)} onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); onSendBackOpen(false); } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); submitFeedback(); } }} placeholder="What should the session change or fix?" className="min-h-16 w-full resize-y rounded-lg border border-border bg-background px-2.5 py-2 text-xs leading-5 outline-none focus:border-primary focus:ring-2 focus:ring-primary/10" /><div className="mt-1 flex items-center gap-1"><Button size="sm" disabled={!feedback.trim()} onClick={submitFeedback}><Send className="h-3 w-3" />Send</Button><Button size="sm" variant="ghost" onClick={() => onSendBackOpen(false)}>Cancel</Button><span className="ml-auto text-[9px] text-muted-foreground">Esc cancels</span></div></div> : null}
  </article>;
}

export default function BoardView({ items, bots, projects, search, onOpenItem, onAction, onOpenSession, onStartWork, onAcceptWork, onSendBack, onRetryWork, onRetry }: BoardViewProps) {
  const [botFilter, setBotFilter] = useState<string | null>(null);
  const filter = botFilter ?? defaultBoardBotFilter(bots);
  const board = useMemo(() => buildBoard(items, bots, filter, search), [bots, filter, items, search]);
  const [dragging, setDragging] = useState<{ item: McItem; from: BoardColumn } | null>(null);
  const [dropTarget, setDropTarget] = useState<BoardColumn | null>(null);
  const [sendBackId, setSendBackId] = useState<string | null>(null);
  const botFor = (item: McItem) => bots.find((bot) => bot.section_id === item.section_id);
  const dropFor = (to: BoardColumn) => (dragging && dragging.from !== to ? boardDropFor(dragging.from, to, dragging.item, botFor(dragging.item)) : null);
  const endDrag = () => { setDragging(null); setDropTarget(null); };
  const drop = (event: DragEvent<HTMLElement>, to: BoardColumn) => {
    const kind = dropFor(to);
    if (!dragging || !kind) return;
    event.preventDefault();
    const { item } = dragging;
    endDrag();
    const approve = approveActionFor(item);
    if (kind === 'approve' && approve) onAction(item, approve);
    else if (kind === 'start_work') onStartWork(item);
    else if (kind === 'accept') onAcceptWork(item);
    else if (kind === 'send_back') setSendBackId(item.item_id);
  };
  const handlers = { projects, onOpenItem, onAction, onOpenSession, onStartWork, onAcceptWork, onSendBack, onRetryWork, onRetry };
  return <section className="flex min-h-0 flex-1 flex-col">
    <div className="flex flex-wrap items-center gap-2 border-b border-border/70 bg-background px-4 py-3 sm:px-5">
      <div className="min-w-0 flex-1"><p className="text-sm font-semibold">Board</p><p className="text-[10px] text-muted-foreground">Every item from Propose to Done. Drag a card to approve, start work, accept, or send back — or use its buttons.</p></div>
      <select value={filter} onChange={(event) => setBotFilter(event.target.value)} aria-label="Filter board by bot" className="h-9 min-w-44 rounded-lg border border-border bg-background px-2.5 text-xs outline-none focus:border-primary focus:ring-2 focus:ring-primary/10">
        <option value={BOARD_FILTER_WORK}>Bots with work sessions</option>
        <option value={BOARD_FILTER_ALL}>All bots</option>
        {bots.map((bot) => <option key={bot.section_id} value={bot.section_id}>{bot.title}</option>)}
      </select>
    </div>
    <div className="min-h-0 flex-1 overflow-x-auto overflow-y-auto p-3 sm:p-4">
      <div className="flex min-h-full flex-col gap-3 md:flex-row md:items-stretch">
        {BOARD_COLUMNS.map((column) => {
          const cards = board.columns[column.key];
          const valid = Boolean(dropFor(column.key));
          return <section key={column.key} aria-label={`${column.label} · ${cards.length}`} onDragOver={(event) => { if (!valid) return; event.preventDefault(); event.dataTransfer.dropEffect = 'move'; if (dropTarget !== column.key) setDropTarget(column.key); }} onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropTarget((current) => (current === column.key ? null : current)); }} onDrop={(event) => drop(event, column.key)} className={`flex min-h-40 flex-col rounded-2xl border bg-muted/20 transition-colors md:w-[272px] md:min-w-[260px] md:shrink-0 ${valid ? (dropTarget === column.key ? 'border-primary bg-primary/10' : 'border-dashed border-primary/50 bg-primary/5') : 'border-border/70'}`}>
            <header className="flex items-center justify-between gap-2 px-3 py-2.5"><h3 className="text-xs font-semibold">{column.label}</h3><span className="rounded-full bg-background px-2 py-0.5 text-[10px] font-medium tabular-nums text-muted-foreground">{cards.length}</span></header>
            <div role="list" className="flex min-h-0 flex-1 flex-col gap-2 px-2 pb-2 md:overflow-y-auto">
              {cards.map((item) => <BoardCard key={item.item_id} {...handlers} item={item} bot={botFor(item)} column={boardColumnFor(item, botFor(item)) ?? column.key} sendingBack={sendBackId === item.item_id} onSendBackOpen={(open) => setSendBackId(open ? item.item_id : null)} onDragStart={() => setDragging({ item, from: column.key })} onDragEnd={endDrag} />)}
              {cards.length === 0 ? <p className="rounded-xl border border-dashed border-border px-3 py-6 text-center text-[11px] text-muted-foreground">{column.empty}</p> : null}
              {column.key === 'done' && board.olderDone ? <p className="px-1 text-center text-[10px] text-muted-foreground">+{board.olderDone} older not shown</p> : null}
            </div>
          </section>;
        })}
      </div>
    </div>
  </section>;
}
