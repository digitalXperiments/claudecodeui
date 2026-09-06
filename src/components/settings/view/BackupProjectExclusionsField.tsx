import { useMemo, useState } from 'react';
import { Loader2, Search } from 'lucide-react';

import type { BackupProjectOption } from '../hooks/useBackupProjectOptions';

type CombinedOption = BackupProjectOption & { unavailable: boolean };

type BackupProjectExclusionsFieldProps = {
  excludedPaths: string[];
  options: BackupProjectOption[];
  optionsLoading: boolean;
  optionsError: string | null;
  onChange: (excludedPaths: string[]) => void;
};

/**
 * Searchable checkbox multi-select for picking which registered projects'
 * agent conversations should be excluded from the backup. There is no
 * free-text entry — every row comes from the real project list — and a path
 * that was excluded before but no longer resolves to a live project is kept
 * (not silently dropped) and shown as unavailable so a save doesn't erase it.
 */
export default function BackupProjectExclusionsField({
  excludedPaths,
  options,
  optionsLoading,
  optionsError,
  onChange,
}: BackupProjectExclusionsFieldProps) {
  const [searchQuery, setSearchQuery] = useState('');

  const combinedOptions = useMemo<CombinedOption[]>(() => {
    const knownPaths = new Set(options.map((option) => option.fullPath));
    const unavailableEntries: CombinedOption[] = excludedPaths
      .filter((fullPath) => !knownPaths.has(fullPath))
      .map((fullPath) => ({ fullPath, displayName: fullPath, unavailable: true }));
    return [...options.map((option) => ({ ...option, unavailable: false })), ...unavailableEntries];
  }, [options, excludedPaths]);

  const filteredOptions = useMemo(() => {
    const query = searchQuery.trim().toLocaleLowerCase();
    if (!query) return combinedOptions;
    return combinedOptions.filter((option) => (
      option.displayName.toLocaleLowerCase().includes(query)
      || option.fullPath.toLocaleLowerCase().includes(query)
    ));
  }, [combinedOptions, searchQuery]);

  const toggle = (fullPath: string, checked: boolean) => {
    onChange(checked
      ? [...new Set([...excludedPaths, fullPath])]
      : excludedPaths.filter((item) => item !== fullPath));
  };

  return (
    <div className="space-y-2">
      <div>
        <span className="text-sm font-medium">Exclude projects</span>
        <p className="mt-0.5 text-sm text-muted-foreground">
          Agent conversations for excluded projects are left out of the backup. Leave everything unchecked to include all projects.
        </p>
      </div>

      <div className="space-y-2 rounded-md border border-border/70 bg-muted/10 p-2">
        {optionsLoading ? (
          <div className="flex items-center gap-2 px-1 py-1.5 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Loading projects…
          </div>
        ) : optionsError ? (
          <p className="px-1 py-1.5 text-xs text-destructive">{optionsError}</p>
        ) : combinedOptions.length === 0 ? (
          <p className="px-1 py-1.5 text-xs text-muted-foreground">No projects found.</p>
        ) : (
          <>
            <div className="relative">
              <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <input
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                placeholder="Search projects…"
                className="h-8 w-full rounded-md border border-border bg-background pl-8 pr-2 text-xs"
              />
            </div>
            <div className="max-h-48 overflow-y-auto rounded-md border border-border bg-background p-1">
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
                      checked={excludedPaths.includes(option.fullPath)}
                      onChange={(event) => toggle(option.fullPath, event.target.checked)}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">
                        {option.displayName}
                        {option.unavailable && <span className="ml-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">(unavailable)</span>}
                      </span>
                      <span className="block truncate text-[10px] text-muted-foreground">{option.fullPath}</span>
                    </span>
                  </label>
                ))
              )}
            </div>
            <p className="text-[11px] text-muted-foreground">
              {excludedPaths.length === 0 ? 'All projects included' : `${excludedPaths.length} excluded`}
            </p>
          </>
        )}
      </div>
    </div>
  );
}
