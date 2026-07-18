import { useEffect } from 'react';
import type { TFunction } from 'i18next';

import type { LoadingProgress, Project, ProjectCategory, ProjectSession, LLMProvider } from '../../../../types/app';
import type { SessionActivityMap } from '../../../../hooks/useSessionProtection';
import type { MCPServerStatus, ProjectCategoryGroup, SessionWithProvider } from '../../types/types';

import SidebarCategoryHeader from './SidebarCategoryHeader';
import SidebarProjectItem from './SidebarProjectItem';
import SidebarProjectsState from './SidebarProjectsState';

export type SidebarProjectListProps = {
  projects: Project[];
  filteredProjects: Project[];
  groupedProjects: ProjectCategoryGroup[];
  categories: ProjectCategory[];
  collapsedCategoryIds: Set<string>;
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
  isLoading: boolean;
  loadingProgress: LoadingProgress | null;
  expandedProjects: Set<string>;
  editingProject: string | null;
  editingName: string;
  initialSessionsLoaded: Set<string>;
  currentTime: Date;
  editingSession: string | null;
  editingSessionName: string;
  deletingProjects: Set<string>;
  tasksEnabled: boolean;
  mcpServerStatus: MCPServerStatus;
  getProjectSessions: (project: Project) => SessionWithProvider[];
  onLoadMoreSessions: (projectId: string) => void;
  loadingMoreProjects: Set<string>;
  activeSessions: SessionActivityMap;
  attentionSessionIds: ReadonlySet<string>;
  forceExpanded?: boolean;
  isProjectStarred: (projectName: string) => boolean;
  onEditingNameChange: (value: string) => void;
  onToggleProject: (projectName: string) => void;
  onProjectSelect: (project: Project) => void;
  onToggleStarProject: (projectName: string) => void;
  onStartEditingProject: (project: Project) => void;
  onCancelEditingProject: () => void;
  onSaveProjectName: (projectName: string) => void;
  onDeleteProject: (project: Project) => void;
  onMoveToCategory: (project: Project) => void;
  onToggleCategory: (categoryKey: string) => void;
  onEditCategory: (category: ProjectCategory) => void;
  onDeleteCategory: (category: ProjectCategory) => void;
  onDropProjectOnCategory: (projectId: string, categoryId: string | null) => void;
  onReorderCategory: (draggedCategoryId: string, targetCategoryId: string) => void;
  onSessionSelect: (session: SessionWithProvider, projectName: string) => void;
  onDeleteSession: (
    projectName: string,
    sessionId: string,
    sessionTitle: string,
    provider: LLMProvider,
  ) => void;
  onNewSession: (project: Project) => void;
  onEditingSessionNameChange: (value: string) => void;
  onStartEditingSession: (sessionId: string, initialName: string) => void;
  onCancelEditingSession: () => void;
  onSaveEditingSession: (projectName: string, sessionId: string, summary: string, provider: LLMProvider) => void;
  t: TFunction;
};

