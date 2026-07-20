import { ProjectMemory } from '../../../memory';
import type { MemoryProject } from '../../../memory/types';
import type { SettingsProject } from '../../types/types';

type MemorySettingsTabProps = {
  projects: SettingsProject[];
};

export default function MemorySettingsTab({ projects }: MemorySettingsTabProps) {
  return (
    <ProjectMemory
      currentProjects={projects.map<MemoryProject>((project) => ({
        projectId: project.name,
        displayName: project.displayName || project.name,
        fullPath: project.fullPath,
        path: project.path,
      }))}
    />
  );
}
