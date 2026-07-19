import { useCallback, useEffect, useRef, useState } from 'react';

import { authenticatedFetch } from '../../../utils/api';
import type {
  ApiResponse,
  ProjectSkill,
  ProjectSkillsResponse,
  ProviderSkillCreateEntryPayload,
} from '../types';

const toResponseJson = async <T>(response: Response): Promise<T> => response.json() as Promise<T>;

const getApiErrorMessage = (payload: unknown, fallback: string): string => {
  if (!payload || typeof payload !== 'object') {
    return fallback;
  }

  const record = payload as Record<string, unknown>;
  const error = record.error;
  if (error && typeof error === 'object') {
    const message = (error as Record<string, unknown>).message;
    if (typeof message === 'string' && message.trim()) {
      return message;
    }
  }

  if (typeof error === 'string' && error.trim()) {
    return error;
  }

  return fallback;
};

const normalizeProjectSkill = (skill: Partial<ProjectSkill>): ProjectSkill => ({
  name: String(skill.name ?? ''),
  description: String(skill.description ?? ''),
  directoryName: String(skill.directoryName ?? ''),
  sourcePath: String(skill.sourcePath ?? ''),
  providers: Array.isArray(skill.providers) ? skill.providers : [],
  conflicts: Array.isArray(skill.conflicts) ? skill.conflicts : [],
});

const fetchProjectSkills = async (workspacePath: string): Promise<ProjectSkill[]> => {
  const params = new URLSearchParams({ workspacePath });
  const response = await authenticatedFetch(`/api/project-skills?${params.toString()}`);
  const data = await toResponseJson<ApiResponse<ProjectSkillsResponse>>(response);
  if (!response.ok || !data.success) {
    throw new Error(getApiErrorMessage(data, 'Failed to load project skills'));
  }

  return (data.data.skills || []).map(normalizeProjectSkill);
};

type UseProjectSkillsArgs = {
  workspacePath: string | null;
};

export function useProjectSkills({ workspacePath }: UseProjectSkillsArgs) {
  const [skills, setSkills] = useState<ProjectSkill[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState<'success' | 'error' | null>(null);
  const activeLoadIdRef = useRef(0);

  const refreshSkills = useCallback(async () => {
    if (!workspacePath) {
      setSkills([]);
      setIsLoading(false);
      setLoadError(null);
      return;
    }

    const loadId = activeLoadIdRef.current + 1;
    activeLoadIdRef.current = loadId;
    setIsLoading(true);
    setLoadError(null);

    try {
      const nextSkills = await fetchProjectSkills(workspacePath);
      if (activeLoadIdRef.current !== loadId) {
        return;
      }

      setSkills(nextSkills);
    } catch (error) {
      if (activeLoadIdRef.current !== loadId) {
        return;
      }

      setSkills([]);
      setLoadError(error instanceof Error ? error.message : 'Failed to load project skills');
    } finally {
      if (activeLoadIdRef.current === loadId) {
        setIsLoading(false);
      }
    }
  }, [workspacePath]);

  const addSkills = useCallback(async (entries: ProviderSkillCreateEntryPayload[]) => {
    if (!workspacePath) {
      throw new Error('Select a project before adding project skills.');
    }

    try {
      const response = await authenticatedFetch('/api/project-skills', {
        method: 'POST',
        body: JSON.stringify({ workspacePath, entries }),
      });
      const data = await toResponseJson<ApiResponse<ProjectSkillsResponse>>(response);
      if (!response.ok || !data.success) {
        throw new Error(getApiErrorMessage(data, 'Failed to save project skills'));
      }

      await refreshSkills();
      setSaveStatus('success');
      return (data.data.skills || []).map(normalizeProjectSkill);
    } catch (error) {
      setSaveStatus('error');
      throw error;
    }
  }, [refreshSkills, workspacePath]);

  const removeSkill = useCallback(async (directoryName: string) => {
    if (!workspacePath) {
      throw new Error('Select a project before removing project skills.');
    }

    const params = new URLSearchParams({ workspacePath });
    const response = await authenticatedFetch(
      `/api/project-skills/${encodeURIComponent(directoryName)}?${params.toString()}`,
      { method: 'DELETE' },
    );
    const data = await toResponseJson<ApiResponse<unknown>>(response);
    if (!response.ok || !data.success) {
      throw new Error(getApiErrorMessage(data, 'Failed to remove project skill'));
    }

    await refreshSkills();
  }, [refreshSkills, workspacePath]);

  useEffect(() => {
    void refreshSkills();
  }, [refreshSkills]);

  useEffect(() => {
    setSaveStatus(null);
  }, [workspacePath]);

  useEffect(() => {
    if (saveStatus === null) {
      return;
    }

    const timer = window.setTimeout(() => setSaveStatus(null), 6000);
    return () => window.clearTimeout(timer);
  }, [saveStatus]);

  return {
    skills,
    isLoading,
    loadError,
    saveStatus,
    addSkills,
    removeSkill,
    refreshSkills,
  };
}
