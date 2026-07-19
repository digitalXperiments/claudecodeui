import { useEffect, useMemo, useState } from 'react';
import { Loader2, Play, Trash2 } from 'lucide-react';

import { Button, Dialog, DialogContent, DialogTitle, Input } from '../../../shared/view/ui';
import { cn } from '../../../lib/utils';
import type { LLMProvider } from '../../../types/app';
import {
  KANBAN_PERMISSION_MODES,
  KANBAN_PROVIDERS,
  type KanbanColumn,
  type KanbanTask,
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
  onClose: () => void;
  onCreate: (input: {
    columnId?: string;
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

function linesToArray(value: string): string[] {
  return value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function arrayToLines(value: string[] | undefined): string {
  return (value ?? []).join('\n');
}

export default function TaskEditor(props: TaskEditorProps) {
  const { open, task, draft, columns, allTasks, onClose } = props;
  const isEdit = Boolean(task);

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [prompt, setPrompt] = useState('');
  const [columnId, setColumnId] = useState('');
  const [assignee, setAssignee] = useState<LLMProvider | ''>('');
  const [permissionMode, setPermissionMode] = useState('default');
  const [allowed, setAllowed] = useState('');
  const [disallowed, setDisallowed] = useState('');
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
      setColumnId(task.column_id);
      setAssignee(task.assignee_provider ?? '');
      setPermissionMode(task.permission_mode || 'default');
      setAllowed(arrayToLines(task.tools?.allowedCommands));
      setDisallowed(arrayToLines(task.tools?.disallowedCommands));
      setScheduleCron(task.schedule_cron ?? '');
    } else {
      setTitle('');
      setDescription('');
      setPrompt('');
      setColumnId(draft?.columnId ?? columns[0]?.id ?? '');
      setAssignee('');
      setPermissionMode('default');
      setAllowed('');
      setDisallowed('');
      setScheduleCron('');
    }
  }, [open, task, draft, columns]);

  const dependencyOptions = useMemo(
    () => allTasks.filter((t) => t.task_id !== task?.task_id),
    [allTasks, task?.task_id],
  );

  const buildTools = () => {
    const allowedCommands = linesToArray(allowed);
    const disallowedCommands = linesToArray(disallowed);
    const tools: { allowedCommands?: string[]; disallowedCommands?: string[] } = {};
    if (allowedCommands.length > 0) {
      tools.allowedCommands = allowedCommands;
    }
    if (disallowedCommands.length > 0) {
      tools.disallowedCommands = disallowedCommands;
    }
    return tools;
  };

  const handleSave = async () => {
    if (!title.trim()) {
      setError('Title is required');
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
        permissionMode,
        tools: buildTools(),
        scheduleCron: scheduleCron.trim() ? scheduleCron.trim() : null,
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

            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1">
                <label className={labelClass} htmlFor="kanban-permission">
                  Permission mode
                </label>
                <select
                  id="kanban-permission"
                  className={selectClass}
                  value={permissionMode}
                  onChange={(e) => setPermissionMode(e.target.value)}
                >
                  {KANBAN_PERMISSION_MODES.map((mode) => (
                    <option key={mode.value} value={mode.value}>
                      {mode.label}
                    </option>
                  ))}
                </select>
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
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1">
                <label className={labelClass} htmlFor="kanban-allowed">
                  Allowed commands (one per line)
                </label>
                <textarea
                  id="kanban-allowed"
                  className={textareaClass}
                  rows={3}
                  value={allowed}
                  onChange={(e) => setAllowed(e.target.value)}
                  placeholder="Bash(ls)"
                />
              </div>
              <div className="flex flex-col gap-1">
                <label className={labelClass} htmlFor="kanban-disallowed">
                  Disallowed commands (one per line)
                </label>
                <textarea
                  id="kanban-disallowed"
                  className={textareaClass}
                  rows={3}
                  value={disallowed}
                  onChange={(e) => setDisallowed(e.target.value)}
                  placeholder="Bash(rm)"
                />
              </div>
            </div>

            {isEdit ? (
              <div className="flex flex-col gap-1">
                <span className={labelClass}>Depends on</span>
                {dependencyOptions.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No other tasks to depend on.</p>
                ) : (
                  <div className="max-h-32 overflow-y-auto rounded-md border border-border p-2">
                    {dependencyOptions.map((option) => {
                      const checked = task?.dependsOn.includes(option.task_id) ?? false;
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
                <TaskRunOutput sessionId={task.app_session_id} isRunning={task.status === 'running'} />
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
