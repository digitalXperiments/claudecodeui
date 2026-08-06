import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Ban, Calendar, Clock, FolderGit2, GitBranch, Loader2 } from 'lucide-react';

import { Badge } from '../../../shared/view/ui';
import { cn } from '../../../lib/utils';
import { KANBAN_PROVIDERS, type KanbanTask, type KanbanTaskStatus } from '../types';

const STATUS_STYLES: Record<KanbanTaskStatus, string> = {
  todo: 'bg-secondary text-secondary-foreground',
  queued: 'bg-blue-500/15 text-blue-600 dark:text-blue-400',
  running: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
  done: 'bg-green-500/15 text-green-600 dark:text-green-400',
  failed: 'bg-destructive/15 text-destructive',
  blocked: 'bg-muted text-muted-foreground',
};

function providerLabel(provider: string | null | undefined): string | null {
  if (!provider) {
    return null;
  }
  return KANBAN_PROVIDERS.find((p) => p.value === provider)?.label ?? provider;
}

type KanbanCardProps = {
  task: KanbanTask;
  onOpen: (task: KanbanTask) => void;
  /** Project name to badge on the card (global board only). */
  projectName?: string | null;
  /** Board task map for resolving dependency titles. */
  taskById?: Map<string, KanbanTask>;
};

export default function KanbanCard({
  task,
  onOpen,
  projectName = null,
  taskById,
}: KanbanCardProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: task.task_id,
    data: { type: 'task', columnId: task.column_id },
  });

  const style = {
    transform: CSS.Translate.toString(transform),
    transition,
  };

  const implementLabel = providerLabel(task.assignee_provider);
  const reviewLabel = providerLabel(task.review_provider);
  const deps = task.dependsOn ?? [];
  const openDeps: KanbanTask[] = [];
  for (const id of deps) {
    const dep = taskById?.get(id);
    if (dep && dep.status !== 'done') {
      openDeps.push(dep);
    }
  }
  const blockedByTitles = openDeps.slice(0, 2).map((t) => t.title);

  const dueAt = task.due_date ? new Date(task.due_date).getTime() : null;
  const overdue =
    dueAt !== null &&
    !Number.isNaN(dueAt) &&
    dueAt < Date.now() &&
    task.status !== 'done' &&
    task.status !== 'failed';

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      onClick={() => onOpen(task)}
      className={cn(
        'group cursor-grab touch-manipulation select-none rounded-md border border-border bg-card p-3 text-left shadow-sm transition-colors hover:border-primary/50 active:border-primary/40',
        isDragging && 'opacity-50',
        task.status === 'blocked' && 'border-amber-500/40',
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="text-sm font-medium leading-snug text-card-foreground">{task.title}</span>
        <Badge className={cn('shrink-0 gap-1', STATUS_STYLES[task.status])} variant="secondary">
          {task.status === 'running' && <Loader2 className="h-3 w-3 animate-spin" />}
          {task.status === 'blocked' && <Ban className="h-3 w-3" />}
          {task.status}
        </Badge>
      </div>

      {task.description ? (
        <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{task.description}</p>
      ) : null}

      {blockedByTitles.length > 0 ? (
        <p className="mt-1.5 line-clamp-2 text-[11px] text-amber-700 dark:text-amber-400">
          Waiting on: {blockedByTitles.join(', ')}
          {openDeps.length > 2 ? ` +${openDeps.length - 2}` : ''}
        </p>
      ) : null}

      <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
        {projectName ? (
          <Badge variant="outline" className="gap-1 font-normal">
            <FolderGit2 className="h-3 w-3" />
            {projectName}
          </Badge>
        ) : null}
        {implementLabel ? (
          <Badge variant="outline" className="font-normal" title="Implementation agent">
            {implementLabel}
          </Badge>
        ) : null}
        {reviewLabel ? (
          <Badge variant="outline" className="font-normal opacity-80" title="Review agent">
            rev: {reviewLabel}
          </Badge>
        ) : null}
        {deps.length > 0 ? (
          <span
            className="inline-flex items-center gap-0.5"
            title={`Depends on ${deps.length} task(s); auto-runs when all are done`}
          >
            <GitBranch className="h-3 w-3" />
            {deps.length}
          </span>
        ) : null}
        {task.schedule_cron ? (
          <span className="inline-flex items-center gap-0.5">
            <Clock className="h-3 w-3" />
            {task.schedule_cron}
          </span>
        ) : null}
        {task.due_date ? (
          <span
            className={cn(
              'inline-flex items-center gap-0.5',
              overdue ? 'font-medium text-destructive' : '',
            )}
            title={overdue ? 'Overdue' : `Due ${new Date(task.due_date).toLocaleString()}`}
          >
            <Calendar className="h-3 w-3" />
            {new Date(task.due_date).toLocaleDateString()}
          </span>
        ) : null}
        {task.feature_branch ? (
          <span className="inline-flex max-w-28 items-center gap-0.5 truncate" title={task.feature_branch}>
            <GitBranch className="h-3 w-3" />
            <span className="truncate">{task.feature_branch}</span>
          </span>
        ) : null}
      </div>
    </div>
  );
}
