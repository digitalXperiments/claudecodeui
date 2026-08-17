import * as React from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Activity,
  Archive,
  ArrowDownToLine,
  ArrowUpFromLine,
  BarChart3,
  ChevronRight,
  CircleAlert,
  ClipboardCopy,
  FileCode2,
  FileText,
  Folder,
  FolderPlus,
  Gauge,
  GitCommit,
  GitMerge,
  History,
  MessageSquare,
  MessageSquarePlus,
  MonitorPlay,
  Moon,
  Network,
  Palette,
  PanelLeft,
  Radar,
  RefreshCw,
  Search,
  Settings,
  SquareKanban,
  Sun,
  SunMoon,
  Terminal,
  X,
} from 'lucide-react';

import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  Dialog,
  DialogContent,
  DialogTitle,
} from '../../shared/view/ui';
import { useTheme } from '../../contexts/ThemeContext';
import { usePaletteOps } from '../../contexts/PaletteOpsContext';
import { usePlugins } from '../../contexts/PluginsContext';
import { useAppFeatures } from '../../hooks/useAppFeatures';
import { useUiPreferences } from '../../hooks/useUiPreferences';
import { copyTextToClipboard } from '../../utils/clipboard';
import { SETTINGS_MAIN_TABS } from '../settings/constants/constants';
import type { AppTab, Project } from '../../types/app';
import type { SidebarSearchMode } from '../sidebar/types/types';

import { useSessionsSource } from './sources/useSessionsSource';
import { useFilesSource } from './sources/useFilesSource';
import { useCommitsSource } from './sources/useCommitsSource';
import { useSessionMessageSearch } from './sources/useSessionMessageSearch';
import { useBranchesSource } from './sources/useBranchesSource';
import { useGitActions } from './sources/useGitActions';
import { useGlobalSkillsSource, useProjectSkillsSource } from './sources/useSkillsSource';

type Page = 'actions' | 'files' | 'sessions' | 'commits' | 'branches' | 'projects' | 'skills';

const PAGE_LABELS: Record<Page, string> = {
  actions: 'Actions',
  files: 'Files',
  sessions: 'Sessions',
  commits: 'Commits',
  branches: 'Branches',
  projects: 'Projects',
  skills: 'Skills',
};

type CommandPaletteProps = {
  projects: Project[];
  selectedProject: Project | null;
  onStartNewChat: (project: Project) => void;
  onOpenSettings: (tab?: string) => void;
  onShowTab?: (tab: AppTab) => void;
  onSelectProject?: (project: Project) => void;
};

const NAV_TABS: Array<{ id: AppTab; label: string; keywords: string; icon: React.ComponentType<{ className?: string }> }> = [
  { id: 'chat', label: 'Go to Chat', keywords: 'chat messages conversation', icon: MessageSquare },
  { id: 'shell', label: 'Go to Shell', keywords: 'shell terminal console', icon: Terminal },
  { id: 'files', label: 'Go to Files', keywords: 'files file tree explorer', icon: Folder },
  { id: 'git', label: 'Go to Git', keywords: 'git diff branches', icon: GitMerge },
  { id: 'operations', label: 'Go to Operations', keywords: 'operations runs spend', icon: Gauge },
  { id: 'tasks', label: 'Go to Tasks', keywords: 'tasks taskmaster', icon: SquareKanban },
  { id: 'browser', label: 'Go to Browser', keywords: 'browser playwright', icon: MonitorPlay },
];

const SIDEBAR_MODES: Array<{ id: SidebarSearchMode; label: string; keywords: string; icon: React.ComponentType<{ className?: string }> }> = [
  { id: 'projects', label: 'Sidebar: Projects', keywords: 'projects list folders', icon: Folder },
  { id: 'recent', label: 'Sidebar: Recent conversations', keywords: 'recent history conversations', icon: History },
  { id: 'running', label: 'Sidebar: Running sessions', keywords: 'running active processing', icon: Activity },
  { id: 'conversations', label: 'Sidebar: Search conversations', keywords: 'search messages transcript', icon: Search },
  { id: 'archived', label: 'Sidebar: Archive', keywords: 'archive archived', icon: Archive },
];

