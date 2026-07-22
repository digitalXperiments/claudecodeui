import { systemNotificationsDb, userDb } from '@/modules/database/index.js';
import { notifyRunFailed, notifyRunStopped } from '@/modules/notifications/index.js';
import { chatRunRegistry, type RunCompletionEvent } from '@/modules/websocket/index.js';
import { kanbanDb } from '@/modules/kanban/kanban.repository.js';
import {
  COLUMN_DONE,
  COLUMN_REVIEW,
  isKanbanProvider,
  type KanbanRunStatus,
} from '@/modules/kanban/kanban.types.js';

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
      try {
        systemNotificationsDb.create({
          kind: 'run_failed',
          severity: 'error',
          title: `Kanban task failed: ${taskTitle}`,
          body: `A ${provider || 'agent'} run failed for this task.`,
          source: 'kanban',
          href: null,
          meta: { appSessionId, provider, taskTitle },
          dedupeKey: `kanban-fail:${appSessionId}`,
        });
      } catch {
        // inbox write is best-effort
      }
    } else {
      notifyRunStopped({
        userId,
        provider,
        sessionId: appSessionId,
        stopReason: outcome === 'aborted' ? 'aborted' : 'completed',
        sessionName: taskTitle,
      } as unknown as Parameters<typeof notifyRunStopped>[0]);
      if (outcome === 'aborted') {
        try {
          systemNotificationsDb.create({
            kind: 'action_required',
            severity: 'warning',
            title: `Kanban run aborted: ${taskTitle}`,
            body: 'The agent run was aborted before completion.',
            source: 'kanban',
            meta: { appSessionId, provider, taskTitle },
            dedupeKey: `kanban-abort:${appSessionId}`,
          });
        } catch {
          // best-effort
        }
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[Kanban] notification dispatch failed', { appSessionId, error: message });
  }
}

/**
 * Optional hook invoked when a task is fully complete (Done column). Phase 5's
 * automation engine registers this to enqueue dependents.
 */
let onTaskDone: ((taskId: string) => void) | null = null;

export function setOnTaskDone(handler: ((taskId: string) => void) | null): void {
  onTaskDone = handler;
}

/**
 * Hook invoked after every kanban run settles (success or failure), with the
 * task id. The run queue registers this to free a concurrency slot and drain.
 */
let onRunSettled: ((taskId: string) => void) | null = null;

export function setOnRunSettled(handler: ((taskId: string) => void) | null): void {
  onRunSettled = handler;
}

/**
 * Optional hook to enqueue a follow-up run (e.g. review). Injected from the
 * queue module so this file stays free of a hard queue dependency. The context
 * carries hand-off data from the finished run — currently the implementation
 * agent's output tail for the review brief.
 */
export type KanbanEnqueueContext = {
  implementOutput?: string | null;
};

let onEnqueue: ((taskId: string, trigger: 'review', context?: KanbanEnqueueContext) => void) | null =
  null;

export function setOnEnqueue(
  handler: ((taskId: string, trigger: 'review', context?: KanbanEnqueueContext) => void) | null,
): void {
  onEnqueue = handler;
}

/** Cap on how much implementation output travels into the review brief. */
const MAX_IMPLEMENT_OUTPUT_CHARS = 6000;

/**
 * Best-effort extraction of what the implementation agent actually said, pulled
 * from the run's buffered events (still resident at completion time). Prefers
 * whole `text` messages; falls back to concatenated `stream_delta` chunks for
 * providers that only stream. Returns null when nothing usable was captured —
 * the review brief then relies on the git-diff instructions alone.
 */
function extractImplementOutput(appSessionId: string): string | null {
  try {
    const events = chatRunRegistry.replayEvents(appSessionId, 0);
    const textChunks: string[] = [];
    const deltaChunks: string[] = [];
    for (const event of events) {
      if (typeof event.content !== 'string') {
        continue;
      }
      if (event.kind === 'text' || event.kind === 'error') {
        textChunks.push(event.content);
      } else if (event.kind === 'stream_delta') {
        deltaChunks.push(event.content);
      }
    }
    const joined = (textChunks.length > 0 ? textChunks.join('\n') : deltaChunks.join('')).trim();
    if (!joined) {
      return null;
    }
    return joined.length > MAX_IMPLEMENT_OUTPUT_CHARS
      ? `…${joined.slice(-MAX_IMPLEMENT_OUTPUT_CHARS)}`
      : joined;
  } catch {
    return null;
  }
}

/**
 * Persist a durable, human-readable trail entry summarising what an agent run
 * did. The output tail otherwise lives only in the transient run-event buffer
 * and is lost once the session is cleared. Best-effort — never throws into the
 * completion path.
 */
