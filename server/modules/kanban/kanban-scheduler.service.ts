import { Cron } from 'croner';

import { systemNotificationsDb } from '@/modules/database/index.js';
import { interruptsService } from '@/modules/interrupt-queue/index.js';
import { kanbanDb } from '@/modules/kanban/kanban.repository.js';
import { enqueueTask } from '@/modules/kanban/kanban-queue.service.js';

/** Active cron jobs keyed by task id. */
const jobs = new Map<string, Cron>();
let started = false;

/** Periodic overdue-escalation sweep job (not keyed by task id). */
let overdueSweepJob: Cron | null = null;
/** Re-entry guard so a slow sweep can never overlap itself. */
let sweepRunning = false;

/** How often the overdue sweep runs. */
const OVERDUE_SWEEP_CRON = '*/15 * * * *';
/** Re-escalate an overdue task at most once per 6 hours. */
const ESCALATION_COOLDOWN_MS = 6 * 60 * 60 * 1000;

/**
 * Escalate overdue tasks: for every task past its due date still in `todo`/
 * `queued`, raise a system notification + task comment and stamp `escalated_at`
 * so the next escalation is at most every 6 hours. Runs only while the
 * scheduler is started (mirrors `syncSchedules`' `started` guard) and never
 * overlaps itself.
 */
export function sweepOverdueTasks(): void {
  if (!started || sweepRunning) {
    return;
  }
  sweepRunning = true;
  try {
    const now = new Date();
    const nowIso = now.toISOString();
    for (const task of kanbanDb.listOverdueTasks(nowIso)) {
      const escalatedAt = task.escalated_at ? Date.parse(task.escalated_at) : null;
      const withinCooldown =
        escalatedAt !== null &&
        !Number.isNaN(escalatedAt) &&
        now.getTime() - escalatedAt <= ESCALATION_COOLDOWN_MS;
      if (withinCooldown) {
        continue;
      }
      try {
        const dueLabel = task.due_date ?? '';
        systemNotificationsDb.create({
          kind: 'info',
          severity: 'warning',
          title: `Overdue: ${task.title}`,
          body: `Task is overdue (due ${dueLabel}).`,
          source: 'kanban',
          href: '/kanban',
          meta: { taskId: task.task_id },
          dedupeKey: `kanban-overdue-${task.task_id}`,
        });
        try {
          interruptsService.create({
            projectId: task.project_id,
            kind: 'task_overdue',
            severity: 'warning',
            title: `Overdue: ${task.title}`,
            body: `Task is overdue (due ${dueLabel}).`,
            taskId: task.task_id,
            href: '/kanban',
            actions: [
              { id: 'open_href', label: 'Open board', style: 'primary' },
              { id: 'dismiss', label: 'Dismiss', style: 'secondary' },
            ],
            meta: { taskId: task.task_id, dueDate: task.due_date },
            dedupeKey: `task_overdue:${task.task_id}`,
          });
        } catch {
          // interrupt is best-effort
        }
        kanbanDb.addComment({
          taskId: task.task_id,
          authorType: 'agent',
          author: null,
          body: `⚠️ Task overdue (due ${dueLabel}).`,
        });
        kanbanDb.updateTask(task.task_id, { escalatedAt: nowIso });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error('[Kanban] overdue escalation failed for task', {
          taskId: task.task_id,
          error: message,
        });
      }
    }
  } finally {
    sweepRunning = false;
  }
}

function startOverdueSweep(): void {
  if (overdueSweepJob) {
    overdueSweepJob.stop();
    overdueSweepJob = null;
  }
  try {
    overdueSweepJob = new Cron(OVERDUE_SWEEP_CRON, () => {
      sweepOverdueTasks();
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[Kanban] failed to start overdue sweep', { error: message });
  }
}

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
  startOverdueSweep();
}

/** Stop every cron job (shutdown). */
export function stopKanbanScheduler(): void {
  for (const taskId of [...jobs.keys()]) {
    clearJob(taskId);
  }
  if (overdueSweepJob) {
    overdueSweepJob.stop();
    overdueSweepJob = null;
  }
  started = false;
}

export function getScheduledJobCount(): number {
  return jobs.size;
}
