import { authenticatedFetch } from '../../../utils/api';

/**
 * Client for the global usage-stats endpoint (GET /api/runs/stats/global).
 * Types mirror the server contract in server/modules/runs/runs.types.ts.
 */

export type StatsOverview = {
  totalRuns: number;
  runsWithTokens: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalCostUsd: number | null;
  runsWithCost: number;
  totalDurationMs: number;
  avgDurationMs: number | null;
  conversationCount: number;
  activeConversations: number;
  avgTokensPerConversation: number | null;
  avgTokensPerRun: number | null;
  successRate: number | null;
};

export type StatsStatusCount = { status: string; count: number };

export type StatsDayBucket = {
  day: string; // YYYY-MM-DD (UTC)
  runs: number;
  tokens: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  durationMs: number;
  conversations: number;
};

export type StatsProviderRow = {
  provider: string | null;
  runs: number;
  tokens: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  durationMs: number;
  conversations: number;
};

export type StatsModelRow = {
  provider: string | null;
  model: string | null;
  runs: number;
  tokens: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  durationMs: number;
};

export type StatsSourceRow = { source: string; runs: number; tokens: number };

export type StatsHourBucket = { hour: number; runs: number };

export type GlobalRunStats = {
  range: { from: string | null; to: string | null };
  generatedAt: string;
  firstRunAt: string | null;
  overview: StatsOverview;
  byStatus: StatsStatusCount[];
  daily: StatsDayBucket[];
  providers: StatsProviderRow[];
  models: StatsModelRow[];
  sources: StatsSourceRow[];
  byHourUtc: StatsHourBucket[];
};

export type StatsRangeParams = {
  /** ISO-8601 inclusive lower bound; omit for unbounded. */
  from?: string;
  /** ISO-8601 inclusive upper bound; omit for unbounded. */
  to?: string;
  /** Provider id, or `__unknown__` for unattributed runs. */
  provider?: string;
};

async function parse<T>(response: Response): Promise<T> {
  const payload = (await response.json().catch(() => null)) as
    | { error?: { message?: string } | string; message?: string }
    | null;
  if (!response.ok) {
    const error = typeof payload?.error === 'string' ? payload.error : payload?.error?.message;
    throw new Error(error || payload?.message || `Stats request failed (${response.status})`);
  }
  return payload as T;
}

export const statsApi = {
  async global(params: StatsRangeParams = {}): Promise<GlobalRunStats> {
    const query = new URLSearchParams();
    if (params.from) query.set('from', params.from);
    if (params.to) query.set('to', params.to);
    if (params.provider != null) query.set('provider', params.provider);
    const suffix = query.toString();
    const response = await authenticatedFetch(`/api/runs/stats/global${suffix ? `?${suffix}` : ''}`);
    const payload = await parse<{ stats: GlobalRunStats }>(response);
    return payload.stats;
  },
};
