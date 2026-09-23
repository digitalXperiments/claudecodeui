import { chatRunRegistry, DETACHED_CONNECTION, startProviderRun, type ProviderSpawnFn } from '@/modules/websocket/index.js';
import { sessionsDb } from '@/modules/database/index.js';
import type { AgentRelayJob } from '@/modules/agent-relay/agent-relay.types.js';
import type { LLMProvider, NormalizedMessage } from '@/shared/types.js';

/** Provider runtimes used to resume an idle lead after a worker completes. */
let runtimeSpawnFns: Partial<Record<LLMProvider, ProviderSpawnFn>> = {};

/**
 * Keep terminal notifications for one lead together long enough to turn a
 * fan-out burst into one harvest turn. The timer starts with the first
 * completion and is not extended by later completions, so a busy relay batch
 * cannot postpone the lead indefinitely.
 */
const WAKE_COALESCE_MS = 2_000;
/** While the lead is mid-turn, check back this often instead of dropping the notice. */
const BUSY_RECHECK_MS = 5_000;
/** Give up re-checking a busy lead after this long; the notices stay queued for its next wake. */
const MAX_BUSY_WAIT_MS = 2 * 60 * 60_000;
/** Backoff for a wake turn that failed (e.g. the lead's provider is out of quota). */
const WAKE_RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];
const SUMMARY_CHARS = 280;

type DeliveryNotice = { key: string; text: string };

type PendingWake = {
  jobs: Map<string, AgentRelayJob>;
  notices: Map<string, DeliveryNotice>;
  timer: ReturnType<typeof setTimeout> | null;
  firstQueuedAt: number;
  failures: number;
};

const pendingWakes = new Map<string, PendingWake>();
const wakingLeads = new Set<string>();

/**
 * Relays each lead has already observed in a terminal state through its own
 * MCP calls (relay_wait/status/result). A lead that harvested a job inside
 * its own turn must not be woken again for it.
 */
const seenTerminal = new Map<string, Set<string>>();

export type LeadWakeFailure = { leadSessionId: string; relayIds: string[]; error: string; attempts: number; gaveUp: boolean };
let onWakeFailure: ((failure: LeadWakeFailure) => void) | null = null;

function displayStatus(job: AgentRelayJob): string {
  const resultStatus = job.result?.status;
  return resultStatus === 'blocked' || resultStatus === 'failed' ? resultStatus : job.status;
}

function oneLine(value: string, max: number): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/**
 * The wake digest carries what the lead needs to decide its next step, so a
 * routine completion does not cost an extra relay_status round trip.
 */
export function wakePrompt(jobs: AgentRelayJob[], notices: DeliveryNotice[] = []): string {
  const workers = jobs.map((job) => {
    const label = job.label || job.relay_id;
    const parts = [`- ${label} (${job.relay_id}): ${displayStatus(job)}`];
    const summary = job.result?.summary ? oneLine(job.result.summary, SUMMARY_CHARS) : job.error ? oneLine(job.error, SUMMARY_CHARS) : '';
    if (summary) parts.push(`  summary: ${summary}`);
    const files = job.result?.workspace?.files.length ?? job.result?.filesTouched.length ?? 0;
    if (files) parts.push(`  files changed: ${files}`);
    if (job.result?.openQuestions.length) parts.push(`  open questions: ${job.result.openQuestions.slice(0, 3).map((item) => oneLine(item, 160)).join(' | ')}`);
    if (job.denied_actions.length) {
      parts.push(`  denied actions (do these yourself after review if needed): ${job.denied_actions.slice(-3).map((action) => oneLine(action.command || action.tool || action.reason, 120)).join(' | ')}`);
    }
    return parts.join('\n');
  });
  return [
    '[Agent Relay notification]',
    ...(workers.length ? ['Delegated workers reached a terminal state:', ...workers] : []),
    ...(notices.length ? ['Delivery updates:', ...notices.map((notice) => `- ${notice.text}`)] : []),
    'The lead session was idle, so this turn was started automatically.',
    'Use relay_result for full reports. Writers are verified and rehearsed by the server automatically; land passing rehearsals with relay_land. Continue supervising any other owned relays before ending the assignment.',
  ].join('\n');
}

