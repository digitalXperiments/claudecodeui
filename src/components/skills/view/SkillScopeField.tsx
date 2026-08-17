import { useMemo, useState } from 'react';
import { Loader2, Search } from 'lucide-react';

import { Input } from '../../../shared/view/ui';
import type { GlobalSkillScope, SkillProjectOption } from '../types';

type SkillScopeFieldProps = {
  scope: GlobalSkillScope;
  projects: string[];
  options: SkillProjectOption[];
  optionsLoading: boolean;
  onChange: (scope: GlobalSkillScope, projects: string[]) => void;
  /** Hide the "All projects" radio — used when copying into a selected set only. */
  hideAllProjects?: boolean;
};

/**
 * Controlled form field for picking a global skill's scope: every project or a
 * selected set of projects. Intended for create/upload dialogs.
 */
export default function SkillScopeField({
  scope,
  projects,
  options,
  optionsLoading,
  onChange,
  hideAllProjects = false,
}: SkillScopeFieldProps) {
  const [searchQuery, setSearchQuery] = useState('');

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

  const handleScopeChange = (nextScope: GlobalSkillScope) => {
    onChange(nextScope, nextScope === 'projects' ? projects : []);
  };

  const handleProjectToggle = (projectPath: string, checked: boolean) => {
    onChange(
      scope,
      checked
        ? [...new Set([...projects, projectPath])]
        : projects.filter((item) => item !== projectPath),
    );
  };

  return (
    <div className="space-y-2">
      <span className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">Applies to</span>
      {!hideAllProjects && (
        <div className="flex flex-col gap-1.5">
          <label className="flex cursor-pointer items-center gap-2 text-sm text-foreground">
            <input
              type="radio"
              name="skill-scope-field"
              checked={scope === 'all'}
              onChange={() => handleScopeChange('all')}
            />
            All projects
          </label>
          <label className="flex cursor-pointer items-center gap-2 text-sm text-foreground">
            <input
              type="radio"
              name="skill-scope-field"
              checked={scope === 'projects'}
              onChange={() => handleScopeChange('projects')}
            />
            Selected projects
          </label>
        </div>
      )}

      {(hideAllProjects || scope === 'projects') && (
        <div className="space-y-2 rounded-md border border-border/70 bg-muted/10 p-2">
          {optionsLoading ? (
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
                        checked={projects.includes(option.fullPath)}
                        onChange={(event) => handleProjectToggle(option.fullPath, event.target.checked)}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate">{option.displayName}</span>
                        <span className="block truncate text-[10px] text-muted-foreground">{option.fullPath}</span>
                      </span>
                    </label>
                  ))
                )}
              </div>
              <p className="text-[11px] text-muted-foreground">
                {projects.length === 0 ? 'Pick at least one project' : `${projects.length} selected`}
              </p>
            </>
          )}
        </div>
      )}
    </div>
  );
}
