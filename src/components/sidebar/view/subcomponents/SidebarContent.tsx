import { useState, type ReactNode } from 'react';
import { Activity, Archive, Folder, History, MessageSquare, RotateCcw, Search, Trash2 } from 'lucide-react';
import type { TFunction } from 'i18next';

import { cn } from '../../../../lib/utils';
import type { Project } from '../../../../types/app';
import type { ReleaseInfo } from '../../../../types/sharedTypes';
import type { ConversationSearchResults, SearchProgress } from '../../hooks/useSidebarController';
import type { ArchivedProjectListItem, ArchivedSessionListItem, RecentSessionListItem, SidebarSearchMode } from '../../types/types';
import SessionProviderLogo from '../../../llm-logo-provider/SessionProviderLogo';
import {
  getAllSessions,
  getSessionName,
  getSessionTime,
  readProjectsPanelCollapsed,
  writeProjectsPanelCollapsed,
} from '../../utils/utils';

import SidebarProjectList, { type SidebarProjectListProps } from './SidebarProjectList';
import SidebarRail from './SidebarRail';
import SidebarProjectsPanel from './SidebarProjectsPanel';
import SidebarLayout from './SidebarLayout';

function HighlightedSnippet({ snippet, highlights }: { snippet: string; highlights: { start: number; end: number }[] }) {
  const parts: ReactNode[] = [];
  let cursor = 0;
  for (const h of highlights) {
    if (h.start > cursor) {
      parts.push(snippet.slice(cursor, h.start));
    }
    parts.push(
      <mark key={h.start} className="rounded-sm bg-yellow-200 px-0.5 text-foreground dark:bg-yellow-800">
        {snippet.slice(h.start, h.end)}
      </mark>
    );
    cursor = h.end;
  }
  if (cursor < snippet.length) {
    parts.push(snippet.slice(cursor));
  }
  return (
    <span className="min-w-0 flex-1 break-words text-xs leading-relaxed text-muted-foreground">
      {parts}
    </span>
  );
}

type ArchivedSessionGroup = {
  key: string;
  projectId: string | null;
  projectDisplayName: string;
  projectPath: string | null;
  isProjectArchived: boolean;
  sessions: ArchivedSessionListItem[];
  latestActivity: string | null;
};

function groupArchivedSessionsByProject(sessions: ArchivedSessionListItem[]): ArchivedSessionGroup[] {
  const groups = new Map<string, ArchivedSessionGroup>();

  for (const session of sessions) {
    const key = session.projectId ?? session.projectPath ?? `session:${session.sessionId}`;
    const existingGroup = groups.get(key);

    if (existingGroup) {
      existingGroup.sessions.push(session);
      if (!existingGroup.latestActivity || (session.lastActivity && session.lastActivity > existingGroup.latestActivity)) {
        existingGroup.latestActivity = session.lastActivity;
      }
      continue;
    }

    groups.set(key, {
      key,
      projectId: session.projectId,
      projectDisplayName: session.projectDisplayName,
      projectPath: session.projectPath,
      isProjectArchived: session.isProjectArchived,
      sessions: [session],
      latestActivity: session.lastActivity,
    });
  }

  return [...groups.values()].sort((groupA, groupB) => {
    const a = groupA.latestActivity ?? '';
    const b = groupB.latestActivity ?? '';
    return b.localeCompare(a);
  });
}

function formatCompactArchivedAge(dateString: string | null): string {
  if (!dateString) {
    return '';
  }

  const date = new Date(dateString);
  if (Number.isNaN(date.getTime())) {
    return '';
  }

  const diffInMinutes = Math.floor(Math.max(0, Date.now() - date.getTime()) / (1000 * 60));
  if (diffInMinutes < 1) {
    return '<1m';
  }
  if (diffInMinutes < 60) {
    return `${diffInMinutes}m`;
  }

  const diffInHours = Math.floor(diffInMinutes / 60);
  if (diffInHours < 24) {
    return `${diffInHours}hr`;
  }

  return `${Math.floor(diffInHours / 24)}d`;
}

