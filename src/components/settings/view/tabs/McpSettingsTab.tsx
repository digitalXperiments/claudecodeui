import { McpCatalogPanel } from '../../../mcp';
import type { McpProject } from '../../../mcp/types';
import type { SettingsProject } from '../../types/types';

type McpSettingsTabProps = {
  projects: SettingsProject[];
};

export default function McpSettingsTab({ projects }: McpSettingsTabProps) {
  return (
    <McpCatalogPanel
      currentProjects={projects.map<McpProject>((project) => ({
        projectId: project.name,
        displayName: project.displayName,
        fullPath: project.fullPath,
        path: project.path,
      }))}
    />
  );
}
