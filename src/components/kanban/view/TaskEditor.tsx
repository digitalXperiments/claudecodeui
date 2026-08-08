import { useEffect, useMemo, useRef, useState } from 'react';
import { FolderGit2, GitBranch, Loader2, Play, Search, Sparkles, Trash2 } from 'lucide-react';

import { Badge, Button, Dialog, DialogContent, DialogTitle, Input } from '../../../shared/view/ui';
import { cn } from '../../../lib/utils';
import type { LLMProvider } from '../../../types/app';
import { authenticatedFetch } from '../../../utils/api';
import PermissionsContent from '../../settings/view/tabs/agents-settings/sections/content/PermissionsContent';
import type { AgyPermissionMode, CodexPermissionMode, PiPermissionMode } from '../../settings/types/types';
import {
  agentProfilesApi,
  type AgentRunProfile,
} from '../../settings/api/agentProfilesApi';
import {
  KANBAN_PERMISSION_MODES,
  KANBAN_PROVIDERS,
  type KanbanColumn,
  type KanbanTask,
  type KanbanTaskStatus,
  type ProjectRef,
} from '../types';
import { kanbanApi, type TaskPatch } from '../api/kanbanApi';

const GENERATE_PROVIDER_KEY = 'kanban.generateTaskFields.provider';

function readStoredGenerateProvider(): LLMProvider {
  try {
    const raw = localStorage.getItem(GENERATE_PROVIDER_KEY);
    if (raw && KANBAN_PROVIDERS.some((p) => p.value === raw)) {
      return raw as LLMProvider;
    }
  } catch {
    // ignore
  }
  return 'claude';
}

import TaskRunOutput from './TaskRunOutput';
import TaskComments from './TaskComments';
import ContextPackPanel from '../../context-packs/ContextPackPanel';

type TaskDraft = {
  columnId?: string;
};

type TaskEditorProps = {
  open: boolean;
  task: KanbanTask | null;
  draft: TaskDraft | null;
  columns: KanbanColumn[];
  allTasks: KanbanTask[];
  /** Available projects; when `requireProject`, the task must pick one. */
  projects: ProjectRef[];
  requireProject: boolean;
  /** Pre-select project for new tasks on a project board. */
  defaultProjectId?: string | null;
  /** projectId -> display name, for labelling cross-project dependencies. */
  projectNameById: Map<string, string> | null;
  onClose: () => void;
  onCreate: (input: {
    columnId?: string;
    projectId?: string;
    title: string;
    description?: string;
    prompt?: string;
    assigneeProvider?: LLMProvider | null;
    reviewProvider?: LLMProvider | null;
    implementProfileId?: string | null;
    reviewProfileId?: string | null;
    permissionMode?: string;
    tools?: {
      allowedCommands?: string[];
      disallowedCommands?: string[];
      mcpServers?: string[];
      skills?: string[];
    };
    scheduleCron?: string | null;
    dueDate?: string | null;
  }) => Promise<KanbanTask | void>;
  onUpdate: (taskId: string, patch: TaskPatch) => Promise<void>;
  onDelete: (taskId: string) => Promise<void>;
  onAddDependency: (taskId: string, dependsOnTaskId: string) => Promise<void>;
  onRemoveDependency: (taskId: string, dependsOnTaskId: string) => Promise<void>;
  onRun?: (taskId: string) => Promise<void>;
};

const STATUS_BADGE: Record<KanbanTaskStatus, string> = {
  todo: 'bg-secondary text-secondary-foreground',
  queued: 'bg-blue-500/15 text-blue-600 dark:text-blue-400',
  running: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
  done: 'bg-green-500/15 text-green-600 dark:text-green-400',
  failed: 'bg-destructive/15 text-destructive',
  blocked: 'bg-muted text-muted-foreground',
};

const labelClass = 'text-xs font-medium text-muted-foreground';
const selectClass =
  'h-9 w-full rounded-md border border-input bg-background px-3 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring';
const textareaClass =
  'w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring';

const CODEX_MODES: CodexPermissionMode[] = ['default', 'acceptEdits', 'bypassPermissions'];
const AGY_MODES: AgyPermissionMode[] = ['plan', 'acceptEdits', 'bypassPermissions'];
const PI_MODES: PiPermissionMode[] = ['plan', 'bypassPermissions'];

/** Providers with a dedicated allow/deny editor (share the settings UI). */
const ALLOW_DENY_PROVIDERS: LLMProvider[] = ['claude', 'cursor', 'grok'];

function coerceCodexMode(mode: string): CodexPermissionMode {
  return CODEX_MODES.includes(mode as CodexPermissionMode) ? (mode as CodexPermissionMode) : 'default';
}

function coerceAgyMode(mode: string): AgyPermissionMode {
  return AGY_MODES.includes(mode as AgyPermissionMode) ? (mode as AgyPermissionMode) : 'bypassPermissions';
}

function coercePiMode(mode: string): PiPermissionMode {
  return PI_MODES.includes(mode as PiPermissionMode) ? (mode as PiPermissionMode) : 'bypassPermissions';
}

