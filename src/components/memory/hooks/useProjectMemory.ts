import { useCallback, useEffect, useRef, useState } from 'react';

import { authenticatedFetch } from '../../../utils/api';
import type {
  ApiResponse,
  ProjectMemoryStatus,
  ProjectMemoryStatusResponse,
  ProjectMemoryVaultStats,
  ProjectMemoryVaultStatsResponse,
} from '../types';

const toResponseJson = async <T>(response: Response): Promise<T> => response.json() as Promise<T>;

const getApiErrorMessage = (payload: unknown, fallback: string): string => {
  if (payload && typeof payload === 'object') {
    const error = (payload as Record<string, unknown>).error;
    if (error && typeof error === 'object') {
      const message = (error as Record<string, unknown>).message;
      if (typeof message === 'string' && message.trim()) {
        return message;
      }
    }
    if (typeof error === 'string' && error.trim()) {
      return error;
    }
  }
  return fallback;
};

const emptyStatus = (workspacePath: string): ProjectMemoryStatus => ({
  workspacePath,
  enabled: false,
  vaultFolder: '',
  vaultPath: null,
  settingsConfigured: false,
  providers: [],
  skillInstalled: false,
});

type UseProjectMemoryArgs = {
  workspacePath: string | null;
};

export function useProjectMemory({ workspacePath }: UseProjectMemoryArgs) {
  const [status, setStatus] = useState<ProjectMemoryStatus | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const activeLoadIdRef = useRef(0);

  const refresh = useCallback(async () => {
    if (!workspacePath) {
      setStatus(null);
      setIsLoading(false);
      setError(null);
      return;
    }

    const loadId = activeLoadIdRef.current + 1;
    activeLoadIdRef.current = loadId;
    setIsLoading(true);
    setError(null);

    try {
      const params = new URLSearchParams({ workspacePath });
      const response = await authenticatedFetch(`/api/project-memory?${params.toString()}`);
      const data = await toResponseJson<ApiResponse<ProjectMemoryStatusResponse>>(response);
      if (activeLoadIdRef.current !== loadId) {
        return;
      }
      if (!response.ok || !data.success) {
        throw new Error(getApiErrorMessage(data, 'Failed to load project memory'));
      }
      setStatus(data.data.status);
    } catch (err) {
      if (activeLoadIdRef.current !== loadId) {
        return;
      }
      setStatus(workspacePath ? emptyStatus(workspacePath) : null);
      setError(err instanceof Error ? err.message : 'Failed to load project memory');
    } finally {
      if (activeLoadIdRef.current === loadId) {
        setIsLoading(false);
      }
    }
  }, [workspacePath]);

  const enable = useCallback(async (vaultFolder: string) => {
    if (!workspacePath) {
      throw new Error('Select a project first.');
    }
    setIsBusy(true);
    setError(null);
    try {
      const response = await authenticatedFetch('/api/project-memory', {
        method: 'PUT',
        body: JSON.stringify({ workspacePath, vaultFolder, enabled: true }),
      });
      const data = await toResponseJson<ApiResponse<{ status: ProjectMemoryStatus }>>(response);
      if (!response.ok || !data.success) {
        throw new Error(getApiErrorMessage(data, 'Failed to enable project memory'));
      }
      setStatus(data.data.status);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to enable project memory');
      throw err;
    } finally {
      setIsBusy(false);
    }
  }, [workspacePath]);

  const disable = useCallback(async () => {
    if (!workspacePath) {
      return;
    }
    setIsBusy(true);
    setError(null);
    try {
      const params = new URLSearchParams({ workspacePath });
      const response = await authenticatedFetch(`/api/project-memory?${params.toString()}`, {
        method: 'DELETE',
      });
      const data = await toResponseJson<ApiResponse<{ status: ProjectMemoryStatus }>>(response);
      if (!response.ok || !data.success) {
        throw new Error(getApiErrorMessage(data, 'Failed to disable project memory'));
      }
      setStatus(data.data.status);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to disable project memory');
      throw err;
    } finally {
      setIsBusy(false);
    }
  }, [workspacePath]);

  const rescaffold = useCallback(async () => {
    if (!workspacePath) {
      return;
    }
    setIsBusy(true);
    setError(null);
    try {
      const response = await authenticatedFetch('/api/project-memory/rescaffold', {
        method: 'POST',
        body: JSON.stringify({ workspacePath }),
      });
      const data = await toResponseJson<ApiResponse<unknown>>(response);
      if (!response.ok || !data.success) {
        throw new Error(getApiErrorMessage(data, 'Failed to scaffold vault'));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to scaffold vault');
      throw err;
    } finally {
      setIsBusy(false);
    }
  }, [workspacePath]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const [vaultStats, setVaultStats] = useState<ProjectMemoryVaultStats | null>(null);
  const [isLoadingStats, setIsLoadingStats] = useState(false);

  const refreshVaultStats = useCallback(async () => {
    if (!workspacePath || !status?.enabled) {
      setVaultStats(null);
      return;
    }

    setIsLoadingStats(true);
    try {
      const params = new URLSearchParams({ workspacePath });
      const response = await authenticatedFetch(`/api/project-memory/vault-stats?${params.toString()}`);
      const data = await toResponseJson<ApiResponse<ProjectMemoryVaultStatsResponse>>(response);
      if (!response.ok || !data.success) {
        throw new Error(getApiErrorMessage(data, 'Failed to load vault stats'));
      }
      setVaultStats(data.data.stats);
    } catch {
      setVaultStats(null);
    } finally {
      setIsLoadingStats(false);
    }
  }, [workspacePath, status?.enabled]);

  useEffect(() => {
    void refreshVaultStats();
  }, [refreshVaultStats]);

  return { status, isLoading, isBusy, error, refresh, enable, disable, rescaffold, vaultStats, isLoadingStats, refreshVaultStats };
}