function pendingFor(leadSessionId: string): PendingWake {
  let pending = pendingWakes.get(leadSessionId);
  if (!pending) {
    pending = { jobs: new Map(), notices: new Map(), timer: null, firstQueuedAt: Date.now(), failures: 0 };
    pendingWakes.set(leadSessionId, pending);
  }
  return pending;
}

function schedule(leadSessionId: string, delayMs: number): void {
  const pending = pendingWakes.get(leadSessionId);
  if (!pending || pending.timer) return;
  pending.timer = setTimeout(() => {
    pending.timer = null;
    void flushLeadWake(leadSessionId);
  }, delayMs);
  pending.timer.unref?.();
}

function takeUnseen(leadSessionId: string, pending: PendingWake): { jobs: AgentRelayJob[]; notices: DeliveryNotice[] } {
  const seen = seenTerminal.get(leadSessionId);
  const jobs = [...pending.jobs.values()].filter((job) => !seen?.has(`${job.relay_id}:${job.attempt}`));
  const notices = [...pending.notices.values()];
  return { jobs, notices };
}

async function flushLeadWake(leadSessionId: string): Promise<void> {
  const pending = pendingWakes.get(leadSessionId);
  if (!pending) return;

  const lead = sessionsDb.getSessionById(leadSessionId);
  if (!lead || lead.is_internal || lead.isArchived) {
    pendingWakes.delete(leadSessionId);
    return;
  }
  // A lead still in its own turn harvests results itself; check back later
  // rather than dropping the notice (a completion that lands during a turn
  // used to be lost for good).
  if (chatRunRegistry.isProcessing(leadSessionId) || wakingLeads.has(leadSessionId)) {
    if (Date.now() - pending.firstQueuedAt < MAX_BUSY_WAIT_MS) schedule(leadSessionId, BUSY_RECHECK_MS);
    return;
  }

  const { jobs, notices } = takeUnseen(leadSessionId, pending);
  if (jobs.length === 0 && notices.length === 0) {
    pendingWakes.delete(leadSessionId);
    return;
  }
  const spawnFn = runtimeSpawnFns[lead.provider as LLMProvider];
  if (!spawnFn) {
    // Runtimes register shortly after boot; keep the notice instead of losing it.
    if (Date.now() - pending.firstQueuedAt < MAX_BUSY_WAIT_MS) schedule(leadSessionId, BUSY_RECHECK_MS);
    return;
  }

  // Take the batch now; anything published during the wake turn queues anew.
  pendingWakes.delete(leadSessionId);
  wakingLeads.add(leadSessionId);
  let failure: string | null = null;
  try {
    // No injectFn is intentional: this path is only for an idle lead. If a
    // user starts a turn in the small race before startProviderRun registers,
    // the starter returns RUN_IN_PROGRESS and the active lead owns the work.
    const errors: string[] = [];
    let unsuccessful = false;
    const started = await startProviderRun({
      appSessionId: leadSessionId,
      provider: lead.provider as LLMProvider,
      providerSessionId: lead.provider_session_id,
      projectPath: lead.runtime_project_path ?? lead.project_path,
      spawnFn,
      content: wakePrompt(jobs, notices),
      options: {
        permissionMode: lead.permission_mode || 'default',
        sessionSummary: `Agent Relay · ${jobs.length || notices.length} update${(jobs.length || notices.length) === 1 ? '' : 's'}`,
      },
      connection: DETACHED_CONNECTION,
      userId: null,
      onEvent: (message: NormalizedMessage) => {
        if (message.kind === 'error' && typeof message.content === 'string') errors.push(message.content);
        if (message.kind === 'complete') {
          const complete = message as NormalizedMessage & { success?: boolean; exitCode?: number; aborted?: boolean };
          unsuccessful = complete.success === false || (typeof complete.exitCode === 'number' && complete.exitCode !== 0);
        }
      },
    });
    if (!started.ok) {
      // The operator started a turn in the meantime; retry once it is idle.
      requeue(leadSessionId, jobs, notices, 0);
      schedule(leadSessionId, BUSY_RECHECK_MS);
      return;
    }
    await started.completion;
    for (const job of jobs) markRelaySeenByLead(leadSessionId, [job]);
    if (unsuccessful) failure = errors.join(' ').slice(0, 500) || 'the lead turn ended unsuccessfully';
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  } finally {
    wakingLeads.delete(leadSessionId);
  }

  if (failure) {
    const attempts = (pending.failures ?? 0) + 1;
    const gaveUp = attempts > WAKE_RETRY_DELAYS_MS.length;
    console.warn('[AgentRelay] failed to wake idle lead session', { sessionId: leadSessionId, attempts, error: failure });
    try {
      onWakeFailure?.({ leadSessionId, relayIds: jobs.map((job) => job.relay_id), error: failure, attempts, gaveUp });
    } catch {
      // Observability must not break retries.
    }
    if (!gaveUp) {
      requeue(leadSessionId, jobs, notices, attempts);
      schedule(leadSessionId, WAKE_RETRY_DELAYS_MS[attempts - 1]!);
    }
  } else if (pendingWakes.has(leadSessionId)) {
    schedule(leadSessionId, WAKE_COALESCE_MS);
  }
}