export default function SidebarProjectList({
  projects,
  filteredProjects,
  groupedProjects,
  categories,
  collapsedCategoryIds,
  selectedProject,
  selectedSession,
  isLoading,
  loadingProgress,
  expandedProjects,
  editingProject,
  editingName,
  initialSessionsLoaded,
  currentTime,
  editingSession,
  editingSessionName,
  deletingProjects,
  tasksEnabled,
  mcpServerStatus,
  getProjectSessions,
  onLoadMoreSessions,
  loadingMoreProjects,
  activeSessions,
  attentionSessionIds,
  forceExpanded = false,
  isProjectStarred,
  onEditingNameChange,
  onToggleProject,
  onProjectSelect,
  onToggleStarProject,
  onStartEditingProject,
  onCancelEditingProject,
  onSaveProjectName,
  onDeleteProject,
  onMoveToCategory,
  onToggleCategory,
  onEditCategory,
  onDeleteCategory,
  onDropProjectOnCategory,
  onReorderCategory,
  onSessionSelect,
  onDeleteSession,
  onNewSession,
  onEditingSessionNameChange,
  onStartEditingSession,
  onCancelEditingSession,
  onSaveEditingSession,
  t,
}: SidebarProjectListProps) {
  const state = (
    <SidebarProjectsState
      isLoading={isLoading}
      loadingProgress={loadingProgress}
      projectsCount={projects.length}
      filteredProjectsCount={filteredProjects.length}
      t={t}
    />
  );

  useEffect(() => {
    let baseTitle = 'CloudCLI UI';
    const displayName = selectedProject?.displayName?.trim();
    if (displayName) {
      baseTitle = `${displayName} - ${baseTitle}`;
    }
    document.title = baseTitle;
  }, [selectedProject]);

  const showProjects = !isLoading && projects.length > 0 && filteredProjects.length > 0;

  const renderProjectItem = (project: Project) => (
    // React key + per-project state lookups all use the DB `projectId`
    // so they remain stable across renames and session changes.
    <SidebarProjectItem
      key={project.projectId}
      project={project}
      selectedProject={selectedProject}
      selectedSession={selectedSession}
      isExpanded={forceExpanded || expandedProjects.has(project.projectId)}
      isDeleting={deletingProjects.has(project.projectId)}
      isStarred={isProjectStarred(project.projectId)}
      editingProject={editingProject}
      editingName={editingName}
      sessions={getProjectSessions(project)}
      initialSessionsLoaded={initialSessionsLoaded.has(project.projectId)}
      isLoadingMoreSessions={loadingMoreProjects.has(project.projectId)}
      currentTime={currentTime}
      editingSession={editingSession}
      editingSessionName={editingSessionName}
      tasksEnabled={tasksEnabled}
      mcpServerStatus={mcpServerStatus}
      onEditingNameChange={onEditingNameChange}
      onToggleProject={onToggleProject}
      onProjectSelect={onProjectSelect}
      onToggleStarProject={onToggleStarProject}
      onStartEditingProject={onStartEditingProject}
      onCancelEditingProject={onCancelEditingProject}
      onSaveProjectName={onSaveProjectName}
      onDeleteProject={onDeleteProject}
      onMoveToCategory={onMoveToCategory}
      onSessionSelect={onSessionSelect}
      onDeleteSession={onDeleteSession}
      onLoadMoreSessions={onLoadMoreSessions}
      activeSessions={activeSessions}
      attentionSessionIds={attentionSessionIds}
      onNewSession={onNewSession}
      onEditingSessionNameChange={onEditingSessionNameChange}
      onStartEditingSession={onStartEditingSession}
      onCancelEditingSession={onCancelEditingSession}
      onSaveEditingSession={onSaveEditingSession}
      t={t}
    />
  );

  // Without categories the sidebar renders the classic flat project list.
  if (categories.length === 0) {
    return (
      <div className="pb-safe-area-inset-bottom md:space-y-1">
        {!showProjects ? state : filteredProjects.map(renderProjectItem)}
      </div>
    );
  }

  return (
    <div className="pb-safe-area-inset-bottom md:space-y-1">
      {!showProjects
        ? state
        : groupedProjects.map((group) => {
            const categoryKey = group.category?.categoryId ?? 'uncategorized';
            const isCollapsed = collapsedCategoryIds.has(categoryKey);

            return (
              <div key={categoryKey} className="md:space-y-1">
                <SidebarCategoryHeader
                  category={group.category}
                  projectCount={group.projects.length}
                  isCollapsed={isCollapsed}
                  onToggle={onToggleCategory}
                  onEditCategory={onEditCategory}
                  onDeleteCategory={onDeleteCategory}
                  onDropProject={onDropProjectOnCategory}
                  onReorderCategory={onReorderCategory}
                  t={t}
                />
                {!isCollapsed && group.projects.map(renderProjectItem)}
              </div>
            );
          })}
    </div>
  );
}
