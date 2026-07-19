import { Cron } from 'croner';

import { kanbanDb } from '@/modules/kanban/kanban.repository.js';
import { enqueueTask } from '@/modules/kanban/kanban-queue.service.js';

/** Active cron jobs keyed by task id. */
const jobs = new Map<string, Cron>();
let started = false;

function clearJob(taskId: string): void {
  const job = jobs.get(taskId);
  if (job) {
    job.stop();
    jobs.delete(taskId);
  }
}

/**
 * Rebuild the set of cron jobs from the current scheduled tasks. Safe to call
 * whenever a task's cron changes (create/update/delete). Invalid cron strings
 * are logged and skipped rather than crashing the scheduler.
 */
export function syncSchedules(): void {
  if (!started) {
    return;
  }
  const scheduled = kanbanDb.listScheduledTasks();
  const wanted = new Set(scheduled.map((task) => task.task_id));

  // Drop jobs for tasks that are no longer scheduled.
  for (const taskId of [...jobs.keys()]) {
    if (!wanted.has(taskId)) {
      clearJob(taskId);
    }
  }

  for (const task of scheduled) {
    const cron = task.schedule_cron?.trim();
    if (!cron) {
      continue;
    }
    const existing = jobs.get(task.task_id);
    // Recreate the job if the pattern changed (croner has no reschedule API).
    if (existing && existing.getPattern() === cron) {
      continue;
    }
    clearJob(task.task_id);
    try {
      const job = new Cron(cron, () => {
        enqueueTask(task.task_id, 'schedule');
      });
      jobs.set(task.task_id, job);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[Kanban] invalid cron for task', { taskId: task.task_id, cron, error: message });
    }
  }
}

/** Start the scheduler and load all persisted schedules. */
export function startKanbanScheduler(): void {
  started = true;
  syncSchedules();
}

/** Stop every cron job (shutdown). */
export function stopKanbanScheduler(): void {
  for (const taskId of [...jobs.keys()]) {
    clearJob(taskId);
  }
  started = false;
}

export function getScheduledJobCount(): number {
  return jobs.size;
}
