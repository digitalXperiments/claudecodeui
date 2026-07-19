import { randomUUID } from 'node:crypto';

import { getConnection } from '@/modules/database/index.js';
import {
  DEFAULT_COLUMNS,
  type CreateBoardInput,
  type CreateTaskInput,
  type KanbanBoard,
  type KanbanBoardRow,
  type KanbanColumn,
  type KanbanRunRow,
  type KanbanRunStatus,
  type KanbanRunTrigger,
  type KanbanTask,
  type KanbanTaskRow,
  type KanbanTaskStatus,
  type KanbanTaskTools,
  type UpdateTaskInput,
} from '@/modules/kanban/kanban.types.js';

function parseColumns(columnsJson: string): KanbanColumn[] {
  try {
    const parsed = JSON.parse(columnsJson);
    return Array.isArray(parsed) ? (parsed as KanbanColumn[]) : [];
  } catch {
    return [];
  }
}

function parseTools(toolsJson: string): KanbanTaskTools {
  try {
    const parsed = JSON.parse(toolsJson);
    return parsed && typeof parsed === 'object' ? (parsed as KanbanTaskTools) : {};
  } catch {
    return {};
  }
}

function mapBoard(row: KanbanBoardRow): KanbanBoard {
  const { columns_json, ...rest } = row;
  return { ...rest, columns: parseColumns(columns_json).sort((a, b) => a.order - b.order) };
}

function mapTask(row: KanbanTaskRow, dependsOn: string[]): KanbanTask {
  const { tools_json, ...rest } = row;
  return { ...rest, tools: parseTools(tools_json), dependsOn };
}

