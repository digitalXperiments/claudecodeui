import { useCallback, useEffect, useRef, useState } from 'react';

import { kanbanApi, type TaskPatch } from '../api/kanbanApi';
import type { KanbanBoard, KanbanTask } from '../types';

type BoardState = {
  board: KanbanBoard | null;
  tasks: KanbanTask[];
  loading: boolean;
  error: string | null;
};

/**
 * Loads (or lazily creates) the first Kanban board for a project and exposes
 * task mutations. Moves are applied optimistically and reverted on failure.
 */
export function useKanbanBoard(projectId: string | null) {
  const [state, setState] = useState<BoardState>({
    board: null,
    tasks: [],
    loading: false,
    error: null,
  });
  // Guards against races when the project changes mid-request.
  const activeProjectRef = useRef<string | null>(null);

  const load = useCallback(async (targetProjectId: string) => {
    activeProjectRef.current = targetProjectId;
    setState((prev) => ({ ...prev, loading: true, error: null }));
    try {
      let boards = await kanbanApi.listBoards(targetProjectId);
      if (boards.length === 0) {
        const created = await kanbanApi.createBoard(targetProjectId, 'Board');
        boards = [created];
      }
      const { board, tasks } = await kanbanApi.getBoard(boards[0].board_id);
      if (activeProjectRef.current !== targetProjectId) {
        return;
      }
      setState({ board, tasks, loading: false, error: null });
    } catch (error) {
      if (activeProjectRef.current !== targetProjectId) {
        return;
      }
      setState({
        board: null,
        tasks: [],
        loading: false,
        error: error instanceof Error ? error.message : 'Failed to load board',
      });
    }
  }, []);

  useEffect(() => {
    if (!projectId) {
      activeProjectRef.current = null;
      setState({ board: null, tasks: [], loading: false, error: null });
      return;
    }
    void load(projectId);
  }, [projectId, load]);

  const refreshTasks = useCallback(async () => {
    const boardId = state.board?.board_id;
    if (!boardId) {
      return;
    }
    const { board, tasks } = await kanbanApi.getBoard(boardId);
    setState((prev) => ({ ...prev, board, tasks }));
  }, [state.board?.board_id]);

  const upsertTask = useCallback((task: KanbanTask) => {
    setState((prev) => {
      const exists = prev.tasks.some((t) => t.task_id === task.task_id);
      const tasks = exists
        ? prev.tasks.map((t) => (t.task_id === task.task_id ? task : t))
        : [...prev.tasks, task];
      return { ...prev, tasks };
    });
  }, []);

  const createTask = useCallback(
    async (input: Parameters<typeof kanbanApi.createTask>[0]) => {
      const task = await kanbanApi.createTask(input);
      upsertTask(task);
      return task;
    },
    [upsertTask],
  );

  const updateTask = useCallback(
    async (taskId: string, patch: TaskPatch) => {
      const task = await kanbanApi.updateTask(taskId, patch);
      upsertTask(task);
      return task;
    },
    [upsertTask],
  );

  const deleteTask = useCallback(async (taskId: string) => {
    await kanbanApi.deleteTask(taskId);
    setState((prev) => ({ ...prev, tasks: prev.tasks.filter((t) => t.task_id !== taskId) }));
  }, []);

  /**
   * Optimistically move a task to a column/position, then persist. On failure,
   * restore the previous task list.
   */
  const moveTask = useCallback(
    async (taskId: string, columnId: string, position: number) => {
      let snapshot: KanbanTask[] = [];
      setState((prev) => {
        snapshot = prev.tasks;
        const tasks = prev.tasks.map((t) =>
          t.task_id === taskId ? { ...t, column_id: columnId, position } : t,
        );
        return { ...prev, tasks };
      });
      try {
        const task = await kanbanApi.updateTask(taskId, { columnId, position });
        upsertTask(task);
      } catch (error) {
        setState((prev) => ({
          ...prev,
          tasks: snapshot,
          error: error instanceof Error ? error.message : 'Failed to move task',
        }));
      }
    },
    [upsertTask],
  );

  /**
   * Apply a drag result: `orderedIds` is the full task order for `columnId`
   * after the move. Renumbers positions locally, then persists every affected
   * task. On failure the previous list is restored.
   */
  const reorderColumn = useCallback(
    async (columnId: string, orderedIds: string[]) => {
      let snapshot: KanbanTask[] = [];
      setState((prev) => {
        snapshot = prev.tasks;
        const positionById = new Map(orderedIds.map((id, index) => [id, index]));
        const tasks = prev.tasks.map((t) =>
          positionById.has(t.task_id)
            ? { ...t, column_id: columnId, position: positionById.get(t.task_id)! }
            : t,
        );
        return { ...prev, tasks };
      });
      try {
        await Promise.all(
          orderedIds.map((id, index) => kanbanApi.updateTask(id, { columnId, position: index })),
        );
      } catch (error) {
        setState((prev) => ({
          ...prev,
          tasks: snapshot,
          error: error instanceof Error ? error.message : 'Failed to reorder tasks',
        }));
      }
    },
    [],
  );

  const addDependency = useCallback(
    async (taskId: string, dependsOnTaskId: string) => {
      const task = await kanbanApi.addDependency(taskId, dependsOnTaskId);
      upsertTask(task);
      return task;
    },
    [upsertTask],
  );

  const removeDependency = useCallback(
    async (taskId: string, dependsOnTaskId: string) => {
      const task = await kanbanApi.removeDependency(taskId, dependsOnTaskId);
      upsertTask(task);
      return task;
    },
    [upsertTask],
  );

  const clearError = useCallback(() => setState((prev) => ({ ...prev, error: null })), []);

  return {
    ...state,
    reload: () => (projectId ? load(projectId) : Promise.resolve()),
    refreshTasks,
    createTask,
    updateTask,
    deleteTask,
    moveTask,
    reorderColumn,
    addDependency,
    removeDependency,
    clearError,
  };
}
