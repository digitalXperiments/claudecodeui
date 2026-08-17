import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useDeviceSettings } from '../../../hooks/useDeviceSettings';
import { useVersionCheck } from '../../../hooks/useVersionCheck';
import { useUiPreferences } from '../../../hooks/useUiPreferences';
import { useAppFeatures } from '../../../hooks/useAppFeatures';
import { useSidebarController } from '../hooks/useSidebarController';
import { useTaskMaster } from '../../../contexts/TaskMasterContext';
import { usePaletteOps, usePaletteOpsRegister } from '../../../contexts/PaletteOpsContext';
import { useTasksSettings } from '../../../contexts/TasksSettingsContext';
import type { Project, ProjectCategory, LLMProvider } from '../../../types/app';
import type { MCPServerStatus, SidebarProps } from '../types/types';
import MissionControlPanel, { type WorkThisSessionRequest } from '../../mission-control/view/MissionControlPanel';
import { missionControlApi } from '../../mission-control/api/missionControlApi';
import KanbanPanel from '../../kanban/view/KanbanPanel';
import AgentSwarmPanel from '../../swarm/view/AgentSwarmPanel';
import StatsPanel from '../../stats/view/StatsPanel';

import SidebarContent from './subcomponents/SidebarContent';
import SidebarModals from './subcomponents/SidebarModals';
import NeedsYouPanel from './subcomponents/NeedsYouPanel';
import type { SidebarProjectListProps } from './subcomponents/SidebarProjectList';

type TaskMasterSidebarContext = {
  setCurrentProject: (project: Project) => void;
  mcpServerStatus: MCPServerStatus;
};

