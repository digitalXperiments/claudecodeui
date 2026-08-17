import { authenticatedFetch } from '../../../utils/api';

import { useApiSource } from './useApiSource';

export type SkillResult = {
  id: string;
  name: string;
  description: string;
  scope: 'project' | 'global';
};

type SkillsPayload = {
  success?: boolean;
  data?: {
    skills?: Array<{
      name?: string;
      description?: string;
      directoryName?: string;
    }>;
  };
};

const parseSkills = (data: SkillsPayload, scope: SkillResult['scope']): SkillResult[] => {
  const rows = data.data?.skills ?? [];
  return rows.map((skill) => {
    const directoryName = String(skill.directoryName ?? skill.name ?? '');
    return {
      id: `${scope}:${directoryName}`,
      name: String(skill.name ?? directoryName),
      description: String(skill.description ?? ''),
      scope,
    };
  });
};

export function useProjectSkillsSource(workspacePath: string | undefined, enabled: boolean) {
  return useApiSource<SkillResult, SkillsPayload>({
    enabled: enabled && Boolean(workspacePath),
    deps: [workspacePath],
    fetcher: (signal) => {
      const params = new URLSearchParams({ workspacePath: workspacePath! });
      return authenticatedFetch(`/api/project-skills?${params.toString()}`, { signal });
    },
    parse: (data) => parseSkills(data, 'project'),
  });
}

export function useGlobalSkillsSource(enabled: boolean) {
  return useApiSource<SkillResult, SkillsPayload>({
    enabled,
    deps: [],
    fetcher: (signal) => authenticatedFetch('/api/global-skills', { signal }),
    parse: (data) => parseSkills(data, 'global'),
  });
}
