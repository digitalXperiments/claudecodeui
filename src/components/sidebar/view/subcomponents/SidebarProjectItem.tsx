import { useEffect, useId, useRef, useState } from 'react';
import {
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Edit3,
  FolderInput,
  MoreHorizontal,
  Star,
  Trash2,
  X,
} from 'lucide-react';
import type { TFunction } from 'i18next';

import { cn } from '../../../../lib/utils';
import type { Project, ProjectSession, LLMProvider } from '../../../../types/app';
import type { SessionActivityMap } from '../../../../hooks/useSessionProtection';
import type { MCPServerStatus, SessionWithProvider } from '../../types/types';
import { PROJECT_DRAG_MIME } from '../../utils/utils';

import SidebarProjectSessions from './SidebarProjectSessions';

type SidebarProjectItemProps = {
  project: Project;
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
  isExpanded: boolean;
  isDeleting: boolean;
  isStarred: boolean;
  editingProject: string | null;
  editingName: string;
  sessions: SessionWithProvider[];
  initialSessionsLoaded: boolean;
  isLoadingMoreSessions: boolean;
  currentTime: Date;
  editingSession: string | null;
  editingSessionName: string;
  tasksEnabled: boolean;
  mcpServerStatus: MCPServerStatus;
  onEditingNameChange: (name: string) => void;
  onToggleProject: (projectName: string) => void;
  onProjectSelect: (project: Project) => void;
  onToggleStarProject: (projectName: string) => void;
  onStartEditingProject: (project: Project) => void;
  onCancelEditingProject: () => void;
  onSaveProjectName: (projectName: string) => void;
  onDeleteProject: (project: Project) => void;
  onMoveToCategory: (project: Project) => void;
  onSessionSelect: (session: SessionWithProvider, projectName: string) => void;
  onDeleteSession: (
    projectName: string,
    sessionId: string,
    sessionTitle: string,
    provider: LLMProvider,
  ) => void;
  onLoadMoreSessions: (projectId: string) => void;
  activeSessions: SessionActivityMap;
  attentionSessionIds: ReadonlySet<string>;
  onNewSession: (project: Project) => void;
  onEditingSessionNameChange: (value: string) => void;
  onStartEditingSession: (sessionId: string, initialName: string) => void;
  onCancelEditingSession: () => void;
  onSaveEditingSession: (projectName: string, sessionId: string, summary: string, provider: LLMProvider) => void;
  showInlineSessions?: boolean;
  t: TFunction;
};

type ProjectOverflowMenuProps = {
  project: Project;
  t: TFunction;
  onRename: () => void;
  onMove: () => void;
  onDelete: () => void;
};

