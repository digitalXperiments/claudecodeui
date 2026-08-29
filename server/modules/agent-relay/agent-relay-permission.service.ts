import { agentRelayDb } from '@/modules/agent-relay/agent-relay.repository.js';
import type {
  AgentRelayApproval,
  AgentRelayApprovalPolicy,
  AgentRelayMode,
} from '@/modules/agent-relay/agent-relay.types.js';
// Relay reuses the swarm module's tested permission classifier (exported from
// its barrel) rather than forking a second policy engine. The classifier is
// pure: it maps a request to read / workspace-write / risky. Relay layers its
// own envelope rules on top, because a relay worker's contract is the task
// `mode`, not a swarm roster seat.
import { classifyPermissionRequest, extractPermissionRequestDetails } from '@/modules/swarm/index.js';
import { newRelayApprovalId } from '@/shared/ids.js';
import type { AnyRecord, LLMProvider } from '@/shared/types.js';

/** Seat kinds used purely to drive the shared classifier's two views. */
const READ_ONLY_VIEW_SEAT = 'explorer';
const WRITER_VIEW_SEAT = 'implementer';

export type RelayPermissionDecision = {
  allow: boolean;
  updatedInput?: unknown;
  message?: string;
};

export type RelayPermissionResolver = (requestId: string, decision: RelayPermissionDecision) => void;

export type RelayPermissionContext = {
  relayId: string;
  mode: AgentRelayMode;
  approvalPolicy?: AgentRelayApprovalPolicy;
  provider: LLMProvider;
  /** The only writable area for this job: the worktree root, or the project root. */
  envelopeRoot: string;
  sourceSessionId: string | null;
  /** How long an escalation waits for the lead before it is denied. */
  approvalTimeoutMs: number;
};

export type RelayPermissionOutcome = {
  requestId: string;
  relayId: string;
  allow: boolean;
  reason: string;
  via: 'policy' | 'lead' | 'operator' | 'timeout';
  approvalId: string | null;
  latencyMs: number;
};

export type RelayPermissionTier = 'approve' | 'deny' | 'escalate';

const registry = new Map<string, RelayPermissionContext & { registeredAt: number }>();

/** Wakes an in-flight escalation the moment a decision is recorded. */
const waiters = new Map<string, (settled: { allow: boolean; reason: string; via: RelayPermissionOutcome['via'] }) => void>();

export type RelayPermissionObserver = {
  /** A worker just parked on a request the lead has to answer. */
  onEscalated?: (approval: AgentRelayApproval) => void;
  /** A request was finally settled, however it was settled. */
  onSettled?: (outcome: RelayPermissionOutcome) => void;
};

let resolverOverride: RelayPermissionResolver | null = null;
let observer: RelayPermissionObserver = {};

/** Test/bootstrap hook: replace the claude-sdk resolveToolApproval bridge. */
export function configureRelayPermissionResolver(resolver: RelayPermissionResolver | null): void {
  resolverOverride = resolver;
}

/** Lets the relay service broadcast approval changes without a circular import. */
export function configureRelayPermissionObserver(next: RelayPermissionObserver | null): void {
  observer = next ?? {};
}

function notify<K extends keyof RelayPermissionObserver>(
  hook: K,
  ...args: Parameters<NonNullable<RelayPermissionObserver[K]>>
): void {
  try {
    (observer[hook] as ((...a: unknown[]) => void) | undefined)?.(...args);
  } catch {
    // Observability must never change the decision path.
  }
}

async function resolveDecision(requestId: string, decision: RelayPermissionDecision): Promise<void> {
  if (resolverOverride) {
    resolverOverride(requestId, decision);
    return;
  }
  // Same process-wide pendingToolApprovals registry every runtime waits on.
  // claude-sdk.js is a legacy root runtime file outside the module graph, so
  // the boundaries plugin cannot classify it; the import is lazy (module cache
  // shared with server/index.js) and overridable for tests/bootstrap.
  // eslint-disable-next-line boundaries/no-unknown
  const sdk = (await import('@/claude-sdk.js')) as unknown as {
    resolveToolApproval: RelayPermissionResolver;
  };
  sdk.resolveToolApproval(requestId, decision);
}

/**
 * Relay's envelope policy, expressed on top of the shared classifier.
 *
 * The classifier's read-only-seat view answers "is this a pure read?" and its
 * writer view answers "is this scoped to the declared root, or genuinely
 * risky?". Relay combines them so each task `mode` enforces exactly what the
 * lead declared:
 *
 * - safe reads run immediately in both modes;
 * - `isolated_write` + `auto` (the default) may write inside its own worktree
 *   without asking, and auto-denies anything risky or unclassifiable — the
 *   lead is never parked;
 * - `isolated_write` + `manual` still escalates in-tree writes and risk to
 *   the lead;
 * - `read_only` never writes and never escalates, even if the lead would
 *   have approved it.
 */
