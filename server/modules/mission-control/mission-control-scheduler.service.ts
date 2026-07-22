import { Cron } from 'croner';

import { missionControlDb } from '@/modules/mission-control/mission-control.repository.js';
import { runSectionProduce } from '@/modules/mission-control/mission-control-runner.service.js';

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

async function tickSection(sectionId: string): Promise<void> {
  if (running.has(sectionId)) {
    console.warn('[MissionControl] skip overlapping schedule tick', { sectionId });
    return;
  }
  running.add(sectionId);
  try {
    await runSectionProduce(sectionId);
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

  const scheduled = missionControlDb.listEnabledScheduledSections();
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
  started = true;
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