function recordAgentComment(
  taskId: string,
  runId: string,
  provider: string | null,
  role: 'implement' | 'review',
  outcome: 'done' | 'failed' | 'aborted',
  output: string | null,
): void {
  try {
    const roleLabel = role === 'review' ? 'Review agent' : 'Implementation agent';
    const outcomeLabel =
      outcome === 'done' ? 'completed' : outcome === 'aborted' ? 'was aborted' : 'failed';
    const header = `${roleLabel}${provider ? ` (${provider})` : ''} ${outcomeLabel}.`;
    const body = output ? `${header}\n\n${output}` : header;
    kanbanDb.addComment({
      taskId,
      authorType: 'agent',
      author: provider,
      body,
      runId,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[Kanban] failed to record agent comment', { taskId, error: message });
  }
}

/** True when the task's board actually contains the given column. */
function boardHasColumn(task: { board_id: string } | null, columnId: string): boolean {
  if (!task) {
    return false;
  }
  const board = kanbanDb.getBoard(task.board_id);
  return Boolean(board?.columns.some((col) => col.id === columnId));
}

/**
 * Treat exitCode 0 as success even if a provider omitted the `success` flag.
 * This hardens against incomplete complete messages that used to mark real
 * successes as `failed`.
 */
function isSuccessfulOutcome(event: RunCompletionEvent): boolean {
  if (event.aborted) {
    return false;
  }
  if (event.success) {
    return true;
  }
  return event.exitCode === 0;
}

/**
 * Reconcile a task + its `kanban_runs` row from a terminal run outcome. Only
 * acts when a running kanban run exists for the app session — interactive chat
 * runs (which also fire `onRunComplete`) have no such row and are ignored.
 *
 * Lifecycle on success:
 * - implement + review agent set → move to Review, clear session, enqueue review
 * - implement + no review agent  → move to Done, cascade dependents
 * - review                       → move to Done, cascade dependents
 *
 * Exported for tests; the live wiring goes through `initKanbanAutomation`.
 */
export function handleRunCompletion(event: RunCompletionEvent): void {
  const run = kanbanDb.findRunningRunByAppSession(event.appSessionId);
  if (!run) {
    return;
  }

  const success = isSuccessfulOutcome(event);
  const runStatus: KanbanRunStatus = event.aborted ? 'aborted' : success ? 'done' : 'failed';
  kanbanDb.finishRun(run.run_id, runStatus, event.exitCode);
  kanbanDb.recordTaskRunResult(run.task_id, event.exitCode);

  const task = kanbanDb.getTask(run.task_id);
  const role = run.role === 'review' ? 'review' : 'implement';
  const hasReviewAgent = Boolean(
    task?.review_provider && isKanbanProvider(task.review_provider),
  );

  // Capture what the agent said once; reused for the durable comment trail and
  // (on the implement→review handoff) the review brief.
  const agentOutput = extractImplementOutput(event.appSessionId);
  recordAgentComment(run.task_id, run.run_id, event.provider, role, runStatus, agentOutput);

  // Free the queue slot before any follow-up enqueue of the *same* task
  // (implement → review). Otherwise isTracked() would drop the review run.
  onRunSettled?.(run.task_id);

  if (event.aborted) {
    kanbanDb.setTaskStatus(run.task_id, 'todo');
  } else if (!success) {
    // Keep the card in its current column so the user can fix and re-run.
    kanbanDb.setTaskStatus(run.task_id, 'failed');
  } else if (role === 'implement' && hasReviewAgent) {
    // Implementation finished → hand off to the review agent with the
    // implementation output. Clear the session so the review agent gets a
    // fresh conversation.
    kanbanDb.setTaskSession(run.task_id, null);
    // Move into the Review column when the board has one; on custom boards
    // without it the review still runs, the card just stays put.
    if (boardHasColumn(task, COLUMN_REVIEW)) {
      kanbanDb.moveTaskToColumn(run.task_id, COLUMN_REVIEW, 'todo');
    } else {
      kanbanDb.setTaskStatus(run.task_id, 'todo');
    }
    onEnqueue?.(run.task_id, 'review', {
      implementOutput: agentOutput,
    });
  } else {
    // Fully done: either no review agent, or the review itself finished. Move
    // to the Done column when the board has one; otherwise just flip status.
    if (boardHasColumn(task, COLUMN_DONE)) {
      kanbanDb.moveTaskToColumn(run.task_id, COLUMN_DONE, 'done');
    } else {
      kanbanDb.setTaskStatus(run.task_id, 'done');
    }
    onTaskDone?.(run.task_id);
  }

  const outcome: 'done' | 'failed' | 'aborted' = event.aborted
    ? 'aborted'
    : success
      ? 'done'
      : 'failed';
  notifyTaskOutcome(event.provider, event.appSessionId, task?.title ?? 'Task', outcome);
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
