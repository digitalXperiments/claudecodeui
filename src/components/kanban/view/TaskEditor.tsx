import { useEffect, useMemo, useState } from 'react';
import { Loader2, Play, Trash2 } from 'lucide-react';

import { Button, Dialog, DialogContent, DialogTitle, Input } from '../../../shared/view/ui';
import { cn } from '../../../lib/utils';
import type { LLMProvider } from '../../../types/app';
import PermissionsContent from '../../settings/view/tabs/agents-settings/sections/content/PermissionsContent';
import type { AgyPermissionMode, CodexPermissionMode } from '../../settings/types/types';
import {
  KANBAN_PERMISSION_MODES,
  KANBAN_PROVIDERS,
  type KanbanColumn,
  type KanbanTask,
  type ProjectRef,
} from '../types';
import type { TaskPatch } from '../api/kanbanApi';

import TaskRunOutput from './TaskRunOutput';

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
    permissionMode?: string;
    tools?: { allowedCommands?: string[]; disallowedCommands?: string[] };
    scheduleCron?: string | null;
  }) => Promise<void>;
  onUpdate: (taskId: string, patch: TaskPatch) => Promise<void>;
  onDelete: (taskId: string) => Promise<void>;
  onAddDependency: (taskId: string, dependsOnTaskId: string) => Promise<void>;
  onRemoveDependency: (taskId: string, dependsOnTaskId: string) => Promise<void>;
  onRun?: (taskId: string) => Promise<void>;
};

const labelClass = 'text-xs font-medium text-muted-foreground';
const selectClass =
  'h-9 w-full rounded-md border border-input bg-background px-3 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring';
const textareaClass =
  'w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring';

const CODEX_MODES: CodexPermissionMode[] = ['default', 'acceptEdits', 'bypassPermissions'];
const AGY_MODES: AgyPermissionMode[] = ['plan', 'acceptEdits', 'bypassPermissions'];

/** Providers with a dedicated allow/deny editor (share the settings UI). */
const ALLOW_DENY_PROVIDERS: LLMProvider[] = ['claude', 'cursor', 'grok'];

function coerceCodexMode(mode: string): CodexPermissionMode {
  return CODEX_MODES.includes(mode as CodexPermissionMode) ? (mode as CodexPermissionMode) : 'default';
}

function coerceAgyMode(mode: string): AgyPermissionMode {
  return AGY_MODES.includes(mode as AgyPermissionMode) ? (mode as AgyPermissionMode) : 'bypassPermissions';
}

