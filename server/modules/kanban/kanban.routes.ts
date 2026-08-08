import express from 'express';

import { AppError, asyncHandler } from '@/shared/utils.js';
import { kanbanDb, KanbanCycleError } from '@/modules/kanban/kanban.repository.js';
import { kanbanRunner } from '@/modules/kanban/kanban-runner.service.js';
import { handleManualColumnMove } from '@/modules/kanban/kanban-automation.service.js';
import { generateTaskFields } from '@/modules/kanban/kanban-generate.service.js';
import { enqueueTask, blockTaskForWip } from '@/modules/kanban/kanban-queue.service.js';
import { syncSchedules } from '@/modules/kanban/kanban-scheduler.service.js';
import {
  COLUMN_IN_PROGRESS,
  COLUMN_REVIEW,
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

function validateProviderField(
  value: unknown,
  fieldName: string,
): LLMProvider | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null || value === '') {
    return null;
  }
  if (!isKanbanProvider(value)) {
    throw new AppError(`Invalid ${fieldName}: ${String(value)}`, {
      code: 'KANBAN_INVALID_PROVIDER',
      statusCode: 400,
    });
  }
  return value;
}

function validateAssignee(value: unknown): LLMProvider | null | undefined {
  return validateProviderField(value, 'assignee_provider');
}

function validateReviewProvider(value: unknown): LLMProvider | null | undefined {
  return validateProviderField(value, 'review_provider');
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
    let wipLimit: number | undefined;
    if (col.wipLimit !== undefined && col.wipLimit !== null) {
      if (typeof col.wipLimit !== 'number' || !Number.isInteger(col.wipLimit) || col.wipLimit < 0) {
        throw new AppError(`Invalid wipLimit for column "${name}": must be a non-negative integer`, {
          code: 'KANBAN_INVALID_COLUMNS',
          statusCode: 400,
        });
      }
      wipLimit = col.wipLimit;
    }
    return {
      id,
      name,
      order: typeof col.order === 'number' ? col.order : index,
      runOnEnter: typeof col.runOnEnter === 'boolean' ? col.runOnEnter : undefined,
      permissionMode: readOptionalString(col.permissionMode),
      wipLimit,
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

/**
 * Parse a client-supplied due date. `null`/empty clears it; anything that
 * doesn't parse as a date is ignored (kept as-is for updates, unset for
 * creates). Valid values are normalised to an ISO timestamp.
 */
function parseDueDate(value: unknown): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null || value === '') {
    return null;
  }
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  try {
    const parsed = new Date(trimmed);
    if (Number.isNaN(parsed.getTime())) {
      return undefined;
    }
    return parsed.toISOString();
  } catch {
    return undefined;
  }
}

/**
 * Recompute a task's `blocked` state from its dependencies. A task with any
 * dependency that isn't `done` is marked `blocked`; when the last blocker
 * clears it drops back to `todo`. Tasks that are actively running/queued/done
 * are left untouched — their lifecycle owns the status.
 */
