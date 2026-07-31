import { useState } from 'react';
import { FileCode2 } from 'lucide-react';

import { GlobalSkills, ProjectSkills } from '../../../skills';
import type { SkillsProject } from '../../../skills/types';
import { cn } from '../../../../lib/utils';
import type { SettingsProject } from '../../types/types';

type SkillsSettingsTabProps = {
  projects: SettingsProject[];
};

type SkillsView = 'user' | 'project';

/**
 * Unified Skills settings: CloudCLI-authored skills with explicit fan-out.
 * Replaces the separate Global skills + Skills (project) nav items and the
 * per-agent Skills tabs.
 */
export default function SkillsSettingsTab({ projects }: SkillsSettingsTabProps) {
  const [view, setView] = useState<SkillsView>('user');
  const skillsProjects = projects.map<SkillsProject>((project) => ({
    projectId: project.name,
    displayName: project.displayName,
    fullPath: project.fullPath,
    path: project.path,
  }));

  return (
    <div className="space-y-4">
      <div className="flex min-w-0 items-start gap-3">
        <FileCode2 className="mt-0.5 h-5 w-5 flex-shrink-0 text-blue-500" />
        <div className="min-w-0 space-y-1">
          <h3 className="text-lg font-medium text-foreground">Skills</h3>
          <p className="text-sm text-muted-foreground">
            Author skills once in CloudCLI, then enable them on the agents you choose.
            Each agent receives a projection in its native skills folder — no duplicate definitions.
          </p>
        </div>
      </div>

      <div className="inline-flex rounded-lg border border-border bg-muted/30 p-0.5">
        <button
          type="button"
          onClick={() => setView('user')}
          className={cn(
            'rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
            view === 'user'
              ? 'bg-background text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          User / multi-project
        </button>
        <button
          type="button"
          onClick={() => setView('project')}
          className={cn(
            'rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
            view === 'project'
              ? 'bg-background text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          Single project
        </button>
      </div>

      {view === 'user' ? (
        <GlobalSkills />
      ) : (
        <ProjectSkills currentProjects={skillsProjects} />
      )}
    </div>
  );
}