function Sidebar({
  projects,
  selectedProject,
  selectedSession,
  activeSessions,
  attentionSessionIds,
  onProjectSelect,
  onSessionSelect,
  onNewSession,
  onSessionDelete,
  onLoadMoreSessions,
  onProjectDelete,
  isLoading,
  loadingProgress,
  onRefresh,
  onShowSettings,
  showSettings,
  settingsInitialTab,
  onCloseSettings,
  isMobile,
  projectsPanelWidth,
  studioActive = false,
  onShowStudio,
}: SidebarProps) {
  const { t } = useTranslation(['sidebar', 'common']);
  const { isPWA } = useDeviceSettings({ trackMobile: false });
  const { updateAvailable, restartRequired, latestVersion, currentVersion, releaseInfo, installMode } = useVersionCheck(
    'siteboon',
    'claudecodeui',
  );
  const { preferences, setPreference } = useUiPreferences();
  const { features } = useAppFeatures();
  const { sidebarVisible } = preferences;
  const { setCurrentProject, mcpServerStatus } = useTaskMaster() as TaskMasterSidebarContext;
  const { tasksEnabled } = useTasksSettings();
  const paletteOps = usePaletteOps();
  const [showNeedsYou, setShowNeedsYou] = useState(false);
  const [needsYouCount, setNeedsYouCount] = useState(0);
  const [showMissionControl, setShowMissionControl] = useState(false);
  const [missionControlPendingCount, setMissionControlPendingCount] = useState(0);
  const [showKanban, setShowKanban] = useState(false);
  const [showAgentSwarm, setShowAgentSwarm] = useState(false);
  const [showStats, setShowStats] = useState(false);
  const handleMissionControlPendingChange = useCallback((count: number) => {
    setMissionControlPendingCount(count);
  }, []);

  // Keep Mission Control badge fresh even when the panel is closed.
  useEffect(() => {
    let cancelled = false;
    const load = () => {
      void missionControlApi
        .summary()
        .then((s) => {
          if (!cancelled) setMissionControlPendingCount(s.pendingCount);
        })
        .catch(() => {});
    };
    load();
    const id = window.setInterval(load, 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  const {
    isSidebarCollapsed,
    expandedProjects,
    editingProject,
    showNewProject,
    editingName,
    initialSessionsLoaded,
    currentTime,
    isRefreshing,
    editingSession,
    editingSessionName,
    searchFilter,
    searchMode,
    setSearchMode,
    conversationResults,
    isSearching,
    searchProgress,
    clearConversationResults,
    runningSessionsCount,
    recentSessions,
    deletingProjects,
    deleteConfirmation,
    sessionDeleteConfirmation,
    showVersionModal,
    filteredProjects,
    groupedProjects,
    categories,
    collapsedCategoryIds,
    categoryEditor,
    categoryDeleteConfirmation,
    moveToCategoryProject,
    archivedProjects,
    archivedSessions,
    archivedSessionsCount,
    isArchivedSessionsLoading,
    toggleProject,
    handleSessionClick,
    toggleStarProject,
    isProjectStarred,
    toggleCategoryCollapsed,
    assignProjectToCategory,
    saveCategory,
    requestDeleteCategory,
    confirmDeleteCategory,
    reorderCategoriesByDrag,
    setCategoryEditor,
    setCategoryDeleteConfirmation,
    setMoveToCategoryProject,
    getProjectSessions,
    loadingMoreProjects,
    loadMoreSessionsForProject,
    startEditing,
    cancelEditing,
    saveProjectName,
    showDeleteSessionConfirmation,
    confirmDeleteSession,
    requestProjectDelete,
    confirmDeleteProject,
    handleProjectSelect,
    openArchivedSession,
    restoreArchivedProject,
    restoreArchivedSession,
    refreshProjects,
    updateSessionSummary,
    collapseSidebar: handleCollapseSidebar,
    expandSidebar: handleExpandSidebar,
    setShowNewProject,
    setEditingName,
    setEditingSession,
    setEditingSessionName,
    setSearchFilter,
    setDeleteConfirmation,
    setSessionDeleteConfirmation,
    setShowVersionModal,
  } = useSidebarController({
    projects,
    selectedProject,
    selectedSession,
    activeSessions,
    isLoading,
    isMobile,
    t,
    onRefresh,
    onProjectSelect,
    onSessionSelect,
    onSessionDelete,
    onLoadMoreSessions,
    onProjectDelete,
    setCurrentProject,
    setSidebarVisible: (visible) => setPreference('sidebarVisible', visible),
    sidebarVisible,
  });

  useEffect(() => {
    if (typeof document === 'undefined') {
      return;
    }

    document.documentElement.classList.toggle('pwa-mode', isPWA);
    document.body.classList.toggle('pwa-mode', isPWA);
  }, [isPWA]);

  const handleProjectCreated = () => {
    void paletteOps.refreshProjects();
  };

  usePaletteOpsRegister({
    openNeedsYou: () => setShowNeedsYou(true),
    openMissionControl: () => setShowMissionControl(true),
    openKanban: features.kanbanEnabled ? () => setShowKanban(true) : undefined,
    openAgentSwarm: () => setShowAgentSwarm(true),
    openStudio: () => onShowStudio?.(),
    openStats: () => setShowStats(true),
    openNewProject: () => setShowNewProject(true),
    setSidebarSearchMode: (mode) => {
      setSearchMode(mode);
      if (mode === 'projects') clearConversationResults();
    },
    selectProject: onProjectSelect,
    toggleSidebarCollapsed: () => {
      if (isSidebarCollapsed) {
        handleExpandSidebar();
      } else {
        handleCollapseSidebar();
      }
    },
  });

  const projectListProps: SidebarProjectListProps = {
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
    loadingMoreProjects,
    activeSessions,
    attentionSessionIds,
    forceExpanded: searchMode === 'running',
    isProjectStarred,
    onEditingNameChange: setEditingName,
    onToggleProject: toggleProject,
    onProjectSelect: handleProjectSelect,
    onToggleStarProject: toggleStarProject,
    onStartEditingProject: startEditing,
    onCancelEditingProject: cancelEditing,
    onSaveProjectName: (projectName) => {
      void saveProjectName(projectName);
    },
    onDeleteProject: requestProjectDelete,
    onMoveToCategory: (project: Project) => setMoveToCategoryProject(project),
    onToggleCategory: toggleCategoryCollapsed,
    onEditCategory: (category: ProjectCategory) =>
      setCategoryEditor({ mode: 'edit', category }),
    onDeleteCategory: requestDeleteCategory,
    onDropProjectOnCategory: assignProjectToCategory,
    onReorderCategory: reorderCategoriesByDrag,
    onSessionSelect: handleSessionClick,
    onDeleteSession: showDeleteSessionConfirmation,
    onLoadMoreSessions: loadMoreSessionsForProject,
    onNewSession,
    onEditingSessionNameChange: setEditingSessionName,
    onStartEditingSession: (sessionId, initialName) => {
      setEditingSession(sessionId);
      setEditingSessionName(initialName);
    },
    onCancelEditingSession: () => {
      setEditingSession(null);
      setEditingSessionName('');
    },
    onSaveEditingSession: (projectName: string, sessionId: string, summary: string, provider: LLMProvider) => {
      void updateSessionSummary(projectName, sessionId, summary, provider);
    },
    t,
  };

  return (
    <>
        <SidebarModals
          projects={projects}
        showSettings={showSettings}
        settingsInitialTab={settingsInitialTab}
        onCloseSettings={onCloseSettings}
        showNewProject={showNewProject}
        onCloseNewProject={() => setShowNewProject(false)}
        onProjectCreated={handleProjectCreated}
        deleteConfirmation={deleteConfirmation}
        onCancelDeleteProject={() => setDeleteConfirmation(null)}
        onConfirmDeleteProject={confirmDeleteProject}
        sessionDeleteConfirmation={sessionDeleteConfirmation}
        onCancelDeleteSession={() => setSessionDeleteConfirmation(null)}
        onConfirmDeleteSession={confirmDeleteSession}
        categories={categories}
        categoryEditor={categoryEditor}
        onCloseCategoryEditor={() => setCategoryEditor(null)}
        onSaveCategory={saveCategory}
        categoryDeleteConfirmation={categoryDeleteConfirmation}
        onCancelDeleteCategory={() => setCategoryDeleteConfirmation(null)}
        onConfirmDeleteCategory={confirmDeleteCategory}
        moveToCategoryProject={moveToCategoryProject}
        onCloseMoveToCategory={() => setMoveToCategoryProject(null)}
        onAssignProjectToCategory={assignProjectToCategory}
        onCreateCategoryFromMove={() => setCategoryEditor({ mode: 'create' })}
        showVersionModal={showVersionModal}
        onCloseVersionModal={() => setShowVersionModal(false)}
        releaseInfo={releaseInfo}
        currentVersion={currentVersion}
        latestVersion={latestVersion}
        installMode={installMode}
        t={t}
      />

      <SidebarContent
        isPWA={isPWA}
        isMobile={isMobile}
        isCollapsed={isSidebarCollapsed}
        isLoading={isLoading}
        projects={projects}
        runningSessionsCount={runningSessionsCount}
        archivedProjects={archivedProjects}
        archivedSessions={archivedSessions}
        archivedSessionsCount={archivedSessionsCount}
        isArchivedSessionsLoading={isArchivedSessionsLoading}
        searchFilter={searchFilter}
        onSearchFilterChange={setSearchFilter}
        onClearSearchFilter={() => setSearchFilter('')}
        searchMode={searchMode}
        onSearchModeChange={(mode) => {
          setSearchMode(mode);
          if (mode === 'projects') clearConversationResults();
        }}
        recentSessions={recentSessions}
        onRecentSessionClick={({ project, session }) => {
          // Selecting a conversation also selects its owning project so the
          // chat view has full project context (mirrors session rows).
          handleProjectSelect(project);
          handleSessionClick(session, project.projectId);
        }}
        conversationResults={conversationResults}
        isSearching={isSearching}
        searchProgress={searchProgress}
        onRestoreArchivedProject={restoreArchivedProject}
        onArchivedSessionClick={openArchivedSession}
        onRestoreArchivedSession={restoreArchivedSession}
        onDeleteArchivedSession={(session) => {
          showDeleteSessionConfirmation(
            session.projectId,
            session.sessionId,
            session.sessionTitle,
            session.provider,
            { isArchived: true },
          );
        }}
        onConversationResultClick={(projectId: string | null, sessionId: string, provider: string, messageTimestamp?: string | null, messageSnippet?: string | null) => {
          // `projectId` (DB key) is the canonical identifier post-migration.
          // The server emits null when it can't resolve a project row for
          // the search hit; treat that as "no project" and still navigate
          // to the session so the user can open it from the URL.
          const resolvedProvider = (provider || 'claude') as LLMProvider;
          const project = projectId ? projects.find(p => p.projectId === projectId) : null;
          const searchTarget = { __searchTargetTimestamp: messageTimestamp || null, __searchTargetSnippet: messageSnippet || null };
          const sessionObj = {
            id: sessionId,
            __provider: resolvedProvider,
            __projectId: projectId ?? undefined,
            ...searchTarget,
          };
          if (project) {
            handleProjectSelect(project);
            const sessions = getProjectSessions(project);
            const existing = sessions.find(s => s.id === sessionId);
            if (existing) {
              handleSessionClick({ ...existing, ...searchTarget }, project.projectId);
            } else {
              handleSessionClick(sessionObj, project.projectId);
            }
          } else {
            handleSessionClick(sessionObj, projectId ?? '');
          }
        }}
        onRefresh={() => {
          void refreshProjects();
        }}
        isRefreshing={isRefreshing}
        onCreateProject={() => setShowNewProject(true)}
        onCreateCategory={() => setCategoryEditor({ mode: 'create' })}
        onCollapseSidebar={handleCollapseSidebar}
        onExpandSidebar={handleExpandSidebar}
        updateAvailable={updateAvailable}
        restartRequired={restartRequired}
        releaseInfo={releaseInfo}
        latestVersion={latestVersion}
        currentVersion={currentVersion}
        onShowVersionModal={() => setShowVersionModal(true)}
        onShowSettings={onShowSettings}
        onShowNeedsYou={() => setShowNeedsYou(true)}
        needsYouCount={needsYouCount}
        onShowMissionControl={() => setShowMissionControl(true)}
        missionControlPendingCount={missionControlPendingCount}
        onShowKanban={features.kanbanEnabled ? () => setShowKanban(true) : undefined}
        onShowAgentSwarm={() => setShowAgentSwarm(true)}
        onShowStudio={() => onShowStudio?.()}
        studioActive={studioActive}
        onShowStats={() => setShowStats(true)}
        projectListProps={projectListProps}
        projectsPanelWidth={projectsPanelWidth}
        t={t}
      />

      <NeedsYouPanel
        open={showNeedsYou}
        onClose={() => setShowNeedsYou(false)}
        onCountChange={setNeedsYouCount}
      />

      <MissionControlPanel
        isOpen={showMissionControl}
        onClose={() => setShowMissionControl(false)}
        projects={projects}
        onPendingCountChange={handleMissionControlPendingChange}
        onWorkThis={(request: WorkThisSessionRequest) => {
          sessionStorage.setItem(
            `cloudcli:pending-prompt:${request.sessionId}`,
            JSON.stringify({
              prompt: request.prompt,
              provider: request.provider,
              summary: request.title,
            }),
          );
          const project = projects.find((entry) => entry.projectId === request.projectId);
          if (project) {
            onProjectSelect(project);
          }
          onSessionSelect({
            id: request.sessionId,
            title: request.title,
            summary: request.title,
            __provider: request.provider as LLMProvider,
            __projectId: request.projectId,
          });
        }}
      />

      {features.kanbanEnabled ? (
        <KanbanPanel
          isOpen={showKanban}
          onClose={() => setShowKanban(false)}
          selectedProject={selectedProject}
          projects={projects}
        />
      ) : null}

      <AgentSwarmPanel
        isOpen={showAgentSwarm}
        onClose={() => setShowAgentSwarm(false)}
        selectedProject={selectedProject}
        projects={projects}
      />

      <StatsPanel
        isOpen={showStats}
        onClose={() => setShowStats(false)}
      />

    </>
  );
}

export default Sidebar;
