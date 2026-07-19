import { kanbanDb } from '@/modules/kanban/kanban.repository.js';
import { kanbanRunner } from '@/modules/kanban/kanban-runner.service.js';
import { setOnRunSettled, setOnTaskDone } from '@/modules/kanban/kanban-automation.service.js';
import type { KanbanRunTrigger } from '@/modules/kanban/kanban.types.js';

type QueueItem = { taskId: string; trigger: KanbanRunTrigger };

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
let concurrency = DEFAULT_CONCURRENCY;

function isTracked(taskId: string): boolean {
  return inFlight.has(taskId) || pending.some((item) => item.taskId === taskId);
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
    kanbanRunner.runTask(item.taskId, item.trigger).catch((error) => {
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
 */
export function enqueueTask(taskId: string, trigger: KanbanRunTrigger): void {
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
  if (!task.assignee_provider) {
    // Nothing to run automatically without an assigned agent.
    return;
  }
  kanbanDb.setTaskStatus(taskId, 'queued');
  pending.push({ taskId, trigger });
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
    if (dependenciesSatisfied(dependentId)) {
      enqueueTask(dependentId, 'dependency');
    }
  }
}

function handleRunSettled(taskId: string): void {
  inFlight.delete(taskId);
  drain();
}

/**
 * Re-enqueue tasks persisted as `queued` (e.g. after a restart). Called on boot
 * after reconcile.
 */
export function requeuePersisted(): void {
  for (const task of kanbanDb.listTasksByStatus('queued')) {
    if (!isTracked(task.task_id) && task.assignee_provider) {
      pending.push({ taskId: task.task_id, trigger: 'dependency' });
    }
  }
  drain();
}

/** Wire the queue into the automation callbacks. Idempotent. */
export function initKanbanQueue(options: { concurrency?: number } = {}): void {
  concurrency = options.concurrency && options.concurrency > 0 ? options.concurrency : DEFAULT_CONCURRENCY;
  setOnRunSettled(handleRunSettled);
  setOnTaskDone(cascadeDependents);
}

export function stopKanbanQueue(): void {
  setOnRunSettled(null);
  setOnTaskDone(null);
  pending.length = 0;
  inFlight.clear();
}

/** Introspection for tests / diagnostics. */
export function getQueueStatus(): { pending: number; inFlight: number; concurrency: number } {
  return { pending: pending.length, inFlight: inFlight.size, concurrency };
}
