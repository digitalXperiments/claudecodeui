import { Cron } from 'croner';

import { notificationPreferencesDb } from '@/modules/database/index.js';
import { runDailyDigest } from '@/modules/notifications/services/notification-digest.service.js';

const DEFAULT_DIGEST_TIME = '08:00';
const DIGEST_TIME_PATTERN = /^(\d{2}):(\d{2})$/;

/** Active digest cron jobs keyed by userId. */
const jobs = new Map();
let started = false;
/** Prevent overlapping digest ticks for the same user. */
const running = new Set();

function parseDigestTime(time) {
  const match = typeof time === 'string' ? time.match(DIGEST_TIME_PATTERN) : null;
  if (!match) {
    return null;
  }
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) {
    return null;
  }
  return `${String(minutes).padStart(2, '0')} ${String(hours).padStart(2, '0')} * * *`;
}

function clearJob(userId) {
  const job = jobs.get(userId);
  if (job) {
    job.stop();
    jobs.delete(userId);
  }
}

async function tickDigest(userId, preferences) {
  if (running.has(userId)) {
    console.warn('[Notifications] skip overlapping digest tick', { userId });
    return;
  }
  running.add(userId);
  try {
    const result = await runDailyDigest(userId, preferences);
    console.log('[Notifications] daily digest run', { userId, count: result.count });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[Notifications] daily digest failed', { userId, error: message });
  } finally {
    running.delete(userId);
  }
}

/**
 * Rebuild digest cron jobs from stored preferences. Safe after any
 * notification-preferences update.
 */
export function syncNotificationDigestSchedules() {
  if (!started) {
    return;
  }

  const rows = notificationPreferencesDb.listAll();
  const wanted = new Map();
  for (const row of rows) {
    if (row.preferences?.digest?.enabled === true) {
      wanted.set(row.userId, row.preferences);
    }
  }

  for (const userId of [...jobs.keys()]) {
    if (!wanted.has(userId)) {
      clearJob(userId);
    }
  }

  for (const [userId, preferences] of wanted) {
    const pattern = parseDigestTime(preferences.digest?.time) || `00 ${DEFAULT_DIGEST_TIME.slice(0, 2)} * * *`;
    const existing = jobs.get(userId);
    if (existing && existing.getPattern() === pattern) {
      continue;
    }
    clearJob(userId);
    try {
      const job = new Cron(pattern, () => {
        void tickDigest(userId, preferences);
      });
      jobs.set(userId, job);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[Notifications] invalid digest schedule', { userId, pattern, error: message });
    }
  }
}

export function startNotificationDigestScheduler() {
  if (started) {
    return;
  }
  started = true;
  syncNotificationDigestSchedules();
}

export function stopNotificationDigestScheduler() {
  for (const userId of [...jobs.keys()]) {
    clearJob(userId);
  }
  started = false;
}
