import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../../utils/api';
import type { Project } from '../../../types/app';
import type { FileTreeNode } from '../types/types';

const FILE_TREE_TIMEOUT_MS = 30_000;

type UseFileTreeDataResult = {
  files: FileTreeNode[];
  loading: boolean;
  error: string | null;
  refreshFiles: () => void;
};

export function useFileTreeData(selectedProject: Project | null): UseFileTreeDataResult {
  const [files, setFiles] = useState<FileTreeNode[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const abortControllerRef = useRef<AbortController | null>(null);

  const refreshFiles = useCallback(() => {
    setRefreshKey((prev) => prev + 1);
  }, []);

  useEffect(() => {
    // File-tree requests use the DB projectId; the backend resolves it to the
    // project's absolute path through the projects table.
    const projectId = selectedProject?.projectId;

    if (!projectId) {
      setFiles([]);
      setLoading(false);
      setError(null);
      return;
    }

    // Abort previous request
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    const controller = new AbortController();
    abortControllerRef.current = controller;
    // A stalled request must not leave the panel on "Loading files..." forever.
    let timedOut = false;
    const timeoutId = window.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, FILE_TREE_TIMEOUT_MS);

    // Track mount state so aborted or late responses do not enqueue stale state updates.
    let isActive = true;

    const fetchFiles = async () => {
      if (isActive) {
        setLoading(true);
        setError(null);
      }
      try {
        const response = await api.getFiles(projectId, { signal: controller.signal });

        if (!response.ok) {
          const errorText = await response.text();
          console.error('File fetch failed:', response.status, errorText);
          if (isActive) {
            setFiles([]);
            setError(`Failed to load files (${response.status})`);
          }
          return;
        }

        const data = (await response.json()) as FileTreeNode[];
        if (isActive) {
          setFiles(data);
        }
      } catch (error) {
        if ((error as { name?: string }).name === 'AbortError' && !timedOut) {
          return;
        }

        console.error('Error fetching files:', error);
        if (isActive) {
          setFiles([]);
          setError(timedOut ? 'Loading files timed out' : 'Failed to load files');
        }
      } finally {
        window.clearTimeout(timeoutId);
        if (isActive) {
          setLoading(false);
        }
      }
    };

    void fetchFiles();

    return () => {
      isActive = false;
      window.clearTimeout(timeoutId);
      controller.abort();
    };
  }, [selectedProject?.projectId, refreshKey]);

  return {
    files,
    loading,
    error,
    refreshFiles,
  };
}
