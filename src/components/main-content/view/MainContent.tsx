import React, { lazy, Suspense, useCallback, useEffect, useState } from 'react';

import ChatInterface from '../../chat/view/ChatInterface';
import type { MainContentProps } from '../types/types';
import { useTaskMaster } from '../../../contexts/TaskMasterContext';
import { usePaletteOpsRegister } from '../../../contexts/PaletteOpsContext';
import { useTasksSettings } from '../../../contexts/TasksSettingsContext';
import { useUiPreferences } from '../../../hooks/useUiPreferences';
import { useFileOpenResolver } from '../../../hooks/useFileOpenResolver';
import { authenticatedFetch } from '../../../utils/api';
import { useEditorSidebar } from '../../code-editor/hooks/useEditorSidebar';
import type { Project } from '../../../types/app';

import ErrorBoundary from './ErrorBoundary';
import MainContentHeader from './subcomponents/MainContentHeader';
import MainContentStateView from './subcomponents/MainContentStateView';
import MobileMenuButton from './subcomponents/MobileMenuButton';

const StudioView = lazy(() => import('../../studio/view/StudioView'));
const FileTree = lazy(() => import('../../file-tree/view/FileTree'));
const StandaloneShell = lazy(() => import('../../standalone-shell/view/StandaloneShell'));
const GitPanel = lazy(() => import('../../git-panel/view/GitPanel'));
const OperationsView = lazy(() => import('../../operations/view/OperationsView'));
const PluginTabContent = lazy(() => import('../../plugins/view/PluginTabContent'));
const EditorSidebar = lazy(() => import('../../code-editor/view/EditorSidebar'));
const TaskMasterPanel = lazy(() =>
  import('../../task-master').then((module) => ({ default: module.TaskMasterPanel })),
);
const BrowserUsePanel = lazy(() =>
  import('../../browser-use').then((module) => ({ default: module.BrowserUsePanel })),
);

type TaskMasterContextValue = {
  currentProject?: Project | null;
  setCurrentProject?: ((project: Project) => void) | null;
};

type TasksSettingsContextValue = {
  tasksEnabled: boolean;
  isTaskMasterInstalled: boolean | null;
  isTaskMasterReady: boolean | null;
};

