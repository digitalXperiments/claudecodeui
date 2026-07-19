import { userDb } from '@/modules/database/index.js';
import { notifyRunFailed, notifyRunStopped } from '@/modules/notifications/index.js';
import { chatRunRegistry, type RunCompletionEvent } from '@/modules/websocket/index.js';
import { kanbanDb } from '@/modules/kanban/kanban.repository.js';
import type { KanbanRunStatus, KanbanTaskStatus } from '@/modules/kanban/kanban.types.js';

/**
 * Best-effort push of a task-completion notification through the host
 * notification infra. Kanban runs are headless, so we attribute the event to
 * the primary user (single-user installs); failures are swallowed.
 */
function notifyTaskOutcome(
  provider: string | null,
  appSessionId: string,
  taskTitle: string,
  outcome: 'done' | 'failed' | 'aborted',
): void {
  try {
    const userId = userDb.getFirstUser()?.id;
    if (!userId) {
      return;
    }
    // notifyRun* live in an untyped JS module whose param types TS infers as
    // narrow `null` from their defaults; the runtime accepts strings fine.
    if (outcome === 'failed') {
      notifyRunFailed({
        userId,
        provider,
        sessionId: appSessionId,
        error: `Task "${taskTitle}" failed`,
        sessionName: taskTitle,
      } as unknown as Parameters<typeof notifyRunFailed>[0]);
    } else {
      notifyRunStopped({
        userId,
        provider,
        sessionId: appSessionId,
        stopReason: outcome === 'aborted' ? 'aborted' : 'completed',
        sessionName: taskTitle,
      } as unknown as Parameters<typeof notifyRunStopped>[0]);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[Kanban] notification dispatch failed', { appSessionId, error: message });
  }
}

/**
 * Optional hook invoked when a task reaches `done`. Phase 5's automation engine
 * registers this to enqueue dependents; kept as a settable seam so this module
 * has no hard dependency on the scheduler/queue.
 */
let onTaskDone: ((taskId: string) => void) | null = null;

export function setOnTaskDone(handler: ((taskId: string) => void) | null): void {
  onTaskDone = handler;
}

/**
 * Reconcile a task + its `kanban_runs` row from a terminal run outcome. Only
 * acts when a running kanban run exists for the app session — interactive chat
 * runs (which also fire `onRunComplete`) have no such row and are ignored.
 *
 * Exported for tests; the live wiring goes through `initKanbanAutomation`.
 */
export function handleRunCompletion(event: RunCompletionEvent): void {
  const run = kanbanDb.findRunningRunByAppSession(event.appSessionId);
  if (!run) {
    return;
  }

  const runStatus: KanbanRunStatus = event.aborted ? 'aborted' : event.success ? 'done' : 'failed';
  kanbanDb.finishRun(run.run_id, runStatus, event.exitCode);

  const taskStatus: KanbanTaskStatus = event.success ? 'done' : event.aborted ? 'todo' : 'failed';
  kanbanDb.setTaskStatus(run.task_id, taskStatus);
  kanbanDb.recordTaskRunResult(run.task_id, event.exitCode);

  const task = kanbanDb.getTask(run.task_id);
  notifyTaskOutcome(
    event.provider,
    event.appSessionId,
    task?.title ?? 'Task',
    event.success ? 'done' : event.aborted ? 'aborted' : 'failed',
  );

  // Dependency cascade is wired in Phase 5; on success, dependents may unblock.
  if (event.success) {
    onTaskDone?.(run.task_id);
  }
}

/**
 * Boot-time durability pass: any `running` kanban run/task with no live registry
 * entry (the process restarted mid-run) is marked `failed`. Prevents tasks from
 * being stuck "running" forever after a crash/restart.
 */
export function reconcileKanbanOnBoot(): void {
  const stale = kanbanDb.listRunningRuns();
  for (const run of stale) {
    const appSessionId = run.app_session_id;
    if (appSessionId && chatRunRegistry.isProcessing(appSessionId)) {
      continue; // genuinely still running in this process
    }
    kanbanDb.finishRun(run.run_id, 'failed', null);
    kanbanDb.setTaskStatus(run.task_id, 'failed');
    kanbanDb.recordTaskRunResult(run.task_id, null);
  }
  if (stale.length > 0) {
    console.log(`[Kanban] reconciled ${stale.length} stale run(s) on boot`);
  }
}

let unsubscribe: (() => void) | null = null;

/**
 * Subscribe the automation engine to run completions. Idempotent; returns a
 * disposer. Called once at server boot.
 */
export function initKanbanAutomation(): () => void {
  if (unsubscribe) {
    return unsubscribe;
  }
  unsubscribe = chatRunRegistry.onRunComplete(handleRunCompletion);
  return unsubscribe;
}

export function stopKanbanAutomation(): void {
  unsubscribe?.();
  unsubscribe = null;
}
