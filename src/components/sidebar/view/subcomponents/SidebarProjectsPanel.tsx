import { FolderPlus, Plus, RefreshCw, Search, X } from 'lucide-react';
import type { TFunction } from 'i18next';

import { Button, Input, ScrollArea } from '../../../../shared/view/ui';
import { cn } from '../../../../lib/utils';
import type { SidebarSearchMode } from '../../types/types';

type SidebarProjectsPanelProps = {
  searchMode: SidebarSearchMode;
  searchFilter: string;
  onSearchFilterChange: (value: string) => void;
  onClearSearchFilter: () => void;
  onRefresh: () => void;
  isRefreshing: boolean;
  onCreateProject: () => void;
  onCreateCategory: () => void;
  isLoading: boolean;
  projectsCount: number;
  runningSessionsCount: number;
  archivedSessionsCount: number;
  isArchivedSessionsLoading: boolean;
  children: React.ReactNode;
  t: TFunction;
};

const MOD_KEY =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl';

function panelTitle(searchMode: SidebarSearchMode, t: TFunction): string {
  switch (searchMode) {
    case 'running':
      return t('search.runningTooltip', { defaultValue: 'Running sessions' });
    case 'conversations':
      return t('search.conversationsPlaceholder');
    case 'archived':
      return t('search.archiveOnlyTooltip', { defaultValue: 'Archive only' });
    case 'projects':
    default:
      return t('search.modeProjects');
  }
}

function searchPlaceholder(searchMode: SidebarSearchMode, t: TFunction): string {
  switch (searchMode) {
    case 'conversations':
      return t('search.conversationsPlaceholder');
    case 'archived':
      return t('search.archivedPlaceholder', { defaultValue: 'Search archived sessions...' });
    case 'running':
      return t('search.runningPlaceholder', { defaultValue: 'Search running sessions...' });
    case 'projects':
    default:
      return t('projects.searchPlaceholder');
  }
}

export default function SidebarProjectsPanel({
  searchMode,
  searchFilter,
  onSearchFilterChange,
  onClearSearchFilter,
  onRefresh,
  isRefreshing,
  onCreateProject,
  onCreateCategory,
  isLoading,
  projectsCount,
  runningSessionsCount,
  archivedSessionsCount,
  isArchivedSessionsLoading,
  children,
  t,
}: SidebarProjectsPanelProps) {
  const showSearch =
    (projectsCount > 0 || runningSessionsCount > 0 || archivedSessionsCount > 0 || isArchivedSessionsLoading) &&
    !isLoading;

  return (
    <div className="flex h-full w-64 flex-col border-r border-border/50 bg-card/40 md:w-72">
      <div className="flex flex-shrink-0 items-center justify-between gap-2 px-3 pb-2 pt-3">
        <h2 className="text-sm font-semibold text-foreground">{panelTitle(searchMode, t)}</h2>
        <div className="flex items-center gap-0.5">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-7 rounded-lg p-0 text-muted-foreground hover:bg-accent/80 hover:text-foreground"
            onClick={onRefresh}
            disabled={isRefreshing}
            title={t('tooltips.refresh')}
          >
            <RefreshCw className={cn('h-3.5 w-3.5', isRefreshing && 'animate-spin')} />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-7 rounded-lg p-0 text-muted-foreground hover:bg-accent/80 hover:text-foreground"
            onClick={onCreateProject}
            title={t('tooltips.createProject')}
          >
            <Plus className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-7 rounded-lg p-0 text-muted-foreground hover:bg-accent/80 hover:text-foreground"
            onClick={onCreateCategory}
            title={t('tooltips.newCategory', { defaultValue: 'New category' })}
          >
            <FolderPlus className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {showSearch && (
        <div className="px-3 pb-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/50" />
            <Input
              type="text"
              placeholder={searchPlaceholder(searchMode, t)}
              value={searchFilter}
              onChange={(event) => onSearchFilterChange(event.target.value)}
              className="nav-search-input h-9 rounded-xl border-0 pl-9 pr-14 text-sm transition-all duration-200 placeholder:text-muted-foreground/40 focus-visible:ring-0 focus-visible:ring-offset-0"
            />
            {searchFilter ? (
              <button
                onClick={onClearSearchFilter}
                aria-label={t('tooltips.clearSearch')}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded-md p-0.5 hover:bg-accent"
              >
                <X className="h-3 w-3 text-muted-foreground" />
              </button>
            ) : (
              <kbd
                aria-hidden
                title={t('tooltips.openCommandPalette')}
                className="pointer-events-none absolute right-2.5 top-1/2 hidden -translate-y-1/2 items-center gap-0.5 rounded border border-border/60 bg-muted/40 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground md:inline-flex"
              >
                {MOD_KEY}
                <span>K</span>
              </kbd>
            )}
          </div>
        </div>
      )}

      <ScrollArea className="flex-1 overflow-y-auto overscroll-contain px-1.5 py-1">
        {children}
      </ScrollArea>
    </div>
  );
}
