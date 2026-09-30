import type { AgentRelayJob } from '../../../agent-relay/types';

export type RelayUsageSummary = {
  jobCount: number;
  tokens: number;
  jobsWithTokens: number;
  costUsd: number;
  jobsWithCost: number;
};

export function summarizeRelayUsage(jobs: AgentRelayJob[]): RelayUsageSummary {
  return jobs.reduce<RelayUsageSummary>((summary, job) => {
    const tokens = job.usage?.totalTokens;
    const costUsd = job.usage?.costUsd;
    return {
      jobCount: summary.jobCount + 1,
      tokens: summary.tokens + (tokens ?? 0),
      jobsWithTokens: summary.jobsWithTokens + (tokens != null ? 1 : 0),
      costUsd: summary.costUsd + (costUsd ?? 0),
      jobsWithCost: summary.jobsWithCost + (costUsd != null ? 1 : 0),
    };
  }, { jobCount: 0, tokens: 0, jobsWithTokens: 0, costUsd: 0, jobsWithCost: 0 });
}

export function dependencyWaitReason(job: AgentRelayJob, jobsById: Map<string, AgentRelayJob>): string | null {
  if (job.status !== 'queued') return null;
  if (job.depends_on.length === 0) return job.queue_position ? `Queued at position ${job.queue_position}.` : 'Queued for an available worker slot.';

  const waitingOn = job.depends_on
    .map((dependencyId) => jobsById.get(dependencyId))
    .filter((dependency): dependency is AgentRelayJob => dependency !== undefined && dependency.status !== 'completed');
  if (waitingOn.length === 0) return job.queue_position ? `Dependencies complete · queued at position ${job.queue_position}.` : 'Dependencies complete · waiting for an available worker slot.';

  const blocked = waitingOn.some((dependency) => ['blocked', 'failed', 'cancelled', 'timed_out'].includes(dependency.status));
  const labels = waitingOn.map((dependency) => dependency.label || dependency.task).map((label) => label.length > 42 ? `${label.slice(0, 39)}…` : label);
  return blocked ? `Blocked by ${labels.join(', ')}.` : `Waiting for ${labels.join(', ')}.`;
}

export function retryLabel(job: AgentRelayJob): string | null {
  if (job.retries <= 0 && job.retry_count <= 0 && job.attempt <= 1) return null;
  return `attempt ${job.attempt}${job.retries > 0 ? ` · ${job.retry_count}/${job.retries} retries` : ''}`;
}
