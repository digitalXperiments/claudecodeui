import { Plus, X } from 'lucide-react';
import type { TFunction } from 'i18next';

import { Button, ScrollArea } from '../../../../shared/view/ui';
import { cn } from '../../../../lib/utils';
import type { Project, ProjectSession, LLMProvider } from '../../../../types/app';
import type { SessionActivityMap } from '../../../../hooks/useSessionProtection';
import type { SessionWithProvider } from '../../types/types';

import SidebarProjectSessions from './SidebarProjectSessions';

type SidebarSessionsPanelProps = {
  project: Project | null;
  selectedSession: ProjectSession | null;
  sessions: SessionWithProvider[];
  initialSessionsLoaded: boolean;
  hasMoreSessions: boolean;
  isLoadingMoreSessions: boolean;
  activeSessions: SessionActivityMap;
  attentionSessionIds: ReadonlySet<string>;
  currentTime: Date;
  editingSession: string | null;
  editingSessionName: string;
  onEditingSessionNameChange: (value: string) => void;
  onStartEditingSession: (sessionId: string, initialName: string) => void;
  onCancelEditingSession: () => void;
  onSaveEditingSession: (projectName: string, sessionId: string, summary: string, provider: LLMProvider) => void;
  onProjectSelect: (project: Project) => void;
  onSessionSelect: (session: SessionWithProvider, projectName: string) => void;
  onDeleteSession: (
    projectName: string,
    sessionId: string,
    sessionTitle: string,
    provider: LLMProvider,
  ) => void;
  onLoadMoreSessions: (projectId: string) => void;
  onNewSession: (project: Project) => void;
  onClose: () => void;
  t: TFunction;
};

export default function SidebarSessionsPanel({
  project,
  selectedSession,
  sessions,
  initialSessionsLoaded,
  hasMoreSessions,
  isLoadingMoreSessions,
  activeSessions,
  attentionSessionIds,
  currentTime,
  editingSession,
  editingSessionName,
  onEditingSessionNameChange,
  onStartEditingSession,
  onCancelEditingSession,
  onSaveEditingSession,
  onProjectSelect,
  onSessionSelect,
  onDeleteSession,
  onLoadMoreSessions,
  onNewSession,
  onClose,
  t,
}: SidebarSessionsPanelProps) {
  if (!project) {
    return null;
  }

  return (
    <div className="flex h-full w-64 flex-col border-r border-border/50 bg-background/60 md:w-72">
      <div className="flex flex-shrink-0 items-start justify-between gap-2 border-b border-border/40 px-3 pb-2 pt-3">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-semibold text-foreground" title={project.displayName}>
            {project.displayName}
          </h2>
          {project.fullPath !== project.displayName && (
            <p className="truncate text-[11px] text-muted-foreground" title={project.fullPath}>
              {project.fullPath.length > 35 ? `...${project.fullPath.slice(-32)}` : project.fullPath}
            </p>
          )}
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 w-7 flex-shrink-0 rounded-lg p-0 text-muted-foreground hover:bg-accent/80 hover:text-foreground"
          onClick={onClose}
          title={t('cancel', { defaultValue: 'Close' })}
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>

      <div className="px-3 py-2">
        <Button
          variant="default"
          size="sm"
          className="h-8 w-full justify-center gap-2 bg-primary text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          onClick={() => onNewSession(project)}
        >
          <Plus className="h-3.5 w-3.5" />
          {t('sessions.newSession')}
        </Button>
      </div>

      <ScrollArea className={cn('flex-1 overflow-y-auto overscroll-contain px-2 py-1', !initialSessionsLoaded && 'px-3')}>
        <SidebarProjectSessions
          project={project}
          isExpanded
          sessions={sessions}
          selectedSession={selectedSession}
          initialSessionsLoaded={initialSessionsLoaded}
          hasMoreSessions={hasMoreSessions}
          isLoadingMoreSessions={isLoadingMoreSessions}
          activeSessions={activeSessions}
          attentionSessionIds={attentionSessionIds}
          currentTime={currentTime}
          editingSession={editingSession}
          editingSessionName={editingSessionName}
          onEditingSessionNameChange={onEditingSessionNameChange}
          onStartEditingSession={onStartEditingSession}
          onCancelEditingSession={onCancelEditingSession}
          onSaveEditingSession={onSaveEditingSession}
          onProjectSelect={onProjectSelect}
          onSessionSelect={onSessionSelect}
          onDeleteSession={onDeleteSession}
          onLoadMoreSessions={onLoadMoreSessions}
          onNewSession={onNewSession}
          t={t}
        />
      </ScrollArea>
    </div>
  );
}
