import { useCallback, useEffect, useRef, useState } from 'react';

import { kanbanApi, type TaskPatch } from '../api/kanbanApi';
import type { KanbanBoard, KanbanBoardScope, KanbanTask, ProjectRef } from '../types';

type BoardState = {
  board: KanbanBoard | null;
  tasks: KanbanTask[];
  projects: ProjectRef[];
  loading: boolean;
  error: string | null;
};

const EMPTY_STATE: BoardState = {
  board: null,
  tasks: [],
  projects: [],
  loading: false,
  error: null,
};

/**
 * Loads (or lazily creates) a Kanban board and exposes task mutations. In
 * `project` scope it loads the project's board; in `global` scope it loads the
 * single cross-project board and the project list (for badges + task assignment).
 * Moves are applied optimistically and reverted on failure.
 */
export function useKanbanBoard(projectId: string | null, scope: KanbanBoardScope = 'project') {
  const [state, setState] = useState<BoardState>(EMPTY_STATE);
  // Guards against races when the target (project or scope) changes mid-request.
  const loadKeyRef = useRef<string>('');

  const load = useCallback(async (targetScope: KanbanBoardScope, targetProjectId: string | null) => {
    const key = `${targetScope}:${targetProjectId ?? ''}`;
    loadKeyRef.current = key;
    setState((prev) => ({ ...prev, loading: true, error: null }));
    try {
      let board: KanbanBoard;
      let tasks: KanbanTask[];
      if (targetScope === 'global') {
        const result = await kanbanApi.getGlobalBoard();
        board = result.board;
        tasks = result.tasks;
      } else {
        let boards = await kanbanApi.listBoards(targetProjectId as string);
        if (boards.length === 0) {
          boards = [await kanbanApi.createBoard(targetProjectId as string, 'Board')];
        }
        const result = await kanbanApi.getBoard(boards[0].board_id);
        board = result.board;
        tasks = result.tasks;
      }
      // The project list powers global-board badges + the per-task project picker.
      const projects = targetScope === 'global' ? await kanbanApi.listProjects() : [];
      if (loadKeyRef.current !== key) {
        return;
      }
      setState({ board, tasks, projects, loading: false, error: null });
    } catch (error) {
      if (loadKeyRef.current !== key) {
        return;
      }
      setState({
        ...EMPTY_STATE,
        error: error instanceof Error ? error.message : 'Failed to load board',
      });
    }
  }, []);

  useEffect(() => {
    if (scope === 'project' && !projectId) {
      loadKeyRef.current = '';
      setState(EMPTY_STATE);
      return;
    }
    void load(scope, projectId);
  }, [projectId, scope, load]);

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

  const setColumnRunOnEnter = useCallback(
    async (columnId: string, runOnEnter: boolean) => {
      const board = state.board;
      if (!board) {
        return;
      }
      const columns = board.columns.map((col) =>
        col.id === columnId ? { ...col, runOnEnter } : col,
      );
      setState((prev) => (prev.board ? { ...prev, board: { ...prev.board, columns } } : prev));
      try {
        const updated = await kanbanApi.updateBoard(board.board_id, { columns });
        setState((prev) => ({ ...prev, board: updated }));
      } catch (error) {
        setState((prev) => ({
          ...prev,
          error: error instanceof Error ? error.message : 'Failed to update column',
        }));
      }
    },
    [state.board],
  );

  const clearError = useCallback(() => setState((prev) => ({ ...prev, error: null })), []);

  return {
    ...state,
    reload: () =>
      scope === 'global' || projectId ? load(scope, projectId) : Promise.resolve(),
    refreshTasks,
    createTask,
    updateTask,
    deleteTask,
    moveTask,
    reorderColumn,
    addDependency,
    removeDependency,
    setColumnRunOnEnter,
    clearError,
  };
}