export default function TaskEditor(props: TaskEditorProps) {
  const {
    open,
    task,
    draft,
    columns: columnsProp,
    allTasks: allTasksProp,
    projects: projectsProp,
    requireProject,
    defaultProjectId = null,
    projectNameById,
    onClose,
  } = props;
  const isEdit = Boolean(task);
  // Defensive defaults — these feed `.length`/`.map`/`.filter` in render and
  // hook deps; memoized so a nullish prop can't churn effects every render.
  const columns = useMemo(() => columnsProp ?? [], [columnsProp]);
  const allTasks = useMemo(() => allTasksProp ?? [], [allTasksProp]);
  const projects = useMemo(() => projectsProp ?? [], [projectsProp]);

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [prompt, setPrompt] = useState('');
  const [projectId, setProjectId] = useState('');
  const [columnId, setColumnId] = useState('');
  const [assignee, setAssignee] = useState<LLMProvider | ''>('');
  const [reviewAgent, setReviewAgent] = useState<LLMProvider | ''>('');
  const [implementProfileId, setImplementProfileId] = useState('');
  const [reviewProfileId, setReviewProfileId] = useState('');
  const [profiles, setProfiles] = useState<AgentRunProfile[]>([]);
  /** When true, show legacy provider-only assignment under Advanced. */
  const [showAdvancedAgents, setShowAdvancedAgents] = useState(false);
  const [permissionMode, setPermissionMode] = useState('default');
  const [skipPermissions, setSkipPermissions] = useState(false);
  const [allowed, setAllowed] = useState<string[]>([]);
  const [disallowed, setDisallowed] = useState<string[]>([]);
  const [mcpServersSelected, setMcpServersSelected] = useState<string[]>([]);
  const [mcpCatalog, setMcpCatalog] = useState<string[]>([]);
  const [mcpLoading, setMcpLoading] = useState(false);
  const [skillsSelected, setSkillsSelected] = useState<string[]>([]);
  const [projectSkillOptions, setProjectSkillOptions] = useState<
    { directoryName: string; name: string; description: string }[]
  >([]);
  const [skillsLoading, setSkillsLoading] = useState(false);
  const [scheduleCron, setScheduleCron] = useState('');
  const [dueDate, setDueDate] = useState('');
  /** Draft dependency ids while creating; applied after create. Live task uses task.dependsOn. */
  const [draftDependsOn, setDraftDependsOn] = useState<string[]>([]);
  const [depSearch, setDepSearch] = useState('');
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [generateProvider, setGenerateProvider] = useState<LLMProvider>(readStoredGenerateProvider);
  const [error, setError] = useState<string | null>(null);
  /** Track whether skills were user-edited so auto-default does not clobber. */
  const skillsTouchedRef = useRef(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void agentProfilesApi
      .list()
      .then((list) => {
        if (!cancelled) setProfiles(list);
      })
      .catch(() => {
        if (!cancelled) setProfiles([]);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  // Reset local form state whenever the target task/draft *identity* changes.
  // Keyed on task_id (not the `task` object) because the board polls every
  // 2.5s while any run is active and replaces every task object with a fresh
  // reference on each tick — depending on `task`/`columns`/`projects` directly
  // here reset the form (wiping in-progress edits, or a blank new-task draft)
  // on every poll tick even though nothing the user cares about changed.
  const taskIdentity = task?.task_id ?? null;
  const draftColumnIdentity = draft?.columnId ?? null;
  useEffect(() => {
    if (!open) {
      return;
    }
    setError(null);
    setDepSearch('');
    skillsTouchedRef.current = false;
    if (task) {
      setTitle(task.title);
      setDescription(task.description ?? '');
      setPrompt(task.prompt ?? '');
      setProjectId(task.project_id ?? '');
      setColumnId(task.column_id);
      setAssignee(task.assignee_provider ?? '');
      setReviewAgent(task.review_provider ?? '');
      setImplementProfileId(task.implement_profile_id ?? '');
      setReviewProfileId(task.review_profile_id ?? '');
      // Open advanced only when task uses raw providers without profiles.
      const hasRawImplement =
        !task.implement_profile_id && Boolean(task.assignee_provider);
      const hasRawReview = !task.review_profile_id && Boolean(task.review_provider);
      setShowAdvancedAgents(hasRawImplement || hasRawReview);
      setPermissionMode(task.permission_mode || 'default');
      setSkipPermissions((task.permission_mode || 'default') === 'bypassPermissions');
      setAllowed(task.tools?.allowedCommands ?? []);
      setDisallowed(task.tools?.disallowedCommands ?? []);
      setMcpServersSelected(
        Array.isArray(task.tools?.mcpServers) ? task.tools.mcpServers : [],
      );
      setSkillsSelected(Array.isArray(task.tools?.skills) ? task.tools.skills : []);
      if (Array.isArray(task.tools?.skills) && task.tools.skills.length > 0) {
        skillsTouchedRef.current = true;
      }
      setScheduleCron(task.schedule_cron ?? '');
      setDueDate(task.due_date ? task.due_date.slice(0, 10) : '');
      setDraftDependsOn([]);
    } else {
      setTitle('');
      setDescription('');
      setPrompt('');
      setProjectId(
        defaultProjectId ||
          (projects.length === 1 ? projects[0].projectId : ''),
      );
      setColumnId(draft?.columnId ?? columns[0]?.id ?? '');
      setAssignee('');
      setReviewAgent('');
      setImplementProfileId('');
      setReviewProfileId('');
      setShowAdvancedAgents(false);
      setPermissionMode('default');
      setSkipPermissions(false);
      setAllowed([]);
      setDisallowed([]);
      setMcpServersSelected([]);
      setSkillsSelected([]);
      setScheduleCron('');
      setDueDate('');
      setDraftDependsOn([]);
    }
    // Intentionally keyed on identity, not the task/draft/columns/projects
    // object refs (see comment above); those are still read fresh from the
    // closure whenever this does run.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, taskIdentity, draftColumnIdentity]);

  const implementProfile = useMemo(
    () => profiles.find((p) => p.profile_id === implementProfileId) ?? null,
    [profiles, implementProfileId],
  );
  const reviewProfile = useMemo(
    () => profiles.find((p) => p.profile_id === reviewProfileId) ?? null,
    [profiles, reviewProfileId],
  );

  // Load MCP servers for the implementation provider (profile or raw).
  const mcpProvider = useMemo((): LLMProvider | '' => {
    if (implementProfile?.provider) {
      return implementProfile.provider as LLMProvider;
    }
    return assignee;
  }, [implementProfile, assignee]);

  useEffect(() => {
    if (!open || !mcpProvider) {
      setMcpCatalog([]);
      return;
    }
    let cancelled = false;
    setMcpLoading(true);
    const params = new URLSearchParams();
    const project = projects.find((p) => p.projectId === projectId);
    if (project?.path) {
      params.set('projectPath', project.path);
      params.set('workspacePath', project.path);
    }
    const qs = params.toString() ? `?${params.toString()}` : '';
    void authenticatedFetch(`/api/providers/${mcpProvider}/mcp/servers${qs}`)
      .then(async (res) => {
        if (!res.ok) throw new Error('failed');
        const data = await res.json();
        const servers = data?.data?.servers ?? data?.servers ?? [];
        const names = new Set<string>();
        for (const s of Array.isArray(servers) ? servers : []) {
          const name = typeof s === 'string' ? s : s?.name;
          if (typeof name === 'string' && name.trim()) names.add(name.trim());
        }
        if (!cancelled) setMcpCatalog([...names].sort((a, b) => a.localeCompare(b)));
      })
      .catch(() => {
        if (!cancelled) setMcpCatalog([]);
      })
      .finally(() => {
        if (!cancelled) setMcpLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, mcpProvider, projectId, projects]);

  // Load project skills when a project is selected; auto-select when empty / new task.
  useEffect(() => {
    if (!open || !projectId) {
      setProjectSkillOptions([]);
      return;
    }
    const project = projects.find((p) => p.projectId === projectId);
    const workspacePath = project?.path;
    if (!workspacePath) {
      setProjectSkillOptions([]);
      return;
    }
    let cancelled = false;
    setSkillsLoading(true);
    const params = new URLSearchParams({ workspacePath });
    void authenticatedFetch(`/api/project-skills?${params.toString()}`)
      .then(async (res) => {
        if (!res.ok) throw new Error('failed');
        const data = await res.json();
        const skills = data?.data?.skills ?? data?.skills ?? [];
        const list = (Array.isArray(skills) ? skills : [])
          .map((s: { directoryName?: string; name?: string; description?: string }) => ({
            directoryName: String(s.directoryName ?? ''),
            name: String(s.name ?? s.directoryName ?? ''),
            description: String(s.description ?? ''),
          }))
          .filter((s: { directoryName: string }) => s.directoryName);
        if (cancelled) return;
        setProjectSkillOptions(list);
        // Auto-select all project skills for new tasks or when none chosen yet.
        if (!skillsTouchedRef.current && list.length > 0) {
          setSkillsSelected(list.map((s: { directoryName: string }) => s.directoryName));
        }
      })
      .catch(() => {
        if (!cancelled) setProjectSkillOptions([]);
      })
      .finally(() => {
        if (!cancelled) setSkillsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, projectId, projects]);

  const mcpOptions = useMemo(() => {
    const set = new Set(mcpCatalog);
    for (const n of mcpServersSelected) set.add(n);
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [mcpCatalog, mcpServersSelected]);

  const selectedDependsOn = useMemo(() => {
    if (task) {
      return task.dependsOn ?? [];
    }
    return draftDependsOn;
  }, [task, draftDependsOn]);

  const applyImplementProfile = (profileId: string) => {
    setImplementProfileId(profileId);
    if (!profileId) {
      // Switching off a profile: keep advanced closed unless they open it.
      return;
    }
    const profile = profiles.find((p) => p.profile_id === profileId);
    if (!profile) return;
    setAssignee(profile.provider as LLMProvider);
    setPermissionMode(profile.permission_mode || 'default');
    setSkipPermissions((profile.permission_mode || 'default') === 'bypassPermissions');
    setAllowed(profile.tools?.allowedCommands ?? []);
    setDisallowed(profile.tools?.disallowedCommands ?? []);
    setShowAdvancedAgents(false);
  };

  const applyReviewProfile = (profileId: string) => {
    setReviewProfileId(profileId);
    if (!profileId) {
      setReviewAgent('');
      return;
    }
    const profile = profiles.find((p) => p.profile_id === profileId);
    if (!profile) return;
    setReviewAgent(profile.provider as LLMProvider);
    setShowAdvancedAgents(false);
  };

  const profileSummary = (profile: AgentRunProfile | null) => {
    if (!profile) return null;
    const bits = [
      profile.provider,
      profile.model || 'default model',
      profile.effort || 'default effort',
      profile.permission_mode,
    ];
    return bits.join(' · ');
  };

  const dependencyOptions = useMemo(() => {
    const others = allTasks.filter((t) => t.task_id !== task?.task_id);
    const q = depSearch.trim().toLowerCase();
    if (!q) {
      return others;
    }
    return others.filter((t) => {
      const projectLabel = projectNameById?.get(t.project_id) ?? '';
      return (
        t.title.toLowerCase().includes(q) ||
        t.status.toLowerCase().includes(q) ||
        projectLabel.toLowerCase().includes(q)
      );
    });
  }, [allTasks, task?.task_id, depSearch, projectNameById]);

  // Tasks that list this one as a dependency (who will auto-run after this finishes).
  const dependents = useMemo(() => {
    if (!task) {
      return [] as KanbanTask[];
    }
    return allTasks.filter((t) => (t.dependsOn ?? []).includes(task.task_id));
  }, [allTasks, task]);

  const usesAllowDeny = assignee !== '' && ALLOW_DENY_PROVIDERS.includes(assignee);

  const buildTools = () => {
    const tools: {
      allowedCommands?: string[];
      disallowedCommands?: string[];
      mcpServers?: string[];
      skills?: string[];
    } = {};
    if (allowed.length > 0) {
      tools.allowedCommands = allowed;
    }
    if (disallowed.length > 0) {
      tools.disallowedCommands = disallowed;
    }
    if (mcpServersSelected.length > 0) {
      tools.mcpServers = mcpServersSelected;
    }
    if (skillsSelected.length > 0) {
      tools.skills = skillsSelected;
    }
    return tools;
  };

  const toggleInList = (
    list: string[],
    setList: (next: string[]) => void,
    name: string,
  ) => {
    if (list.includes(name)) {
      setList(list.filter((n) => n !== name));
    } else {
      setList([...list, name]);
    }
  };

  // Resolve the stored permission_mode from the provider-appropriate control:
  // allow/deny providers derive it from the skip toggle; others use the mode value.
  const resolvePermissionMode = (): string =>
    usesAllowDeny ? (skipPermissions ? 'bypassPermissions' : 'default') : permissionMode;

  // Provider-aware permission editor: reuses the settings PermissionsContent for
  // claude/cursor/grok (allow+deny) and codex/agy (mode); falls back to a generic
  // mode select for kimi/opencode/unassigned (which take only a permission mode).
  const renderPermissions = () => {
    if (assignee === 'claude') {
      return (
        <PermissionsContent
          agent="claude"
          skipPermissions={skipPermissions}
          onSkipPermissionsChange={setSkipPermissions}
          allowedTools={allowed}
          onAllowedToolsChange={setAllowed}
          disallowedTools={disallowed}
          onDisallowedToolsChange={setDisallowed}
        />
      );
    }
    if (assignee === 'cursor' || assignee === 'grok') {
      return (
        <PermissionsContent
          agent={assignee}
          skipPermissions={skipPermissions}
          onSkipPermissionsChange={setSkipPermissions}
          allowedCommands={allowed}
          onAllowedCommandsChange={setAllowed}
          disallowedCommands={disallowed}
          onDisallowedCommandsChange={setDisallowed}
        />
      );
    }
    if (assignee === 'codex') {
      return (
        <PermissionsContent
          agent="codex"
          permissionMode={coerceCodexMode(permissionMode)}
          onPermissionModeChange={(value) => setPermissionMode(value)}
        />
      );
    }
    if (assignee === 'agy') {
      return (
        <PermissionsContent
          agent="agy"
          permissionMode={coerceAgyMode(permissionMode)}
          onPermissionModeChange={(value) => setPermissionMode(value)}
        />
      );
    }
    if (assignee === 'pi') {
      return (
        <PermissionsContent
          agent="pi"
          permissionMode={coercePiMode(permissionMode)}
          onPermissionModeChange={(value) => setPermissionMode(value)}
        />
      );
    }
    return (
      <select
        className={selectClass}
        value={permissionMode}
        onChange={(e) => setPermissionMode(e.target.value)}
        aria-label="Permission mode"
      >
        {KANBAN_PERMISSION_MODES.map((mode) => (
          <option key={mode.value} value={mode.value}>
            {mode.label}
          </option>
        ))}
      </select>
    );
  };

  const handleGenerateFields = async () => {
    if (!title.trim()) {
      setError('Enter a title first, then generate description & prompt');
      return;
    }
    setGenerating(true);
    setError(null);
    try {
      try {
        localStorage.setItem(GENERATE_PROVIDER_KEY, generateProvider);
      } catch {
        // ignore storage failures
      }
      const result = await kanbanApi.generateTaskFields({
        title: title.trim(),
        description: description.trim() || undefined,
        prompt: prompt.trim() || undefined,
        provider: generateProvider,
        projectId: projectId || null,
      });
      if (result.description) {
        setDescription(result.description);
      }
      if (result.prompt) {
        setPrompt(result.prompt);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to generate task fields');
    } finally {
      setGenerating(false);
    }
  };

  const handleSave = async () => {
    if (!title.trim()) {
      setError('Title is required');
      return;
    }
    if (requireProject && !projectId) {
      setError('Pick a project for this task');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const common = {
        title: title.trim(),
        description,
        prompt,
        assigneeProvider: assignee === '' ? null : assignee,
        reviewProvider: reviewAgent === '' ? null : reviewAgent,
        implementProfileId: implementProfileId || null,
        reviewProfileId: reviewProfileId || null,
        permissionMode: resolvePermissionMode(),
        tools: buildTools(),
        scheduleCron: scheduleCron.trim() ? scheduleCron.trim() : null,
        dueDate: dueDate ? new Date(`${dueDate}T00:00:00`).toISOString() : null,
        ...(projectId ? { projectId } : {}),
      };
      if (task) {
        await props.onUpdate(task.task_id, { ...common, columnId });
      } else {
        const created = await props.onCreate({ ...common, columnId });
        // Apply draft dependency links after the task exists.
        if (created?.task_id && draftDependsOn.length > 0) {
          for (const depId of draftDependsOn) {
            await props.onAddDependency(created.task_id, depId);
          }
        }
      }
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save task');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!task) {
      return;
    }
    setSaving(true);
    try {
      await props.onDelete(task.task_id);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete task');
      setSaving(false);
    }
  };

  const handleRun = async () => {
    if (!task || !props.onRun) {
      return;
    }
    setRunning(true);
    setError(null);
    try {
      await props.onRun(task.task_id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to run task');
    } finally {
      setRunning(false);
    }
  };

  const toggleDependency = async (dependsOnTaskId: string, checked: boolean) => {
    setError(null);
    // New tasks: keep links in local draft until save.
    if (!task) {
      setDraftDependsOn((prev) => {
        if (checked) {
          return prev.includes(dependsOnTaskId) ? prev : [...prev, dependsOnTaskId];
        }
        return prev.filter((id) => id !== dependsOnTaskId);
      });
      return;
    }
    try {
      if (checked) {
        await props.onAddDependency(task.task_id, dependsOnTaskId);
      } else {
        await props.onRemoveDependency(task.task_id, dependsOnTaskId);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update dependency');
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (!next ? onClose() : undefined)}>
      <DialogContent
        className="z-50 flex h-dvh max-h-dvh w-full max-w-none flex-col overflow-hidden rounded-none border-0 p-0 shadow-none sm:h-auto sm:max-h-[85vh] sm:max-w-xl sm:rounded-xl sm:border sm:shadow-lg"
        onEscapeKeyDown={onClose}
        onPointerDownOutside={onClose}
      >
        <DialogTitle>{isEdit ? 'Edit task' : 'New task'}</DialogTitle>
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex flex-shrink-0 items-center justify-between border-b border-border px-4 py-3 pt-[max(0.75rem,env(safe-area-inset-top))] md:pt-3">
            <h3 className="text-sm font-semibold">{isEdit ? 'Edit task' : 'New task'}</h3>
            {isEdit && props.onRun ? (
              <Button size="sm" variant="secondary" className="touch-manipulation" onClick={handleRun} disabled={running}>
                {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
                Run
              </Button>
            ) : null}
          </div>

          <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-4">
            <div className="flex flex-col gap-1">
              <label className={labelClass} htmlFor="kanban-title">
                Title
              </label>
              <Input
                id="kanban-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Task title"
              />
            </div>

            <div className="rounded-md border border-border bg-muted/30 p-3">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <label className={labelClass} htmlFor="kanban-generate-provider">
                    Generate with
                  </label>
                  <select
                    id="kanban-generate-provider"
                    className={selectClass}
                    value={generateProvider}
                    onChange={(e) => setGenerateProvider(e.target.value as LLMProvider)}
                    disabled={generating}
                  >
                    {KANBAN_PROVIDERS.map((p) => (
                      <option key={p.value} value={p.value}>
                        {p.label}
                      </option>
                    ))}
                  </select>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  className="shrink-0 touch-manipulation"
                  onClick={() => void handleGenerateFields()}
                  disabled={generating || !title.trim()}
                  title={
                    title.trim()
                      ? 'Generate exhaustive description and implementer prompt'
                      : 'Enter a title first'
                  }
                >
                  {generating ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Sparkles className="h-4 w-4" />
                  )}
                  {generating ? 'Generating…' : 'Generate description & prompt'}
                </Button>
              </div>
              <p className="mt-2 text-[11px] text-muted-foreground">
                Uses the selected provider to expand the title into an exhaustive description and a
                ready-to-run agent prompt. Existing text is refined rather than discarded.
              </p>
            </div>

            <div className="flex flex-col gap-1">
              <label className={labelClass} htmlFor="kanban-description">
                Description
              </label>
              <textarea
                id="kanban-description"
                className={textareaClass}
                rows={6}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Exhaustive task brief (or generate from title)"
              />
            </div>

            <div className="flex flex-col gap-1">
              <label className={labelClass} htmlFor="kanban-prompt">
                Prompt (sent to the agent on run)
              </label>
              <textarea
                id="kanban-prompt"
                className={textareaClass}
                rows={6}
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="Describe what the agent should do (or generate from title)"
              />
            </div>

            {requireProject || projects.length > 0 ? (
              <div className="flex flex-col gap-1">
                <label className={labelClass} htmlFor="kanban-project">
                  Project
                </label>
                <select
                  id="kanban-project"
                  className={selectClass}
                  value={projectId}
                  onChange={(e) => {
                    skillsTouchedRef.current = false;
                    setSkillsSelected([]);
                    setProjectId(e.target.value);
                  }}
                >
                  <option value="">{requireProject ? 'Select a project…' : 'None'}</option>
                  {projects.map((project) => (
                    <option key={project.projectId} value={project.projectId}>
                      {project.displayName}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}

            <div className="space-y-2 rounded-md border border-border p-3">
              <div>
                <p className="text-xs font-medium text-foreground">MCP servers for this task</p>
                <p className="text-[11px] text-muted-foreground">
                  Steer the agent to the correct integrations. Expanded into allow-list patterns at
                  run time for Claude / Cursor / Grok.
                </p>
              </div>
              {!mcpProvider ? (
                <p className="text-[11px] text-muted-foreground">
                  Assign an implementation agent/profile to load MCP servers for that provider.
                </p>
              ) : mcpLoading ? (
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading MCP servers…
                </div>
              ) : mcpOptions.length === 0 ? (
                <p className="text-[11px] text-muted-foreground">
                  No MCP servers found. Configure them in Settings → MCP.
                </p>
              ) : (
                <div className="flex max-h-36 flex-wrap gap-1.5 overflow-y-auto">
                  {mcpOptions.map((name) => {
                    const selected = mcpServersSelected.includes(name);
                    return (
                      <button
                        key={name}
                        type="button"
                        className={cn(
                          'rounded-full border px-2.5 py-1 text-[11px] transition-colors',
                          selected
                            ? 'border-primary bg-primary/10 text-primary'
                            : 'border-border bg-background text-muted-foreground hover:border-primary/40',
                        )}
                        onClick={() =>
                          toggleInList(mcpServersSelected, setMcpServersSelected, name)
                        }
                      >
                        {name}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="space-y-2 rounded-md border border-border p-3">
              <div>
                <p className="text-xs font-medium text-foreground">Project skills</p>
                <p className="text-[11px] text-muted-foreground">
                  When a project has skills, they are selected by default so the agent gets
                  do/don&apos;t context. Deselect any you do not want for this task.
                </p>
              </div>
              {!projectId ? (
                <p className="text-[11px] text-muted-foreground">
                  Attach a project to load and select project skills.
                </p>
              ) : skillsLoading ? (
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading project skills…
                </div>
              ) : projectSkillOptions.length === 0 ? (
                <p className="text-[11px] text-muted-foreground">
                  No managed project skills found for this workspace.
                </p>
              ) : (
                <div className="flex max-h-36 flex-col gap-1.5 overflow-y-auto">
                  {projectSkillOptions.map((skill) => {
                    const selected = skillsSelected.includes(skill.directoryName);
                    return (
                      <label
                        key={skill.directoryName}
                        className={cn(
                          'flex cursor-pointer items-start gap-2 rounded-md border px-2 py-1.5 text-xs',
                          selected ? 'border-primary/40 bg-primary/5' : 'border-border',
                        )}
                      >
                        <input
                          type="checkbox"
                          className="mt-0.5"
                          checked={selected}
                          onChange={() => {
                            skillsTouchedRef.current = true;
                            toggleInList(skillsSelected, setSkillsSelected, skill.directoryName);
                          }}
                        />
                        <span className="min-w-0">
                          <span className="font-medium text-foreground">
                            {skill.name || skill.directoryName}
                          </span>
                          {skill.description ? (
                            <span className="mt-0.5 line-clamp-2 block text-[11px] text-muted-foreground">
                              {skill.description}
                            </span>
                          ) : null}
                        </span>
                      </label>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="flex flex-col gap-1">
              <label className={labelClass} htmlFor="kanban-column">
                Column
              </label>
              <select
                id="kanban-column"
                className={selectClass}
                value={columnId}
                onChange={(e) => setColumnId(e.target.value)}
              >
                {columns.map((col) => (
                  <option key={col.id} value={col.id}>
                    {col.name}
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-3 rounded-md border border-border p-3">
              <div>
                <p className="text-xs font-medium text-foreground">Agents</p>
                <p className="text-[11px] text-muted-foreground">
                  Pick a saved profile from Settings → Agent profiles. Profiles include model,
                  effort, and permissions.
                </p>
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="flex flex-col gap-1.5">
                  <label className={labelClass} htmlFor="kanban-implement-profile">
                    Implementation
                  </label>
                  <select
                    id="kanban-implement-profile"
                    className={selectClass}
                    value={implementProfileId}
                    onChange={(e) => applyImplementProfile(e.target.value)}
                  >
                    <option value="">Unassigned</option>
                    {profiles.map((profile) => (
                      <option key={profile.profile_id} value={profile.profile_id}>
                        {profile.name}
                      </option>
                    ))}
                  </select>
                  {implementProfile ? (
                    <div className="rounded-md bg-muted/50 px-2 py-1.5 text-[11px] leading-snug text-muted-foreground">
                      <span className="font-medium text-foreground/80">{implementProfile.name}</span>
                      <br />
                      {profileSummary(implementProfile)}
                      <br />
                      <span className="text-muted-foreground/80">
                        Runs when the card moves to In Progress.
                      </span>
                    </div>
                  ) : (
                    <p className="text-[11px] text-muted-foreground">
                      Required for auto-run. Create profiles in Settings if the list is empty.
                    </p>
                  )}
                </div>

                <div className="flex flex-col gap-1.5">
                  <label className={labelClass} htmlFor="kanban-review-profile">
                    Review
                  </label>
                  <select
                    id="kanban-review-profile"
                    className={selectClass}
                    value={reviewProfileId}
                    onChange={(e) => applyReviewProfile(e.target.value)}
                  >
                    <option value="">None — skip review</option>
                    {profiles.map((profile) => (
                      <option key={profile.profile_id} value={profile.profile_id}>
                        {profile.name}
                      </option>
                    ))}
                  </select>
                  {reviewProfile ? (
                    <div className="rounded-md bg-muted/50 px-2 py-1.5 text-[11px] leading-snug text-muted-foreground">
                      <span className="font-medium text-foreground/80">{reviewProfile.name}</span>
                      <br />
                      {profileSummary(reviewProfile)}
                      <br />
                      <span className="text-muted-foreground/80">
                        Runs after implementation succeeds.
                      </span>
                    </div>
                  ) : (
                    <p className="text-[11px] text-muted-foreground">
                      Optional. Leave as None to go straight to Done after implement.
                    </p>
                  )}
                </div>
              </div>

              <div className="border-t border-border/70 pt-2">
                <button
                  type="button"
                  className="text-[11px] font-medium text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                  onClick={() => setShowAdvancedAgents((v) => !v)}
                >
                  {showAdvancedAgents ? 'Hide' : 'Show'} advanced: provider without a profile
                </button>
                {showAdvancedAgents ? (
                  <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <div className="flex flex-col gap-1">
                      <label className={labelClass} htmlFor="kanban-assignee">
                        Implementation provider
                      </label>
                      <select
                        id="kanban-assignee"
                        className={selectClass}
                        value={assignee}
                        onChange={(e) => {
                          setAssignee(e.target.value as LLMProvider | '');
                          if (e.target.value) setImplementProfileId('');
                        }}
                        disabled={Boolean(implementProfileId)}
                      >
                        <option value="">Unassigned</option>
                        {KANBAN_PROVIDERS.map((provider) => (
                          <option key={provider.value} value={provider.value}>
                            {provider.label}
                          </option>
                        ))}
                      </select>
                      {implementProfileId ? (
                        <p className="text-[11px] text-muted-foreground">
                          Using profile — clear the profile above to pick a raw provider.
                        </p>
                      ) : null}
                    </div>
                    <div className="flex flex-col gap-1">
                      <label className={labelClass} htmlFor="kanban-review">
                        Review provider
                      </label>
                      <select
                        id="kanban-review"
                        className={selectClass}
                        value={reviewAgent}
                        onChange={(e) => {
                          setReviewAgent(e.target.value as LLMProvider | '');
                          if (e.target.value) setReviewProfileId('');
                        }}
                        disabled={Boolean(reviewProfileId)}
                      >
                        <option value="">None</option>
                        {KANBAN_PROVIDERS.map((provider) => (
                          <option key={provider.value} value={provider.value}>
                            {provider.label}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                ) : null}
              </div>
            </div>

            <div className="flex flex-col gap-1">
              <label className={labelClass} htmlFor="kanban-cron">
                Schedule (cron)
              </label>
              <Input
                id="kanban-cron"
                value={scheduleCron}
                onChange={(e) => setScheduleCron(e.target.value)}
                placeholder="e.g. 0 9 * * 1"
              />
            </div>

            <div className="flex flex-col gap-1">
              <label className={labelClass} htmlFor="kanban-due">
                Due date
              </label>
              <Input
                id="kanban-due"
                type="date"
                value={dueDate}
                onChange={(e) => setDueDate(e.target.value)}
                className="h-9"
              />
              <p className="text-[11px] leading-snug text-muted-foreground">
                Overdue cards are flagged and escalated in the notification inbox.
              </p>
            </div>

            <div className="flex flex-col gap-2 rounded-md border border-border p-3">
              <span className={labelClass}>
                Permissions
                {implementProfile
                  ? ` — profile “${implementProfile.name}”`
                  : assignee
                    ? ` — ${assignee}`
                    : ''}
              </span>
              {implementProfileId ? (
                <p className="text-xs text-muted-foreground">
                  Permissions come from the selected profile (Settings → Agent profiles). Edit the
                  profile to change allow/deny rules for this and other tasks.
                </p>
              ) : showAdvancedAgents && assignee ? (
                renderPermissions()
              ) : (
                <p className="text-xs text-muted-foreground">
                  Select an implementation profile, or use advanced provider assignment, to set
                  permissions.
                </p>
              )}
            </div>

            <div className="flex flex-col gap-2 rounded-md border border-border p-3">
              <div className="flex items-start gap-2">
                <GitBranch className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-medium text-foreground">Depends on (linked tasks)</p>
                  <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
                    This task stays blocked until every linked task is <strong className="font-medium text-foreground/80">done</strong>.
                    Then it moves to In Progress and <strong className="font-medium text-foreground/80">auto-runs</strong> if it has an
                    implementation agent/profile.
                  </p>
                </div>
              </div>

              {selectedDependsOn.length > 0 ? (
                <div className="flex flex-wrap gap-1">
                  {selectedDependsOn.map((depId) => {
                    const dep = allTasks.find((t) => t.task_id === depId);
                    return (
                      <Badge
                        key={depId}
                        variant="outline"
                        className={cn(
                          'max-w-full gap-1 font-normal',
                          dep ? STATUS_BADGE[dep.status] : '',
                        )}
                        title={dep ? `${dep.title} · ${dep.status}` : depId}
                      >
                        <span className="truncate">{dep?.title ?? depId.slice(0, 8)}</span>
                        {dep ? (
                          <span className="shrink-0 opacity-70">· {dep.status}</span>
                        ) : null}
                      </Badge>
                    );
                  })}
                </div>
              ) : null}

              {allTasks.filter((t) => t.task_id !== task?.task_id).length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  No other tasks on this board yet. Create more tasks to link them.
                </p>
              ) : (
                <>
                  <div className="relative">
                    <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      value={depSearch}
                      onChange={(e) => setDepSearch(e.target.value)}
                      placeholder="Search tasks to link…"
                      className="h-8 pl-8 text-xs"
                    />
                  </div>
                  <div className="max-h-40 overflow-y-auto rounded-md border border-border p-1">
                    {dependencyOptions.length === 0 ? (
                      <p className="px-2 py-1.5 text-xs text-muted-foreground">No matches.</p>
                    ) : (
                      dependencyOptions.map((option) => {
                        const checked = selectedDependsOn.includes(option.task_id);
                        return (
                          <label
                            key={option.task_id}
                            className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-accent"
                          >
                            <input
                              type="checkbox"
                              className="shrink-0"
                              checked={checked}
                              onChange={(e) => toggleDependency(option.task_id, e.target.checked)}
                            />
                            <span className="min-w-0 flex-1 truncate">{option.title}</span>
                            <Badge
                              variant="secondary"
                              className={cn(
                                'shrink-0 px-1.5 py-0 text-[10px] font-normal',
                                STATUS_BADGE[option.status],
                              )}
                            >
                              {option.status}
                            </Badge>
                            {projectNameById?.get(option.project_id) ? (
                              <span className="hidden max-w-20 shrink-0 truncate text-[10px] text-muted-foreground sm:inline">
                                {projectNameById.get(option.project_id)}
                              </span>
                            ) : null}
                          </label>
                        );
                      })
                    )}
                  </div>
                </>
              )}

              {isEdit && dependents.length > 0 ? (
                <div className="border-t border-border pt-2">
                  <p className="text-[11px] font-medium text-muted-foreground">
                    Unlocks when done ({dependents.length})
                  </p>
                  <ul className="mt-1 space-y-0.5">
                    {dependents.map((d) => (
                      <li key={d.task_id} className="truncate text-xs text-foreground/80">
                        → {d.title}
                        {!d.assignee_provider && !d.implement_profile_id ? (
                          <span className="text-muted-foreground"> (no agent — won’t auto-run)</span>
                        ) : (
                          <span className="text-muted-foreground"> (will auto-run)</span>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>

            {isEdit && task ? (
              <div className="flex flex-col gap-1 border-t border-border pt-3">
                <span className={labelClass}>Run</span>
                <div className="rounded-md border border-border/60 bg-muted/20 px-2.5 py-2 text-[11px] text-muted-foreground">
                  <p className="flex items-start gap-1.5">
                    <FolderGit2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-sky-600 dark:text-sky-400" />
                    <span>
                      Each agent run gets its own <strong className="font-medium text-foreground">git worktree</strong> and feature branch so the main project folder stays clean. Worktrees appear under Source Control → Workspaces after a run starts.
                    </span>
                  </p>
                  {task.workspace_id ? (
                    <p className="mt-1.5 truncate font-mono text-[10px] text-sky-700 dark:text-sky-300" title={task.workspace_id}>
                      Active workspace: {task.workspace_id}
                    </p>
                  ) : (
                    <p className="mt-1.5 text-[10px]">No worktree yet — created automatically on the next agent run.</p>
                  )}
                </div>
                {task.feature_branch ? (
                  <p className="flex items-center gap-1 text-xs text-muted-foreground">
                    <GitBranch className="h-3 w-3 shrink-0" />
                    <span className="truncate" title={task.feature_branch}>
                      Branch: {task.feature_branch}
                    </span>
                  </p>
                ) : null}
                {task.last_run_at ? (
                  <p className="text-xs text-muted-foreground">
                    Last run {new Date(task.last_run_at).toLocaleString()}
                    {task.last_exit_code !== null ? ` · exit ${task.last_exit_code}` : ''}
                  </p>
                ) : null}
                <TaskRunOutput
                  sessionId={task.app_session_id}
                  isRunning={task.status === 'running'}
                  provider={
                    (task.column_id === 'review'
                      ? task.review_provider
                      : task.assignee_provider) ??
                    task.assignee_provider ??
                    task.review_provider ??
                    'claude'
                  }
                />
              </div>
            ) : null}

            {isEdit && task ? (
              <TaskComments
                taskId={task.task_id}
                refreshSignal={`${task.status}:${task.updated_at}`}
              />
            ) : null}

            {isEdit && task?.project_id ? (
              <ContextPackPanel
                projectId={task.project_id}
                taskId={task.task_id}
                title={task.title}
                sessionId={task.app_session_id}
              />
            ) : null}

            {error ? <p className="text-sm text-destructive">{error}</p> : null}
          </div>

          <div
            className={cn(
              'flex flex-shrink-0 items-center gap-2 border-t border-border px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] md:pb-3',
              isEdit ? 'justify-between' : 'justify-end',
            )}
          >
            {isEdit ? (
              <Button
                variant="ghost"
                size="sm"
                className="touch-manipulation text-destructive"
                onClick={handleDelete}
                disabled={saving}
              >
                <Trash2 className="h-4 w-4" />
                Delete
              </Button>
            ) : null}
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                className="touch-manipulation"
                onClick={onClose}
                disabled={saving || generating}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                className="touch-manipulation"
                onClick={handleSave}
                disabled={saving || generating}
              >
                {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                {isEdit ? 'Save' : 'Create'}
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
