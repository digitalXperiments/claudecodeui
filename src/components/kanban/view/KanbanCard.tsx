import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Clock, GitBranch, Loader2 } from 'lucide-react';

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

function providerLabel(provider: KanbanTask['assignee_provider']): string | null {
  if (!provider) {
    return null;
  }
  return KANBAN_PROVIDERS.find((p) => p.value === provider)?.label ?? provider;
}

type KanbanCardProps = {
  task: KanbanTask;
  onOpen: (task: KanbanTask) => void;
};

export default function KanbanCard({ task, onOpen }: KanbanCardProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: task.task_id,
    data: { type: 'task', columnId: task.column_id },
  });

  const style = {
    transform: CSS.Translate.toString(transform),
    transition,
  };

  const provider = providerLabel(task.assignee_provider);

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      onClick={() => onOpen(task)}
      className={cn(
        'group cursor-grab select-none rounded-md border border-border bg-card p-3 text-left shadow-sm transition-colors hover:border-primary/50',
        isDragging && 'opacity-50',
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="text-sm font-medium leading-snug text-card-foreground">{task.title}</span>
        <Badge className={cn('shrink-0 gap-1', STATUS_STYLES[task.status])} variant="secondary">
          {task.status === 'running' && <Loader2 className="h-3 w-3 animate-spin" />}
          {task.status}
        </Badge>
      </div>

      {task.description ? (
        <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{task.description}</p>
      ) : null}

      <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
        {provider ? (
          <Badge variant="outline" className="font-normal">
            {provider}
          </Badge>
        ) : null}
        {task.dependsOn.length > 0 ? (
          <span className="inline-flex items-center gap-0.5">
            <GitBranch className="h-3 w-3" />
            {task.dependsOn.length}
          </span>
        ) : null}
        {task.schedule_cron ? (
          <span className="inline-flex items-center gap-0.5">
            <Clock className="h-3 w-3" />
            {task.schedule_cron}
          </span>
        ) : null}
      </div>
    </div>
  );
}
