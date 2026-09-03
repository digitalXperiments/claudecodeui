import { chatRunRegistry, DETACHED_CONNECTION, startProviderRun, type ProviderSpawnFn } from '@/modules/websocket/index.js';
import { sessionsDb } from '@/modules/database/index.js';
import type { AgentRelayJob } from '@/modules/agent-relay/agent-relay.types.js';
import type { LLMProvider } from '@/shared/types.js';

/** Provider runtimes used to resume an idle lead after a worker completes. */
let runtimeSpawnFns: Partial<Record<LLMProvider, ProviderSpawnFn>> = {};

/**
 * Keep terminal notifications for one lead together long enough to turn a
 * fan-out burst into one harvest turn. The timer starts with the first
 * completion and is not extended by later completions, so a busy relay batch
 * cannot postpone the lead indefinitely.
 */
const WAKE_COALESCE_MS = 2_000;
const pendingWakes = new Map<string, {
  jobs: Map<string, AgentRelayJob>;
  timer: ReturnType<typeof setTimeout>;
}>();
const wakingLeads = new Set<string>();

function displayStatus(job: AgentRelayJob): string {
  const resultStatus = job.result?.status;
  return resultStatus === 'blocked' || resultStatus === 'failed' ? resultStatus : job.status;
}

function wakePrompt(jobs: AgentRelayJob[]): string {
  const workers = jobs.map((job) => {
    const label = job.label || job.relay_id;
    return `- ${label} (${job.relay_id}): ${displayStatus(job)}`;
  });
  return [
    '[Agent Relay notification]',
    'The following delegated workers reached a terminal state:',
    ...workers,
    'The lead session was idle, so this turn was started automatically.',
    'Harvest these results now with relay_status or relay_result, and continue supervising any other owned relays before ending the assignment.',
  ].join('\n');
}

function scheduleLeadWake(job: AgentRelayJob): void {
  const leadSessionId = job.source_session_id;
  if (!leadSessionId) return;

  let pending = pendingWakes.get(leadSessionId);
  if (!pending) {
    const jobs = new Map<string, AgentRelayJob>();
    const timer = setTimeout(() => {
      pendingWakes.delete(leadSessionId);
      void wakeLeadForWorkers(Array.from(jobs.values()));
    }, WAKE_COALESCE_MS);
    timer.unref?.();
    pending = { jobs, timer };
    pendingWakes.set(leadSessionId, pending);
  }

  // A terminal row can be published more than once while its result is
  // normalized. Keep only the latest snapshot for each relay id.
  pending.jobs.set(job.relay_id, job);
}

async function wakeLeadForWorkers(jobs: AgentRelayJob[]): Promise<void> {
  if (jobs.length === 0) return;

  const leadSessionId = jobs[0]?.source_session_id;
  if (!leadSessionId) return;
  // A lead that is still in its original turn can harvest the result itself.
  // In particular, do not inject a second prompt into a Grok/ACP relay_wait.
  if (chatRunRegistry.isProcessing(leadSessionId) || wakingLeads.has(leadSessionId)) return;

  const lead = sessionsDb.getSessionById(leadSessionId);
  if (!lead || lead.is_internal || lead.isArchived) return;
  const spawnFn = runtimeSpawnFns[lead.provider as LLMProvider];
  if (!spawnFn) return;

  wakingLeads.add(leadSessionId);
  try {
    // No injectFn is intentional: this path is only for an idle lead. If a
    // user starts a turn in the small race before startProviderRun registers,
    // the starter returns RUN_IN_PROGRESS and the active lead owns the work.
    const started = await startProviderRun({
      appSessionId: leadSessionId,
      provider: lead.provider as LLMProvider,
      providerSessionId: lead.provider_session_id,
      projectPath: lead.runtime_project_path ?? lead.project_path,
      spawnFn,
      content: wakePrompt(jobs),
      options: {
        permissionMode: lead.permission_mode || 'default',
        sessionSummary: `Agent Relay · ${jobs.length} terminal worker${jobs.length === 1 ? '' : 's'}`,
      },
      connection: DETACHED_CONNECTION,
      userId: null,
    });
    if (started.ok) await started.completion;
  } catch (error) {
    console.warn('[AgentRelay] failed to wake idle lead session', {
      sessionId: leadSessionId,
      relayIds: jobs.map((job) => job.relay_id),
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    wakingLeads.delete(leadSessionId);
  }
}

/** Installs the provider runtimes used by the relay-to-lead wake bridge. */
export function configureAgentRelayLeadWake(
  spawnFns: Partial<Record<LLMProvider, ProviderSpawnFn>>,
): void {
  runtimeSpawnFns = spawnFns;
}

/**
 * Called after a terminal relay row is persisted. A short coalescing window
 * prevents a burst of sibling completions from starting overlapping lead turns.
 */
export function notifyAgentRelayTerminal(job: AgentRelayJob): void {
  if (!['completed', 'failed', 'cancelled', 'timed_out'].includes(job.status)) return;
  if (!job.source_session_id) return;
  scheduleLeadWake(job);
}