export default function TaskEditor(props: TaskEditorProps) {
  const { open, task, draft, columns, allTasks, projects, requireProject, projectNameById, onClose } =
    props;
  const isEdit = Boolean(task);

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [prompt, setPrompt] = useState('');
  const [projectId, setProjectId] = useState('');
  const [columnId, setColumnId] = useState('');
  const [assignee, setAssignee] = useState<LLMProvider | ''>('');
  const [permissionMode, setPermissionMode] = useState('default');
  const [skipPermissions, setSkipPermissions] = useState(false);
  const [allowed, setAllowed] = useState<string[]>([]);
  const [disallowed, setDisallowed] = useState<string[]>([]);
  const [scheduleCron, setScheduleCron] = useState('');
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset local form state whenever the target task/draft changes.
  useEffect(() => {
    if (!open) {
      return;
    }
    setError(null);
    if (task) {
      setTitle(task.title);
      setDescription(task.description ?? '');
      setPrompt(task.prompt ?? '');
      setProjectId(task.project_id ?? '');
      setColumnId(task.column_id);
      setAssignee(task.assignee_provider ?? '');
      setPermissionMode(task.permission_mode || 'default');
      setSkipPermissions((task.permission_mode || 'default') === 'bypassPermissions');
      setAllowed(task.tools?.allowedCommands ?? []);
      setDisallowed(task.tools?.disallowedCommands ?? []);
      setScheduleCron(task.schedule_cron ?? '');
    } else {
      setTitle('');
      setDescription('');
      setPrompt('');
      setProjectId(projects.length === 1 ? projects[0].projectId : '');
      setColumnId(draft?.columnId ?? columns[0]?.id ?? '');
      setAssignee('');
      setPermissionMode('default');
      setSkipPermissions(false);
      setAllowed([]);
      setDisallowed([]);
      setScheduleCron('');
    }
  }, [open, task, draft, columns, projects]);

  const dependencyOptions = useMemo(
    () => allTasks.filter((t) => t.task_id !== task?.task_id),
    [allTasks, task?.task_id],
  );

  const usesAllowDeny = assignee !== '' && ALLOW_DENY_PROVIDERS.includes(assignee);

  const buildTools = () => {
    const tools: { allowedCommands?: string[]; disallowedCommands?: string[] } = {};
    if (allowed.length > 0) {
      tools.allowedCommands = allowed;
    }
    if (disallowed.length > 0) {
      tools.disallowedCommands = disallowed;
    }
    return tools;
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
        permissionMode: resolvePermissionMode(),
        tools: buildTools(),
        scheduleCron: scheduleCron.trim() ? scheduleCron.trim() : null,
        ...(projectId ? { projectId } : {}),
      };
      if (task) {
        await props.onUpdate(task.task_id, { ...common, columnId });
      } else {
        await props.onCreate({ ...common, columnId });
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
    if (!task) {
      return;
    }
    setError(null);
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
      <DialogContent className="max-w-xl" onEscapeKeyDown={onClose} onPointerDownOutside={onClose}>
        <DialogTitle>{isEdit ? 'Edit task' : 'New task'}</DialogTitle>
        <div className="flex max-h-[85vh] flex-col">
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <h3 className="text-sm font-semibold">{isEdit ? 'Edit task' : 'New task'}</h3>
            {isEdit && props.onRun ? (
              <Button size="sm" variant="secondary" onClick={handleRun} disabled={running}>
                {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
                Run
              </Button>
            ) : null}
          </div>

          <div className="flex flex-col gap-3 overflow-y-auto px-4 py-4">
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

            <div className="flex flex-col gap-1">
              <label className={labelClass} htmlFor="kanban-description">
                Description
              </label>
              <textarea
                id="kanban-description"
                className={textareaClass}
                rows={2}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Optional notes"
              />
            </div>

            <div className="flex flex-col gap-1">
              <label className={labelClass} htmlFor="kanban-prompt">
                Prompt (sent to the agent on run)
              </label>
              <textarea
                id="kanban-prompt"
                className={textareaClass}
                rows={4}
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="Describe what the agent should do"
              />
            </div>

            {requireProject ? (
              <div className="flex flex-col gap-1">
                <label className={labelClass} htmlFor="kanban-project">
                  Project
                </label>
                <select
                  id="kanban-project"
                  className={selectClass}
                  value={projectId}
                  onChange={(e) => setProjectId(e.target.value)}
                >
                  <option value="">Select a project…</option>
                  {projects.map((project) => (
                    <option key={project.projectId} value={project.projectId}>
                      {project.displayName}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}

            <div className="grid grid-cols-2 gap-3">
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

              <div className="flex flex-col gap-1">
                <label className={labelClass} htmlFor="kanban-assignee">
                  Agent
                </label>
                <select
                  id="kanban-assignee"
                  className={selectClass}
                  value={assignee}
                  onChange={(e) => setAssignee(e.target.value as LLMProvider | '')}
                >
                  <option value="">Unassigned</option>
                  {KANBAN_PROVIDERS.map((provider) => (
                    <option key={provider.value} value={provider.value}>
                      {provider.label}
                    </option>
                  ))}
                </select>
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

            <div className="flex flex-col gap-2 rounded-md border border-border p-3">
              <span className={labelClass}>
                Permissions{assignee ? ` — ${assignee}` : ''}
              </span>
              {renderPermissions()}
            </div>

            {isEdit ? (
              <div className="flex flex-col gap-1">
                <span className={labelClass}>Depends on</span>
                {dependencyOptions.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No other tasks to depend on.</p>
                ) : (
                  <div className="max-h-32 overflow-y-auto rounded-md border border-border p-2">
                    {dependencyOptions.map((option) => {
                      const checked = task?.dependsOn?.includes(option.task_id) ?? false;
                      return (
                        <label
                          key={option.task_id}
                          className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 text-sm hover:bg-accent"
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={(e) => toggleDependency(option.task_id, e.target.checked)}
                          />
                          <span className="truncate">{option.title}</span>
                          {projectNameById && projectNameById.get(option.project_id) ? (
                            <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                              {projectNameById.get(option.project_id)}
                            </span>
                          ) : null}
                        </label>
                      );
                    })}
                  </div>
                )}
              </div>
            ) : null}

            {isEdit && task ? (
              <div className="flex flex-col gap-1 border-t border-border pt-3">
                <span className={labelClass}>Run</span>
                {task.last_run_at ? (
                  <p className="text-xs text-muted-foreground">
                    Last run {new Date(task.last_run_at).toLocaleString()}
                    {task.last_exit_code !== null ? ` · exit ${task.last_exit_code}` : ''}
                  </p>
                ) : null}
                <TaskRunOutput
                  sessionId={task.app_session_id}
                  isRunning={task.status === 'running'}
                  provider={task.assignee_provider ?? 'claude'}
                />
              </div>
            ) : null}

            {error ? <p className="text-sm text-destructive">{error}</p> : null}
          </div>

          <div
            className={cn(
              'flex items-center gap-2 border-t border-border px-4 py-3',
              isEdit ? 'justify-between' : 'justify-end',
            )}
          >
            {isEdit ? (
              <Button variant="ghost" size="sm" className="text-destructive" onClick={handleDelete} disabled={saving}>
                <Trash2 className="h-4 w-4" />
                Delete
              </Button>
            ) : null}
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={onClose} disabled={saving}>
                Cancel
              </Button>
              <Button size="sm" onClick={handleSave} disabled={saving}>
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
