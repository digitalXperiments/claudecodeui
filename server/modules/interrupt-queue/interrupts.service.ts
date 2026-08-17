import { runService } from '@/modules/runs/index.js';
import { broadcastSystemEvent } from '@/modules/websocket/index.js';
import { CloudError, TERMINAL_RUN_STATUSES } from '@/shared/run-events.js';
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

/**
 * Default approval window for interactive permission gates. The provider may
 * wait forever on a human, but the *interrupt card* goes stale quickly: once
 * this window elapses it expires out of "Needs you" (env-tunable).
 */
function permissionInterruptTtlMs(): number {
  const fromEnv = Number(process.env.CLOUDCLI_PERMISSION_INTERRUPT_TTL_MINUTES);
  const minutes = Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : 30;
  return minutes * 60_000;
}

function defaultExpiresAt(input: CreateInterruptInput): string | null {
  if (input.expiresAt !== undefined) return input.expiresAt;
  if (input.kind === 'permission_pending') {
    return new Date(Date.now() + permissionInterruptTtlMs()).toISOString();
  }
  return null;
}

function isPastExpiry(interrupt: Interrupt): boolean {
  if (!interrupt.expires_at) return false;
  const ms = Date.parse(interrupt.expires_at);
  return Number.isFinite(ms) && ms <= Date.now();
}

/**
 * Run-scoped kinds whose premise is "the run is still in flight". Post-mortem
 * pointers (run_failed, ci_failed) intentionally survive their run's terminal
 * transition — they are the user's link to what went wrong.
 */
