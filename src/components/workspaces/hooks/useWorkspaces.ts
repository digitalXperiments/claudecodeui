import { useCallback, useEffect, useState } from 'react';

import { workspaceApi } from '../api/workspaceApi';
import type { AgentWorkspace, WorkspaceCiStatus, WorkspaceDiff, WorkspaceLiveStatus, WorkspacePullRequest, WorkspaceTestReport } from '../types';

export function useWorkspaces(projectId: string | null) {
  const [workspaces, setWorkspaces] = useState<AgentWorkspace[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [status, setStatus] = useState<WorkspaceLiveStatus | null>(null);
  const [diff, setDiff] = useState<WorkspaceDiff | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testReport, setTestReport] = useState<WorkspaceTestReport | null>(null);
  const [pullRequest, setPullRequest] = useState<WorkspacePullRequest | null>(null);
  const [ciStatus, setCiStatus] = useState<WorkspaceCiStatus | null>(null);
  const [isShipping, setIsShipping] = useState(false);

  const refresh = useCallback(async () => {
    if (!projectId) {
      setWorkspaces([]);
      setSelectedId(null);
      return;
    }
    setIsLoading(true);
    setError(null);
    try {
      const next = await workspaceApi.list(projectId);
      setWorkspaces(next);
      setSelectedId((current) => (current && next.some((item) => item.workspace_id === current) ? current : next[0]?.workspace_id ?? null));
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Failed to load workspaces');
    } finally {
      setIsLoading(false);
    }
  }, [projectId]);

  const select = useCallback(async (workspaceId: string) => {
    setSelectedId(workspaceId);
    setTestReport(null);
    setPullRequest(null);
    setCiStatus(null);
    setError(null);
    try {
      const [nextStatus, nextDiff] = await Promise.all([
        workspaceApi.status(workspaceId),
        workspaceApi.diff(workspaceId),
      ]);
      setStatus(nextStatus);
      setDiff(nextDiff);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Failed to load workspace details');
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (selectedId) {
      void select(selectedId);
    } else {
      setStatus(null);
      setDiff(null);
    }
  }, [selectedId, select]);

  const runAction = useCallback(
    async (action: (workspaceId: string) => Promise<unknown>) => {
      if (!selectedId) return;
      setIsLoading(true);
      setError(null);
      try {
        await action(selectedId);
        await refresh();
      } catch (requestError) {
        setError(requestError instanceof Error ? requestError.message : 'Workspace action failed');
      } finally {
        setIsLoading(false);
      }
    },
    [refresh, selectedId],
  );

  const runShipAction = useCallback(async (action: (workspaceId: string) => Promise<unknown>) => {
    if (!selectedId) return;
    setIsShipping(true);
    setError(null);
    try {
      await action(selectedId);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Ship action failed');
    } finally {
      setIsShipping(false);
    }
  }, [selectedId]);

  const selected = workspaces.find((workspace) => workspace.workspace_id === selectedId) ?? null;

  return {
    workspaces,
    selectedId,
    selected,
    status,
    diff,
    isLoading,
    error,
    refresh,
    select: setSelectedId,
    merge: () => runAction((workspaceId) => workspaceApi.merge(workspaceId)),
    discard: () => runAction((workspaceId) => workspaceApi.discard(workspaceId)),
    cleanup: () => runAction((workspaceId) => workspaceApi.cleanup(workspaceId)),
    testReport,
    pullRequest,
    ciStatus,
    isShipping,
    runShipTest: () => runShipAction(async (workspaceId) => setTestReport(await workspaceApi.shipTest(workspaceId))),
    createShipPr: () => runShipAction(async (workspaceId) => setPullRequest(await workspaceApi.shipPr(workspaceId))),
    refreshShipCi: () => runShipAction(async (workspaceId) => setCiStatus(await workspaceApi.shipCi(workspaceId, pullRequest?.url))),
    openShipFix: (failureSummary: string) => runShipAction(async () => {
      if (!selected?.run_id) throw new Error('This workspace is not linked to a run.');
      await workspaceApi.shipFixCi(selected.run_id, failureSummary);
    }),
  };
}
