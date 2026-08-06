import { Cron } from 'croner';

import { webhooksDb } from '@/modules/webhooks/webhooks.repository.js';
import {
  reconstructPayloadFromDelivery,
  startWebhookDelivery,
} from '@/modules/webhooks/webhooks-runner.service.js';

let job: Cron | null = null;
let started = false;
let running = false;

/**
 * Re-dispatch failed deliveries whose retry window has elapsed. Each tick only
 * runs a cheap "which deliveries are due" query; a `running` guard prevents
 * overlapping ticks from double-dispatching when a tick outlives the minute
 * interval.
 */
async function tick(): Promise<void> {
  if (running) {
    return;
  }
  running = true;
  try {
    const due = webhooksDb.listRetryableDeliveries(new Date().toISOString());
    for (const delivery of due) {
      try {
        const source = webhooksDb.getSourceById(delivery.source_id);
        if (!source) {
          continue;
        }
        const payload = reconstructPayloadFromDelivery(delivery);
        const startedRun = await startWebhookDelivery({
          source,
          payload,
          deliveryId: delivery.delivery_id,
        });
        void startedRun.completion.catch(() => {
          // Completion errors are already recorded on the delivery row by the runner.
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error('[Webhooks] retry scheduler dispatch failed', {
          deliveryId: delivery.delivery_id,
          error: message,
        });
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[Webhooks] retry scheduler tick failed', { error: message });
  } finally {
    running = false;
  }
}

/** Start the once-a-minute retry scheduler (idempotent). */
export function startWebhookRetryScheduler(): void {
  if (started) {
    return;
  }
  started = true;
  job = new Cron('*/1 * * * *', () => {
    void tick();
  });
}

/** Stop the scheduler and cancel any pending job (shutdown). */
export function stopWebhookRetryScheduler(): void {
  if (job) {
    job.stop();
    job = null;
  }
  started = false;
  running = false;
}

export function isWebhookRetrySchedulerRunning(): boolean {
  return started;
}
