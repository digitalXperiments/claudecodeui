/**
 * Interrupt queue maintenance: reconcile "Needs you" against reality so dead
 * entries never linger.
 *
 * - Boot sweep: clears any backlog accumulated while the server was down
 *   (terminal/missing runs, elapsed approval windows).
 * - Periodic sweep: every few minutes with a single cheap JOIN query.
 *
 * The sweep itself lives in interruptsService.sweep(); this module only owns
 * the cadence.
 */

import { Cron } from 'croner';

import { interruptsService } from '@/modules/interrupt-queue/interrupts.service.js';

/** Sweep cadence in minutes (env-tunable, min 1). */
const SWEEP_MINUTES = (() => {
  const raw = Number(process.env.CLOUDCLI_INTERRUPT_SWEEP_MINUTES);
  return Number.isFinite(raw) && raw >= 1 ? Math.trunc(raw) : 3;
})();

let sweepJob: Cron | null = null;

export function sweepInterrupts(): { resolved: number; expired: number } {
  return interruptsService.sweep();
}

export function startInterruptMaintenance(): () => void {
  stopInterruptMaintenance();

  // One-time boot reconciliation, off the startup critical path.
  setImmediate(() => {
    try {
      const result = sweepInterrupts();
      if (result.resolved > 0 || result.expired > 0) {
        console.log(
          `[Interrupts] boot sweep resolved ${result.resolved}, expired ${result.expired} stale interrupt(s)`,
        );
      }
    } catch (error) {
      console.error('[Interrupts] boot sweep failed', error);
    }
  });

  sweepJob = new Cron(`*/${SWEEP_MINUTES} * * * *`, { timezone: 'UTC' }, () => {
    try {
      const result = sweepInterrupts();
      if (result.resolved > 0 || result.expired > 0) {
        console.log(
          `[Interrupts] sweep resolved ${result.resolved}, expired ${result.expired} stale interrupt(s)`,
        );
      }
    } catch (error) {
      console.error('[Interrupts] sweep failed', error);
    }
  });
  return stopInterruptMaintenance;
}

export function stopInterruptMaintenance(): void {
  sweepJob?.stop();
  sweepJob = null;
}
