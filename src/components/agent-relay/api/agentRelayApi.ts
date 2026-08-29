import { authenticatedFetch } from '../../../utils/api';
import type {
  AgentRelayApproval,
  AgentRelayJob,
  AgentRelayRuntimeStatus,
  AgentRelaySettings,
} from '../types';

async function readData<T>(response: Response): Promise<T> {
  const payload = await response.json().catch(() => ({})) as {
    success?: boolean;
    data?: T;
    error?: unknown;
    message?: unknown;
  };
  if (!response.ok || payload.success === false || payload.data === undefined) {
    const structuredMessage = payload.error && typeof payload.error === 'object'
      ? (payload.error as { message?: unknown }).message
      : null;
    const message = typeof payload.error === 'string'
      ? payload.error
      : typeof structuredMessage === 'string'
        ? structuredMessage
        : typeof payload.message === 'string'
          ? payload.message
          : `Agent Relay request failed (${response.status}).`;
    throw new Error(message);
  }
  return payload.data;
}

export const agentRelayApi = {
  async getSettings(): Promise<AgentRelaySettings> {
    const data = await readData<{ settings: AgentRelaySettings }>(await authenticatedFetch('/api/agent-relay/settings'));
    return data.settings;
  },

  async updateSettings(patch: Partial<AgentRelaySettings>): Promise<AgentRelaySettings> {
    const data = await readData<{ settings: AgentRelaySettings }>(await authenticatedFetch('/api/agent-relay/settings', {
      method: 'PUT',
      body: JSON.stringify(patch),
    }));
    return data.settings;
  },

  async getStatus(): Promise<AgentRelayRuntimeStatus> {
    const data = await readData<{ status: AgentRelayRuntimeStatus }>(await authenticatedFetch('/api/agent-relay/status'));
    return data.status;
  },

  async sync(): Promise<void> {
    await readData(await authenticatedFetch('/api/agent-relay/sync', { method: 'POST' }));
  },

  /**
   * `sessionId` scopes the list to the relays one lead chat dispatched. Omit it
   * for the project-wide operator view.
   */
  async listJobs(input: { projectId?: string; sessionId?: string; active?: boolean; limit?: number } = {}): Promise<AgentRelayJob[]> {
    const query = new URLSearchParams();
    if (input.projectId) query.set('projectId', input.projectId);
    if (input.sessionId) query.set('sessionId', input.sessionId);
    if (input.active !== undefined) query.set('active', String(input.active));
    if (input.limit) query.set('limit', String(input.limit));
    const data = await readData<{ jobs: AgentRelayJob[] }>(await authenticatedFetch(`/api/agent-relay/jobs?${query}`));
    return data.jobs;
  },

  async listPendingApprovals(input: { sessionId?: string } = {}): Promise<AgentRelayApproval[]> {
    const query = new URLSearchParams({ status: 'pending', limit: '50' });
    if (input.sessionId) query.set('sessionId', input.sessionId);
    const data = await readData<{ approvals: AgentRelayApproval[] }>(
      await authenticatedFetch(`/api/agent-relay/approvals?${query}`),
    );
    return data.approvals;
  },

  async followUp(relayId: string, prompt: string): Promise<AgentRelayJob> {
    const data = await readData<{ job: AgentRelayJob }>(
      await authenticatedFetch(`/api/agent-relay/jobs/${encodeURIComponent(relayId)}/follow-up`, {
        method: 'POST',
        body: JSON.stringify({ prompt }),
      }),
    );
    return data.job;
  },

  async peek(relayId: string, limit = 20): Promise<{
    relayId: string;
    status: string;
    label: string | null;
    elapsedMs: number | null;
    idleMs: number | null;
    toolCallCount: number;
    timeoutMs: number;
    recentActivity: Array<{ at: string; type: string; tool: string | null; detail: string | null }>;
    /** In-memory tail of the worker's streamed prose while it runs. */
    recentOutput: string | null;
    pendingApprovals: AgentRelayApproval[];
  }> {
    const data = await readData<{ peek: {
      relayId: string;
      status: string;
      label: string | null;
      elapsedMs: number | null;
      idleMs: number | null;
      toolCallCount: number;
      timeoutMs: number;
      recentActivity: Array<{ at: string; type: string; tool: string | null; detail: string | null }>;
      recentOutput: string | null;
      pendingApprovals: AgentRelayApproval[];
    } }>(
      await authenticatedFetch(`/api/agent-relay/jobs/${encodeURIComponent(relayId)}/peek?limit=${limit}`),
    );
    return data.peek;
  },

  async diff(relayId: string): Promise<{
    relayId: string;
    workspace: { feature_branch?: string; root_path?: string } | null;
    files: Array<{ path: string; status: string }>;
    summary: { additions: number; deletions: number };
  }> {
    const data = await readData<{ diff: {
      relayId: string;
      workspace: { feature_branch?: string; root_path?: string } | null;
      files: Array<{ path: string; status: string }>;
      summary: { additions: number; deletions: number };
    } }>(
      await authenticatedFetch(`/api/agent-relay/jobs/${encodeURIComponent(relayId)}/diff`),
    );
    return data.diff;
  },

  async decideApproval(approvalId: string, allow: boolean, reason?: string): Promise<AgentRelayApproval> {
    const data = await readData<{ approval: AgentRelayApproval }>(
      await authenticatedFetch(`/api/agent-relay/approvals/${encodeURIComponent(approvalId)}/decide`, {
        method: 'POST',
        body: JSON.stringify({ allow, reason }),
      }),
    );
    return data.approval;
  },

  async cancel(relayId: string): Promise<AgentRelayJob> {
    const data = await readData<{ job: AgentRelayJob }>(await authenticatedFetch(`/api/agent-relay/jobs/${encodeURIComponent(relayId)}/cancel`, { method: 'POST' }));
    return data.job;
  },
};
