import { kanbanDb } from '@/modules/kanban/kanban.repository.js';
import { kanbanRunner } from '@/modules/kanban/kanban-runner.service.js';
import {
  setOnEnqueue,
  setOnRunSettled,
  setOnTaskDone,
  type KanbanEnqueueContext,
} from '@/modules/kanban/kanban-automation.service.js';
import {
  COLUMN_IN_PROGRESS,
  COLUMN_REVIEW,
  type KanbanBoard,
  type KanbanRunTrigger,
  type KanbanTask,
} from '@/modules/kanban/kanban.types.js';

type QueueItem = { taskId: string; trigger: KanbanRunTrigger; context?: KanbanEnqueueContext };

const DEFAULT_CONCURRENCY = 3;

/**
 * In-memory run queue with a concurrency cap. Automation triggers (dependency,
 * column-move, schedule) enqueue here; manual runs bypass it. Tasks are marked
 * `queued` in the DB so a restart can requeue them (see `requeuePersisted`).
 *
 * A task occupies a slot from the moment its run starts until the run settles
 * (reported via `onRunSettled`) — so the cap bounds concurrently *running*
 * agents, not just concurrent starts.
 */
const pending: QueueItem[] = [];
const inFlight = new Set<string>();
/**
 * Tasks that have already been told their column is at its WIP limit. Gates
 * comment spam: we only annotate the first time a task is WIP-blocked, not on
 * every re-scan while the column stays full.
 */
const wipBlocked = new Set<string>();
let concurrency = DEFAULT_CONCURRENCY;

function isTracked(taskId: string): boolean {
  return inFlight.has(taskId) || pending.some((item) => item.taskId === taskId);
}

/**
 * True when the given column has `wipLimit` set and already contains at least
 * that many active (queued or running) tasks. `excludeTaskId` / `excludeTaskIds`
 * are ignored from the count (e.g. the task being moved within its own column).
 */
export function isColumnAtWipLimit(
  board: KanbanBoard | null,
  columnId: string,
  options: { excludeTaskId?: string; excludeTaskIds?: string[] } = {},
): boolean {
  if (!board) {
    return false;
  }
  const column = board.columns.find((col) => col.id === columnId);
  const limit = column?.wipLimit;
  if (limit === undefined || limit === null || limit <= 0) {
    return false;
  }
  const excluded = new Set<string>();
  if (options.excludeTaskId) {
    excluded.add(options.excludeTaskId);
  }
  for (const id of options.excludeTaskIds ?? []) {
    excluded.add(id);
  }
  let active = 0;
  for (const task of kanbanDb.listTasksByColumn(columnId)) {
    if (excluded.has(task.task_id)) {
      continue;
    }
    if (task.status === 'queued' || task.status === 'running') {
      active += 1;
    }
  }
  return active >= limit;
}

/** Annotate a task once with the WIP-waiting comment. */
function addWipBlockComment(taskId: string, columnName: string): void {
  if (wipBlocked.has(taskId)) {
    return;
  }
  wipBlocked.add(taskId);
  try {
    kanbanDb.addComment({
      taskId,
      authorType: 'agent',
      author: null,
      body: `WIP limit reached in ${columnName}; will auto-start when a slot frees.`,
    });
  } catch {
    // best-effort
  }
}

/**
 * If the task's column is at its WIP limit, park the task back at `todo` with a
 * hint comment and return true (caller should not enqueue). The task is picked
 * up again by `releaseWipWaiters` the next time a run in that column settles.
 */
export function blockTaskForWip(
  task: KanbanTask,
  board: KanbanBoard | null,
  options: { excludeTaskId?: string; excludeTaskIds?: string[] } = {},
): boolean {
  if (!isColumnAtWipLimit(board, task.column_id, { excludeTaskId: task.task_id, ...options })) {
    return false;
  }
  kanbanDb.setTaskStatus(task.task_id, 'todo');
  const columnName = board?.columns.find((col) => col.id === task.column_id)?.name ?? task.column_id;
  addWipBlockComment(task.task_id, columnName);
  return true;
}

