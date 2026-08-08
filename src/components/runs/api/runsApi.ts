import { authenticatedFetch } from '../../../utils/api';

import type {
  AgentRunSummary,
  BudgetUpdate,
  ProjectRunBudget,
  ProjectRunStats,
  RunEvent,
  RunListFilters,
  RunStatus,
} from '../types';

async function parse<T>(response: Response): Promise<T> {
  const payload = (await response.json().catch(() => null)) as
    | { error?: { message?: string } | string; message?: string }
    | null;
  if (!response.ok) {
    const error = typeof payload?.error === 'string' ? payload.error : payload?.error?.message;
    throw new Error(error || payload?.message || `Run request failed (${response.status})`);
  }
  return payload as T;
}

export const runsApi = {
  async list(projectId: string, filters: RunListFilters = {}): Promise<AgentRunSummary[]> {
    const query = new URLSearchParams({ projectId, limit: String(filters.limit ?? 100) });
    if (filters.status) query.set('status', filters.status);
    if (filters.source) query.set('source', filters.source);
    if (filters.from) query.set('from', filters.from);
    if (filters.to) query.set('to', filters.to);
    const response = await authenticatedFetch(`/api/runs?${query.toString()}`);
    const payload = await parse<{ runs?: AgentRunSummary[] }>(response);
    return payload.runs ?? [];
  },

  async stats(projectId: string): Promise<ProjectRunStats> {
    const query = new URLSearchParams({ projectId });
    const response = await authenticatedFetch(`/api/runs/stats?${query.toString()}`);
    const payload = await parse<{ stats: ProjectRunStats }>(response);
    return payload.stats;
  },

  async getBudget(projectId: string): Promise<ProjectRunBudget> {
    const query = new URLSearchParams({ projectId });
    const response = await authenticatedFetch(`/api/runs/budget?${query.toString()}`);
    const payload = await parse<{ budget: ProjectRunBudget }>(response);
    return payload.budget;
  },

  async putBudget(projectId: string, update: BudgetUpdate): Promise<ProjectRunBudget> {
    const response = await authenticatedFetch('/api/runs/budget', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId,
        monthlyTokenBudget: update.monthlyTokenBudget,
        monthlyCostUsdBudget: update.monthlyCostUsdBudget,
        stuckMinutes: update.stuckMinutes,
      }),
    });
    const payload = await parse<{ budget: ProjectRunBudget }>(response);
    return payload.budget;
  },

  async events(runId: string, afterSeq?: number): Promise<RunEvent[]> {
    const query = new URLSearchParams({ limit: '500' });
    if (typeof afterSeq === 'number' && afterSeq > 0) {
      query.set('afterSeq', String(afterSeq));
    }
    const response = await authenticatedFetch(
      `/api/runs/${encodeURIComponent(runId)}/events?${query.toString()}`,
    );
    const payload = await parse<{ events?: RunEvent[] }>(response);
    return payload.events ?? [];
  },

  async abort(runId: string): Promise<AgentRunSummary | null> {
    const response = await authenticatedFetch(`/api/runs/${encodeURIComponent(runId)}/abort`, {
      method: 'POST',
    });
    const payload = await parse<{ run?: AgentRunSummary | null }>(response);
    return payload.run ?? null;
  },
};

export type { RunStatus };
