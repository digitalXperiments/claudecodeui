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
  selectedTaskIds?: Set<string>;
  onToggleSelect?: (taskId: string) => void;
  accentIndex?: number;
};

/** Cycling through these on the WIP badge toggles the column's limit. */
const WIP_PRESETS = [undefined, 1, 2, 3, 5] as const;
const COLUMN_ACCENTS = [
  { shell: 'from-slate-500/[0.07] to-card/70', rail: 'from-slate-400 to-slate-600', icon: 'bg-slate-500/15 text-slate-600 dark:text-slate-300' },
  { shell: 'from-sky-500/[0.09] to-card/70', rail: 'from-sky-400 to-blue-600', icon: 'bg-sky-500/15 text-sky-700 dark:text-sky-300' },
  { shell: 'from-violet-500/[0.09] to-card/70', rail: 'from-violet-400 to-purple-600', icon: 'bg-violet-500/15 text-violet-700 dark:text-violet-300' },
  { shell: 'from-amber-500/[0.09] to-card/70', rail: 'from-amber-400 to-orange-500', icon: 'bg-amber-500/15 text-amber-700 dark:text-amber-300' },
  { shell: 'from-emerald-500/[0.09] to-card/70', rail: 'from-emerald-400 to-green-600', icon: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300' },
] as const;

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
  selectedTaskIds,
  onToggleSelect,
  accentIndex = 0,
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
  const accent = COLUMN_ACCENTS[accentIndex % COLUMN_ACCENTS.length];

  return (
    <div className={cn('relative flex h-full w-[min(21rem,calc(100vw-2rem))] shrink-0 snap-center flex-col overflow-hidden rounded-2xl border border-border/50 bg-gradient-to-b shadow-sm md:w-80', accent.shell)}>
      <div className={cn('h-1 w-full shrink-0 bg-gradient-to-r', accent.rail)} />
      <div className="flex flex-shrink-0 items-center justify-between gap-2 border-b border-border/30 px-3.5 py-3">
        <div className="flex min-w-0 items-center gap-1.5 text-sm font-semibold text-foreground">
          <span className={cn('flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-[10px] font-bold', accent.icon)}>{String(accentIndex + 1).padStart(2, '0')}</span>
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
                'rounded-full px-2 py-0.5 text-[10px] font-semibold transition-colors hover:bg-accent',
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
          'flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto overscroll-contain p-2.5 transition-colors',
          isOver && 'bg-primary/10 ring-2 ring-inset ring-primary/20',
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
              selected={selectedTaskIds?.has(task.task_id)}
              onToggleSelect={onToggleSelect}
            />
          ))}
        </SortableContext>
        {sortedTasks.length === 0 ? (
          <button
            type="button"
            onClick={() => onAddTask(column.id)}
            className="flex min-h-28 flex-1 flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border/70 bg-background/30 text-xs text-muted-foreground transition hover:border-primary/35 hover:bg-primary/[0.04] hover:text-foreground"
          >
            <Plus className="h-4 w-4" />
            Add or drop a task
          </button>
        ) : null}
      </div>
    </div>
  );
}