function drain(): void {
  while (inFlight.size < concurrency && pending.length > 0) {
    const item = pending.shift()!;
    if (inFlight.has(item.taskId)) {
      continue;
    }
    inFlight.add(item.taskId);
    // runTask resolves once the run has *started*; the slot is released later
    // when the run settles via onRunSettled. A synchronous start failure frees
    // the slot immediately and marks the task failed.
    kanbanRunner.runTask(item.taskId, item.trigger, item.context).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[Kanban] queued run failed to start', { taskId: item.taskId, error: message });
      try {
        kanbanDb.setTaskStatus(item.taskId, 'failed');
      } catch {
        // task may have been deleted; ignore
      }
      inFlight.delete(item.taskId);
      drain();
    });
  }
}

/**
 * Enqueue a task for automated execution. No-op (deduped) if the task is
 * already queued, in flight, or actively running — this is the debounce that
 * prevents runaway re-triggering.
 *
 * Review triggers require a review agent; all other triggers require an
 * implementation agent.
 */
export function enqueueTask(
  taskId: string,
  trigger: KanbanRunTrigger,
  context?: KanbanEnqueueContext,
  options: { excludeWipTaskIds?: string[] } = {},
): void {
  if (isTracked(taskId)) {
    return;
  }
  const task = kanbanDb.getTask(taskId);
  if (!task) {
    return;
  }
  if (task.status === 'running' || task.status === 'queued') {
    return;
  }
  const needsReviewAgent = trigger === 'review' || task.column_id === 'review';
  if (needsReviewAgent) {
    if (!task.review_provider) {
      // No review agent — nothing to auto-run in Review.
      return;
    }
  } else if (!task.assignee_provider) {
    // Nothing to run automatically without an implementation agent.
    return;
  }
  // Dependency gate: a task with unfinished dependencies must not run. Mark it
  // `blocked` instead of `queued`; `cascadeDependents` will re-enqueue it once
  // its last blocker finishes. (Review runs are exempt — a task only reaches
  // Review after its own implementation, so its deps were already satisfied.)
  if (!needsReviewAgent && !dependenciesSatisfied(taskId)) {
    kanbanDb.setTaskStatus(taskId, 'blocked');
    return;
  }
  // WIP gate: auto-runs respect the destination column's active-task cap.
  const board = kanbanDb.getBoard(task.board_id);
  if (blockTaskForWip(task, board, { excludeTaskIds: options.excludeWipTaskIds })) {
    return;
  }
  wipBlocked.delete(task.task_id);
  kanbanDb.setTaskStatus(taskId, 'queued');
  pending.push({ taskId, trigger, context });
  drain();
}

/** True when every dependency of the task is in the `done` state. */
function dependenciesSatisfied(taskId: string): boolean {
  const deps = kanbanDb.listDependencies(taskId);
  return deps.every((depId) => kanbanDb.getTask(depId)?.status === 'done');
}

/**
 * When a task completes, enqueue any dependent whose dependencies are now all
 * satisfied. Cycles were rejected at write time, so this cannot loop forever.
 */
function cascadeDependents(doneTaskId: string): void {
  for (const dependentId of kanbanDb.listDependents(doneTaskId)) {
    const dependent = kanbanDb.getTask(dependentId);
    if (!dependent) {
      continue;
    }
    if (dependent.status === 'running' || dependent.status === 'queued' || dependent.status === 'done') {
      continue;
    }
    if (!dependenciesSatisfied(dependentId)) {
      // Still blocked by another open dependency; leave it be.
      continue;
    }
    if (dependent.assignee_provider) {
      // Auto-start: surface the work by moving it into In Progress, then run it.
      // We call the repository directly (not the HTTP route) so this move does
      // not re-fire the column-move trigger. Use an interim `todo` status —
      // `enqueueTask` owns the lifecycle and would no-op if we pre-set `queued`.
      const board = kanbanDb.getBoard(dependent.board_id);
      if (isColumnAtWipLimit(board, COLUMN_IN_PROGRESS, { excludeTaskId: dependentId })) {
        // WIP full — keep the dependent parked with a hint; `releaseWipWaiters`
        // promotes it the next time a run in In Progress settles.
        if (dependent.status !== 'blocked') {
          kanbanDb.setTaskStatus(dependentId, 'blocked');
        }
        const columnName =
          board?.columns.find((col) => col.id === COLUMN_IN_PROGRESS)?.name ?? 'In Progress';
        addWipBlockComment(dependentId, columnName);
        continue;
      }
      if (dependent.column_id !== COLUMN_IN_PROGRESS) {
        kanbanDb.moveTaskToColumn(dependentId, COLUMN_IN_PROGRESS, 'todo');
      }
      enqueueTask(dependentId, 'dependency');
    } else if (dependent.status === 'blocked') {
      // Nothing to auto-run; just clear the block so a human can pick it up.
      kanbanDb.setTaskStatus(dependentId, 'todo');
    }
  }
}

