import express from 'express';

import { AppError, asyncHandler } from '@/shared/utils.js';
import { kanbanDb, KanbanCycleError } from '@/modules/kanban/kanban.repository.js';
import { kanbanRunner } from '@/modules/kanban/kanban-runner.service.js';
import {
  isKanbanProvider,
  KANBAN_TASK_STATUSES,
  type KanbanColumn,
  type KanbanTaskStatus,
  type KanbanTaskTools,
} from '@/modules/kanban/kanban.types.js';
import type { LLMProvider } from '@/shared/types.js';

const router = express.Router();

function readString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function requireBoard(boardId: string) {
  const board = kanbanDb.getBoard(boardId);
  if (!board) {
    throw new AppError('Board not found', { code: 'KANBAN_BOARD_NOT_FOUND', statusCode: 404 });
  }
  return board;
}

function requireTask(taskId: string) {
  const task = kanbanDb.getTask(taskId);
  if (!task) {
    throw new AppError('Task not found', { code: 'KANBAN_TASK_NOT_FOUND', statusCode: 404 });
  }
  return task;
}

function validateAssignee(value: unknown): LLMProvider | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  if (!isKanbanProvider(value)) {
    throw new AppError(`Invalid assignee_provider: ${String(value)}`, {
      code: 'KANBAN_INVALID_PROVIDER',
      statusCode: 400,
    });
  }
  return value;
}

function validateColumns(value: unknown): KanbanColumn[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new AppError('columns must be an array', {
      code: 'KANBAN_INVALID_COLUMNS',
      statusCode: 400,
    });
  }
  return value.map((raw, index) => {
    const col = raw as Record<string, unknown>;
    const id = readString(col.id).trim();
    const name = readString(col.name).trim();
    if (!id || !name) {
      throw new AppError('Each column requires an id and a name', {
        code: 'KANBAN_INVALID_COLUMNS',
        statusCode: 400,
      });
    }
    return {
      id,
      name,
      order: typeof col.order === 'number' ? col.order : index,
      runOnEnter: typeof col.runOnEnter === 'boolean' ? col.runOnEnter : undefined,
      permissionMode: readOptionalString(col.permissionMode),
    } satisfies KanbanColumn;
  });
}

function validateStatus(value: unknown): KanbanTaskStatus | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!KANBAN_TASK_STATUSES.includes(value as KanbanTaskStatus)) {
    throw new AppError(`Invalid status: ${String(value)}`, {
      code: 'KANBAN_INVALID_STATUS',
      statusCode: 400,
    });
  }
  return value as KanbanTaskStatus;
}

function mapCycleError<T>(fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    if (error instanceof KanbanCycleError) {
      throw new AppError(error.message, { code: 'KANBAN_CYCLE', statusCode: 409 });
    }
    throw error;
  }
}

// --- Health ---------------------------------------------------------------
router.get(
  '/health',
  asyncHandler(async (_req, res) => {
    res.json({ ok: true });
  }),
);

// --- Boards ---------------------------------------------------------------
router.get(
  '/boards',
  asyncHandler(async (req, res) => {
    const projectId = readString(req.query.projectId).trim();
    if (!projectId) {
      throw new AppError('projectId query parameter is required', {
        code: 'KANBAN_PROJECT_ID_REQUIRED',
        statusCode: 400,
      });
    }
    const boards = kanbanDb.listBoardsByProject(projectId);
    res.json({ success: true, boards });
  }),
);

router.post(
  '/boards',
  asyncHandler(async (req, res) => {
    const body = req.body as Record<string, unknown>;
    const projectId = readString(body.projectId).trim();
    const name = readString(body.name).trim();
    if (!projectId) {
      throw new AppError('projectId is required', {
        code: 'KANBAN_PROJECT_ID_REQUIRED',
        statusCode: 400,
      });
    }
    if (!name) {
      throw new AppError('name is required', { code: 'KANBAN_NAME_REQUIRED', statusCode: 400 });
    }
    const board = kanbanDb.createBoard({
      projectId,
      name,
      columns: validateColumns(body.columns),
    });
    res.status(201).json({ success: true, board });
  }),
);

router.get(
  '/boards/:boardId',
  asyncHandler(async (req, res) => {
    const boardId = readString(req.params.boardId);
    const board = requireBoard(boardId);
    const tasks = kanbanDb.listTasksByBoard(boardId);
    res.json({ success: true, board, tasks });
  }),
);

router.put(
  '/boards/:boardId',
  asyncHandler(async (req, res) => {
    const boardId = readString(req.params.boardId);
    requireBoard(boardId);
    const body = req.body as Record<string, unknown>;
    const board = kanbanDb.updateBoard(boardId, {
      name: readOptionalString(body.name)?.trim() || undefined,
      columns: validateColumns(body.columns),
    });
    res.json({ success: true, board });
  }),
);

router.delete(
  '/boards/:boardId',
  asyncHandler(async (req, res) => {
    const boardId = readString(req.params.boardId);
    const deleted = kanbanDb.deleteBoard(boardId);
    if (!deleted) {
      throw new AppError('Board not found', { code: 'KANBAN_BOARD_NOT_FOUND', statusCode: 404 });
    }
    res.json({ success: true });
  }),
);

