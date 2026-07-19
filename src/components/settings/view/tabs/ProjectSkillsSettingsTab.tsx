import { ProjectSkills } from '../../../skills';
import type { SkillsProject } from '../../../skills/types';
import type { SettingsProject } from '../../types/types';

type ProjectSkillsSettingsTabProps = {
  projects: SettingsProject[];
};

export default function ProjectSkillsSettingsTab({ projects }: ProjectSkillsSettingsTabProps) {
  return (
    <ProjectSkills
      currentProjects={projects.map<SkillsProject>((project) => ({
        projectId: project.name,
        displayName: project.displayName,
        fullPath: project.fullPath,
        path: project.path,
      }))}
    />
  );
}
