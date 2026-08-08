import { runService } from '@/modules/runs/index.js';
import { broadcastSystemEvent } from '@/modules/websocket/index.js';
import { CloudError } from '@/shared/run-events.js';
import { interruptsDb } from '@/modules/interrupt-queue/interrupts.repository.js';
import type {
  CreateInterruptInput,
  Interrupt,
  InterruptActionInput,
  InterruptListFilter,
} from '@/modules/interrupt-queue/interrupts.types.js';

type PermissionResolver = (
  requestId: string,
  decision: { allow: boolean; updatedInput?: unknown; message?: string },
) => void;
let resolvePermission: PermissionResolver | null = null;
type FailoverResolver = (runId: string, playbookId: string | null) => void;
let resolveFailover: FailoverResolver | null = null;
type McItemResolver = (itemId: string, decision: 'approve' | 'deny') => void | Promise<void>;
let resolveMcItem: McItemResolver | null = null;
type RetryRunResolver = (runId: string) => void | Promise<void>;
let resolveRetryRun: RetryRunResolver | null = null;

function emitInterrupt(kind: 'interrupt_created' | 'interrupt_updated', interrupt: Interrupt): void {
  broadcastSystemEvent({ kind, interrupt });
}

export const interruptsService = {
  configurePermissionResolver(resolver: PermissionResolver | null): void {
    resolvePermission = resolver;
  },
  configureFailoverResolver(resolver: FailoverResolver | null): void {
    resolveFailover = resolver;
  },
  configureMcItemResolver(resolver: McItemResolver | null): void {
    resolveMcItem = resolver;
  },
  configureRetryRunResolver(resolver: RetryRunResolver | null): void {
    resolveRetryRun = resolver;
  },
  list(filter: InterruptListFilter = {}): Interrupt[] {
    return interruptsDb.list(filter);
  },
  countOpen(projectId?: string): number {
    return interruptsDb.countOpen(projectId);
  },
  get(id: string): Interrupt | null {
    return interruptsDb.get(id);
  },
  resolveMissionControlItem(itemId: string, actor = 'mission-control', resolution = 'item_action'): Interrupt[] {
    const linked = [
      ...interruptsDb.listByMeta('itemId', itemId),
      ...interruptsDb.listByMeta('item_id', itemId),
    ].filter((interrupt, index, all) => (
      all.findIndex((candidate) => candidate.interrupt_id === interrupt.interrupt_id) === index
    ));
    const resolved: Interrupt[] = [];
    for (const interrupt of linked) {
      const next = interruptsDb.resolve(interrupt.interrupt_id, 'resolved', actor, resolution);
      if (next) {
        resolved.push(next);
        emitInterrupt('interrupt_updated', next);
      }
    }
    return resolved;
  },
  create(input: CreateInterruptInput): Interrupt {
    const interrupt = interruptsDb.create(input);
    emitInterrupt('interrupt_created', interrupt);
    void import('@/modules/automation/index.js')
      .then(({ automationService }) => {
        void automationService.fire({
          type: 'interrupt_created',
          projectId: interrupt.project_id,
          payload: {
            interruptId: interrupt.interrupt_id,
            kind: interrupt.kind,
            severity: interrupt.severity,
            runId: interrupt.run_id,
            taskId: interrupt.task_id,
          },
        });
      })
      .catch(() => {
        // optional
      });
    return interrupt;
  },

  act(id: string, input: InterruptActionInput): Interrupt {
    const interrupt = interruptsDb.get(id);
    if (!interrupt) throw new CloudError('INTERRUPT_NOT_FOUND', `Interrupt not found: ${id}`);
    if (interrupt.status === 'resolved' || interrupt.status === 'dismissed') {
      throw new CloudError('INTERRUPT_ALREADY_RESOLVED', `Interrupt ${id} is already resolved`);
    }

    let resolved: Interrupt;
    switch (input.key) {
      case 'approve_permission':
      case 'deny_permission': {
        const requestId =
          typeof interrupt.meta.requestId === 'string' ? interrupt.meta.requestId : null;
        if (!requestId || !resolvePermission) {
          throw new CloudError('INTERRUPT_NOT_FOUND', 'The permission request is no longer active');
        }
        resolvePermission(requestId, {
          allow: input.key === 'approve_permission',
          updatedInput: input.body?.updatedInput,
          message: typeof input.body?.message === 'string' ? input.body.message : undefined,
        });
        resolved = interruptsDb.resolve(id, 'resolved', input.actor ?? null, input.key)!;
        break;
      }
      case 'abort_run': {
        if (interrupt.run_id) {
          const run = runService.get(interrupt.run_id);
          if (run && !['succeeded', 'failed', 'aborted', 'timed_out'].includes(run.status)) {
            runService.markTerminal(interrupt.run_id, {
              status: 'aborted',
              errorSummary: 'aborted from interrupt queue',
            });
          }
        }
        resolved = interruptsDb.resolve(id, 'resolved', input.actor ?? null, input.key)!;
        break;
      }
      case 'approve_failover': {
        const runId = interrupt.run_id;
        const playbookId =
          typeof interrupt.meta.playbookId === 'string' ? interrupt.meta.playbookId : null;
        if (!runId || !resolveFailover) {
          throw new CloudError('INTERRUPT_NOT_FOUND', 'The failover request is no longer active');
        }
        resolveFailover(runId, playbookId);
        resolved = interruptsDb.resolve(id, 'resolved', input.actor ?? null, input.key)!;
        break;
      }
      case 'approve_mc_item':
      case 'deny_mc_item': {
        const itemId =
          typeof interrupt.meta.itemId === 'string'
            ? interrupt.meta.itemId
            : typeof interrupt.meta.item_id === 'string'
              ? interrupt.meta.item_id
              : null;
        if (itemId && resolveMcItem) {
          void resolveMcItem(itemId, input.key === 'approve_mc_item' ? 'approve' : 'deny');
        }
        resolved = interruptsDb.resolve(id, 'resolved', input.actor ?? null, input.key)!;
        break;
      }
      case 'retry_run': {
        if (interrupt.run_id && resolveRetryRun) {
          void resolveRetryRun(interrupt.run_id);
        }
        resolved = interruptsDb.resolve(id, 'resolved', input.actor ?? null, input.key)!;
        break;
      }
      case 'approve_swarm':
      case 'reject_swarm':
      case 'approve_swarm_plan':
      case 'reject_swarm_plan':
      case 'abort_swarm': {
        const swarmId =
          typeof interrupt.meta.swarmId === 'string'
            ? interrupt.meta.swarmId
            : typeof interrupt.meta.swarm_id === 'string'
              ? interrupt.meta.swarm_id
              : null;
        if (!swarmId) {
          throw new CloudError('INTERRUPT_NOT_FOUND', 'Swarm id missing on interrupt');
        }
        // Dynamic import avoids a hard cycle between interrupt-queue and swarm.
        void import('@/modules/swarm/index.js')
          .then(async ({ swarmService }) => {
            switch (input.key) {
              case 'approve_swarm':
                swarmService.approve(swarmId);
                break;
              case 'reject_swarm':
                swarmService.reject(swarmId);
                break;
              case 'approve_swarm_plan':
                swarmService.approvePlan(swarmId);
                break;
              case 'reject_swarm_plan':
                swarmService.rejectPlan(swarmId);
                break;
              case 'abort_swarm':
                await swarmService.abort(swarmId);
                break;
            }
          })
          .catch((error) => {
            console.error('[Interrupts] swarm action failed', error);
          });
        resolved = interruptsDb.resolve(id, 'resolved', input.actor ?? null, input.key)!;
        break;
      }
      case 'dismiss':
      case 'open_href':
      case 'resume_run':
      case 'delegate_provider':
        resolved = interruptsDb.resolve(id, 'resolved', input.actor ?? null, input.key)!;
        break;
      default:
        throw new CloudError('INTERRUPT_NOT_FOUND', `Unsupported interrupt action: ${input.key}`);
    }
    emitInterrupt('interrupt_updated', resolved);
    return resolved;
  },

  snooze(id: string, until: string, actor?: string | null): Interrupt {
    const interrupt = interruptsDb.get(id);
    if (!interrupt) throw new CloudError('INTERRUPT_NOT_FOUND', `Interrupt not found: ${id}`);
    if (interrupt.status === 'resolved' || interrupt.status === 'dismissed') {
      throw new CloudError('INTERRUPT_ALREADY_RESOLVED', `Interrupt ${id} is already resolved`);
    }
    const date = new Date(until);
    if (Number.isNaN(date.getTime()) || date.getTime() <= Date.now()) {
      throw new CloudError('INTERRUPT_NOT_FOUND', 'Snooze deadline must be a future ISO timestamp');
    }
    const snoozed = interruptsDb.snooze(id, date.toISOString(), actor ?? null)!;
    emitInterrupt('interrupt_updated', snoozed);
    return snoozed;
  },

  /**
   * Ordered checklist for "Plan my day" (PRD §7.7): open interrupts by priority
   * plus overdue/blocked kanban tasks when a project filter is set.
   */
  planMyDay(projectId?: string | null): {
    interrupts: Interrupt[];
    generatedAt: string;
  } {
    const interrupts = interruptsDb.list({
      status: ['open'],
      projectId: projectId ?? undefined,
      limit: 50,
    });
    return { interrupts, generatedAt: new Date().toISOString() };
  },
};
