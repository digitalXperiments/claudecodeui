import { authenticatedFetch } from '../../../utils/api';

import type { AgentWorkspace, WorkspaceCiStatus, WorkspaceDiff, WorkspaceLiveStatus, WorkspacePullRequest, WorkspaceTestReport } from '../types';

async function readResponse<T>(response: Response): Promise<T> {
  const payload = (await response.json().catch(() => null)) as
    | { error?: { message?: string }; message?: string }
    | null;
  if (!response.ok) {
    throw new Error(payload?.error?.message || payload?.message || `Workspace request failed (${response.status})`);
  }
  return payload as T;
}

export const workspaceApi = {
  async list(projectId: string): Promise<AgentWorkspace[]> {
    const response = await authenticatedFetch(`/api/projects/${encodeURIComponent(projectId)}/workspaces`);
    const payload = await readResponse<{ workspaces?: AgentWorkspace[] }>(response);
    return payload.workspaces ?? [];
  },

  async status(workspaceId: string): Promise<WorkspaceLiveStatus> {
    const response = await authenticatedFetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/status`);
    const payload = await readResponse<{ status: WorkspaceLiveStatus }>(response);
    return payload.status;
  },

  async diff(workspaceId: string): Promise<WorkspaceDiff> {
    const response = await authenticatedFetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/diff`);
    const payload = await readResponse<{ diff: WorkspaceDiff }>(response);
    return payload.diff;
  },

  async merge(workspaceId: string, strategy: 'ff-only' | 'merge' | 'squash' = 'merge') {
    const response = await authenticatedFetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/merge`, {
      method: 'POST',
      body: JSON.stringify({ strategy }),
    });
    return readResponse<{ result: { merged: boolean } }>(response);
  },

  async discard(workspaceId: string) {
    const response = await authenticatedFetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/discard`, {
      method: 'POST',
      body: JSON.stringify({ deleteBranch: true }),
    });
    return readResponse<{ workspace: AgentWorkspace }>(response);
  },

  async cleanup(workspaceId: string) {
    const response = await authenticatedFetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/cleanup`, {
      method: 'POST',
    });
    return readResponse<{ workspace: AgentWorkspace }>(response);
  },

  async shipTest(workspaceId: string): Promise<WorkspaceTestReport> {
    const response = await authenticatedFetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/ship/test`, { method: 'POST' });
    const payload = await readResponse<{ report: WorkspaceTestReport }>(response);
    return payload.report;
  },

  async shipPr(workspaceId: string, input: { title?: string; body?: string; draft?: boolean } = {}): Promise<WorkspacePullRequest> {
    const response = await authenticatedFetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/ship/pr`, { method: 'POST', body: JSON.stringify(input) });
    const payload = await readResponse<{ pullRequest: WorkspacePullRequest }>(response);
    return payload.pullRequest;
  },

  async shipCi(workspaceId: string, prUrl?: string): Promise<WorkspaceCiStatus> {
    const query = prUrl ? `?pr=${encodeURIComponent(prUrl)}` : '';
    const response = await authenticatedFetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/ship/ci${query}`);
    const payload = await readResponse<{ status: WorkspaceCiStatus }>(response);
    return payload.status;
  },

  async shipFixCi(runId: string, failureSummary: string) {
    const response = await authenticatedFetch(`/api/runs/${encodeURIComponent(runId)}/ship/fix-ci`, { method: 'POST', body: JSON.stringify({ failureSummary }) });
    return readResponse<{ run: unknown }>(response);
  },
};
