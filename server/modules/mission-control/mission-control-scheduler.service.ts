import { Cron } from 'croner';

import { missionControlDb } from '@/modules/mission-control/mission-control.repository.js';
import { runSectionProduce } from '@/modules/mission-control/mission-control-runner.service.js';

import { drainWorkQueue, recoverWorkDispatches } from './mission-control-dispatch.service.js';

/**
 * Injected by the bot kernel while the runtime flag is on: sections it returns `true` for are
 * owned by the signals scheduler, so the legacy cron must not also tick them.
 */
let scheduleFilter: ((sectionId: string) => boolean) | null = null;

export function setMissionControlScheduleFilter(filter: ((sectionId: string) => boolean) | null): void {
  scheduleFilter = filter;
  syncMissionControlSchedules();
}

/** Active cron jobs keyed by section id. */
const jobs = new Map<string, Cron>();
let started = false;
/** Prevent overlapping produce runs for the same section. */
const running = new Set<string>();

function clearJob(sectionId: string): void {
  const job = jobs.get(sectionId);
  if (job) {
    job.stop();
    jobs.delete(sectionId);
  }
}

/** Runs one scheduled produce tick for a section (exported for tests). */
export async function tickSection(sectionId: string): Promise<void> {
  if (running.has(sectionId)) {
    console.warn('[MissionControl] skip overlapping schedule tick', { sectionId });
    return;
  }
  running.add(sectionId);
  try {
    await runSectionProduce(sectionId, { trigger: 'schedule' });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[MissionControl] scheduled produce failed', { sectionId, error: message });
  } finally {
    running.delete(sectionId);
  }
}

/**
 * Rebuild cron jobs from enabled sections with a schedule. Safe after
 * create/update/delete of any section.
 */
export function syncMissionControlSchedules(): void {
  if (!started) return;

  const scheduled = missionControlDb
    .listEnabledScheduledSections()
    .filter((section) => !scheduleFilter?.(section.section_id));
  const wanted = new Set(scheduled.map((s) => s.section_id));

  for (const sectionId of [...jobs.keys()]) {
    if (!wanted.has(sectionId)) {
      clearJob(sectionId);
    }
  }

  for (const section of scheduled) {
    const cron = section.schedule_cron?.trim();
    if (!cron) continue;

    const existing = jobs.get(section.section_id);
    if (existing && existing.getPattern() === cron) {
      continue;
    }
    clearJob(section.section_id);
    try {
      const job = new Cron(cron, () => {
        void tickSection(section.section_id);
      });
      jobs.set(section.section_id, job);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[MissionControl] invalid cron for section', {
        sectionId: section.section_id,
        cron,
        error: message,
      });
    }
  }
}

export function startMissionControlScheduler(): void {
  if (started) return;
  recoverWorkDispatches();
  started = true;
  for (const section of missionControlDb.listSections()) drainWorkQueue(section.section_id);
  syncMissionControlSchedules();
}

export function stopMissionControlScheduler(): void {
  for (const sectionId of [...jobs.keys()]) {
    clearJob(sectionId);
  }
  started = false;
}

export function getMissionControlScheduledJobCount(): number {
  return jobs.size;
}
