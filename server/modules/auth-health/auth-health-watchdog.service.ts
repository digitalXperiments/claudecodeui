/**
 * Auth health watchdog: hourly cron probe of every provider's auth status plus
 * one initial run shortly after boot, so expired credentials surface as inbox
 * notifications soon after a restart.
 */

import { Cron } from 'croner';

import {
  applyAuthHealthOutcomes,
  checkAuthHealth,
} from '@/modules/auth-health/auth-health.service.js';

const DEFAULT_CRON_PATTERN = '23 * * * *';
const INITIAL_RUN_DELAY_MS = 90_000;

let job: Cron | null = null;
let initialTimer: ReturnType<typeof setTimeout> | null = null;
/** Prevent overlapping watchdog ticks (probes spawn provider CLIs). */
let running = false;

async function tick(): Promise<void> {
  if (running) {
    console.warn('[auth-health] skip overlapping watchdog tick');
    return;
  }
  running = true;
  try {
    const report = await checkAuthHealth();
    await applyAuthHealthOutcomes(report);
    const broken = report.providers
      .filter((p) => p.installed && !p.authenticated)
      .map((p) => p.provider);
    if (broken.length > 0) {
      console.warn(`[auth-health] broken provider auth: ${broken.join(', ')}`);
    } else {
      console.log('[auth-health] all installed providers authenticated');
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[auth-health] watchdog tick failed:', message);
  } finally {
    running = false;
  }
}

export function startAuthHealthWatchdog(): void {
  if (process.env.AUTH_HEALTH_DISABLED === '1') {
    console.log('[auth-health] watchdog disabled (AUTH_HEALTH_DISABLED=1)');
    return;
  }
  if (job) {
    return;
  }

  const pattern = process.env.AUTH_HEALTH_CRON?.trim() || DEFAULT_CRON_PATTERN;
  job = new Cron(pattern, () => {
    void tick();
  });
  console.log(`[auth-health] watchdog started (cron "${pattern}", initial run in ${INITIAL_RUN_DELAY_MS / 1000}s)`);

  initialTimer = setTimeout(() => {
    void tick();
  }, INITIAL_RUN_DELAY_MS);
  // Never keep the process alive just for the initial probe.
  initialTimer.unref?.();
}

export function stopAuthHealthWatchdog(): void {
  if (initialTimer) {
    clearTimeout(initialTimer);
    initialTimer = null;
  }
  if (job) {
    job.stop();
    job = null;
  }
}
