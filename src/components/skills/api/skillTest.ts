import { authenticatedFetch } from '../../../utils/api';

/**
 * Result of a headless skill dry-run test. `success: false` means the provider
 * runtime itself failed (API error, CLI crash) or the provider does not support
 * project-scope skill testing.
 */
export type SkillTestResult = {
  success: boolean;
  text: string;
  errorMessage?: string;
  durationMs: number;
  scratchPath: string;
  cleanedUp: boolean;
};

type SkillTestResponse = {
  success: true;
  data: {
    result: SkillTestResult;
  };
};

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

/**
 * Runs a dry-run test of a drafted skill against one provider. The backend
 * materializes the skill into a scratch project under `tmp/cloudcli/`, runs a
 * detached agent turn against it, and removes the scratch project afterwards.
 */
export const testSkill = async (params: {
  content: string;
  provider: string;
  workspacePath?: string | null;
  testPrompt?: string;
}, target: 'global' | 'project'): Promise<SkillTestResult> => {
  const endpoint = target === 'project'
    ? '/api/project-skills/test'
    : '/api/global-skills/test';
  const response = await authenticatedFetch(endpoint, {
    method: 'POST',
    body: JSON.stringify(params),
  });
  const data = await response.json() as SkillTestResponse;
  if (!response.ok || !data.success) {
    throw new Error(getApiErrorMessage(data, 'Failed to test skill'));
  }

  return data.data.result;
};