function refreshBlockedState(taskId: string): void {
  const task = kanbanDb.getTask(taskId);
  if (!task) {
    return;
  }
  if (task.status === 'running' || task.status === 'queued' || task.status === 'done') {
    return;
  }
  const hasOpenDep = task.dependsOn.some(
    (depId) => kanbanDb.getTask(depId)?.status !== 'done',
  );
  if (hasOpenDep && task.status !== 'blocked') {
    kanbanDb.setTaskStatus(taskId, 'blocked');
  } else if (!hasOpenDep && task.status === 'blocked') {
    kanbanDb.setTaskStatus(taskId, 'todo');
  }
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

// --- Global board ---------------------------------------------------------
// The single cross-project board: tasks may belong to different projects and
// depend on one another across project boundaries.
router.get(
  '/global',
  asyncHandler(async (_req, res) => {
    const board = kanbanDb.getOrCreateGlobalBoard();
    const tasks = kanbanDb.listTasksByBoard(board.board_id);
    res.json({ success: true, board, tasks });
  }),
);

router.get(
  '/global/archived',
  asyncHandler(async (_req, res) => {
    const board = kanbanDb.getOrCreateGlobalBoard();
    const tasks = kanbanDb.listTasksByBoard(board.board_id, true).filter((task) => task.archived_at);
    res.json({ success: true, tasks });
  }),
);

// --- Boards ---------------------------------------------------------------
// Boards are global-only. The single board is fetched via GET /global; the
// only board mutation is editing its columns.
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

// --- Tasks ----------------------------------------------------------------

/**
 * Expand a title (+ optional notes) into an exhaustive description and an
 * implementer prompt using the selected provider. Used by the TaskEditor
 * "Generate" control before the card is saved.
 */
router.post(
  '/generate-task-fields',
  asyncHandler(async (req, res) => {
    const body = req.body as Record<string, unknown>;
    const title = readString(body.title).trim();
    if (!title) {
      throw new AppError('title is required', {
        code: 'KANBAN_TITLE_REQUIRED',
        statusCode: 400,
      });
    }
    const provider = validateProviderField(body.provider, 'provider');
    if (!provider) {
      throw new AppError('provider is required', {
        code: 'KANBAN_INVALID_PROVIDER',
        statusCode: 400,
      });
    }
    const result = await generateTaskFields({
      title,
      notes: readOptionalString(body.notes),
      description: readOptionalString(body.description),
      prompt: readOptionalString(body.prompt),
      provider,
      projectId: readOptionalString(body.projectId) || null,
    });
    res.json({
      success: true,
      description: result.description,
      prompt: result.prompt,
      provider: result.provider,
    });
  }),
);

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
    requireBoard(boardId);
    // The board is global; every task picks which project it belongs to.
    const projectId = readString(body.projectId).trim();
    if (!projectId) {
      throw new AppError('projectId is required', {
        code: 'KANBAN_PROJECT_ID_REQUIRED',
        statusCode: 400,
      });
    }
    const task = kanbanDb.createTask({
      boardId,
      projectId,
      title,
      description: readOptionalString(body.description),
      prompt: readOptionalString(body.prompt),
      columnId: readOptionalString(body.columnId),
      assigneeProvider: validateAssignee(body.assigneeProvider),
      reviewProvider: validateReviewProvider(body.reviewProvider),
      implementProfileId:
        body.implementProfileId === null
          ? null
          : readOptionalString(body.implementProfileId) ?? undefined,
      reviewProfileId:
        body.reviewProfileId === null
          ? null
          : readOptionalString(body.reviewProfileId) ?? undefined,
      permissionMode: readOptionalString(body.permissionMode),
      tools: (body.tools as KanbanTaskTools) ?? undefined,
      scheduleCron:
        body.scheduleCron === null ? null : readOptionalString(body.scheduleCron) ?? undefined,
      dueDate: parseDueDate(body.dueDate),
    });
    if (task.schedule_cron) {
      syncSchedules();
    }
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
    const previous = requireTask(taskId);
    const body = req.body as Record<string, unknown>;
    const requestedColumnId = readOptionalString(body.columnId);
    const task = kanbanDb.updateTask(taskId, {
      title: readOptionalString(body.title),
      description: readOptionalString(body.description),
      prompt: readOptionalString(body.prompt),
      projectId: readOptionalString(body.projectId),
      columnId: requestedColumnId,
      position: typeof body.position === 'number' ? body.position : undefined,
      assigneeProvider: validateAssignee(body.assigneeProvider),
      reviewProvider: validateReviewProvider(body.reviewProvider),
      implementProfileId:
        body.implementProfileId === null
          ? null
          : body.implementProfileId !== undefined
            ? readOptionalString(body.implementProfileId) ?? null
            : undefined,
      reviewProfileId:
        body.reviewProfileId === null
          ? null
          : body.reviewProfileId !== undefined
            ? readOptionalString(body.reviewProfileId) ?? null
            : undefined,
      permissionMode: readOptionalString(body.permissionMode),
      tools: (body.tools as KanbanTaskTools) ?? undefined,
      scheduleCron:
        body.scheduleCron === null ? null : readOptionalString(body.scheduleCron) ?? undefined,
      dueDate: parseDueDate(body.dueDate),
      status: validateStatus(body.status),
    });

    if (task && body.scheduleCron !== undefined) {
      syncSchedules();
    }

    // Column-move trigger: auto-pick up work when a card enters In Progress
    // (implementation agent) or Review (review agent). Also honor runOnEnter
    // on custom columns (uses the implementation agent). Guard on an actual
    // column change so re-saves in the same column don't re-fire.
    if (task && task.column_id !== previous.column_id) {
      // Keep the lifecycle status in sync with the column a human dragged the
      // card into (Done ↔ todo), so cards don't sit in Done still reading
      // "todo". Explicit `status` in the body wins over the derived value.
      if (body.status === undefined) {
        handleManualColumnMove(task.task_id, previous.column_id);
      }
      const board = kanbanDb.getBoard(task.board_id);
      const enteredColumn = board?.columns.find((col) => col.id === task.column_id);
      const enteredId = task.column_id;

      // A task can only auto-run once it has a project attached (its working
      // directory). Bridged cards start without one until the user assigns it.
      const hasProject = Boolean(task.project_id && task.project_id.trim());

      // WIP gate: when the entered column is at its active-task limit, park the
      // card at `todo` with a hint instead of auto-running. It will be picked
      // up automatically once a slot frees.
      const atWipLimit = blockTaskForWip(task, board);

      if (enteredId === COLUMN_REVIEW) {
        if (task.review_provider && hasProject && !atWipLimit) {
          enqueueTask(task.task_id, 'review');
        }
      } else if (enteredId === COLUMN_IN_PROGRESS || enteredColumn?.runOnEnter) {
        if (task.assignee_provider && hasProject && !atWipLimit) {
          enqueueTask(task.task_id, 'column_move');
        }
      }
    }

    res.json({ success: true, task: task ? kanbanDb.getTask(task.task_id) : task });
  }),
);

