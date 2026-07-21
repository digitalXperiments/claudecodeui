import { useCallback, useEffect, useState } from 'react';

import { authenticatedFetch } from '../../../utils/api';
import type {
  ApiResponse,
  GlobalSkill,
  GlobalSkillContentUpdateResponse,
  GlobalSkillsResponse,
  ProviderSkillCreateEntryPayload,
  SkillContentResponse,
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

const normalizeGlobalSkill = (skill: Partial<GlobalSkill>): GlobalSkill => ({
  name: String(skill.name ?? ''),
  description: String(skill.description ?? ''),
  directoryName: String(skill.directoryName ?? ''),
  sourcePath: String(skill.sourcePath ?? ''),
  providers: Array.isArray(skill.providers) ? skill.providers : [],
  conflicts: Array.isArray(skill.conflicts) ? skill.conflicts : [],
  unsupported: Array.isArray(skill.unsupported) ? skill.unsupported : [],
  ...(skill.kind === 'memory-template' ? { kind: 'memory-template' as const } : {}),
});

export function useGlobalSkills() {
  const [skills, setSkills] = useState<GlobalSkill[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState<'success' | 'error' | null>(null);

  const refreshSkills = useCallback(async () => {
    setIsLoading(true);
    setLoadError(null);

    try {
      const response = await authenticatedFetch('/api/global-skills');
      const data = await toResponseJson<ApiResponse<GlobalSkillsResponse>>(response);
      if (!response.ok || !data.success) {
        throw new Error(getApiErrorMessage(data, 'Failed to load global skills'));
      }

      setSkills((data.data.skills || []).map(normalizeGlobalSkill));
    } catch (error) {
      setSkills([]);
      setLoadError(error instanceof Error ? error.message : 'Failed to load global skills');
    } finally {
      setIsLoading(false);
    }
  }, []);

  const addSkills = useCallback(async (entries: ProviderSkillCreateEntryPayload[]) => {
    try {
      const response = await authenticatedFetch('/api/global-skills', {
        method: 'POST',
        body: JSON.stringify({ entries }),
      });
      const data = await toResponseJson<ApiResponse<GlobalSkillsResponse>>(response);
      if (!response.ok || !data.success) {
        throw new Error(getApiErrorMessage(data, 'Failed to save global skills'));
      }

      await refreshSkills();
      setSaveStatus('success');
      return (data.data.skills || []).map(normalizeGlobalSkill);
    } catch (error) {
      setSaveStatus('error');
      throw error;
    }
  }, [refreshSkills]);

  const removeSkill = useCallback(async (directoryName: string) => {
    const response = await authenticatedFetch(
      `/api/global-skills/${encodeURIComponent(directoryName)}`,
      { method: 'DELETE' },
    );
    const data = await toResponseJson<ApiResponse<unknown>>(response);
    if (!response.ok || !data.success) {
      throw new Error(getApiErrorMessage(data, 'Failed to remove global skill'));
    }

    await refreshSkills();
  }, [refreshSkills]);

  const getSkillContent = useCallback(async (directoryName: string): Promise<SkillContentResponse> => {
    const response = await authenticatedFetch(
      `/api/global-skills/${encodeURIComponent(directoryName)}/content`,
    );
    const data = await toResponseJson<ApiResponse<SkillContentResponse>>(response);
    if (!response.ok || !data.success) {
      throw new Error(getApiErrorMessage(data, 'Failed to load skill content'));
    }

    return data.data;
  }, []);

  const saveSkillContent = useCallback(async (
    directoryName: string,
    content: string,
  ): Promise<GlobalSkillContentUpdateResponse> => {
    const response = await authenticatedFetch(
      `/api/global-skills/${encodeURIComponent(directoryName)}/content`,
      {
        method: 'PUT',
        body: JSON.stringify({ content }),
      },
    );
    const data = await toResponseJson<ApiResponse<GlobalSkillContentUpdateResponse>>(response);
    if (!response.ok || !data.success) {
      throw new Error(getApiErrorMessage(data, 'Failed to save skill content'));
    }

    await refreshSkills();
    setSaveStatus('success');
    return data.data;
  }, [refreshSkills]);

  useEffect(() => {
    void refreshSkills();
  }, [refreshSkills]);

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
    getSkillContent,
    saveSkillContent,
    refreshSkills,
  };
}
