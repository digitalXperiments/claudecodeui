import { ChevronLeft, ChevronRight, Plus } from 'lucide-react';
import type { TFunction } from 'i18next';

import { Button, ScrollArea, Tooltip } from '../../../../shared/view/ui';
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
  /** When true, render a slim strip that can expand the panel again. */
  isCollapsed?: boolean;
  onToggleCollapse: () => void;
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
  isCollapsed = false,
  onToggleCollapse,
  t,
}: SidebarSessionsPanelProps) {
  if (!project) {
    return null;
  }

  const title = project.displayName;

  if (isCollapsed) {
    return (
      <div className="flex h-full w-10 flex-col items-center border-r border-border/50 bg-background/60 py-2">
        <Tooltip content={t('tooltips.expandSessionsPanel', { defaultValue: 'Expand sessions' })} position="right">
          <button
            type="button"
            onClick={onToggleCollapse}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent/80 hover:text-foreground"
            aria-label={t('tooltips.expandSessionsPanel', { defaultValue: 'Expand sessions' })}
            aria-expanded={false}
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </Tooltip>
        <button
          type="button"
          onClick={onToggleCollapse}
          className="mt-3 flex min-h-0 flex-1 items-start justify-center px-1"
          aria-label={title}
          title={title}
        >
          <span
            className="select-none text-[11px] font-semibold uppercase tracking-wider text-muted-foreground"
            style={{ writingMode: 'vertical-rl', transform: 'rotate(180deg)' }}
          >
            {title}
          </span>
        </button>
      </div>
    );
  }

  return (
    <div className="flex h-full w-64 flex-col border-r border-border/50 bg-background/60 md:w-72">
      <div className="flex flex-shrink-0 border-b border-border/40 px-2 pb-2 pt-2.5 md:px-2.5">
        <button
          type="button"
          onClick={onToggleCollapse}
          className="group flex min-w-0 flex-1 items-start gap-1.5 rounded-lg px-1.5 py-1.5 text-left transition-colors hover:bg-accent/70"
          title={t('tooltips.collapseSessionsPanel', { defaultValue: 'Collapse sessions' })}
          aria-label={t('tooltips.collapseSessionsPanel', { defaultValue: 'Collapse sessions' })}
          aria-expanded={true}
        >
          <ChevronLeft className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-muted-foreground transition-transform group-hover:-translate-x-0.5" />
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
        </button>
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
          showNewSessionButton={false}
          indent={false}
          t={t}
        />
      </ScrollArea>
    </div>
  );
}
