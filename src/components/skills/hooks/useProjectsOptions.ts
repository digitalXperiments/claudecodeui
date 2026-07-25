import { useCallback, useEffect, useState } from 'react';

import { authenticatedFetch } from '../../../utils/api';
import type { SkillProjectOption } from '../types';

type ProjectListItem = {
  fullPath?: unknown;
  path?: unknown;
  displayName?: unknown;
};

/**
 * Loads the app's project list (without sessions) so a global skill can be
 * scoped to a selected set of workspaces.
 */
export function useProjectsOptions() {
  const [projects, setProjects] = useState<SkillProjectOption[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const refreshProjects = useCallback(async () => {
    setIsLoading(true);
    setLoadError(null);

    try {
      const response = await authenticatedFetch('/api/projects?skipSynchronization=1&sessionsLimit=0');
      if (!response.ok) {
        throw new Error('Failed to load projects');
      }

      const data = (await response.json()) as ProjectListItem[];
      const options = (Array.isArray(data) ? data : [])
        .map((project) => {
          const fullPath = typeof project.fullPath === 'string'
            ? project.fullPath
            : typeof project.path === 'string'
              ? project.path
              : '';
          if (!fullPath) {
            return null;
          }

          const displayName = typeof project.displayName === 'string' && project.displayName.trim()
            ? project.displayName
            : fullPath.split('/').filter(Boolean).pop() ?? fullPath;
          return { fullPath, displayName };
        })
        .filter((project): project is SkillProjectOption => project !== null)
        .sort((left, right) => left.displayName.localeCompare(right.displayName));

      setProjects(options);
    } catch (error) {
      setProjects([]);
      setLoadError(error instanceof Error ? error.message : 'Failed to load projects');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshProjects();
  }, [refreshProjects]);

  return { projects, isLoading, loadError, refreshProjects };
}