export const kanbanDb = {
  // --- Boards -------------------------------------------------------------
  createBoard(input: CreateBoardInput): KanbanBoard {
    const db = getConnection();
    const boardId = randomUUID();
    const columns = input.columns && input.columns.length > 0 ? input.columns : DEFAULT_COLUMNS;
    db.prepare(
      `INSERT INTO kanban_boards (board_id, project_id, name, columns_json)
       VALUES (?, ?, ?, ?)`,
    ).run(boardId, input.projectId, input.name, JSON.stringify(columns));
    return kanbanDb.getBoard(boardId)!;
  },

  getBoard(boardId: string): KanbanBoard | null {
    const db = getConnection();
    const row = db
      .prepare(`SELECT * FROM kanban_boards WHERE board_id = ?`)
      .get(boardId) as KanbanBoardRow | undefined;
    return row ? mapBoard(row) : null;
  },

  listBoardsByProject(projectId: string): KanbanBoard[] {
    const db = getConnection();
    const rows = db
      .prepare(`SELECT * FROM kanban_boards WHERE project_id = ? ORDER BY created_at ASC`)
      .all(projectId) as KanbanBoardRow[];
    return rows.map(mapBoard);
  },

  updateBoard(boardId: string, patch: { name?: string; columns?: KanbanColumn[] }): KanbanBoard | null {
    const db = getConnection();
    const existing = kanbanDb.getBoard(boardId);
    if (!existing) {
      return null;
    }
    const name = patch.name ?? existing.name;
    const columns = patch.columns ?? existing.columns;
    db.prepare(
      `UPDATE kanban_boards
       SET name = ?, columns_json = ?, updated_at = CURRENT_TIMESTAMP
       WHERE board_id = ?`,
    ).run(name, JSON.stringify(columns), boardId);
    return kanbanDb.getBoard(boardId);
  },

  deleteBoard(boardId: string): boolean {
    const db = getConnection();
    const result = db.prepare(`DELETE FROM kanban_boards WHERE board_id = ?`).run(boardId);
    return result.changes > 0;
  },

  // --- Tasks --------------------------------------------------------------
  createTask(input: CreateTaskInput): KanbanTask {
    const db = getConnection();
    const board = kanbanDb.getBoard(input.boardId);
    if (!board) {
      throw new Error(`Board not found: ${input.boardId}`);
    }
    const columnId = input.columnId ?? board.columns[0]?.id ?? 'backlog';
    const taskId = randomUUID();
    const nextPosition =
      input.position ??
      (db
        .prepare(
          `SELECT COALESCE(MAX(position), -1) + 1 AS next FROM kanban_tasks WHERE board_id = ? AND column_id = ?`,
        )
        .get(input.boardId, columnId) as { next: number }).next;

    db.prepare(
      `INSERT INTO kanban_tasks (
         task_id, board_id, project_id, title, description, prompt, column_id, position,
         assignee_provider, permission_mode, tools_json, schedule_cron, status
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      taskId,
      input.boardId,
      input.projectId,
      input.title,
      input.description ?? '',
      input.prompt ?? '',
      columnId,
      nextPosition,
      input.assigneeProvider ?? null,
      input.permissionMode ?? 'default',
      JSON.stringify(input.tools ?? {}),
      input.scheduleCron ?? null,
      'todo',
    );
    return kanbanDb.getTask(taskId)!;
  },

  getTask(taskId: string): KanbanTask | null {
    const db = getConnection();
    const row = db
      .prepare(`SELECT * FROM kanban_tasks WHERE task_id = ?`)
      .get(taskId) as KanbanTaskRow | undefined;
    if (!row) {
      return null;
    }
    return mapTask(row, kanbanDb.listDependencies(taskId));
  },

  listTasksByBoard(boardId: string): KanbanTask[] {
    const db = getConnection();
    const rows = db
      .prepare(`SELECT * FROM kanban_tasks WHERE board_id = ? ORDER BY column_id, position ASC`)
      .all(boardId) as KanbanTaskRow[];
    const depsByTask = kanbanDb.listDependenciesForBoard(boardId);
    return rows.map((row) => mapTask(row, depsByTask.get(row.task_id) ?? []));
  },

  updateTask(taskId: string, patch: UpdateTaskInput): KanbanTask | null {
    const db = getConnection();
    const existing = db
      .prepare(`SELECT * FROM kanban_tasks WHERE task_id = ?`)
      .get(taskId) as KanbanTaskRow | undefined;
    if (!existing) {
      return null;
    }

    const next = {
      title: patch.title ?? existing.title,
      description: patch.description ?? existing.description,
      prompt: patch.prompt ?? existing.prompt,
      column_id: patch.columnId ?? existing.column_id,
      position: patch.position ?? existing.position,
      assignee_provider:
        patch.assigneeProvider !== undefined ? patch.assigneeProvider : existing.assignee_provider,
      permission_mode: patch.permissionMode ?? existing.permission_mode,
      tools_json: patch.tools !== undefined ? JSON.stringify(patch.tools) : existing.tools_json,
      schedule_cron:
        patch.scheduleCron !== undefined ? patch.scheduleCron : existing.schedule_cron,
      status: patch.status ?? existing.status,
    };

    db.prepare(
      `UPDATE kanban_tasks SET
         title = ?, description = ?, prompt = ?, column_id = ?, position = ?,
         assignee_provider = ?, permission_mode = ?, tools_json = ?, schedule_cron = ?,
         status = ?, updated_at = CURRENT_TIMESTAMP
       WHERE task_id = ?`,
    ).run(
      next.title,
      next.description,
      next.prompt,
      next.column_id,
      next.position,
      next.assignee_provider,
      next.permission_mode,
      next.tools_json,
      next.schedule_cron,
      next.status,
      taskId,
    );
    return kanbanDb.getTask(taskId);
  },

  setTaskStatus(taskId: string, status: KanbanTaskStatus): void {
    const db = getConnection();
    db.prepare(
      `UPDATE kanban_tasks SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE task_id = ?`,
    ).run(status, taskId);
  },

  setTaskSession(taskId: string, appSessionId: string): void {
    const db = getConnection();
    db.prepare(
      `UPDATE kanban_tasks SET app_session_id = ?, updated_at = CURRENT_TIMESTAMP WHERE task_id = ?`,
    ).run(appSessionId, taskId);
  },

  recordTaskRunResult(taskId: string, exitCode: number | null): void {
    const db = getConnection();
    db.prepare(
      `UPDATE kanban_tasks
       SET last_run_at = CURRENT_TIMESTAMP, last_exit_code = ?, updated_at = CURRENT_TIMESTAMP
       WHERE task_id = ?`,
    ).run(exitCode, taskId);
  },

  deleteTask(taskId: string): boolean {
    const db = getConnection();
    const result = db.prepare(`DELETE FROM kanban_tasks WHERE task_id = ?`).run(taskId);
    return result.changes > 0;
  },

  // --- Dependencies (DAG) -------------------------------------------------
  listDependencies(taskId: string): string[] {
    const db = getConnection();
    const rows = db
      .prepare(`SELECT depends_on_task_id FROM kanban_task_deps WHERE task_id = ?`)
      .all(taskId) as { depends_on_task_id: string }[];
    return rows.map((r) => r.depends_on_task_id);
  },

  listDependenciesForBoard(boardId: string): Map<string, string[]> {
    const db = getConnection();
    const rows = db
      .prepare(
        `SELECT d.task_id, d.depends_on_task_id
         FROM kanban_task_deps d
         JOIN kanban_tasks t ON t.task_id = d.task_id
         WHERE t.board_id = ?`,
      )
      .all(boardId) as { task_id: string; depends_on_task_id: string }[];
    const map = new Map<string, string[]>();
    for (const row of rows) {
      const list = map.get(row.task_id) ?? [];
      list.push(row.depends_on_task_id);
      map.set(row.task_id, list);
    }
    return map;
  },

  /** Tasks that depend on the given task (reverse edges). */
  listDependents(taskId: string): string[] {
    const db = getConnection();
    const rows = db
      .prepare(`SELECT task_id FROM kanban_task_deps WHERE depends_on_task_id = ?`)
      .all(taskId) as { task_id: string }[];
    return rows.map((r) => r.task_id);
  },

  /**
   * Would adding the edge (task depends_on dependsOnTaskId) create a cycle?
   * A cycle exists if `taskId` is already reachable from `dependsOnTaskId`
   * through existing depends-on edges (i.e. dependsOnTaskId transitively
   * depends on taskId).
   */
  wouldCreateCycle(taskId: string, dependsOnTaskId: string): boolean {
    if (taskId === dependsOnTaskId) {
      return true;
    }
    const visited = new Set<string>();
    const stack = [dependsOnTaskId];
    while (stack.length > 0) {
      const current = stack.pop()!;
      if (current === taskId) {
        return true;
      }
      if (visited.has(current)) {
        continue;
      }
      visited.add(current);
      for (const next of kanbanDb.listDependencies(current)) {
        stack.push(next);
      }
    }
    return false;
  },

  /**
   * Add a dependency edge. Throws if it would create a cycle or if either task
   * is missing. Returns true if a new edge was inserted.
   */
  addDependency(taskId: string, dependsOnTaskId: string): boolean {
    const db = getConnection();
    const insert = db.transaction((from: string, to: string) => {
      if (from === to) {
        throw new KanbanCycleError('A task cannot depend on itself');
      }
      const fromExists = db.prepare(`SELECT 1 FROM kanban_tasks WHERE task_id = ?`).get(from);
      const toExists = db.prepare(`SELECT 1 FROM kanban_tasks WHERE task_id = ?`).get(to);
      if (!fromExists || !toExists) {
        throw new Error('Both tasks must exist to create a dependency');
      }
      if (kanbanDb.wouldCreateCycle(from, to)) {
        throw new KanbanCycleError('This dependency would create a cycle');
      }
      const result = db
        .prepare(
          `INSERT OR IGNORE INTO kanban_task_deps (task_id, depends_on_task_id) VALUES (?, ?)`,
        )
        .run(from, to);
      return result.changes > 0;
    });
    return insert(taskId, dependsOnTaskId);
  },

  removeDependency(taskId: string, dependsOnTaskId: string): boolean {
    const db = getConnection();
    const result = db
      .prepare(`DELETE FROM kanban_task_deps WHERE task_id = ? AND depends_on_task_id = ?`)
      .run(taskId, dependsOnTaskId);
    return result.changes > 0;
  },

  // --- Runs ---------------------------------------------------------------
  createRun(input: {
    taskId: string;
    appSessionId: string | null;
    provider: string | null;
    trigger: KanbanRunTrigger;
  }): KanbanRunRow {
    const db = getConnection();
    const runId = randomUUID();
    db.prepare(
      `INSERT INTO kanban_runs (run_id, task_id, app_session_id, provider, trigger, status)
       VALUES (?, ?, ?, ?, ?, 'running')`,
    ).run(runId, input.taskId, input.appSessionId, input.provider, input.trigger);
    return kanbanDb.getRun(runId)!;
  },

  getRun(runId: string): KanbanRunRow | null {
    const db = getConnection();
    const row = db.prepare(`SELECT * FROM kanban_runs WHERE run_id = ?`).get(runId) as
      | KanbanRunRow
      | undefined;
    return row ?? null;
  },

  finishRun(runId: string, status: KanbanRunStatus, exitCode: number | null): void {
    const db = getConnection();
    db.prepare(
      `UPDATE kanban_runs SET status = ?, exit_code = ?, finished_at = CURRENT_TIMESTAMP WHERE run_id = ?`,
    ).run(status, exitCode, runId);
  },

  listRunsByTask(taskId: string, limit = 50): KanbanRunRow[] {
    const db = getConnection();
    return db
      .prepare(`SELECT * FROM kanban_runs WHERE task_id = ? ORDER BY started_at DESC LIMIT ?`)
      .all(taskId, limit) as KanbanRunRow[];
  },

  listRunningRuns(): KanbanRunRow[] {
    const db = getConnection();
    return db.prepare(`SELECT * FROM kanban_runs WHERE status = 'running'`).all() as KanbanRunRow[];
  },

  /** Latest run for a task (any status), or null. */
  getLatestRunForTask(taskId: string): KanbanRunRow | null {
    const db = getConnection();
    const row = db
      .prepare(`SELECT * FROM kanban_runs WHERE task_id = ? ORDER BY started_at DESC LIMIT 1`)
      .get(taskId) as KanbanRunRow | undefined;
    return row ?? null;
  },
};

/** Thrown when a dependency edge would violate the DAG invariant. */
export class KanbanCycleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KanbanCycleError';
  }
}