/** True when the task has the agent its column needs for an auto-run. */
function taskHasAutoRunAgent(task: KanbanTask): boolean {
  return task.column_id === COLUMN_REVIEW
    ? Boolean(task.review_provider)
    : Boolean(task.assignee_provider);
}

/**
 * A run in `settledTaskId`'s column has settled, freeing a WIP slot (the
 * settling task is leaving the run lifecycle). Re-scan for tasks that were
 * parked because their column was at its WIP limit (tracked in `wipBlocked`) —
 * in the settled column, or parked as `blocked` on the board — and let
 * `enqueueTask` restart what it can. `enqueueTask` dedupes tracked tasks and
 * re-checks the WIP limit, so this cannot loop or over-enqueue.
 *
 * Only tasks in `wipBlocked` are considered: an idle `todo` task with an agent
 * was never asked to wait, so settling a run must not start it unprompted.
 *
 * The settling task itself is deliberately *not* mutated here: the completion
 * handler sets its final status right after this hook, and its still-active
 * `running` status would otherwise make it a candidate for the very next
 * settle. Instead it is excluded from the WIP count so the freed slot is
 * visible to the promoted candidates.
 */
function releaseWipWaiters(settledTaskId: string): void {
  const settled = kanbanDb.getTask(settledTaskId);
  if (!settled) {
    return;
  }

  const candidates = new Map<string, KanbanTask>();
  for (const task of kanbanDb.listTasksByColumn(settled.column_id)) {
    if (
      task.task_id !== settledTaskId &&
      (task.status === 'todo' || task.status === 'blocked')
    ) {
      candidates.set(task.task_id, task);
    }
  }
  for (const task of kanbanDb.listTasksByBoard(settled.board_id)) {
    if (task.status === 'blocked' && dependenciesSatisfied(task.task_id)) {
      candidates.set(task.task_id, task);
    }
  }

  for (const candidate of candidates.values()) {
    if (!wipBlocked.has(candidate.task_id)) {
      continue;
    }
    if (!taskHasAutoRunAgent(candidate)) {
      continue;
    }
    if (candidate.column_id !== COLUMN_REVIEW && candidate.column_id !== COLUMN_IN_PROGRESS) {
      kanbanDb.moveTaskToColumn(candidate.task_id, COLUMN_IN_PROGRESS, 'todo');
    }
    enqueueTask(candidate.task_id, candidate.column_id === COLUMN_REVIEW ? 'review' : 'dependency', undefined, {
      excludeWipTaskIds: [settledTaskId],
    });
  }
}

function handleRunSettled(taskId: string): void {
  inFlight.delete(taskId);
  drain();
  releaseWipWaiters(taskId);
}

/**
 * Re-enqueue tasks persisted as `queued` (e.g. after a restart). Called on boot
 * after reconcile.
 */
export function requeuePersisted(): void {
  for (const task of kanbanDb.listTasksByStatus('queued')) {
    if (isTracked(task.task_id)) {
      continue;
    }
    const trigger: KanbanRunTrigger =
      task.column_id === 'review' ? 'review' : 'dependency';
    const hasAgent =
      trigger === 'review' ? Boolean(task.review_provider) : Boolean(task.assignee_provider);
    if (!hasAgent) {
      continue;
    }
    pending.push({ taskId: task.task_id, trigger });
  }
  drain();
}

/** Wire the queue into the automation callbacks. Idempotent. */
export function initKanbanQueue(options: { concurrency?: number } = {}): void {
  concurrency = options.concurrency && options.concurrency > 0 ? options.concurrency : DEFAULT_CONCURRENCY;
  setOnRunSettled(handleRunSettled);
  setOnTaskDone(cascadeDependents);
  setOnEnqueue((taskId, trigger, context) => enqueueTask(taskId, trigger, context));
}

export function stopKanbanQueue(): void {
  setOnRunSettled(null);
  setOnTaskDone(null);
  setOnEnqueue(null);
  pending.length = 0;
  inFlight.clear();
  wipBlocked.clear();
}

/** Introspection for tests / diagnostics. */
export function getQueueStatus(): { pending: number; inFlight: number; concurrency: number } {
  return { pending: pending.length, inFlight: inFlight.size, concurrency };
}