export function classifyRelayPermissionRequest(input: {
  mode: AgentRelayMode;
  approvalPolicy?: AgentRelayApprovalPolicy;
  envelopeRoot: string;
  toolName?: string | null;
  command?: string | null;
  paths?: string[] | null;
  cwd?: string | null;
  rawInput?: unknown;
}): { tier: RelayPermissionTier; reason: string } {
  const approvalPolicy = input.approvalPolicy ?? 'auto';
  const shared = {
    workspaceRoot: input.envelopeRoot,
    toolName: input.toolName,
    command: input.command,
    paths: input.paths,
    cwd: input.cwd,
    rawInput: input.rawInput,
  };

  const readView = classifyPermissionRequest({ ...shared, seatKind: READ_ONLY_VIEW_SEAT });
  if (readView.tier === 'approve') {
    return { tier: 'approve', reason: readView.reason };
  }

  // read_only is a hard capability boundary, not a request for the lead to
  // approve individual writes. Anything the read view cannot prove safe is
  // denied, including risky commands and unknown tools.
  if (input.mode === 'read_only') {
    return { tier: 'deny', reason: `read-only assignment may not perform this action: ${readView.reason}` };
  }

  const writerView = classifyPermissionRequest({ ...shared, seatKind: WRITER_VIEW_SEAT });
  if (writerView.tier === 'approve') {
    // Scoped to the declared root, but only a writer job declared one.
    if (input.mode !== 'isolated_write') {
      return { tier: 'deny', reason: `read-only assignment may not mutate state: ${writerView.reason}` };
    }
    if (approvalPolicy === 'manual') {
      return { tier: 'escalate', reason: `manual approval policy requires lead confirmation: ${writerView.reason}` };
    }
    return { tier: 'approve', reason: `${writerView.reason} (inside the job's isolated worktree)` };
  }
  if (writerView.tier === 'deny') {
    return { tier: 'deny', reason: writerView.reason };
  }
  if (approvalPolicy === 'manual') {
    return { tier: 'escalate', reason: writerView.reason };
  }
  return {
    tier: 'deny',
    reason: `auto policy denied an out-of-envelope action without asking the lead: ${writerView.reason}`,
  };
}