const RUN_LIFETIME_KINDS = ['permission_pending', 'run_stuck', 'approval_pending'];

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
  countOpen(projectId?: string, attentionOnly = false): number {
    return interruptsDb.countOpen(projectId, attentionOnly);
  },
  countUnread(projectId?: string, attentionOnly = false): number {
    return interruptsDb.countUnread(projectId, attentionOnly);
  },
  /** Batch viewport mark-as-read. Read ≠ resolved: items stay actionable. */
  markRead(ids: string[]): { updated: number; unread: number } {
    const updated = interruptsDb.markRead(ids);
    return { updated, unread: interruptsDb.countUnread() };
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
    const interrupt = interruptsDb.create({ ...input, expiresAt: defaultExpiresAt(input) });
    emitInterrupt('interrupt_created', interrupt);
    void import('@/modules/automation/index.js')
      .then(({ automationService }) => {
        automationService.fireDetached({
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

  /**
   * Shared action guard: 404 when missing, 409 when already settled, and 410
   * (INTERRUPT_EXPIRED) when the approval window elapsed. A row whose deadline
   * passed but which the sweep has not flipped yet is expired lazily here so
   * approve/deny can never "succeed" against a stale gate.
   */
  requireActionable(id: string): Interrupt {
    const interrupt = interruptsDb.get(id);
    if (!interrupt) throw new CloudError('INTERRUPT_NOT_FOUND', `Interrupt not found: ${id}`);
    if (interrupt.status === 'resolved' || interrupt.status === 'dismissed') {
      throw new CloudError('INTERRUPT_ALREADY_RESOLVED', `Interrupt ${id} is already resolved`);
    }
    if (interrupt.status === 'expired') {
      throw new CloudError('INTERRUPT_EXPIRED', `Interrupt ${id} has expired`);
    }
    if (isPastExpiry(interrupt)) {
      const expired = interruptsDb.expire(id);
      if (expired) emitInterrupt('interrupt_updated', expired);
      throw new CloudError('INTERRUPT_EXPIRED', `Interrupt ${id} has expired`);
    }
    return interrupt;
  },

  act(id: string, input: InterruptActionInput): Interrupt {
    const interrupt = this.requireActionable(id);

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
        throw new CloudError(
          'INTERRUPT_ACTION_REQUIRES_WAIT',
          `Swarm action ${input.key} must be executed with actAndWait`,
        );
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

  /**
   * Execute an interrupt action whose underlying side effect must complete
   * before the interrupt is resolved. Swarm actions are durable control-plane
   * commands: resolving their notification first would acknowledge an action
   * that may subsequently fail or be rejected as stale.
   *
   * Non-swarm actions retain the existing synchronous behavior.
   */
  async actAndWait(id: string, input: InterruptActionInput): Promise<Interrupt> {
    const swarmActions = new Set([
      'approve_swarm',
      'reject_swarm',
      'approve_swarm_plan',
      'reject_swarm_plan',
      'abort_swarm',
    ]);
    if (!swarmActions.has(input.key)) {
      return this.act(id, input);
    }

    const interrupt = this.requireActionable(id);
    const swarmId =
      typeof interrupt.meta.swarmId === 'string'
        ? interrupt.meta.swarmId
        : typeof interrupt.meta.swarm_id === 'string'
          ? interrupt.meta.swarm_id
          : null;
    if (!swarmId) {
      throw new CloudError('INTERRUPT_NOT_FOUND', 'Swarm id missing on interrupt');
    }

    // Dynamic import avoids the interrupt-queue <-> swarm module cycle.
    const { swarmService } = await import('@/modules/swarm/index.js');
    switch (input.key) {
      case 'approve_swarm':
        await swarmService.approve(swarmId);
        break;
      case 'reject_swarm':
        await swarmService.reject(swarmId);
        break;
      case 'approve_swarm_plan':
        await swarmService.approvePlan(swarmId);
        break;
      case 'reject_swarm_plan':
        await swarmService.rejectPlan(swarmId);
        break;
      case 'abort_swarm':
        await swarmService.abort(swarmId);
        break;
    }

    // Re-read to close the race with another actor resolving this interrupt.
    const current = interruptsDb.get(id);
    if (!current || current.status === 'resolved' || current.status === 'dismissed' || current.status === 'expired') {
      if (!current) {
        throw new CloudError('INTERRUPT_NOT_FOUND', `Interrupt not found: ${id}`);
      }
      return current;
    }
    const resolved = interruptsDb.resolve(id, 'resolved', input.actor ?? null, input.key);
    if (!resolved) {
      throw new CloudError('INTERRUPT_ALREADY_RESOLVED', `Interrupt ${id} was resolved concurrently`);
    }
    emitInterrupt('interrupt_updated', resolved);
    return resolved;
  },

  snooze(id: string, until: string, actor?: string | null): Interrupt {
    this.requireActionable(id);
    const date = new Date(until);
    if (Number.isNaN(date.getTime()) || date.getTime() <= Date.now()) {
      throw new CloudError('INTERRUPT_NOT_FOUND', 'Snooze deadline must be a future ISO timestamp');
    }
    const snoozed = interruptsDb.snooze(id, date.toISOString(), actor ?? null)!;
    emitInterrupt('interrupt_updated', snoozed);
    return snoozed;
  },

  /**
   * Terminal-run hook: a run that finished (succeeded/failed/aborted/timed out)
   * can no longer need a permission decision, be stuck, or await approval —
   * close those interrupts. Post-mortem kinds (run_failed, ci_failed) survive
   * on purpose: they point the user at what went wrong.
   */
  resolveForRun(runId: string, resolution = 'run_terminal'): Interrupt[] {
    const linked = interruptsDb.listActiveByRunId(runId, RUN_LIFETIME_KINDS);
    const resolved: Interrupt[] = [];
    for (const interrupt of linked) {
      const next = interruptsDb.resolve(interrupt.interrupt_id, 'resolved', 'system', resolution);
      if (next && next.status === 'resolved') {
        resolved.push(next);
        emitInterrupt('interrupt_updated', next);
      }
    }
    return resolved;
  },

  /**
   * Close the permission_pending interrupt tied to a provider approval request
   * once that request is answered or cancelled. `timeout` marks the card
   * expired (nobody acted); every other outcome resolves it.
   */
  resolvePermissionRequest(requestId: string, outcome: 'approved' | 'denied' | 'cancelled' | 'timeout', actor = 'system'): Interrupt[] {
    if (!requestId.trim()) return [];
    const linked = interruptsDb
      .listByMeta('requestId', requestId)
      .filter((interrupt) => interrupt.kind === 'permission_pending');
    const settled: Interrupt[] = [];
    for (const interrupt of linked) {
      const next =
        outcome === 'timeout'
          ? interruptsDb.expire(interrupt.interrupt_id, 'timeout')
          : interruptsDb.resolve(interrupt.interrupt_id, 'resolved', actor, `permission_${outcome}`);
      if (next && next.status !== 'open' && next.status !== 'snoozed') {
        settled.push(next);
        emitInterrupt('interrupt_updated', next);
      }
    }
    return settled;
  },

  /**
   * Reconcile the queue against reality (runs on boot and every few minutes):
   *  - run missing (retention-purged) → resolve, the anchor is gone
   *  - run terminal → resolve run-lifetime kinds (see resolveForRun)
   *  - approval window elapsed → expire; legacy permission_pending rows
   *    without a deadline expire once older than the default TTL
   *  - ci_failed stays while its swarm exists (it is the user's pointer to
   *    the failure report) and resolves only when the swarm is deleted
   */
  sweep(): { resolved: number; expired: number } {
    let resolved = 0;
    let expired = 0;
    const settle = (interrupt: Interrupt, next: Interrupt | null, wasExpired: boolean): void => {
      if (next && next.status !== 'open' && next.status !== 'snoozed') {
        if (wasExpired) expired += 1;
        else resolved += 1;
        emitInterrupt('interrupt_updated', next);
      }
    };

    for (const { interrupt, runExists, runStatus, expired: pastDeadline } of interruptsDb.listActiveForSweep()) {
      if (interrupt.kind === 'ci_failed') {
        const swarmId =
          typeof interrupt.meta.swarmId === 'string'
            ? interrupt.meta.swarmId
            : typeof interrupt.meta.swarm_id === 'string'
              ? interrupt.meta.swarm_id
              : null;
        if (swarmId && !interruptsDb.swarmExists(swarmId)) {
          settle(interrupt, interruptsDb.resolve(interrupt.interrupt_id, 'resolved', 'system', 'swarm_deleted'), false);
        }
        continue;
      }

      if (interrupt.kind === 'approval_pending') {
        const itemId =
          typeof interrupt.meta.itemId === 'string'
            ? interrupt.meta.itemId
            : typeof interrupt.meta.item_id === 'string'
              ? interrupt.meta.item_id
              : null;
        if (itemId) {
          const itemState = interruptsDb.missionControlItemState(itemId);
          if (itemState === 'missing' || itemState === 'settled') {
            settle(
              interrupt,
              interruptsDb.resolve(
                interrupt.interrupt_id,
                'resolved',
                'system',
                itemState === 'missing' ? 'mc_item_missing' : 'mc_item_terminal',
              ),
              false,
            );
            continue;
          }
        }
      }

      if (interrupt.run_id) {
        if (!runExists) {
          settle(interrupt, interruptsDb.resolve(interrupt.interrupt_id, 'resolved', 'system', 'run_missing'), false);
          continue;
        }
        const terminal = runStatus != null && (TERMINAL_RUN_STATUSES as ReadonlySet<string>).has(runStatus);
        if (terminal && RUN_LIFETIME_KINDS.includes(interrupt.kind)) {
          settle(interrupt, interruptsDb.resolve(interrupt.interrupt_id, 'resolved', 'system', 'run_terminal'), false);
          continue;
        }
      }

      if (pastDeadline) {
        settle(interrupt, interruptsDb.expire(interrupt.interrupt_id), true);
        continue;
      }

      // Backlog hygiene: permission gates created before expires_at existed.
      if (interrupt.kind === 'permission_pending' && !interrupt.expires_at) {
        const createdMs = Date.parse(interrupt.created_at);
        if (Number.isFinite(createdMs) && Date.now() - createdMs > permissionInterruptTtlMs()) {
          settle(interrupt, interruptsDb.expire(interrupt.interrupt_id), true);
        }
      }
    }
    return { resolved, expired };
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
      attentionOnly: true,
    });
    return { interrupts, generatedAt: new Date().toISOString() };
  },
};
