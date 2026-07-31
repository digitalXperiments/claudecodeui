import { chatRunRegistry, type RunCompletionEvent } from '@/modules/websocket/index.js';
import { webhooksDb } from '@/modules/webhooks/webhooks.repository.js';
import { extractWebhookRunOutcome } from '@/modules/webhooks/webhooks-runner.service.js';

let unsubscribe: (() => void) | null = null;

/**
 * Reconcile webhook delivery status when a provider run completes.
 * Only acts when a delivery row is still accepted/running for the session
 * (chat and kanban runs without a matching delivery are ignored).
 */
export function handleWebhookRunCompletion(event: RunCompletionEvent): void {
  try {
    const delivery = webhooksDb.findDeliveryByAppSession(event.appSessionId);
    if (!delivery) {
      return;
    }
    if (delivery.status === 'done' || delivery.status === 'failed') {
      return;
    }

    const outcome = extractWebhookRunOutcome(event.appSessionId);
    const preview = outcome.text.slice(0, 2000) || null;
    const failed = event.aborted || !event.success || outcome.failed;

    webhooksDb.finishDelivery(delivery.delivery_id, failed ? 'failed' : 'done', {
      errorMessage: failed
        ? outcome.errorMessage ||
          (event.aborted ? 'Run aborted' : 'Provider run failed')
        : null,
      resultPreview: preview,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[Webhooks] onRunComplete handler failed', {
      appSessionId: event.appSessionId,
      error: message,
    });
  }
}

export function initWebhookAutomation(): void {
  if (unsubscribe) {
    return;
  }
  unsubscribe = chatRunRegistry.onRunComplete(handleWebhookRunCompletion);
}

export function stopWebhookAutomation(): void {
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }
}
