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
  onToggleRunOnEnter: (columnId: string, runOnEnter: boolean) => void;
  onSetColumnWipLimit: (columnId: string, wipLimit?: number) => void;
  projectNameById: Map<string, string> | null;
  /** Lookup for dependency titles on cards. */
  taskById?: Map<string, KanbanTask>;
};

/** Cycling through these on the WIP badge toggles the column's limit. */
const WIP_PRESETS = [undefined, 1, 2, 3, 5] as const;

function nextWipPreset(current?: number): number | undefined {
  const index = WIP_PRESETS.findIndex((p) => p === current);
  return WIP_PRESETS[(index + 1) % WIP_PRESETS.length];
}

export default function KanbanColumn({
  column,
  tasks,
  onOpenTask,
  onAddTask,
  onToggleRunOnEnter,
  onSetColumnWipLimit,
  projectNameById,
  taskById,
}: KanbanColumnProps) {
  const { setNodeRef, isOver } = useDroppable({
    id: `column:${column.id}`,
    data: { type: 'column', columnId: column.id },
  });

  const sortedTasks = [...tasks].sort((a, b) => a.position - b.position);
  const activeCount = sortedTasks.filter(
    (t) => t.status === 'queued' || t.status === 'running',
  ).length;
  const hasWip = typeof column.wipLimit === 'number' && column.wipLimit >= 0;
  const atWip = hasWip && activeCount >= (column.wipLimit as number);

  return (
    <div className="flex h-full w-[min(20rem,calc(100vw-2rem))] shrink-0 snap-center flex-col rounded-lg bg-muted/40 md:w-72">
      <div className="flex flex-shrink-0 items-center justify-between gap-2 px-3 py-2">
        <div className="flex min-w-0 items-center gap-1.5 text-sm font-semibold text-foreground">
          <span className="truncate">{column.name}</span>
          <Tooltip
            content={
              hasWip
                ? `WIP limit ${column.wipLimit} — click to change (active ${activeCount})`
                : 'No WIP limit — click to set a limit on active tasks'
            }
            position="top"
          >
            <button
              type="button"
              onClick={() => onSetColumnWipLimit(column.id, nextWipPreset(column.wipLimit))}
              className={cn(
                'rounded px-1.5 text-xs font-normal transition-colors hover:bg-accent',
                hasWip
                  ? atWip
                    ? 'bg-destructive/15 text-destructive'
                    : 'bg-muted text-muted-foreground'
                  : 'bg-muted text-muted-foreground',
              )}
              aria-label={`WIP limit for ${column.name}`}
              title={`WIP limit ${hasWip ? column.wipLimit : 'off'} (${activeCount} active)`}
            >
              {hasWip ? `${activeCount}/${column.wipLimit}` : sortedTasks.length}
            </button>
          </Tooltip>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <Tooltip
            content={
              column.runOnEnter
                ? 'Auto-run is ON — tasks run when moved here'
                : 'Toggle auto-run when tasks enter this column'
            }
            position="top"
          >
            <Button
              variant="ghost"
              size="icon"
              className={cn(
                'h-9 w-9 touch-manipulation md:h-6 md:w-6',
                column.runOnEnter ? 'text-amber-500' : 'text-muted-foreground',
              )}
              onClick={() => onToggleRunOnEnter(column.id, !column.runOnEnter)}
              aria-label={`Toggle auto-run for ${column.name}`}
              aria-pressed={Boolean(column.runOnEnter)}
            >
              <Zap className="h-3.5 w-3.5" />
            </Button>
          </Tooltip>
          <Button
            variant="ghost"
            size="icon"
            className="h-9 w-9 touch-manipulation md:h-6 md:w-6"
            onClick={() => onAddTask(column.id)}
            aria-label={`Add task to ${column.name}`}
          >
            <Plus className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <div
        ref={setNodeRef}
        className={cn(
          'flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto overscroll-contain px-2 pb-2 transition-colors',
          isOver && 'bg-primary/5',
        )}
      >
        <SortableContext items={sortedTasks.map((t) => t.task_id)} strategy={verticalListSortingStrategy}>
          {sortedTasks.map((task) => (
            <KanbanCard
              key={task.task_id}
              task={task}
              onOpen={onOpenTask}
              projectName={projectNameById ? projectNameById.get(task.project_id) ?? null : null}
              taskById={taskById}
            />
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