function requeue(leadSessionId: string, jobs: AgentRelayJob[], notices: DeliveryNotice[], failures: number): void {
  const pending = pendingFor(leadSessionId);
  for (const job of jobs) if (!pending.jobs.has(job.relay_id)) pending.jobs.set(job.relay_id, job);
  for (const notice of notices) if (!pending.notices.has(notice.key)) pending.notices.set(notice.key, notice);
  pending.failures = Math.max(pending.failures, failures);
}

/** Installs the provider runtimes used by the relay-to-lead wake bridge. */
export function configureAgentRelayLeadWake(
  spawnFns: Partial<Record<LLMProvider, ProviderSpawnFn>>,
): void {
  runtimeSpawnFns = spawnFns;
  if (Object.keys(spawnFns).length === 0) {
    for (const pending of pendingWakes.values()) if (pending.timer) clearTimeout(pending.timer);
    pendingWakes.clear();
    seenTerminal.clear();
  }
}

/** Operator alerting for leads that cannot be woken (quota, auth, crash). */
export function configureLeadWakeFailureHandler(handler: ((failure: LeadWakeFailure) => void) | null): void {
  onWakeFailure = handler;
}

/**
 * Record that a lead observed these jobs (terminal) through its own tools, so
 * the wake bridge does not start a redundant turn for them.
 */
export function markRelaySeenByLead(leadSessionId: string | null | undefined, jobs: Array<Pick<AgentRelayJob, 'relay_id' | 'attempt' | 'status'>>): void {
  if (!leadSessionId) return;
  const terminal = jobs.filter((job) => ['completed', 'blocked', 'failed', 'cancelled', 'timed_out'].includes(job.status));
  if (terminal.length === 0) return;
  let seen = seenTerminal.get(leadSessionId);
  if (!seen) {
    seen = new Set();
    seenTerminal.set(leadSessionId, seen);
  }
  for (const job of terminal) seen.add(`${job.relay_id}:${job.attempt}`);
  if (seen.size > 2_000) seenTerminal.set(leadSessionId, new Set([...seen].slice(-1_000)));
}

/**
 * Called after a terminal relay row is persisted. A short coalescing window
 * prevents a burst of sibling completions from starting overlapping lead turns.
 */
export function notifyAgentRelayTerminal(job: AgentRelayJob): void {
  if (!['completed', 'blocked', 'failed', 'cancelled', 'timed_out'].includes(job.status)) return;
  if (!job.source_session_id) return;
  // A terminal row can be published more than once while its result is
  // normalized. Keep only the latest snapshot for each relay id.
  pendingFor(job.source_session_id).jobs.set(job.relay_id, job);
  schedule(job.source_session_id, WAKE_COALESCE_MS);
}

/** Queue a delivery update (verification, rehearsal, landing) for a lead. */
export function notifyAgentRelayDelivery(leadSessionId: string | null | undefined, key: string, text: string): void {
  if (!leadSessionId) return;
  pendingFor(leadSessionId).notices.set(key, { key, text });
  schedule(leadSessionId, WAKE_COALESCE_MS);
}
