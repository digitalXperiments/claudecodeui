import { useEffect, useMemo, useState } from 'react';
import { CopyPlus, Loader2 } from 'lucide-react';

import { Button, Dialog, DialogContent, DialogTitle } from '../../../shared/view/ui';
import { useProjectsOptions } from '../hooks/useProjectsOptions';
import type { ProjectSkill } from '../types';

import SkillScopeField from './SkillScopeField';

type ApplySkillToProjectsDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  skill: ProjectSkill | null;
  sourceWorkspacePath: string | null;
  onApply: (projects: string[]) => Promise<unknown>;
};

/**
 * Pick additional workspaces and copy an existing project skill into each one.
 */
export default function ApplySkillToProjectsDialog({
  open,
  onOpenChange,
  skill,
  sourceWorkspacePath,
  onApply,
}: ApplySkillToProjectsDialogProps) {
  const { projects: projectOptions, isLoading: projectsLoading } = useProjectsOptions();
  const [selectedProjects, setSelectedProjects] = useState<string[]>([]);
  const [isApplying, setIsApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sourceResolved = sourceWorkspacePath?.replace(/\/+$/, '') ?? '';

  const destinationOptions = useMemo(
    () => projectOptions.filter((option) => option.fullPath.replace(/\/+$/, '') !== sourceResolved),
    [projectOptions, sourceResolved],
  );

  useEffect(() => {
    if (!open) {
      return;
    }
    setSelectedProjects([]);
    setError(null);
    setIsApplying(false);
  }, [open, skill?.directoryName]);

  const handleApply = async () => {
    if (selectedProjects.length === 0) {
      setError('Pick at least one project.');
      return;
    }

    setIsApplying(true);
    setError(null);
    try {
      await onApply(selectedProjects);
      onOpenChange(false);
    } catch (applyError) {
      setError(applyError instanceof Error ? applyError.message : 'Failed to apply skill');
    } finally {
      setIsApplying(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        wrapperClassName="z-[10100]"
        className="flex max-h-[min(640px,calc(100vh-2rem))] w-[calc(100vw-2rem)] max-w-lg flex-col overflow-hidden p-0"
      >
        <DialogTitle>Apply skill to projects</DialogTitle>
        <div className="flex-shrink-0 border-b border-border/60 px-4 py-4">
          <div className="text-base font-medium text-foreground">Apply to projects</div>
          <div className="mt-1 text-sm text-muted-foreground">
            Install
            {' '}
            <span className="font-mono text-foreground">{skill?.name ?? 'this skill'}</span>
            {' '}
            into other projects. Each destination gets the same skill folder for every agent.
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <SkillScopeField
            scope="projects"
            projects={selectedProjects}
            options={destinationOptions}
            optionsLoading={projectsLoading}
            hideAllProjects
            onChange={(_scope, nextProjects) => setSelectedProjects(nextProjects)}
          />
          {error && (
            <div className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-800/60 dark:bg-red-900/20 dark:text-red-200">
              {error}
            </div>
          )}
        </div>

        <div className="flex flex-shrink-0 items-center justify-end gap-2 border-t border-border/60 px-4 py-3">
          <Button type="button" variant="outline" size="sm" disabled={isApplying} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={isApplying || selectedProjects.length === 0}
            onClick={() => void handleApply()}
          >
            {isApplying ? <Loader2 className="h-4 w-4 animate-spin" /> : <CopyPlus className="h-4 w-4" />}
            Apply to {selectedProjects.length || ''} project{selectedProjects.length === 1 ? '' : 's'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
