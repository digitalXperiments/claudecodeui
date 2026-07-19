import { useEffect, useMemo, useState } from 'react';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCorners,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { AlertTriangle, Globe, Loader2, Plus, RefreshCw, SquareKanban, Table2 } from 'lucide-react';

import { Button } from '../../../shared/view/ui';
import { cn } from '../../../lib/utils';
import type { Project } from '../../../types/app';
import { useKanbanBoard } from '../hooks/useKanbanBoard';
import { kanbanApi } from '../api/kanbanApi';
import type { KanbanTask } from '../types';

import KanbanColumn from './KanbanColumn';
import KanbanCard from './KanbanCard';
import TaskEditor from './TaskEditor';
import PermissionMatrix from './PermissionMatrix';

type KanbanViewProps = {
  selectedProject: Project | null;
  isVisible: boolean;
};

function columnIdFromOver(overId: string, tasks: KanbanTask[]): string | null {
  if (overId.startsWith('column:')) {
    return overId.slice('column:'.length);
  }
  const overTask = tasks.find((t) => t.task_id === overId);
  return overTask ? overTask.column_id : null;
}

export default function KanbanView({ selectedProject, isVisible }: KanbanViewProps) {
  const projectId = selectedProject?.projectId ?? null;
  const [scope, setScope] = useState<'project' | 'global'>('project');
  const board = useKanbanBoard(projectId, scope);
  const isGlobal = scope === 'global';

  const [editorOpen, setEditorOpen] = useState(false);
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null);
  const [draftColumnId, setDraftColumnId] = useState<string | null>(null);
  const [activeTask, setActiveTask] = useState<KanbanTask | null>(null);
  const [view, setView] = useState<'board' | 'matrix'>('board');

  const boardTasks = useMemo(() => board.tasks ?? [], [board.tasks]);
  // Derive the edited task from live board state so run status/output refresh.
  const editingTask = editingTaskId
    ? boardTasks.find((t) => t.task_id === editingTaskId) ?? null
    : null;
  const anyActive = boardTasks.some((t) => t.status === 'running' || t.status === 'queued');

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );

  const tasksByColumn = useMemo(() => {
    const map = new Map<string, KanbanTask[]>();
    for (const task of boardTasks) {
      const list = map.get(task.column_id) ?? [];
      list.push(task);
      map.set(task.column_id, list);
    }
    return map;
  }, [boardTasks]);

  // projectId -> display name, for the global board's per-card project badges.
  const projectNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const project of board.projects ?? []) {
      map.set(project.projectId, project.displayName);
    }
    return map;
  }, [board.projects]);

  // While a run is queued/in flight, poll so implement→review→done transitions land.
  useEffect(() => {
    if (!anyActive || !isVisible) {
      return;
    }
    const refresh = board.refreshTasks;
    const timer = setInterval(() => {
      void refresh();
    }, 2500);
    return () => clearInterval(timer);
  }, [anyActive, isVisible, board.refreshTasks]);

  if (!isVisible) {
    return null;
  }

  // The global board works without a selected project; the project board needs one.
  if (!selectedProject && !isGlobal) {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-3 text-center text-muted-foreground">
        <SquareKanban className="h-10 w-10 opacity-60" />
        <div className="text-sm">Select a project to open its Kanban board.</div>
        <Button variant="outline" size="sm" onClick={() => setScope('global')}>
          <Globe className="h-4 w-4" />
          Open the global board
        </Button>
      </div>
    );
  }

  const openNewTask = (columnId: string) => {
    setEditingTaskId(null);
    setDraftColumnId(columnId);
    setEditorOpen(true);
  };

  const openEditTask = (task: KanbanTask) => {
    setEditingTaskId(task.task_id);
    setDraftColumnId(null);
    setEditorOpen(true);
  };

  const handleDragStart = (event: DragStartEvent) => {
    const task = boardTasks.find((t) => t.task_id === event.active.id);
    setActiveTask(task ?? null);
  };

  const handleDragEnd = (event: DragEndEvent) => {
    setActiveTask(null);
    const { active, over } = event;
    if (!over) {
      return;
    }
    const activeId = String(active.id);
    const overId = String(over.id);
    const targetColumnId = columnIdFromOver(overId, boardTasks);
    if (!targetColumnId) {
      return;
    }

    const activeTaskItem = boardTasks.find((t) => t.task_id === activeId);
    if (!activeTaskItem) {
      return;
    }

    const columnTasks = (tasksByColumn.get(targetColumnId) ?? [])
      .filter((t) => t.task_id !== activeId)
      .sort((a, b) => a.position - b.position);

    let insertIndex = columnTasks.length;
    if (!overId.startsWith('column:')) {
      const overIndex = columnTasks.findIndex((t) => t.task_id === overId);
      insertIndex = overIndex === -1 ? columnTasks.length : overIndex;
    }

    const orderedIds = [
      ...columnTasks.slice(0, insertIndex).map((t) => t.task_id),
      activeId,
      ...columnTasks.slice(insertIndex).map((t) => t.task_id),
    ];

    const unchanged =
      activeTaskItem.column_id === targetColumnId &&
      orderedIds[insertIndex] === activeId &&
      activeTaskItem.position === insertIndex;
    if (unchanged) {
      return;
    }

    void board.reorderColumn(targetColumnId, orderedIds, activeId);
  };

  const columns = board.board?.columns ?? [];

  return (
    <div className="flex h-full w-full flex-col">
      <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-2">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <SquareKanban className="h-4 w-4" />
          {isGlobal ? 'Global board' : (selectedProject?.displayName ?? board.board?.name ?? 'Kanban')}
        </div>
        <div className="flex items-center gap-2">
          <div className="mr-1 flex items-center rounded-md border border-border p-0.5 text-xs">
            <button
              type="button"
              className={cn(
                'rounded px-2 py-1 transition-colors',
                !isGlobal ? 'bg-secondary text-secondary-foreground' : 'text-muted-foreground',
              )}
              onClick={() => setScope('project')}
              disabled={!selectedProject}
            >
              Project
            </button>
            <button
              type="button"
              className={cn(
                'inline-flex items-center gap-1 rounded px-2 py-1 transition-colors',
                isGlobal ? 'bg-secondary text-secondary-foreground' : 'text-muted-foreground',
              )}
              onClick={() => setScope('global')}
            >
              <Globe className="h-3 w-3" />
              Global
            </button>
          </div>
          <Button
            variant={view === 'matrix' ? 'secondary' : 'ghost'}
            size="icon"
            className="h-8 w-8"
            onClick={() => setView((prev) => (prev === 'board' ? 'matrix' : 'board'))}
            aria-label="Toggle permission matrix"
          >
            <Table2 className="h-4 w-4" />
          </Button>
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => void board.reload()}>
            <RefreshCw className="h-4 w-4" />
          </Button>
          <Button
            size="sm"
            onClick={() => openNewTask(columns[0]?.id ?? 'backlog')}
            disabled={!board.board}
          >
            <Plus className="h-4 w-4" />
            New task
          </Button>
        </div>
      </div>

      {board.error ? (
        <div className="flex items-center gap-2 border-b border-destructive/30 bg-destructive/10 px-4 py-2 text-sm text-destructive">
          <AlertTriangle className="h-4 w-4" />
          <span className="flex-1">{board.error}</span>
          <Button variant="ghost" size="sm" onClick={board.clearError}>
            Dismiss
          </Button>
        </div>
      ) : null}

      {board.loading && !board.board ? (
        <div className="flex flex-1 items-center justify-center text-muted-foreground">
          <Loader2 className="h-6 w-6 animate-spin" />
        </div>
      ) : view === 'matrix' ? (
        <PermissionMatrix tasks={boardTasks} onOpenTask={openEditTask} />
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCorners}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
        >
          <div className="flex flex-1 gap-3 overflow-x-auto p-4">
            {columns.map((column) => (
              <KanbanColumn
                key={column.id}
                column={column}
                tasks={tasksByColumn.get(column.id) ?? []}
                onOpenTask={openEditTask}
                onAddTask={openNewTask}
                onToggleRunOnEnter={board.setColumnRunOnEnter}
                projectNameById={isGlobal ? projectNameById : null}
              />
            ))}
          </div>
          <DragOverlay>
            {activeTask ? <KanbanCard task={activeTask} onOpen={() => undefined} /> : null}
          </DragOverlay>
        </DndContext>
      )}

      <TaskEditor
        open={editorOpen}
        task={editingTask}
        draft={draftColumnId ? { columnId: draftColumnId } : null}
        columns={columns}
        allTasks={boardTasks}
        projects={board.projects}
        requireProject={isGlobal}
        projectNameById={isGlobal ? projectNameById : null}
        onClose={() => setEditorOpen(false)}
        onCreate={async (input) => {
          if (!board.board) {
            return;
          }
          await board.createTask({ boardId: board.board.board_id, ...input });
        }}
        onUpdate={async (taskId, patch) => {
          await board.updateTask(taskId, patch);
        }}
        onDelete={board.deleteTask}
        onAddDependency={async (taskId, dependsOnTaskId) => {
          await board.addDependency(taskId, dependsOnTaskId);
        }}
        onRemoveDependency={async (taskId, dependsOnTaskId) => {
          await board.removeDependency(taskId, dependsOnTaskId);
        }}
        onRun={async (taskId) => {
          await kanbanApi.runTask(taskId);
          await board.refreshTasks();
        }}
      />
    </div>
  );
}