// --- Tasks ----------------------------------------------------------------
router.get(
  '/boards/:boardId/tasks',
  asyncHandler(async (req, res) => {
    const boardId = readString(req.params.boardId);
    requireBoard(boardId);
    const tasks = kanbanDb.listTasksByBoard(boardId);
    res.json({ success: true, tasks });
  }),
);

router.post(
  '/tasks',
  asyncHandler(async (req, res) => {
    const body = req.body as Record<string, unknown>;
    const boardId = readString(body.boardId).trim();
    const title = readString(body.title).trim();
    if (!boardId) {
      throw new AppError('boardId is required', { code: 'KANBAN_BOARD_ID_REQUIRED', statusCode: 400 });
    }
    if (!title) {
      throw new AppError('title is required', { code: 'KANBAN_TITLE_REQUIRED', statusCode: 400 });
    }
    const board = requireBoard(boardId);
    const task = kanbanDb.createTask({
      boardId,
      projectId: board.project_id,
      title,
      description: readOptionalString(body.description),
      prompt: readOptionalString(body.prompt),
      columnId: readOptionalString(body.columnId),
      assigneeProvider: validateAssignee(body.assigneeProvider),
      permissionMode: readOptionalString(body.permissionMode),
      tools: (body.tools as KanbanTaskTools) ?? undefined,
      scheduleCron:
        body.scheduleCron === null ? null : readOptionalString(body.scheduleCron) ?? undefined,
    });
    res.status(201).json({ success: true, task });
  }),
);

router.get(
  '/tasks/:taskId',
  asyncHandler(async (req, res) => {
    const task = requireTask(readString(req.params.taskId));
    const runs = kanbanDb.listRunsByTask(task.task_id);
    res.json({ success: true, task, runs });
  }),
);

router.put(
  '/tasks/:taskId',
  asyncHandler(async (req, res) => {
    const taskId = readString(req.params.taskId);
    requireTask(taskId);
    const body = req.body as Record<string, unknown>;
    const task = kanbanDb.updateTask(taskId, {
      title: readOptionalString(body.title),
      description: readOptionalString(body.description),
      prompt: readOptionalString(body.prompt),
      columnId: readOptionalString(body.columnId),
      position: typeof body.position === 'number' ? body.position : undefined,
      assigneeProvider: validateAssignee(body.assigneeProvider),
      permissionMode: readOptionalString(body.permissionMode),
      tools: (body.tools as KanbanTaskTools) ?? undefined,
      scheduleCron:
        body.scheduleCron === null ? null : readOptionalString(body.scheduleCron) ?? undefined,
      status: validateStatus(body.status),
    });
    res.json({ success: true, task });
  }),
);

router.delete(
  '/tasks/:taskId',
  asyncHandler(async (req, res) => {
    const deleted = kanbanDb.deleteTask(readString(req.params.taskId));
    if (!deleted) {
      throw new AppError('Task not found', { code: 'KANBAN_TASK_NOT_FOUND', statusCode: 404 });
    }
    res.json({ success: true });
  }),
);

// --- Dependencies ---------------------------------------------------------
router.post(
  '/tasks/:taskId/deps',
  asyncHandler(async (req, res) => {
    const taskId = readString(req.params.taskId);
    requireTask(taskId);
    const body = req.body as Record<string, unknown>;
    const dependsOnTaskId = readString(body.dependsOnTaskId).trim();
    if (!dependsOnTaskId) {
      throw new AppError('dependsOnTaskId is required', {
        code: 'KANBAN_DEP_REQUIRED',
        statusCode: 400,
      });
    }
    mapCycleError(() => kanbanDb.addDependency(taskId, dependsOnTaskId));
    const task = kanbanDb.getTask(taskId);
    res.status(201).json({ success: true, task });
  }),
);

router.delete(
  '/tasks/:taskId/deps/:dependsOnTaskId',
  asyncHandler(async (req, res) => {
    const taskId = readString(req.params.taskId);
    const dependsOnTaskId = readString(req.params.dependsOnTaskId);
    kanbanDb.removeDependency(taskId, dependsOnTaskId);
    const task = kanbanDb.getTask(taskId);
    res.json({ success: true, task });
  }),
);

// --- Execution ------------------------------------------------------------
router.post(
  '/tasks/:taskId/run',
  asyncHandler(async (req, res) => {
    const taskId = readString(req.params.taskId);
    requireTask(taskId);
    const result = await kanbanRunner.runTask(taskId, 'manual');
    const task = kanbanDb.getTask(taskId);
    const run = kanbanDb.getRun(result.runId);
    res.status(202).json({ success: true, run, task });
  }),
);

// --- Runs -----------------------------------------------------------------
router.get(
  '/tasks/:taskId/runs',
  asyncHandler(async (req, res) => {
    const taskId = readString(req.params.taskId);
    requireTask(taskId);
    const runs = kanbanDb.listRunsByTask(taskId);
    res.json({ success: true, runs });
  }),
);

export default router;
