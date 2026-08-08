import { useEffect, useMemo, useRef, useState } from 'react';
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
import { AlertTriangle, Archive, Check, Loader2, Plus, RefreshCw, SquareKanban, Table2, Trash2, X } from 'lucide-react';

import { Button } from '../../../shared/view/ui';
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
  /** Optional project list from the sidebar so the picker is instant. */
  projects?: Project[];
};

/**
 * Keeps a stable reference across renders as long as the serialized content
 * is unchanged. The 2.5s board poll (below) replaces `board`/`projects` with
 * fresh objects every tick even when nothing actually changed, which would
 * otherwise re-trigger every effect/memo downstream that depends on these
 * (e.g. TaskEditor's project/column props) on every single poll.
 */
function useStableByContent<T>(value: T): T {
  const key = JSON.stringify(value);
  const ref = useRef<{ key: string; value: T }>({ key, value });
  if (ref.current.key !== key) {
    ref.current = { key, value };
  }
  return ref.current.value;
}

function columnIdFromOver(overId: string, tasks: KanbanTask[]): string | null {
  if (overId.startsWith('column:')) {
    return overId.slice('column:'.length);
  }
  const overTask = tasks.find((t) => t.task_id === overId);
  return overTask ? overTask.column_id : null;
}

export default function KanbanView({ selectedProject, isVisible, projects: projectsProp }: KanbanViewProps) {
  // The board is always the single cross-project global board.
  const board = useKanbanBoard();
  // The sidebar's selected project is only used to pre-select a project when
  // creating a new task — it never scopes the board.
  const defaultProjectId = selectedProject?.projectId ?? null;

  const [editorOpen, setEditorOpen] = useState(false);
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null);
  const [draftColumnId, setDraftColumnId] = useState<string | null>(null);
  const [activeTask, setActiveTask] = useState<KanbanTask | null>(null);
  const [view, setView] = useState<'board' | 'matrix'>('board');
  const [selectedTaskIds, setSelectedTaskIds] = useState<Set<string>>(new Set());
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [archivedTasks, setArchivedTasks] = useState<KanbanTask[]>([]);
  const [bulkBusy, setBulkBusy] = useState(false);

  const boardTasks = useMemo(() => board.tasks ?? [], [board.tasks]);
  // Derive the edited task from live board state so run status/output refresh.
  const editingTask = editingTaskId
    ? boardTasks.find((t) => t.task_id === editingTaskId) ?? null
    : null;
  const anyActive = boardTasks.some((t) => t.status === 'running' || t.status === 'queued');
  const selectedTasks = boardTasks.filter((task) => selectedTaskIds.has(task.task_id));

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

  // Prefer board-loaded projects; fall back to sidebar list for empty/loading states.
  const projectOptionsRaw = useMemo(() => {
    if ((board.projects ?? []).length > 0) {
      return board.projects;
    }
    return (projectsProp ?? []).map((p) => ({
      projectId: p.projectId,
      displayName: p.displayName,
    }));
  }, [board.projects, projectsProp]);
  const projectOptions = useStableByContent(projectOptionsRaw);

  // projectId -> display name, for badges + dependency labels.
  const projectNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const project of projectOptions) {
      map.set(project.projectId, project.displayName);
    }
    if (selectedProject?.projectId && selectedProject.displayName) {
      map.set(selectedProject.projectId, selectedProject.displayName);
    }
    return map;
  }, [projectOptions, selectedProject]);

  // taskId -> task, for card "blocked by" labels and dependency UI.
  const taskById = useMemo(() => {
    const map = new Map<string, KanbanTask>();
    for (const task of boardTasks) {
      map.set(task.task_id, task);
    }
    return map;
  }, [boardTasks]);

  // While a run is queued/in flight, poll so implement→review→done transitions land.
  // Paused mid-drag: a poll tick replaces every task/board object with a fresh
  // reference, which confuses dnd-kit's in-progress drag state (cards visibly
  // snapping/resetting under the pointer).
  const isDragging = activeTask !== null;
  useEffect(() => {
    if (!anyActive || !isVisible || isDragging) {
      return;
    }
    const refresh = board.refreshTasks;
    const timer = setInterval(() => {
      void refresh();
    }, 2500);
    return () => clearInterval(timer);
  }, [anyActive, isVisible, isDragging, board.refreshTasks]);

  const columns = useStableByContent(board.board?.columns ?? []);

  if (!isVisible) {
    return null;
  }

  const openNewTask = (columnId: string) => {
    setEditingTaskId(null);
    setDraftColumnId(columnId);
    setEditorOpen(true);
  };

  const toggleSelected = (taskId: string) => {
    setSelectedTaskIds((previous) => {
      const next = new Set(previous);
      if (next.has(taskId)) next.delete(taskId); else next.add(taskId);
      return next;
    });
  };

  const runBulk = async (action: 'delete' | 'archive' | 'move', columnId?: string) => {
    if (!selectedTasks.length) return;
    if (action === 'delete' && !window.confirm(`Delete ${selectedTasks.length} task${selectedTasks.length === 1 ? '' : 's'}?`)) return;
    const targets = action === 'archive' ? selectedTasks.filter((task) => task.status === 'done') : selectedTasks;
    if (!targets.length) return;
    setBulkBusy(true);
    try {
      await Promise.all(targets.map((task) => action === 'delete'
        ? board.deleteTask(task.task_id)
        : action === 'archive'
          ? board.archiveTask(task.task_id)
          : board.updateTask(task.task_id, { columnId })));
      setSelectedTaskIds(new Set());
    } finally {
      setBulkBusy(false);
    }
  };

  const loadArchived = async () => {
    setArchivedTasks(await kanbanApi.listArchivedTasks());
    setArchivedOpen(true);
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

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      <div className="flex flex-shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2 pr-14 pt-[max(0.5rem,env(safe-area-inset-top))] md:px-4 md:pr-12 md:pt-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <SquareKanban className="h-4 w-4 shrink-0" />
            <span className="truncate">Global board</span>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1.5 md:gap-2">
          <Button variant="ghost" size="sm" className="h-10 gap-1 md:h-8" onClick={() => void loadArchived()}>
            <Archive className="h-4 w-4" /> <span className="hidden sm:inline">Archived</span>
          </Button>
          <Button
            variant={view === 'matrix' ? 'secondary' : 'ghost'}
            size="icon"
            className="h-10 w-10 touch-manipulation md:h-8 md:w-8"
            onClick={() => setView((prev) => (prev === 'board' ? 'matrix' : 'board'))}
            aria-label="Toggle permission matrix"
          >
            <Table2 className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-10 w-10 touch-manipulation md:h-8 md:w-8"
            onClick={() => void board.reload()}
          >
            <RefreshCw className="h-4 w-4" />
          </Button>
          <Button
            size="sm"
            className="h-10 touch-manipulation gap-1 md:h-8"
            onClick={() => openNewTask(columns[0]?.id ?? 'backlog')}
            disabled={!board.board}
          >
            <Plus className="h-4 w-4" />
            <span className="hidden sm:inline">New task</span>
            <span className="sm:hidden">New</span>
          </Button>
        </div>
      </div>

      {selectedTasks.length > 0 ? (
        <div
          className="flex flex-shrink-0 flex-wrap items-center gap-2 border-b border-primary/20 bg-primary/5 px-3 py-2.5 md:px-4"
          role="toolbar"
          aria-label="Bulk task actions"
        >
          <span className="mr-1 inline-flex h-8 items-center rounded-md bg-primary/10 px-2.5 text-sm font-medium text-primary">
            {selectedTasks.length} selected
          </span>
          <select
            className="h-8 rounded-md border border-border bg-background px-2.5 text-sm shadow-sm outline-none transition-colors focus:border-primary focus:ring-2 focus:ring-primary/20"
            value=""
            disabled={bulkBusy}
            onChange={(event) => { if (event.target.value) void runBulk('move', event.target.value); }}
          >
            <option value="">Change list…</option>
            {columns.map((column) => <option key={column.id} value={column.id}>{column.name}</option>)}
          </select>
          <Button size="sm" variant="secondary" className="h-8 gap-1 shadow-sm" disabled={bulkBusy || !selectedTasks.some((task) => task.status === 'done')} onClick={() => void runBulk('archive')}>
            <Archive className="h-4 w-4" /> Archive done
          </Button>
          <Button size="sm" variant="destructive" className="h-8 gap-1 shadow-sm" disabled={bulkBusy} onClick={() => void runBulk('delete')}>
            <Trash2 className="h-4 w-4" /> Delete
          </Button>
          <Button size="sm" variant="ghost" className="h-8" disabled={bulkBusy} onClick={() => setSelectedTaskIds(new Set())}>Clear</Button>
        </div>
      ) : null}

      <div className="hidden flex-shrink-0 border-b border-border bg-muted/30 px-4 py-1.5 text-[11px] text-muted-foreground md:block">
        Cross-project board. Each task belongs to a project you pick. Link tasks with{' '}
        <strong className="font-medium text-foreground/80">Depends on</strong> — when a dependency
        finishes, the next task auto-runs if it has an implementation agent.
      </div>

      {board.error ? (
        <div className="flex flex-shrink-0 items-start gap-2 border-b border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive md:px-4">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span className="min-w-0 flex-1 break-words">{board.error}</span>
          <Button variant="ghost" size="sm" className="touch-manipulation" onClick={board.clearError}>
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
          <div className="flex min-h-0 flex-1 snap-x snap-mandatory gap-3 overflow-x-auto overflow-y-hidden p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] md:snap-none md:p-4">
            {columns.map((column) => (
              <KanbanColumn
                key={column.id}
                column={column}
                tasks={tasksByColumn.get(column.id) ?? []}
                onOpenTask={openEditTask}
                onAddTask={openNewTask}
                onToggleRunOnEnter={board.setColumnRunOnEnter}
                onSetColumnWipLimit={board.setColumnWipLimit}
                projectNameById={projectNameById}
                taskById={taskById}
                selectedTaskIds={selectedTaskIds}
                onToggleSelect={toggleSelected}
              />
            ))}
          </div>
          <DragOverlay>
            {activeTask ? (
              <KanbanCard task={activeTask} onOpen={() => undefined} taskById={taskById} />
            ) : null}
          </DragOverlay>
        </DndContext>
      )}

      {archivedOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4" role="dialog" aria-modal="true" aria-label="Archived tasks">
          <div className="flex max-h-[80vh] w-full max-w-2xl flex-col rounded-lg border border-border bg-background shadow-xl">
            <div className="flex items-center justify-between border-b border-border px-4 py-3">
              <div><h2 className="font-semibold">Archived tasks</h2><p className="text-xs text-muted-foreground">Done tasks hidden from the board.</p></div>
              <Button variant="ghost" size="icon" onClick={() => setArchivedOpen(false)} aria-label="Close archived tasks"><X className="h-4 w-4" /></Button>
            </div>
            <div className="min-h-0 space-y-2 overflow-y-auto p-4">
              {archivedTasks.length === 0 ? <p className="py-8 text-center text-sm text-muted-foreground">No archived tasks.</p> : archivedTasks.map((task) => (
                <div key={task.task_id} className="flex items-center gap-3 rounded-md border border-border p-3">
                  <Check className="h-4 w-4 shrink-0 text-green-600" />
                  <button className="min-w-0 flex-1 truncate text-left text-sm font-medium hover:underline" onClick={() => { setArchivedOpen(false); openEditTask(task); }}>{task.title}</button>
                  <Button size="sm" variant="outline" onClick={async () => { await board.restoreTask(task.task_id); setArchivedTasks((items) => items.filter((item) => item.task_id !== task.task_id)); }}>Restore</Button>
                </div>
              ))}
            </div>
          </div>
        </div>
      ) : null}

      <TaskEditor
        open={editorOpen}
        task={editingTask}
        draft={draftColumnId ? { columnId: draftColumnId } : null}
        columns={columns}
        allTasks={boardTasks}
        projects={projectOptions}
        requireProject
        defaultProjectId={defaultProjectId}
        projectNameById={projectNameById}
        onClose={() => setEditorOpen(false)}
        onCreate={async (input) => {
          // requireProject guarantees a project is picked before this fires.
          if (!board.board || !input.projectId) {
            return;
          }
          const created = await board.createTask({
            boardId: board.board.board_id,
            ...input,
            projectId: input.projectId,
          });
          return created;
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
