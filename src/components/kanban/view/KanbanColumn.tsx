import { useDroppable } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { Plus, Zap } from 'lucide-react';

import { Button, Tooltip } from '../../../shared/view/ui';
import { cn } from '../../../lib/utils';
import type { KanbanColumn as KanbanColumnType, KanbanTask } from '../types';

import KanbanCard from './KanbanCard';

type KanbanColumnProps = {
  column: KanbanColumnType;
  tasks: KanbanTask[];
  onOpenTask: (task: KanbanTask) => void;
  onAddTask: (columnId: string) => void;
};

export default function KanbanColumn({ column, tasks, onOpenTask, onAddTask }: KanbanColumnProps) {
  const { setNodeRef, isOver } = useDroppable({
    id: `column:${column.id}`,
    data: { type: 'column', columnId: column.id },
  });

  const sortedTasks = [...tasks].sort((a, b) => a.position - b.position);

  return (
    <div className="flex h-full w-72 shrink-0 flex-col rounded-lg bg-muted/40">
      <div className="flex items-center justify-between gap-2 px-3 py-2">
        <div className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
          {column.name}
          <span className="rounded bg-muted px-1.5 text-xs font-normal text-muted-foreground">
            {sortedTasks.length}
          </span>
          {column.runOnEnter ? (
            <Tooltip content="Runs assigned tasks when moved here" position="top">
              <Zap className="h-3.5 w-3.5 text-amber-500" />
            </Tooltip>
          ) : null}
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          onClick={() => onAddTask(column.id)}
          aria-label={`Add task to ${column.name}`}
        >
          <Plus className="h-4 w-4" />
        </Button>
      </div>

      <div
        ref={setNodeRef}
        className={cn(
          'flex min-h-[60px] flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2 transition-colors',
          isOver && 'bg-primary/5',
        )}
      >
        <SortableContext items={sortedTasks.map((t) => t.task_id)} strategy={verticalListSortingStrategy}>
          {sortedTasks.map((task) => (
            <KanbanCard key={task.task_id} task={task} onOpen={onOpenTask} />
          ))}
        </SortableContext>
        {sortedTasks.length === 0 ? (
          <div className="flex flex-1 items-center justify-center rounded-md border border-dashed border-border/60 text-xs text-muted-foreground">
            Drop tasks here
          </div>
        ) : null}
      </div>
    </div>
  );
}