export default function CommandPalette({
  projects,
  selectedProject,
  onStartNewChat,
  onOpenSettings,
  onShowTab,
  onSelectProject,
}: CommandPaletteProps) {
  const [open, setOpen] = React.useState(false);
  const [search, setSearch] = React.useState('');
  const [pages, setPages] = React.useState<Page[]>([]);
  const { toggleDarkMode, setThemeMode } = useTheme() as {
    toggleDarkMode: () => void;
    setThemeMode: (mode: 'light' | 'dark' | 'system') => void;
  };
  const navigate = useNavigate();
  const ops = usePaletteOps();
  const { features } = useAppFeatures();
  const { plugins } = usePlugins();
  const { preferences, setPreference } = useUiPreferences();

  const page = pages.at(-1);

  React.useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const isCmdK = (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'k';
      if (!isCmdK) return;
      e.preventDefault();
      setOpen((prev) => !prev);
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, []);

  React.useEffect(() => {
    if (!open) {
      setSearch('');
      setPages([]);
    }
  }, [open]);

  const projectId = selectedProject?.projectId;
  const workspacePath = selectedProject?.fullPath || selectedProject?.path;

  const showActions = !page || page === 'actions';
  const showSessions = !page || page === 'sessions';
  const showFiles = !page || page === 'files';
  const showCommits = !page || page === 'commits';
  const showBranches = !page || page === 'branches' || page === 'actions';
  const showProjects = !page || page === 'projects';
  const showSkills = !page || page === 'skills';

  const sessions = useSessionsSource(projectId, open && showSessions);
  const messageMatches = useSessionMessageSearch(projectId, search, open && showSessions);
  const files = useFilesSource(projectId, open && showFiles);
  const commits = useCommitsSource(projectId, open && showCommits);
  const branches = useBranchesSource(projectId, open && showBranches);
  const git = useGitActions(projectId);
  const projectSkills = useProjectSkillsSource(workspacePath, open && showSkills);
  const globalSkills = useGlobalSkillsSource(open && showSkills);

  const sessionRows = React.useMemo(() => {
    if (!showSessions) return [];
    type Row = { id: string; label: string; provider?: string; snippet?: string };
    const byId = new Map<string, Row>();
    for (const s of sessions) {
      byId.set(s.id, { id: s.id, label: s.label, provider: s.provider });
    }
    for (const m of messageMatches) {
      const existing = byId.get(m.sessionId);
      if (existing) {
        existing.snippet = m.snippet;
      } else {
        byId.set(m.sessionId, {
          id: m.sessionId,
          label: m.label,
          provider: m.provider,
          snippet: m.snippet,
        });
      }
    }
    return Array.from(byId.values());
  }, [sessions, messageMatches, showSessions]);

  const skillRows = React.useMemo(() => [...projectSkills, ...globalSkills], [projectSkills, globalSkills]);

  const run = React.useCallback((fn: () => void) => {
    setOpen(false);
    fn();
  }, []);

  const pushPage = React.useCallback((next: Page) => {
    setSearch('');
    setPages((prev) => [...prev, next]);
  }, []);

  const popPage = React.useCallback(() => {
    setSearch('');
    setPages((prev) => prev.slice(0, -1));
  }, []);

  const handleKeyDown = React.useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Backspace' && !search && pages.length > 0) {
      e.preventDefault();
      popPage();
    }
  }, [search, pages.length, popPage]);

  const startNewChatDisabled = !selectedProject;
  const browseLimit = 5;
  const filesShown = page === 'files' ? files : files.slice(0, browseLimit);
  const commitsShown = page === 'commits' ? commits : commits.slice(0, browseLimit);
  const sessionsShown = page === 'sessions' ? sessionRows : sessionRows.slice(0, browseLimit);
  const branchesShown = page === 'branches' ? branches : branches.slice(0, browseLimit);
  const projectsShown = page === 'projects' ? projects : projects.slice(0, browseLimit);
  const skillsShown = page === 'skills' ? skillRows : skillRows.slice(0, browseLimit);

  const goProject = (project: Project) => {
    (onSelectProject ?? ops.selectProject)(project);
    onShowTab?.('chat');
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-xl overflow-hidden p-0">
        <DialogTitle>Command palette</DialogTitle>
        <Command label="Command palette" onKeyDown={handleKeyDown}>
          {page && (
            <div className="flex items-center gap-2 border-b px-3 py-2">
              <span className="inline-flex items-center gap-1 rounded-md bg-accent px-2 py-0.5 text-xs font-medium text-accent-foreground">
                {PAGE_LABELS[page]}
                <button
                  type="button"
                  onClick={popPage}
                  aria-label="Back to all"
                  className="ml-0.5 rounded-sm opacity-70 hover:opacity-100"
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
              <span className="text-xs text-muted-foreground">Backspace to go back</span>
            </div>
          )}
          <CommandInput
            placeholder={page ? `Search ${PAGE_LABELS[page].toLowerCase()}…` : 'Search or jump anywhere…'}
            value={search}
            onValueChange={setSearch}
          />
          <CommandList className="max-h-[min(28rem,60vh)]">
            <CommandEmpty>No results.</CommandEmpty>

            {showActions && (
              <CommandGroup heading="Actions">
                <CommandItem
                  value="Start new chat session"
                  disabled={startNewChatDisabled}
                  onSelect={() => {
                    if (!selectedProject) return;
                    run(() => onStartNewChat(selectedProject));
                  }}
                >
                  <MessageSquarePlus className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                  <span className="flex-1">Start new chat</span>
                  {startNewChatDisabled && (
                    <span className="text-xs text-muted-foreground">Select a project first</span>
                  )}
                </CommandItem>
                <CommandItem value="New project create workspace" onSelect={() => run(() => ops.openNewProject())}>
                  <FolderPlus className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                  <span className="flex-1">New project</span>
                </CommandItem>
                <CommandItem value="Open settings" onSelect={() => run(() => onOpenSettings())}>
                  <Settings className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                  <span className="flex-1">Open settings</span>
                </CommandItem>
                <CommandItem value="Refresh reload projects" onSelect={() => run(() => { void ops.refreshProjects(); })}>
                  <RefreshCw className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                  <span className="flex-1">Refresh projects</span>
                </CommandItem>
                <CommandItem value="Toggle sidebar collapse" onSelect={() => run(() => ops.toggleSidebarCollapsed())}>
                  <PanelLeft className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                  <span className="flex-1">Toggle sidebar</span>
                </CommandItem>
                {selectedProject && (
                  <CommandItem
                    value={`Copy project path ${selectedProject.fullPath}`}
                    onSelect={() => run(() => { void copyTextToClipboard(selectedProject.fullPath); })}
                  >
                    <ClipboardCopy className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                    <span className="flex-1">Copy project path</span>
                  </CommandItem>
                )}
              </CommandGroup>
            )}

            {showActions && (
              <CommandGroup heading="Open">
                <CommandItem value="Open Needs You interrupts permissions" onSelect={() => run(() => ops.openNeedsYou())}>
                  <CircleAlert className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                  <span className="flex-1">Needs you</span>
                </CommandItem>
                <CommandItem value="Open Mission Control inbox" onSelect={() => run(() => ops.openMissionControl())}>
                  <Radar className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                  <span className="flex-1">Mission Control</span>
                </CommandItem>
                {features.kanbanEnabled && (
                  <CommandItem value="Open Kanban board" onSelect={() => run(() => ops.openKanban())}>
                    <SquareKanban className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                    <span className="flex-1">Kanban</span>
                  </CommandItem>
                )}
                <CommandItem value="Open Agent Swarm" onSelect={() => run(() => ops.openAgentSwarm())}>
                  <Network className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                  <span className="flex-1">Agent Swarm</span>
                </CommandItem>
                <CommandItem value="Open Studio prototype design" onSelect={() => run(() => ops.openStudio())}>
                  <Palette className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                  <span className="flex-1">Studio</span>
                </CommandItem>
                <CommandItem value="Open Usage Stats spend" onSelect={() => run(() => ops.openStats())}>
                  <BarChart3 className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                  <span className="flex-1">Usage Stats</span>
                </CommandItem>
              </CommandGroup>
            )}

            {showActions && (
              <CommandGroup heading="Navigate">
                {NAV_TABS.map((tab) => (
                  <CommandItem
                    key={tab.id as string}
                    value={`${tab.label} ${tab.keywords}`}
                    onSelect={() => run(() => onShowTab?.(tab.id))}
                  >
                    <tab.icon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                    <span className="flex-1">{tab.label}</span>
                  </CommandItem>
                ))}
                {plugins.filter((plugin) => plugin.enabled).map((plugin) => (
                  <CommandItem
                    key={plugin.name}
                    value={`Go to plugin ${plugin.displayName} ${plugin.name}`}
                    onSelect={() => run(() => onShowTab?.(`plugin:${plugin.name}`))}
                  >
                    <span className="flex-1">Go to {plugin.displayName}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}

            {showActions && (
              <CommandGroup heading="Sidebar">
                {SIDEBAR_MODES.map((mode) => (
                  <CommandItem
                    key={mode.id}
                    value={`${mode.label} ${mode.keywords}`}
                    onSelect={() => run(() => ops.setSidebarSearchMode(mode.id))}
                  >
                    <mode.icon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                    <span className="flex-1">{mode.label}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}

            {showProjects && projectsShown.length > 0 && (
              <CommandGroup heading="Projects">
                {projectsShown.map((project) => (
                  <CommandItem
                    key={project.projectId}
                    value={`${project.displayName} ${project.fullPath} project`}
                    onSelect={() => run(() => goProject(project))}
                  >
                    <Folder className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                    <span className="flex-1 truncate">{project.displayName}</span>
                    {project.projectId === selectedProject?.projectId && (
                      <span className="text-xs text-muted-foreground">current</span>
                    )}
                  </CommandItem>
                ))}
                {!page && projects.length > browseLimit && (
                  <BrowseAllItem label={`Browse all projects (${projects.length})`} onSelect={() => pushPage('projects')} />
                )}
              </CommandGroup>
            )}

            {showActions && projectId && (
              <CommandGroup heading="Git">
                <CommandItem
                  value="Git Fetch remote"
                  onSelect={() => run(() => { void git.fetch(); onShowTab?.('git'); })}
                >
                  <RefreshCw className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                  <span className="flex-1">Git: Fetch</span>
                </CommandItem>
                <CommandItem
                  value="Git Pull merge upstream"
                  onSelect={() => run(() => { void git.pull(); onShowTab?.('git'); })}
                >
                  <ArrowDownToLine className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                  <span className="flex-1">Git: Pull</span>
                </CommandItem>
                <CommandItem
                  value="Git Push origin remote"
                  onSelect={() => run(() => { void git.push(); onShowTab?.('git'); })}
                >
                  <ArrowUpFromLine className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                  <span className="flex-1">Git: Push</span>
                </CommandItem>
              </CommandGroup>
            )}

            {showActions && (
              <CommandGroup heading="Appearance">
                <CommandItem value="Theme light" onSelect={() => run(() => setThemeMode('light'))}>
                  <Sun className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                  <span className="flex-1">Theme: Light</span>
                </CommandItem>
                <CommandItem value="Theme dark" onSelect={() => run(() => setThemeMode('dark'))}>
                  <Moon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                  <span className="flex-1">Theme: Dark</span>
                </CommandItem>
                <CommandItem value="Theme system os" onSelect={() => run(() => setThemeMode('system'))}>
                  <SunMoon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                  <span className="flex-1">Theme: System</span>
                </CommandItem>
                <CommandItem value="Toggle theme dark light mode" onSelect={() => run(toggleDarkMode)}>
                  <SunMoon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                  <span className="flex-1">Toggle theme</span>
                </CommandItem>
                <CommandItem
                  value="Toggle thinking traces"
                  onSelect={() => run(() => setPreference('showThinking', !preferences.showThinking))}
                >
                  <span className="flex-1">
                    {preferences.showThinking ? 'Hide thinking traces' : 'Show thinking traces'}
                  </span>
                </CommandItem>
                <CommandItem
                  value="Toggle send by ctrl enter"
                  onSelect={() => run(() => setPreference('sendByCtrlEnter', !preferences.sendByCtrlEnter))}
                >
                  <span className="flex-1">
                    {preferences.sendByCtrlEnter ? 'Send with Enter' : 'Send with Ctrl+Enter'}
                  </span>
                </CommandItem>
              </CommandGroup>
            )}

            {showActions && (
              <CommandGroup heading="Settings">
                {SETTINGS_MAIN_TABS.map(({ id, label, keywords, icon: Icon }) => (
                  <CommandItem
                    key={id}
                    value={`Settings ${label} ${keywords}`}
                    onSelect={() => run(() => onOpenSettings(id))}
                  >
                    <Icon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                    <span className="flex-1">Settings: {label}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}

            {showSkills && skillsShown.length > 0 && (
              <CommandGroup heading="Skills">
                {skillsShown.map((skill) => (
                  <CommandItem
                    key={skill.id}
                    value={`${skill.name} ${skill.description} ${skill.scope} skill`}
                    onSelect={() => run(() => onOpenSettings('skills'))}
                  >
                    <FileCode2 className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                    <div className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate">{skill.name}</span>
                      {skill.description && (
                        <span className="truncate text-xs text-muted-foreground">{skill.description}</span>
                      )}
                    </div>
                    <span className="text-xs text-muted-foreground">{skill.scope}</span>
                  </CommandItem>
                ))}
                {!page && skillRows.length > browseLimit && (
                  <BrowseAllItem label={`Browse all skills (${skillRows.length})`} onSelect={() => pushPage('skills')} />
                )}
              </CommandGroup>
            )}

            {showSessions && projectId && sessionsShown.length > 0 && (
              <CommandGroup heading="Sessions">
                {sessionsShown.map((s) => (
                  <CommandItem
                    key={s.id}
                    value={`${s.label} ${s.snippet ?? ''} ${s.id}`.trim()}
                    onSelect={() => run(() => navigate(`/session/${s.id}`))}
                  >
                    <MessageSquare className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                    <div className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate">{s.label}</span>
                      {s.snippet && (
                        <span className="truncate text-xs text-muted-foreground">{s.snippet}</span>
                      )}
                    </div>
                    {s.provider && (
                      <span className="text-xs text-muted-foreground">{s.provider}</span>
                    )}
                  </CommandItem>
                ))}
                {!page && sessionRows.length > browseLimit && (
                  <BrowseAllItem label={`Browse all sessions (${sessionRows.length})`} onSelect={() => pushPage('sessions')} />
                )}
              </CommandGroup>
            )}

            {showFiles && projectId && filesShown.length > 0 && (
              <CommandGroup heading="Files">
                {filesShown.map((f) => (
                  <CommandItem
                    key={f.path}
                    value={f.path}
                    onSelect={() => run(() => ops.openFile(f.path))}
                  >
                    <FileText className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                    <span className="flex-1 truncate">{f.name}</span>
                    <span className="truncate text-xs text-muted-foreground">{f.path}</span>
                  </CommandItem>
                ))}
                {!page && files.length > browseLimit && (
                  <BrowseAllItem label={`Browse all files (${files.length})`} onSelect={() => pushPage('files')} />
                )}
              </CommandGroup>
            )}

            {showCommits && projectId && commitsShown.length > 0 && (
              <CommandGroup heading="Commits">
                {commitsShown.map((c) => (
                  <CommandItem
                    key={c.hash}
                    value={`${c.message} ${c.author} ${c.shortHash}`}
                    onSelect={() => run(() => onShowTab?.('git'))}
                  >
                    <GitCommit className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                    <span className="font-mono text-xs text-muted-foreground">{c.shortHash}</span>
                    <span className="flex-1 truncate">{c.message}</span>
                    <span className="truncate text-xs text-muted-foreground">{c.author}</span>
                  </CommandItem>
                ))}
                {!page && commits.length > browseLimit && (
                  <BrowseAllItem label={`Browse all commits (${commits.length})`} onSelect={() => pushPage('commits')} />
                )}
              </CommandGroup>
            )}

            {showBranches && projectId && branchesShown.length > 0 && (
              <CommandGroup heading="Branches">
                {branchesShown.map((b) => (
                  <CommandItem
                    key={`branch-${b.name}`}
                    value={b.name}
                    onSelect={() => run(() => { void git.checkout(b.name); onShowTab?.('git'); })}
                  >
                    <GitMerge className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                    <span className="flex-1 truncate">Switch to: {b.name}</span>
                  </CommandItem>
                ))}
                {!page && branches.length > browseLimit && (
                  <BrowseAllItem label={`Browse all branches (${branches.length})`} onSelect={() => pushPage('branches')} />
                )}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}

function BrowseAllItem({ label, onSelect }: { label: string; onSelect: () => void }) {
  return (
    <CommandItem value={label} onSelect={onSelect}>
      <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
      <span className="flex-1 text-muted-foreground">{label}</span>
    </CommandItem>
  );
}