function MainContent({
  selectedProject,
  selectedSession,
  activeTab,
  setActiveTab,
  ws,
  sendMessage,
  isMobile,
  onMenuClick,
  isLoading,
  onInputFocusChange,
  onSessionProcessing,
  onSessionIdle,
  processingSessions,
  onNavigateToSession,
  onSessionEstablished,
  onShowSettings,
  externalMessageUpdate,
  newSessionTrigger,
  onSessionSelect,
  onArchiveSession,
  onDeleteSession,
  onNewSession,
  onLoadMoreSessions,
  isLoadingMoreSessions = false,
  projects = [],
  studioActive = false,
  onLeaveStudio,
}: MainContentProps) {
  const { preferences } = useUiPreferences();
  const { showRawParameters, showThinking, sendByCtrlEnter } = preferences;

  const { currentProject, setCurrentProject } = useTaskMaster() as TaskMasterContextValue;
  const { tasksEnabled, isTaskMasterInstalled } = useTasksSettings() as TasksSettingsContextValue;
  const [browserUseEnabled, setBrowserUseEnabled] = useState(false);
  // Lazy keep-alive: mount shell on first visit, then CSS-hide instead of unmount
  // so xterm is not disposed on tab switch (blank flash). Avoids connecting a PTY
  // for users who never open the shell tab.
  const [shellEverOpened, setShellEverOpened] = useState(false);

  const shouldShowTasksTab = Boolean(tasksEnabled && isTaskMasterInstalled);
  const shouldShowBrowserTab = browserUseEnabled;
  const selectedSessionActivity = selectedSession?.id
    ? processingSessions.get(selectedSession.id)
    : undefined;
  const selectedSessionIsProcessing = Boolean(
    selectedSessionActivity && selectedSessionActivity.source !== 'shell',
  );

  useEffect(() => {
    if (activeTab === 'shell') {
      setShellEverOpened(true);
    }
  }, [activeTab]);

  // Reset keep-alive when project changes so a new project does not reuse a
  // stale terminal instance keyed to the previous project path.
  useEffect(() => {
    setShellEverOpened(false);
  }, [selectedProject?.projectId]);

  const {
    editingFile,
    editorWidth,
    editorExpanded,
    hasManualWidth,
    resizeHandleRef,
    handleFileOpen,
    handleCloseEditor,
    handleToggleEditorExpand,
    handleResizeStart,
  } = useEditorSidebar({
    selectedProject,
    isMobile,
  });

  // Resolves bare/partial file references (e.g. links inside chat messages) to
  // real project files before opening them in the in-app editor.
  const resolvedFileOpen = useFileOpenResolver(selectedProject, handleFileOpen);

  useEffect(() => {
    // Identify projects by DB `projectId`; the TaskMaster context uses the
    // same identifier to key its internal maps.
    const selectedProjectId = selectedProject?.projectId;
    const currentProjectId = currentProject?.projectId;

    if (selectedProject && selectedProjectId !== currentProjectId) {
      setCurrentProject?.(selectedProject);
    }
  }, [selectedProject, currentProject?.projectId, setCurrentProject]);

  useEffect(() => {
    if (!shouldShowTasksTab && activeTab === 'tasks') {
      setActiveTab('chat');
    }
  }, [shouldShowTasksTab, activeTab, setActiveTab]);

  const loadBrowserUseSettings = useCallback(async () => {
    try {
      const response = await authenticatedFetch('/api/browser-use/settings');
      const data = await response.json();
      setBrowserUseEnabled(Boolean(response.ok && data?.success !== false && data?.data?.settings?.enabled));
    } catch {
      setBrowserUseEnabled(false);
    }
  }, []);

  useEffect(() => {
    void loadBrowserUseSettings();
    window.addEventListener('browserUseSettingsChanged', loadBrowserUseSettings);
    return () => window.removeEventListener('browserUseSettingsChanged', loadBrowserUseSettings);
  }, [loadBrowserUseSettings]);

  useEffect(() => {
    if (!shouldShowBrowserTab && activeTab === 'browser') {
      setActiveTab('chat');
    }
  }, [shouldShowBrowserTab, activeTab, setActiveTab]);

  usePaletteOpsRegister({
    openFile: (filePath: string) => {
      setActiveTab('files');
      handleFileOpen(filePath);
    },
    // Opens the editor side panel in place, keeping the current tab (e.g. chat).
    openFileInEditor: (filePath: string) => {
      resolvedFileOpen(filePath);
    },
  });

  if (isLoading) {
    return <MainContentStateView mode="loading" isMobile={isMobile} onMenuClick={onMenuClick} />;
  }

  if (studioActive) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        {/* Keep the normal chat session alive while Studio owns the visible
            surface. Its websocket subscription and processing state must not
            disappear just because this route changes the main view. */}
        {selectedProject ? (
          <div className="hidden" aria-hidden="true">
            <ErrorBoundary showDetails>
              <ChatInterface
                selectedProject={selectedProject}
                selectedSession={selectedSession}
                ws={ws}
                sendMessage={sendMessage}
                onFileOpen={handleFileOpen}
                onInputFocusChange={onInputFocusChange}
                onSessionProcessing={onSessionProcessing}
                onSessionIdle={onSessionIdle}
                processingSessions={processingSessions}
                onNavigateToSession={onNavigateToSession}
                onSessionEstablished={onSessionEstablished}
                onShowSettings={onShowSettings}
                showRawParameters={showRawParameters}
                showThinking={showThinking}
                sendByCtrlEnter={sendByCtrlEnter}
                externalMessageUpdate={externalMessageUpdate}
                newSessionTrigger={newSessionTrigger}
                onShowAllTasks={tasksEnabled ? () => setActiveTab('tasks') : null}
              />
            </ErrorBoundary>
          </div>
        ) : null}
        {isMobile ? (
          <div className="pwa-header-safe flex-shrink-0 border-b border-border/50 bg-background/80 p-2 backdrop-blur-sm sm:p-3">
            <MobileMenuButton onMenuClick={onMenuClick} compact />
          </div>
        ) : null}
        <div className="min-h-0 flex-1 overflow-hidden">
          <ErrorBoundary showDetails>
            <Suspense fallback={null}>
            <StudioView
              selectedProject={selectedProject}
              projects={projects.length > 0 ? projects : selectedProject ? [selectedProject] : []}
              ws={ws}
              sendMessage={sendMessage}
              onInputFocusChange={onInputFocusChange}
              onSessionProcessing={onSessionProcessing}
              onSessionIdle={onSessionIdle}
              processingSessions={processingSessions}
              onNavigateToSession={onNavigateToSession}
              onSessionEstablished={onSessionEstablished}
              onShowSettings={onShowSettings}
              externalMessageUpdate={externalMessageUpdate}
              newSessionTrigger={newSessionTrigger}
              isVisible={studioActive}
              onIdeateInChat={({ project, prompt, title }) => {
                sessionStorage.setItem(
                  `cloudcli:pending-prompt:new:${project.projectId}`,
                  JSON.stringify({
                    prompt,
                    summary: title,
                    provider: localStorage.getItem('selected-provider') || 'claude',
                  }),
                );
                onNewSession(project);
              }}
              onBackToChat={onLeaveStudio}
            />
            </Suspense>
          </ErrorBoundary>
        </div>
      </div>
    );
  }

  if (!selectedProject) {
    return <MainContentStateView mode="empty" isMobile={isMobile} onMenuClick={onMenuClick} />;
  }

  return (
    <div className="flex h-full flex-col">
      <MainContentHeader
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        selectedProject={selectedProject}
        selectedSession={selectedSession}
        shouldShowTasksTab={shouldShowTasksTab}
        shouldShowBrowserTab={shouldShowBrowserTab}
        isMobile={isMobile}
        onMenuClick={onMenuClick}
        onSessionSelect={onSessionSelect}
        onArchiveSession={onArchiveSession}
        onDeleteSession={onDeleteSession}
        onNewSession={onNewSession}
        onLoadMoreSessions={onLoadMoreSessions}
        isLoadingMoreSessions={isLoadingMoreSessions}
        processingSessions={processingSessions}
      />

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <div className={`flex min-h-0 min-w-[200px] flex-col overflow-hidden ${editorExpanded ? 'hidden' : ''} flex-1`}>
          <div className={`h-full ${activeTab === 'chat' ? 'block' : 'hidden'}`}>
            <ErrorBoundary showDetails>
              <ChatInterface
                selectedProject={selectedProject}
                selectedSession={selectedSession}
                ws={ws}
                sendMessage={sendMessage}
                onFileOpen={handleFileOpen}
                onInputFocusChange={onInputFocusChange}
                onSessionProcessing={onSessionProcessing}
                onSessionIdle={onSessionIdle}
                processingSessions={processingSessions}
                onNavigateToSession={onNavigateToSession}
                onSessionEstablished={onSessionEstablished}
                onShowSettings={onShowSettings}
                showRawParameters={showRawParameters}
                showThinking={showThinking}
                sendByCtrlEnter={sendByCtrlEnter}
                externalMessageUpdate={externalMessageUpdate}
                newSessionTrigger={newSessionTrigger}
                onShowAllTasks={tasksEnabled ? () => setActiveTab('tasks') : null}
              />
            </ErrorBoundary>
          </div>

          {/* Keep shell mounted after first open (CSS hide) so xterm is not disposed on tab switch.
              Mount when active OR already opened (effect latches shellEverOpened for subsequent hides). */}
          {(shellEverOpened || activeTab === 'shell') && (
            <div className={`h-full w-full overflow-hidden ${activeTab === 'shell' ? 'block' : 'hidden'}`}>
              <Suspense fallback={null}>
              <StandaloneShell
                project={selectedProject}
                session={selectedSession}
                showHeader={false}
                isActive={activeTab === 'shell'}
                autoConnect={!selectedSessionIsProcessing}
                waitForChat={selectedSessionIsProcessing}
              />
              </Suspense>
            </div>
          )}

          {activeTab === 'files' && (
            <div className="h-full overflow-hidden">
              <Suspense fallback={null}>
              <FileTree selectedProject={selectedProject} onFileOpen={handleFileOpen} />
              </Suspense>
            </div>
          )}

          {activeTab === 'git' && (
            <div className="h-full overflow-hidden">
              <Suspense fallback={null}>
              <GitPanel selectedProject={selectedProject} isMobile={isMobile} onFileOpen={handleFileOpen} />
              </Suspense>
            </div>
          )}

          {activeTab === 'operations' && (
            <div className="h-full overflow-hidden">
              <Suspense fallback={null}>
              <OperationsView selectedProject={selectedProject} />
              </Suspense>
            </div>
          )}

          {shouldShowTasksTab && (
            <Suspense fallback={null}>
              <TaskMasterPanel isVisible={activeTab === 'tasks'} />
            </Suspense>
          )}

          {shouldShowBrowserTab && activeTab === 'browser' && (
            <div className="h-full overflow-hidden">
              <Suspense fallback={null}>
              <BrowserUsePanel isVisible={activeTab === 'browser'} onShowSettings={onShowSettings} />
              </Suspense>
            </div>
          )}

          {activeTab.startsWith('plugin:') && (
            <div className="h-full overflow-hidden">
              <Suspense fallback={null}>
              <PluginTabContent
                pluginName={activeTab.replace('plugin:', '')}
                selectedProject={selectedProject}
                selectedSession={selectedSession}
              />
              </Suspense>
            </div>
          )}
        </div>

        <Suspense fallback={null}>
        <EditorSidebar
          editingFile={editingFile}
          isMobile={isMobile}
          editorExpanded={editorExpanded}
          editorWidth={editorWidth}
          hasManualWidth={hasManualWidth}
          resizeHandleRef={resizeHandleRef}
          onResizeStart={handleResizeStart}
          onCloseEditor={handleCloseEditor}
          onToggleEditorExpand={handleToggleEditorExpand}
          projectPath={selectedProject.path}
          fillSpace={activeTab === 'files'}
        />
        </Suspense>
      </div>
    </div>
  );
}

export default React.memo(MainContent);