type SidebarContentProps = {
  isPWA: boolean;
  isMobile: boolean;
  isCollapsed: boolean;
  isLoading: boolean;
  projects: Project[];
  runningSessionsCount: number;
  archivedProjects: ArchivedProjectListItem[];
  archivedSessions: ArchivedSessionListItem[];
  archivedSessionsCount: number;
  isArchivedSessionsLoading: boolean;
  searchFilter: string;
  onSearchFilterChange: (value: string) => void;
  onClearSearchFilter: () => void;
  searchMode: SidebarSearchMode;
  onSearchModeChange: (mode: SidebarSearchMode) => void;
  recentSessions: RecentSessionListItem[];
  onRecentSessionClick: (item: RecentSessionListItem) => void;
  conversationResults: ConversationSearchResults | null;
  isSearching: boolean;
  searchProgress: SearchProgress | null;
  onRestoreArchivedProject: (projectId: string) => void;
  onArchivedSessionClick: (session: ArchivedSessionListItem) => void;
  onRestoreArchivedSession: (sessionId: string) => void;
  onDeleteArchivedSession: (session: ArchivedSessionListItem) => void;
  onConversationResultClick: (
    projectId: string | null,
    sessionId: string,
    provider: string,
    messageTimestamp?: string | null,
    messageSnippet?: string | null,
  ) => void;
  onRefresh: () => void;
  isRefreshing: boolean;
  onCreateProject: () => void;
  onCreateCategory: () => void;
  onCollapseSidebar: () => void;
  onExpandSidebar: () => void;
  updateAvailable: boolean;
  restartRequired: boolean;
  releaseInfo: ReleaseInfo | null;
  latestVersion: string | null;
  currentVersion: string;
  onShowVersionModal: () => void;
  onShowSettings: () => void;
  onShowNeedsYou?: () => void;
  needsYouCount?: number;
  onShowMissionControl?: () => void;
  missionControlPendingCount?: number;
  onShowKanban?: () => void;
  onShowAgentSwarm?: () => void;
  onShowStudio?: () => void;
  studioActive?: boolean;
  onShowStats?: () => void;
  projectListProps: SidebarProjectListProps;
  /** User-resizable desktop width for the Projects column. */
  projectsPanelWidth?: number;
  t: TFunction;
};