export const agentRelayPermissionBroker = {
  /** Register a live relay job so its permission prompts always get answered. */
  register(ctx: RelayPermissionContext): void {
    registry.set(ctx.relayId, { ...ctx, registeredAt: Date.now() });
  },

  deregister(relayId: string): void {
    registry.delete(relayId);
  },

  getRegistration(relayId: string): RelayPermissionContext | null {
    return registry.get(relayId) ?? null;
  },

  /** Exposed for tests. */
  clearAll(): void {
    registry.clear();
    waiters.clear();
  },

  /**
   * Answer one normalized `permission_request` event for a registered job.
   * Never throws and always resolves the request (deny on internal failure) so
   * a broker bug can never leave a worker hanging on its own timeout.
   */
  async handlePermissionRequest(relayId: string, message: AnyRecord): Promise<RelayPermissionOutcome | null> {
    const ctx = registry.get(relayId);
    const requestId = typeof message.requestId === 'string' && message.requestId ? message.requestId : null;
    if (!ctx || !requestId) return null;

    const startedAt = Date.now();
    let allow = false;
    let reason = 'relay permission broker internal error';
    let via: RelayPermissionOutcome['via'] = 'policy';
    let approvalId: string | null = null;

    try {
      const details = extractPermissionRequestDetails(message);
      const classification = classifyRelayPermissionRequest({
        mode: ctx.mode,
        approvalPolicy: ctx.approvalPolicy,
        envelopeRoot: ctx.envelopeRoot,
        toolName: details.toolName,
        command: details.command,
        paths: details.paths,
        cwd: details.cwd,
        rawInput: details.rawInput,
      });

      if (classification.tier === 'approve') {
        allow = true;
        reason = classification.reason;
      } else if (classification.tier === 'deny') {
        allow = false;
        reason = classification.reason;
      } else {
        const escalated = await this.escalate(ctx, requestId, details, classification.reason);
        allow = escalated.allow;
        reason = escalated.reason;
        via = escalated.via;
        approvalId = escalated.approvalId;
      }
    } catch (error) {
      allow = false;
      reason = `relay permission broker error: ${error instanceof Error ? error.message : String(error)}`;
    }

    try {
      await resolveDecision(
        requestId,
        allow
          ? { allow: true, updatedInput: message.input }
          : { allow: false, message: `Agent Relay denied this request: ${reason}` },
      );
    } catch (error) {
      console.error('[AgentRelayPermission] Failed to resolve tool approval', error);
    }

    const outcome: RelayPermissionOutcome = {
      requestId,
      relayId,
      allow,
      reason,
      via,
      approvalId,
      latencyMs: Date.now() - startedAt,
    };
    notify('onSettled', outcome);
    return outcome;
  },

  /**
   * Parks the job as `waiting_approval` and waits for a lead (or operator)
   * decision. Always settles: the bounded timeout denies the request so the
   * worker resumes and can report the blocker instead of being killed.
   */
  async escalate(
    ctx: RelayPermissionContext,
    requestId: string,
    details: { toolName: string | null; command: string | null; paths: string[]; cwd: string | null },
    reason: string,
  ): Promise<{ allow: boolean; reason: string; via: RelayPermissionOutcome['via']; approvalId: string | null }> {
    // A retried request id must reuse its existing row: the unique index on
    // request_id would otherwise throw and deny a decision already in flight.
    const existing = agentRelayDb.getApprovalByRequestId(requestId);
    const approval: AgentRelayApproval = existing ?? agentRelayDb.createApproval({
      approvalId: newRelayApprovalId(),
      relayId: ctx.relayId,
      requestId,
      toolName: details.toolName,
      command: details.command ? details.command.slice(0, 4_000) : null,
      paths: details.paths.slice(0, 50),
      cwd: details.cwd,
      reason,
    });

    if (approval.status !== 'pending') {
      return {
        allow: approval.status === 'approved',
        reason: approval.decision_reason || approval.reason,
        via: 'lead',
        approvalId: approval.approval_id,
      };
    }

    agentRelayDb.markWaitingApproval(ctx.relayId);
    notify('onEscalated', approval);

    const settled = await new Promise<{ allow: boolean; reason: string; via: RelayPermissionOutcome['via'] }>((resolve) => {
      let done = false;
      const settle = (value: { allow: boolean; reason: string; via: RelayPermissionOutcome['via'] }) => {
        if (done) return;
        done = true;
        waiters.delete(approval.approval_id);
        clearTimeout(timer);
        resolve(value);
      };
      const timer = setTimeout(() => {
        // Record the expiry so a late lead decision cannot resolve a request
        // the worker has already been told about.
        agentRelayDb.decideApproval(approval.approval_id, 'expired', {
          reason: `No lead decision within ${ctx.approvalTimeoutMs}ms.`,
          decidedBy: 'timeout',
        });
        settle({
          allow: false,
          reason: `${reason} — no lead decision within ${ctx.approvalTimeoutMs}ms`,
          via: 'timeout',
        });
      }, ctx.approvalTimeoutMs);
      // Deliberately not unref'd: this timer is the only guarantee that a
      // parked worker is ever released, so it must keep the loop alive.
      waiters.set(approval.approval_id, settle);
    });

    const stillPending = agentRelayDb.listApprovals({ relayId: ctx.relayId, status: 'pending', limit: 1 });
    if (stillPending.length === 0) agentRelayDb.clearWaitingApproval(ctx.relayId);
    return { ...settled, approvalId: approval.approval_id };
  },

  /**
   * Records a lead or operator decision for one pending approval and wakes the
   * waiting worker. Returns null when the request no longer exists or was
   * already answered, so callers can report a stale decision honestly.
   */
  decide(
    approvalId: string,
    input: { allow: boolean; reason?: string | null; decidedBy: 'lead' | 'operator' },
  ): AgentRelayApproval | null {
    const decided = agentRelayDb.decideApproval(approvalId, input.allow ? 'approved' : 'denied', {
      reason: input.reason ?? null,
      decidedBy: input.decidedBy,
    });
    if (!decided) return null;
    waiters.get(approvalId)?.({
      allow: input.allow,
      reason: input.reason?.trim()
        || (input.allow ? 'Approved by the requesting lead.' : 'Denied by the requesting lead.'),
      via: input.decidedBy,
    });
    return decided;
  },

  /**
   * Fails every still-pending approval for a job that has stopped running, so
   * a cancelled or timed-out worker never leaves a dangling prompt behind.
   */
  releaseJob(relayId: string, reason: string): void {
    // Runs from job teardown, so it must not throw: the database may already be
    // closed (shutdown, tests) and an exception here would surface as an
    // unhandled rejection that hides the job's real outcome.
    try {
      for (const approval of agentRelayDb.listApprovals({ relayId, status: 'pending', limit: 200 })) {
        agentRelayDb.decideApproval(approval.approval_id, 'expired', { reason, decidedBy: 'system' });
        waiters.get(approval.approval_id)?.({ allow: false, reason, via: 'timeout' });
      }
    } catch (error) {
      console.warn('[AgentRelayPermission] Could not expire pending approvals', error);
    }
    registry.delete(relayId);
  },
};
