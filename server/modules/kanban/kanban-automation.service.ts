import { chatRunRegistry, type RunCompletionEvent } from '@/modules/websocket/index.js';
import { kanbanDb } from '@/modules/kanban/kanban.repository.js';
import type { KanbanRunStatus, KanbanTaskStatus } from '@/modules/kanban/kanban.types.js';

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