export default function SidebarContent({
  isPWA: _isPWA,
  isMobile,
  isCollapsed,
  isLoading,
  projects,
  runningSessionsCount,
  archivedProjects,
  archivedSessions,
  archivedSessionsCount,
  isArchivedSessionsLoading,
  searchFilter,
  onSearchFilterChange,
  onClearSearchFilter,
  searchMode,
  onSearchModeChange,
  recentSessions,
  onRecentSessionClick,
  conversationResults,
  isSearching,
  searchProgress,
  onRestoreArchivedProject,
  onArchivedSessionClick,
  onRestoreArchivedSession,
  onDeleteArchivedSession,
  onConversationResultClick,
  onRefresh,
  isRefreshing,
  onCreateProject,
  onCreateCategory,
  onCollapseSidebar,
  onExpandSidebar,
  updateAvailable,
  restartRequired,
  releaseInfo: _releaseInfo,
  latestVersion: _latestVersion,
  currentVersion: _currentVersion,
  onShowVersionModal,
  onShowSettings,
  onShowNeedsYou,
  needsYouCount = 0,
  onShowMissionControl,
  missionControlPendingCount = 0,
  onShowKanban,
  onShowAgentSwarm,
  onShowStudio,
  studioActive = false,
  onShowStats,
  projectListProps,
  projectsPanelWidth,
  t,
}: SidebarContentProps) {
  const [isProjectsPanelCollapsed, setIsProjectsPanelCollapsed] = useState(
    () => readProjectsPanelCollapsed(),
  );
  const showConversationSearch = searchMode === 'conversations' && searchFilter.trim().length >= 2;
  const hasPartialResults = conversationResults && conversationResults.results.length > 0;
  const groupedArchivedSessions = groupArchivedSessionsByProject(archivedSessions);

  const setProjectsPanelCollapsed = (collapsed: boolean) => {
    setIsProjectsPanelCollapsed(collapsed);
    writeProjectsPanelCollapsed(collapsed);
  };

  const handleSearchModeChange = (mode: SidebarSearchMode) => {
    // Rail navigation always reveals the projects column so mode switches stay useful.
    if (isProjectsPanelCollapsed) {
      setProjectsPanelCollapsed(false);
    }
    onSearchModeChange(mode);
  };

  const renderProjectsBody = () => {
    if (showConversationSearch) {
      if (isSearching && !hasPartialResults) {
        return (
          <div className="px-4 py-12 text-center md:py-8">
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-lg bg-muted md:mb-3">
              <div className="h-6 w-6 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent" />
            </div>
            <p className="text-sm text-muted-foreground">{t('search.searching')}</p>
            {searchProgress && (
              <p className="mt-1 text-xs text-muted-foreground/60">
                {t('search.projectsScanned', { count: searchProgress.scannedProjects })}/{searchProgress.totalProjects}
              </p>
            )}
          </div>
        );
      }

      if (!isSearching && conversationResults && conversationResults.results.length === 0) {
        return (
          <div className="px-4 py-12 text-center md:py-8">
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-lg bg-muted md:mb-3">
              <Search className="h-6 w-6 text-muted-foreground" />
            </div>
            <h3 className="mb-2 text-base font-medium text-foreground md:mb-1">{t('search.noResults')}</h3>
            <p className="text-sm text-muted-foreground">{t('search.tryDifferentQuery')}</p>
          </div>
        );
      }

      if (hasPartialResults) {
        return (
          <div className="space-y-3 px-2">
            <div className="flex items-center justify-between px-1">
              <p className="text-xs text-muted-foreground">
                {t('search.matches', { count: conversationResults.totalMatches })}
              </p>
              {isSearching && searchProgress && (
                <div className="flex items-center gap-1.5">
                  <div className="h-3 w-3 animate-spin rounded-full border-[1.5px] border-muted-foreground/40 border-t-primary" />
                  <p className="text-[10px] text-muted-foreground/60">
                    {searchProgress.scannedProjects}/{searchProgress.totalProjects}
                  </p>
                </div>
              )}
            </div>
            {isSearching && searchProgress && (
              <div className="mx-1 h-0.5 overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-primary/60 transition-all duration-300"
                  style={{ width: `${Math.round((searchProgress.scannedProjects / searchProgress.totalProjects) * 100)}%` }}
                />
              </div>
            )}
            {conversationResults.results.map((projectResult) => (
              <div key={projectResult.projectName} className="space-y-1">
                <div className="flex items-center gap-1.5 px-1 py-1">
                  <Folder className="h-3 w-3 flex-shrink-0 text-muted-foreground" />
                  <span className="truncate text-xs font-normal text-foreground">
                    {projectResult.projectDisplayName}
                  </span>
                </div>
                {projectResult.sessions.map((session) => (
                  <button
                    key={`${projectResult.projectId ?? projectResult.projectName}-${session.sessionId}`}
                    className="w-full rounded-md px-2 py-2 text-left transition-colors hover:bg-accent/50"
                    onClick={() =>
                      onConversationResultClick(
                        projectResult.projectId,
                        session.sessionId,
                        session.provider || session.matches[0]?.provider || 'claude',
                        session.matches[0]?.timestamp,
                        session.matches[0]?.snippet,
                      )
                    }
                  >
                    <div className="mb-1 flex items-center gap-1.5">
                      <MessageSquare className="h-3 w-3 flex-shrink-0 text-primary" />
                      <span className="truncate text-xs font-normal text-foreground">
                        {session.sessionSummary}
                      </span>
                      {session.provider && session.provider !== 'claude' && (
                        <span className="flex-shrink-0 rounded bg-muted px-1 py-0.5 text-[9px] uppercase text-muted-foreground">
                          {session.provider}
                        </span>
                      )}
                    </div>
                    <div className="space-y-1 pl-4">
                      {session.matches.map((match, idx) => (
                        <div key={idx} className="flex items-start gap-1">
                          <span className="mt-0.5 flex-shrink-0 text-[10px] font-normal uppercase text-muted-foreground/60">
                            {match.role === 'user' ? 'U' : 'A'}
                          </span>
                          <HighlightedSnippet snippet={match.snippet} highlights={match.highlights} />
                        </div>
                      ))}
                    </div>
                  </button>
                ))}
              </div>
            ))}
          </div>
        );
      }

      return null;
    }

    if (searchMode === 'running') {
      if (projectListProps.filteredProjects.length === 0) {
        return (
          <div className="px-4 py-12 text-center md:py-8">
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-lg border border-border/70 bg-muted/50 md:mb-3">
              <Activity className="h-6 w-6 text-muted-foreground" />
            </div>
            <h3 className="mb-2 text-base font-medium text-foreground md:mb-1">
              {t('running.emptyTitle', { defaultValue: 'No sessions running' })}
            </h3>
            <p className="text-sm text-muted-foreground">
              {runningSessionsCount > 0
                ? t('running.noMatchingSessions', { defaultValue: 'No running sessions match this search.' })
                : t('running.emptyDescription', { defaultValue: 'Active work will appear here while a provider is processing.' })}
            </p>
          </div>
        );
      }

      return (
        <div className="space-y-2">
          <div className="mx-2 flex items-center justify-between rounded-lg border border-border/60 bg-card/50 px-3 py-2 shadow-sm">
            <div className="flex min-w-0 items-center gap-2">
              <span className="flex h-6 w-6 items-center justify-center rounded-md bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
                <Activity className="h-3.5 w-3.5" />
              </span>
              <span className="truncate text-xs font-normal text-foreground">
                {t('running.title', { defaultValue: 'Running now' })}
              </span>
            </div>
            <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-[11px] font-normal text-emerald-700 dark:text-emerald-300">
              {runningSessionsCount}
            </span>
          </div>
          <SidebarProjectList {...projectListProps} showInlineSessions={false} />
        </div>
      );
    }

    if (searchMode === 'recent') {
      if (recentSessions.length === 0) {
        return (
          <div className="px-4 py-12 text-center md:py-8">
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-lg border border-border/70 bg-muted/50 md:mb-3">
              <History className="h-6 w-6 text-muted-foreground" />
            </div>
            <h3 className="mb-2 text-base font-medium text-foreground md:mb-1">
              {searchFilter.trim()
                ? t('recent.noMatchingSessions', { defaultValue: 'No matching conversations' })
                : t('recent.emptyTitle', { defaultValue: 'No conversations yet' })}
            </h3>
            <p className="text-sm text-muted-foreground">
              {searchFilter.trim()
                ? t('recent.tryDifferentSearch', { defaultValue: 'Try a different search term.' })
                : t('recent.emptyDescription', { defaultValue: 'Conversations from all projects appear here, most recent first.' })}
            </p>
          </div>
        );
      }

      return (
        <div className="space-y-1 px-2">
          {recentSessions.map((item) => {
            const { session, project } = item;
            const isSelected = projectListProps.selectedSession?.id === session.id;

            return (
              <button
                key={`${project.projectId}-${String(session.id)}`}
                className={cn(
                  'flex w-full items-center gap-2 rounded-md border px-2 py-2 text-left transition-colors',
                  isSelected
                    ? 'border-primary/20 bg-primary/5'
                    : 'border-transparent hover:bg-accent/50',
                )}
                onClick={() => onRecentSessionClick(item)}
              >
                <SessionProviderLogo provider={session.__provider} className="h-3.5 w-3.5 flex-shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-xs font-normal text-foreground">
                      {getSessionName(session, t)}
                    </span>
                    <span className="ml-auto flex-shrink-0 text-[11px] text-muted-foreground">
                      {formatCompactArchivedAge(getSessionTime(session) || null)}
                    </span>
                  </div>
                  <p className="mt-0.5 truncate text-[11px] text-muted-foreground/70" title={project.fullPath}>
                    {project.displayName}
                  </p>
                </div>
              </button>
            );
          })}
        </div>
      );
    }

    if (searchMode === 'archived') {
      if (isArchivedSessionsLoading) {
        return (
          <div className="px-4 py-12 text-center md:py-8">
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-lg bg-muted md:mb-3">
              <div className="h-6 w-6 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent" />
            </div>
            <h3 className="mb-2 text-base font-medium text-foreground md:mb-1">
              {t('archived.loadingTitle', { defaultValue: 'Loading archive...' })}
            </h3>
            <p className="text-sm text-muted-foreground">
              {t('archived.loadingDescription', { defaultValue: 'Fetching hidden workspaces and sessions you can restore later.' })}
            </p>
          </div>
        );
      }

      if (archivedProjects.length === 0 && groupedArchivedSessions.length === 0) {
        return (
          <div className="px-4 py-12 text-center md:py-8">
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-lg bg-muted md:mb-3">
              <Archive className="h-6 w-6 text-muted-foreground" />
            </div>
            <h3 className="mb-2 text-base font-medium text-foreground md:mb-1">
              {archivedSessionsCount > 0
                ? t('archived.noMatchingSessions', { defaultValue: 'No matching archived items' })
                : t('archived.emptyTitle', { defaultValue: 'No archived items' })}
            </h3>
            <p className="text-sm text-muted-foreground">
              {archivedSessionsCount > 0
                ? t('archived.tryDifferentSearch', { defaultValue: 'Try a different search term.' })
                : t('archived.emptyDescription', { defaultValue: 'Archived workspaces and sessions will appear here when you hide them from the active list.' })}
            </p>
          </div>
        );
      }

      return (
        <div className="space-y-3 px-2">
          <div className="flex items-center justify-between px-1">
            <p className="text-xs text-muted-foreground">
              {`${archivedSessionsCount} ${t(
                archivedSessionsCount === 1 ? 'archived.sessionCountOne' : 'archived.sessionCountOther',
                archivedSessionsCount === 1 ? 'archived item' : 'archived items',
              )}`}
            </p>
          </div>
          {archivedProjects.map((project) => {
            const projectSessions = getAllSessions(project);

            return (
              <div key={project.projectId} className="overflow-hidden rounded-xl border border-border/70 bg-card/60 shadow-sm">
                <div className="flex items-start justify-between gap-3 border-b border-border/60 px-3 py-2.5">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <Folder className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
                      <span className="truncate text-sm font-normal text-foreground">
                        {project.displayName}
                      </span>
                      <span className="inline-flex items-center justify-center rounded-full bg-muted px-1 py-px text-center text-[7px] font-medium uppercase leading-none tracking-[0.02em] text-muted-foreground">
                        {t('archived.projectArchived', { defaultValue: 'Project archived' })}
                      </span>
                    </div>
                    <p className="mt-1 truncate text-xs text-muted-foreground/70" title={project.fullPath}>
                      {project.fullPath}
                    </p>
                  </div>
                  <button
                    className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg bg-emerald-50 text-emerald-700 transition-colors hover:bg-emerald-100 dark:bg-emerald-900/20 dark:text-emerald-300 dark:hover:bg-emerald-900/30"
                    onClick={() => onRestoreArchivedProject(project.projectId)}
                    title={t('archived.restoreProject', { defaultValue: 'Restore workspace' })}
                  >
                    <RotateCcw className="h-3.5 w-3.5" />
                  </button>
                </div>
                {projectSessions.length > 0 && (
                  <div className="divide-y divide-border/50">
                    {projectSessions.map((session) => (
                      <button
                        key={String(session.id)}
                        className="flex w-full items-center gap-2 px-3 py-2.5 text-left transition-colors hover:bg-accent/40"
                        onClick={() =>
                          onArchivedSessionClick({
                            sessionId: String(session.id),
                            provider: session.__provider,
                            projectId: project.projectId,
                            projectPath: project.fullPath,
                            projectDisplayName: project.displayName,
                            sessionTitle:
                              typeof session.summary === 'string' && session.summary.trim().length > 0
                                ? session.summary
                                : typeof session.name === 'string' && session.name.trim().length > 0
                                  ? session.name
                                  : String(session.id),
                            createdAt: typeof session.created_at === 'string' ? session.created_at : null,
                            updatedAt: typeof session.updated_at === 'string' ? session.updated_at : null,
                            lastActivity:
                              typeof session.lastActivity === 'string'
                                ? session.lastActivity
                                : typeof session.updated_at === 'string'
                                  ? session.updated_at
                                  : typeof session.created_at === 'string'
                                    ? session.created_at
                                    : null,
                            isProjectArchived: true,
                          })
                        }
                      >
                        <SessionProviderLogo provider={session.__provider} className="h-3.5 w-3.5 flex-shrink-0" />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="truncate text-xs font-normal text-foreground">
                              {typeof session.summary === 'string' && session.summary.trim().length > 0
                                ? session.summary
                                : typeof session.name === 'string' && session.name.trim().length > 0
                                  ? session.name
                                  : String(session.id)}
                            </span>
                            <span className="ml-auto flex-shrink-0 text-[11px] text-muted-foreground">
                              {formatCompactArchivedAge(
                                typeof session.lastActivity === 'string'
                                  ? session.lastActivity
                                  : typeof session.updated_at === 'string'
                                    ? session.updated_at
                                    : typeof session.created_at === 'string'
                                      ? session.created_at
                                      : null,
                              )}
                            </span>
                          </div>
                          <p className="mt-0.5 text-[11px] uppercase tracking-wide text-muted-foreground/70">
                            {session.__provider}
                          </p>
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
          {groupedArchivedSessions.map((group) => (
            <div key={group.key} className="overflow-hidden rounded-xl border border-border/70 bg-card/60 shadow-sm">
              <div className="flex items-start justify-between gap-3 border-b border-border/60 px-3 py-2.5">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <Folder className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
                    <span className="truncate text-sm font-normal text-foreground">
                      {group.projectDisplayName}
                    </span>
                    {group.isProjectArchived && (
                      <span className="inline-flex items-center justify-center rounded-full bg-muted px-1 py-px text-center text-[7px] font-medium uppercase leading-none tracking-[0.02em] text-muted-foreground">
                        {t('archived.projectArchived', { defaultValue: 'Project archived' })}
                      </span>
                    )}
                  </div>
                  {group.projectPath && (
                    <p className="mt-1 truncate text-xs text-muted-foreground/70" title={group.projectPath}>
                      {group.projectPath}
                    </p>
                  )}
                </div>
                <span className="flex-shrink-0 text-[11px] text-muted-foreground">
                  {group.sessions.length}
                </span>
              </div>
              <div className="divide-y divide-border/50">
                {group.sessions.map((session) => (
                  <div key={session.sessionId} className="flex items-center gap-2 px-3 py-2.5">
                    <button
                      className="flex min-w-0 flex-1 items-center gap-2 text-left transition-colors hover:text-foreground"
                      onClick={() => onArchivedSessionClick(session)}
                    >
                      <SessionProviderLogo provider={session.provider} className="h-3.5 w-3.5 flex-shrink-0" />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-xs font-normal text-foreground">
                            {session.sessionTitle}
                          </span>
                          {session.lastActivity && (
                            <span className="ml-auto flex-shrink-0 text-[11px] text-muted-foreground">
                              {formatCompactArchivedAge(session.lastActivity)}
                            </span>
                          )}
                        </div>
                        <p className="mt-0.5 text-[11px] uppercase tracking-wide text-muted-foreground/70">
                          {session.provider}
                        </p>
                      </div>
                    </button>
                    <button
                      className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg bg-emerald-50 text-emerald-700 transition-colors hover:bg-emerald-100 dark:bg-emerald-900/20 dark:text-emerald-300 dark:hover:bg-emerald-900/30"
                      onClick={() => onRestoreArchivedSession(session.sessionId)}
                      title={t('archived.restore', { defaultValue: 'Restore session' })}
                    >
                      <RotateCcw className="h-3.5 w-3.5" />
                    </button>
                    <button
                      className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg bg-red-50 text-red-700 transition-colors hover:bg-red-100 dark:bg-red-900/20 dark:text-red-300 dark:hover:bg-red-900/30"
                      onClick={() => onDeleteArchivedSession(session)}
                      title={t('archived.deletePermanently', { defaultValue: 'Delete permanently' })}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      );
    }

    return <SidebarProjectList {...projectListProps} showInlineSessions={false} />;
  };

  const rail = (
    <SidebarRail
      searchMode={searchMode}
      onSearchModeChange={handleSearchModeChange}
      isCollapsed={isCollapsed}
      onToggleCollapse={() => {
        if (isCollapsed) {
          onExpandSidebar();
        } else {
          onCollapseSidebar();
        }
      }}
      runningSessionsCount={runningSessionsCount}
      onShowKanban={onShowKanban}
      onShowAgentSwarm={onShowAgentSwarm ?? (() => {})}
      onShowStudio={onShowStudio ?? (() => {})}
      studioActive={studioActive}
      onShowMissionControl={onShowMissionControl ?? (() => {})}
      missionControlPendingCount={missionControlPendingCount}
      onShowStats={onShowStats ?? (() => {})}
      onShowNeedsYou={onShowNeedsYou ?? (() => {})}
      needsYouCount={needsYouCount}
      onShowSettings={onShowSettings}
      updateAvailable={updateAvailable}
      restartRequired={restartRequired}
      onShowVersionModal={onShowVersionModal}
      t={t}
    />
  );

  // On mobile the projects/sessions swap already; collapse is desktop-only.
  const projectsPanelCollapsed = !isMobile && isProjectsPanelCollapsed;
  const selectedProjectName = projectListProps.selectedProject?.displayName ?? null;

  const projectsPanel = (
    <SidebarProjectsPanel
      searchMode={searchMode}
      searchFilter={searchFilter}
      onSearchFilterChange={onSearchFilterChange}
      onClearSearchFilter={onClearSearchFilter}
      onRefresh={onRefresh}
      isRefreshing={isRefreshing}
      onCreateProject={onCreateProject}
      onCreateCategory={onCreateCategory}
      isLoading={isLoading}
      projectsCount={projects.length}
      runningSessionsCount={runningSessionsCount}
      archivedSessionsCount={archivedSessionsCount}
      isArchivedSessionsLoading={isArchivedSessionsLoading}
      isCollapsed={projectsPanelCollapsed}
      onToggleCollapse={
        isMobile ? undefined : () => setProjectsPanelCollapsed(!isProjectsPanelCollapsed)
      }
      selectedProjectName={selectedProjectName}
      panelWidth={isMobile ? undefined : projectsPanelWidth}
      t={t}
    >
      {renderProjectsBody()}
    </SidebarProjectsPanel>
  );

  // Option C: sessions live in the main chat header, not a second sidebar column.
  return (
    <SidebarLayout
      isCollapsed={isCollapsed}
      isMobile={isMobile}
      mobileShowSessions={false}
      rail={rail}
      projectsPanel={projectsPanel}
      sessionsPanel={null}
    />
  );
}