router.post(
  '/tasks/:taskId/archive',
  asyncHandler(async (req, res) => {
    const task = requireTask(readString(req.params.taskId));
    const archived = req.body?.restore === true
      ? kanbanDb.restoreTask(task.task_id)
      : kanbanDb.archiveTask(task.task_id);
    res.json({ success: true, task: archived });
  }),
);

router.delete(
  '/tasks/:taskId',
  asyncHandler(async (req, res) => {
    const deleted = kanbanDb.deleteTask(readString(req.params.taskId));
    if (!deleted) {
      throw new AppError('Task not found', { code: 'KANBAN_TASK_NOT_FOUND', statusCode: 404 });
    }
    // Drop any cron job that belonged to the deleted task.
    syncSchedules();
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
    refreshBlockedState(taskId);
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
    refreshBlockedState(taskId);
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

// --- Comments (activity trail) --------------------------------------------
router.get(
  '/tasks/:taskId/comments',
  asyncHandler(async (req, res) => {
    const taskId = readString(req.params.taskId);
    requireTask(taskId);
    const comments = kanbanDb.listCommentsByTask(taskId);
    res.json({ success: true, comments });
  }),
);

router.post(
  '/tasks/:taskId/comments',
  asyncHandler(async (req, res) => {
    const taskId = readString(req.params.taskId);
    requireTask(taskId);
    const body = req.body as Record<string, unknown>;
    const text = readString(body.body).trim();
    if (!text) {
      throw new AppError('body is required', { code: 'KANBAN_COMMENT_REQUIRED', statusCode: 400 });
    }
    const comment = kanbanDb.addComment({
      taskId,
      authorType: 'human',
      author: readOptionalString(body.author)?.trim() || null,
      body: text,
    });
    res.status(201).json({ success: true, comment });
  }),
);

router.delete(
  '/tasks/:taskId/comments/:commentId',
  asyncHandler(async (req, res) => {
    const deleted = kanbanDb.deleteComment(readString(req.params.commentId));
    if (!deleted) {
      throw new AppError('Comment not found', {
        code: 'KANBAN_COMMENT_NOT_FOUND',
        statusCode: 404,
      });
    }
    res.json({ success: true });
  }),
);

export default router;