function ProjectOverflowMenu({ project, t, onRename, onMove, onDelete }: ProjectOverflowMenuProps) {
  const [open, setOpen] = useState(false);
  const [pathCopied, setPathCopied] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) {
      return undefined;
    }

    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
        setPathCopied(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        setPathCopied(false);
      }
    };

    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const copyPath = async () => {
    if (!project.fullPath) {
      return;
    }
    try {
      await navigator.clipboard.writeText(project.fullPath);
      setPathCopied(true);
      window.setTimeout(() => setPathCopied(false), 1500);
    } catch {
      // Fallback: leave the path visible in the menu description.
    }
  };

  const run = (action: () => void) => {
    setOpen(false);
    setPathCopied(false);
    action();
  };

  // Short fixed labels — avoid long tooltip i18n strings that read like hotkeys.
  const items: Array<{
    key: string;
    label: string;
    description?: string;
    icon: typeof Edit3;
    onSelect: () => void;
    isDanger?: boolean;
    showDividerBefore?: boolean;
  }> = [
    {
      key: 'rename',
      label: t('projects.menuRename', { defaultValue: 'Rename' }),
      icon: Edit3,
      onSelect: () => run(onRename),
    },
    {
      key: 'move',
      label: t('projects.menuMove', { defaultValue: 'Move' }),
      icon: FolderInput,
      onSelect: () => run(onMove),
    },
  ];

  if (project.fullPath) {
    items.push({
      key: 'path',
      label: pathCopied
        ? t('projects.menuPathCopied', { defaultValue: 'Copied' })
        : t('projects.menuPath', { defaultValue: 'Path' }),
      description: project.fullPath,
      icon: pathCopied ? Check : Copy,
      showDividerBefore: true,
      onSelect: () => {
        void copyPath();
      },
    });
  }

  items.push({
    key: 'delete',
    label: t('projects.menuDelete', { defaultValue: 'Delete' }),
    icon: Trash2,
    isDanger: true,
    showDividerBefore: true,
    onSelect: () => run(onDelete),
  });

  return (
    <div ref={rootRef} className="relative flex-shrink-0">
      <button
        type="button"
        className={cn(
          'flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors',
          'hover:bg-accent hover:text-foreground',
          'opacity-100 md:opacity-0 md:group-hover:opacity-100 md:focus-visible:opacity-100',
          open && 'bg-accent text-foreground opacity-100',
        )}
        aria-label={t('tooltips.projectActions', { defaultValue: 'Project actions' })}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={(event) => {
          event.stopPropagation();
          setOpen((value) => !value);
          setPathCopied(false);
        }}
      >
        <MoreHorizontal className="h-4 w-4" />
      </button>

      {open ? (
        <div
          id={menuId}
          role="menu"
          className="absolute right-0 top-[calc(100%+4px)] z-50 min-w-[9.5rem] max-w-[min(16rem,calc(100vw-2rem))] rounded-lg border border-border bg-popover p-0.5 text-popover-foreground shadow-lg"
          onClick={(event) => event.stopPropagation()}
        >
          {items.map((item) => {
            const Icon = item.key === 'path' && pathCopied ? Check : item.icon;
            return (
              <div key={item.key}>
                {item.showDividerBefore ? <div className="mx-1.5 my-0.5 h-px bg-border" /> : null}
                <button
                  type="button"
                  role="menuitem"
                  className={cn(
                    'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] leading-none transition-colors',
                    item.isDanger
                      ? 'text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/40'
                      : 'text-foreground hover:bg-accent',
                  )}
                  onClick={() => item.onSelect()}
                >
                  <Icon className="h-3.5 w-3.5 flex-shrink-0 opacity-80" />
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium tracking-tight">{item.label}</span>
                    {item.description ? (
                      <span className="mt-1 block break-all font-mono text-[10px] leading-snug text-muted-foreground">
                        {item.description}
                      </span>
                    ) : null}
                  </span>
                </button>
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

export default function SidebarProjectItem({
  project,
  selectedProject,
  selectedSession,
  isExpanded,
  isDeleting,
  isStarred,
  editingProject,
  editingName,
  sessions,
  initialSessionsLoaded,
  isLoadingMoreSessions,
  currentTime,
  editingSession,
  editingSessionName,
  tasksEnabled,
  mcpServerStatus,
  onEditingNameChange,
  onToggleProject,
  onProjectSelect,
  onToggleStarProject,
  onStartEditingProject,
  onCancelEditingProject,
  onSaveProjectName,
  onDeleteProject,
  onMoveToCategory,
  onSessionSelect,
  onDeleteSession,
  onLoadMoreSessions,
  activeSessions,
  attentionSessionIds,
  onNewSession,
  onEditingSessionNameChange,
  onStartEditingSession,
  onCancelEditingSession,
  onSaveEditingSession,
  showInlineSessions = true,
  t,
}: SidebarProjectItemProps) {
  const isSelected = selectedProject?.projectId === project.projectId;
  const isEditing = editingProject === project.projectId;
  const sessionCount = Number(project.sessionMeta?.total ?? sessions.length);

  const toggleProject = () => onToggleProject(project.projectId);
  const toggleStarProject = () => onToggleStarProject(project.projectId);

  const handleProjectDragStart = (event: React.DragEvent<HTMLElement>) => {
    if (isEditing) {
      event.preventDefault();
      return;
    }
    event.dataTransfer.setData(PROJECT_DRAG_MIME, project.projectId);
    event.dataTransfer.effectAllowed = 'move';
  };

  const saveProjectName = () => {
    onSaveProjectName(project.projectId);
  };

  const handleRowActivate = () => {
    if (isEditing) {
      return;
    }
    onProjectSelect(project);
    if (showInlineSessions) {
      toggleProject();
    }
  };

  return (
    <div className={cn(isDeleting && 'pointer-events-none opacity-50')}>
      <div
        className={cn(
          'group mx-1 flex items-center gap-1 rounded-lg px-1.5 py-1 transition-colors',
          'hover:bg-accent/50',
          isSelected && 'bg-accent text-accent-foreground',
          isStarred && !isSelected && 'bg-yellow-50/40 dark:bg-yellow-900/10',
        )}
        draggable={!isEditing}
        onDragStart={handleProjectDragStart}
      >
        <button
          type="button"
          className={cn(
            'flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md transition-colors',
            isStarred
              ? 'text-yellow-600 hover:bg-yellow-50 dark:text-yellow-400 dark:hover:bg-yellow-900/20'
              : 'text-muted-foreground/50 hover:bg-accent hover:text-muted-foreground',
          )}
          onClick={(event) => {
            event.stopPropagation();
            toggleStarProject();
          }}
          title={isStarred ? t('tooltips.removeFromFavorites') : t('tooltips.addToFavorites')}
          aria-label={isStarred ? t('tooltips.removeFromFavorites') : t('tooltips.addToFavorites')}
        >
          <Star className={cn('h-3.5 w-3.5', isStarred && 'fill-current')} />
        </button>

        {isEditing ? (
          <div className="flex min-w-0 flex-1 items-center gap-1">
            <input
              type="text"
              value={editingName}
              onChange={(event) => onEditingNameChange(event.target.value)}
              className="h-7 min-w-0 flex-1 rounded-md border border-border bg-background px-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/20"
              placeholder={t('projects.projectNamePlaceholder')}
              autoFocus
              onClick={(event) => event.stopPropagation()}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  saveProjectName();
                }
                if (event.key === 'Escape') {
                  onCancelEditingProject();
                }
              }}
            />
            <button
              type="button"
              className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md text-green-600 hover:bg-green-50 dark:hover:bg-green-900/20"
              onClick={(event) => {
                event.stopPropagation();
                saveProjectName();
              }}
              title={t('common.save', { defaultValue: 'Save' })}
            >
              <Check className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent"
              onClick={(event) => {
                event.stopPropagation();
                onCancelEditingProject();
              }}
              title={t('common.cancel', { defaultValue: 'Cancel' })}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        ) : (
          <>
            <button
              type="button"
              className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1 py-1 text-left"
              onClick={handleRowActivate}
              title={project.displayName}
            >
              <span className="min-w-0 flex-1 truncate text-sm font-normal text-foreground">
                {project.displayName}
              </span>
              <span
                className="flex-shrink-0 rounded-full bg-muted px-1.5 py-px text-[10px] tabular-nums leading-4 text-muted-foreground"
                aria-label={t('projects.sessionCount', {
                  count: sessionCount,
                  defaultValue: `${sessionCount} sessions`,
                })}
              >
                {sessionCount}
              </span>
              {showInlineSessions ? (
                isExpanded ? (
                  <ChevronDown className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
                ) : (
                  <ChevronRight className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100" />
                )
              ) : null}
            </button>

            <ProjectOverflowMenu
              project={project}
              t={t}
              onRename={() => onStartEditingProject(project)}
              onMove={() => onMoveToCategory(project)}
              onDelete={() => onDeleteProject(project)}
            />
          </>
        )}
      </div>

      {showInlineSessions ? (
        <SidebarProjectSessions
          project={project}
          isExpanded={isExpanded}
          sessions={sessions}
          selectedSession={selectedSession}
          initialSessionsLoaded={initialSessionsLoaded}
          hasMoreSessions={Boolean(project.sessionMeta?.hasMore)}
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
      ) : null}
    </div>
  );
}
