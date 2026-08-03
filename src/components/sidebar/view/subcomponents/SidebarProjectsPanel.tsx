import { ChevronLeft, ChevronRight, FolderPlus, Plus, RefreshCw, Search, X } from 'lucide-react';
import type { TFunction } from 'i18next';

import { Button, Input, ScrollArea, Tooltip } from '../../../../shared/view/ui';
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
  /** When true, render a slim strip that can expand the panel again. */
  isCollapsed?: boolean;
  onToggleCollapse?: () => void;
  /** Active project name shown on the collapsed strip under the panel title. */
  selectedProjectName?: string | null;
  /** User-resizable desktop width; when omitted, the legacy fixed width applies. */
  panelWidth?: number;
  children: React.ReactNode;
  t: TFunction;
};

const MOD_KEY =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl';

function panelTitle(searchMode: SidebarSearchMode, t: TFunction): string {
  switch (searchMode) {
    case 'running':
      return t('search.runningTooltip', { defaultValue: 'Running sessions' });
    case 'recent':
      return t('search.recentTooltip', { defaultValue: 'Recent conversations' });
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
    case 'recent':
      return t('search.recentPlaceholder', { defaultValue: 'Search recent conversations...' });
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
  isCollapsed = false,
  onToggleCollapse,
  selectedProjectName = null,
  panelWidth,
  children,
  t,
}: SidebarProjectsPanelProps) {
  const showSearch =
    (projectsCount > 0 || runningSessionsCount > 0 || archivedSessionsCount > 0 || isArchivedSessionsLoading) &&
    !isLoading;
  const title = panelTitle(searchMode, t);
  const stripLabel = selectedProjectName
    ? `${title} · ${selectedProjectName}`
    : title;

  if (isCollapsed) {
    return (
      <div className="flex h-full w-10 flex-col items-center border-r border-border/50 bg-card/40 py-2">
        <Tooltip content={t('tooltips.expandProjectsPanel', { defaultValue: 'Expand projects' })} position="right">
          <button
            type="button"
            onClick={onToggleCollapse}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent/80 hover:text-foreground"
            aria-label={t('tooltips.expandProjectsPanel', { defaultValue: 'Expand projects' })}
            aria-expanded={false}
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </Tooltip>
        <button
          type="button"
          onClick={onToggleCollapse}
          className="mt-3 flex min-h-0 flex-1 flex-col items-center gap-3 px-1"
          aria-label={stripLabel}
          title={stripLabel}
        >
          <span
            className="select-none text-[11px] font-semibold uppercase tracking-wider text-muted-foreground"
            style={{ writingMode: 'vertical-rl', transform: 'rotate(180deg)' }}
          >
            {title}
          </span>
          {selectedProjectName ? (
            <span
              className="max-h-[45%] select-none overflow-hidden text-ellipsis text-[11px] font-medium text-foreground/80"
              style={{ writingMode: 'vertical-rl', transform: 'rotate(180deg)' }}
            >
              {selectedProjectName}
            </span>
          ) : null}
        </button>
      </div>
    );
  }

  return (
    <div
      className={cn('flex h-full flex-col border-r border-border/50 bg-card/40', !panelWidth && 'w-64 md:w-72')}
      style={panelWidth ? { width: `${panelWidth}px`, flexShrink: 0 } : undefined}
    >
      <div className="flex flex-shrink-0 items-center justify-between gap-1 px-2 pb-2 pt-2.5 md:px-2.5">
        {onToggleCollapse ? (
          <button
            type="button"
            onClick={onToggleCollapse}
            className="group flex min-w-0 flex-1 items-center gap-1.5 rounded-lg px-1.5 py-1.5 text-left transition-colors hover:bg-accent/70"
            title={t('tooltips.collapseProjectsPanel', { defaultValue: 'Collapse projects' })}
            aria-label={t('tooltips.collapseProjectsPanel', { defaultValue: 'Collapse projects' })}
            aria-expanded={true}
          >
            <ChevronLeft className="hidden h-3.5 w-3.5 flex-shrink-0 text-muted-foreground transition-transform group-hover:-translate-x-0.5 md:block" />
            <h2 className="truncate text-sm font-semibold text-foreground">{title}</h2>
          </button>
        ) : (
          <h2 className="truncate px-1.5 text-sm font-semibold text-foreground">{title}</h2>
        )}
        <div className="flex flex-shrink-0 items-center gap-0.5">
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
