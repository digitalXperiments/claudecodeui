import { useEffect, useMemo, useState } from 'react';
import { Loader2, Search } from 'lucide-react';

import { Button, Input } from '../../../shared/view/ui';
import type { GlobalSkill, GlobalSkillScope, SkillProjectOption } from '../types';

type SkillScopeControlProps = {
  skill: GlobalSkill;
  projects: SkillProjectOption[];
  projectsLoading: boolean;
  onApplyScope: (scope: GlobalSkillScope, projects: string[]) => Promise<void>;
};

/**
 * Per-skill scope picker: apply the global skill to every project (user-scope
 * fan-out) or only to a selected set of projects (project-scope fan-out).
 * Switching to "All projects" applies immediately; project selection is
 * committed with the Apply button.
 */
export default function SkillScopeControl({
  skill,
  projects,
  projectsLoading,
  onApplyScope,
}: SkillScopeControlProps) {
  const [selectedScope, setSelectedScope] = useState<GlobalSkillScope>(skill.scope);
  const [checkedPaths, setCheckedPaths] = useState<string[]>(skill.projects);
  const [searchQuery, setSearchQuery] = useState('');
  const [isApplying, setIsApplying] = useState(false);
  const [scopeError, setScopeError] = useState<string | null>(null);

  // Re-sync the local draft whenever the saved skill changes (e.g. after a refresh).
  useEffect(() => {
    setSelectedScope(skill.scope);
    setCheckedPaths(skill.projects);
    setScopeError(null);
  }, [skill.scope, skill.projects]);

  // Scoped paths that are no longer app projects stay listed so they can be
  // reviewed and unchecked.
  const options = useMemo(() => {
    const known = new Set(projects.map((project) => project.fullPath));
    const missing = skill.projects
      .filter((projectPath) => !known.has(projectPath))
      .map((projectPath) => ({
        fullPath: projectPath,
        displayName: `${projectPath.split('/').filter(Boolean).pop() ?? projectPath} (unavailable)`,
      }));
    return [...projects, ...missing];
  }, [projects, skill.projects]);

  const filteredOptions = useMemo(() => {
    const query = searchQuery.trim().toLocaleLowerCase();
    if (!query) {
      return options;
    }
    return options.filter((option) => (
      option.displayName.toLocaleLowerCase().includes(query)
      || option.fullPath.toLocaleLowerCase().includes(query)
    ));
  }, [options, searchQuery]);

  const isDirty = useMemo(() => {
    if (selectedScope !== skill.scope) {
      return true;
    }
    if (selectedScope !== 'projects') {
      return false;
    }
    if (checkedPaths.length !== skill.projects.length) {
      return true;
    }
    return checkedPaths.some((projectPath) => !skill.projects.includes(projectPath));
  }, [selectedScope, checkedPaths, skill.scope, skill.projects]);

  const applyScope = async (scope: GlobalSkillScope, projectPaths: string[]) => {
    setIsApplying(true);
    setScopeError(null);
    try {
      await onApplyScope(scope, projectPaths);
    } catch (error) {
      setScopeError(error instanceof Error ? error.message : 'Failed to update skill scope');
    } finally {
      setIsApplying(false);
    }
  };

  const handleScopeChange = (scope: GlobalSkillScope) => {
    setSelectedScope(scope);
    if (scope === 'all' && skill.scope !== 'all') {
      void applyScope('all', []);
    }
  };

  const handleProjectToggle = (projectPath: string, checked: boolean) => {
    setCheckedPaths((current) => (
      checked
        ? [...new Set([...current, projectPath])]
        : current.filter((item) => item !== projectPath)
    ));
  };

  return (
    <div className="mt-4 space-y-2 border-t border-border/60 pt-3">
      <span className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">Applies to</span>
      <div className="flex flex-col gap-1.5">
        <label className="flex cursor-pointer items-center gap-2 text-sm text-foreground">
          <input
            type="radio"
            name={`skill-scope-${skill.directoryName}`}
            checked={selectedScope === 'all'}
            onChange={() => handleScopeChange('all')}
            disabled={isApplying}
          />
          All projects
        </label>
        <label className="flex cursor-pointer items-center gap-2 text-sm text-foreground">
          <input
            type="radio"
            name={`skill-scope-${skill.directoryName}`}
            checked={selectedScope === 'projects'}
            onChange={() => handleScopeChange('projects')}
            disabled={isApplying}
          />
          Selected projects
        </label>
      </div>

      {selectedScope === 'projects' && (
        <div className="space-y-2 rounded-md border border-border/70 bg-muted/10 p-2">
          {projectsLoading ? (
            <div className="flex items-center gap-2 px-1 py-1.5 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Loading projects…
            </div>
          ) : options.length === 0 ? (
            <p className="px-1 py-1.5 text-xs text-muted-foreground">No projects found.</p>
          ) : (
            <>
              <div className="relative">
                <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                  placeholder="Search projects…"
                  className="h-8 pl-8 text-xs"
                />
              </div>
              <div className="max-h-40 overflow-y-auto rounded-md border border-border bg-background p-1">
                {filteredOptions.length === 0 ? (
                  <p className="px-2 py-1.5 text-xs text-muted-foreground">No matches.</p>
                ) : (
                  filteredOptions.map((option) => (
                    <label
                      key={option.fullPath}
                      className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-accent"
                    >
                      <input
                        type="checkbox"
                        className="shrink-0"
                        checked={checkedPaths.includes(option.fullPath)}
                        onChange={(event) => handleProjectToggle(option.fullPath, event.target.checked)}
                        disabled={isApplying}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate">{option.displayName}</span>
                        <span className="block truncate text-[10px] text-muted-foreground">{option.fullPath}</span>
                      </span>
                    </label>
                  ))
                )}
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className="text-[11px] text-muted-foreground">
                  {checkedPaths.length === 0
                    ? 'Pick at least one project'
                    : `${checkedPaths.length} selected`}
                </span>
                <Button
                  type="button"
                  size="sm"
                  className="h-7 px-2.5 text-xs"
                  disabled={isApplying || checkedPaths.length === 0 || !isDirty}
                  onClick={() => void applyScope('projects', checkedPaths)}
                >
                  {isApplying && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                  Apply
                </Button>
              </div>
            </>
          )}
        </div>
      )}

      {skill.scope === 'projects' && selectedScope === 'projects' && !isDirty && (
        <p className="text-[11px] text-muted-foreground">
          Installed in {skill.projects.length} project{skill.projects.length === 1 ? '' : 's'}.
        </p>
      )}

      {scopeError && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-800/60 dark:bg-red-900/20 dark:text-red-200">
          {scopeError}
        </div>
      )}
    </div>
  );
}
