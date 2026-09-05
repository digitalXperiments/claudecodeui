import { Cron } from 'croner';

import type { ProviderUsageResponse } from '@/modules/provider-usage/index.js';
import { broadcastSystemEvent } from '@/modules/websocket/index.js';

import { continuityRepository } from './continuity.repository.js';
import { dispatchContinuityRecovery } from './continuity.service.js';
import {
  classifyProviderQuota,
  configureContinuityUsageLoader,
  CONTINUITY_RESET_JITTER_MS,
  CONTINUITY_USAGE_POLL_DEFER_MS,
  LIVE_USAGE_PROVIDERS,
  loadContinuityUsage,
} from './continuity-usage.js';

export { configureContinuityUsageLoader };

const CONTINUITY_USAGE_SWEEP_LIMIT = 250;

let job: Cron | null = null;
let running = false;
let started = false;

async function refreshWaitingRecoveryUsage(nowMs: number): Promise<void> {
  const waiting = continuityRepository.listWaitingForProviders(
    LIVE_USAGE_PROVIDERS,
    CONTINUITY_USAGE_SWEEP_LIMIT,
  );
  if (waiting.length === 0) return;

  let usage: ProviderUsageResponse;
  try {
    // One shared manual refresh preserves provider-usage's anti-stampede policy.
    usage = await loadContinuityUsage(nowMs);
  } catch {
    return;
  }

  const rowsByProvider = new Map(usage.providers.map((provider) => [provider.providerId, provider]));
  for (const recovery of waiting) {
    const evidence = classifyProviderQuota(rowsByProvider.get(recovery.sourceProvider), nowMs);
    const due = !recovery.retryAt || Date.parse(recovery.retryAt) <= nowMs;
    let retryAt: string | null = null;
    if (evidence.kind === 'available') {
      retryAt = new Date(nowMs).toISOString();
    } else if (evidence.kind === 'exhausted' && evidence.resetsAt) {
      retryAt = new Date(Date.parse(evidence.resetsAt) + CONTINUITY_RESET_JITTER_MS).toISOString();
    } else if (evidence.kind === 'exhausted' && due) {
      // Keep polling instead of firing the fallback timer while quota is still empty.
      retryAt = new Date(nowMs + CONTINUITY_USAGE_POLL_DEFER_MS).toISOString();
    }
    if (!retryAt) continue;

    const updated = continuityRepository.updateWaitingRetryAt(
      recovery.recoveryId,
      retryAt,
      'provider',
    );
    if (updated) {
      broadcastSystemEvent({
        kind: 'continuity_updated',
        sessionId: updated.sessionId,
        recovery: updated,
      });
    }
  }
}

export async function runContinuitySchedulerTick(nowMs = Date.now()): Promise<void> {
  if (running) return;
  running = true;
  try {
    await refreshWaitingRecoveryUsage(nowMs);
    const recoveries = continuityRepository.claimDue(new Date(nowMs).toISOString());
    for (const recovery of recoveries) {
      try {
        await dispatchContinuityRecovery(recovery);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const updated = continuityRepository.update(recovery.recoveryId, {
          status: 'needs_attention',
          lastError: message,
          completedAt: new Date().toISOString(),
        });
        if (updated) {
          broadcastSystemEvent({
            kind: 'continuity_updated',
            sessionId: updated.sessionId,
            recovery: updated,
          });
        }
        console.error('[Continuity] recovery dispatch failed', {
          recoveryId: recovery.recoveryId,
          error: message,
        });
      }
    }
  } finally {
    running = false;
  }
}

export function startContinuityScheduler(): void {
  if (started) return;
  continuityRepository.recoverInterrupted();
  started = true;
  void runContinuitySchedulerTick();
  job = new Cron('*/15 * * * * *', () => void runContinuitySchedulerTick());
}

export function stopContinuityScheduler(): void {
  job?.stop();
  job = null;
  running = false;
  started = false;
}
