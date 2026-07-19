import { KANBAN_PERMISSION_MODES, KANBAN_PROVIDERS, type KanbanTask } from '../types';

type PermissionMatrixProps = {
  tasks: KanbanTask[];
  onOpenTask: (task: KanbanTask) => void;
};

function providerLabel(provider: string | null | undefined): string {
  if (!provider) {
    return '—';
  }
  return KANBAN_PROVIDERS.find((p) => p.value === provider)?.label ?? provider;
}

function permissionLabel(mode: string): string {
  return KANBAN_PERMISSION_MODES.find((m) => m.value === mode)?.label ?? mode;
}

/**
 * Board-wide agents × tasks permission overview: which agents run each task and
 * under what permissions. Read-only; click a row to edit the task.
 */
export default function PermissionMatrix({ tasks, onOpenTask }: PermissionMatrixProps) {
  if (tasks.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
        No tasks yet.
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-auto p-4">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-border text-left text-xs uppercase text-muted-foreground">
            <th className="px-3 py-2 font-medium">Task</th>
            <th className="px-3 py-2 font-medium">Implement</th>
            <th className="px-3 py-2 font-medium">Review</th>
            <th className="px-3 py-2 font-medium">Permission mode</th>
            <th className="px-3 py-2 font-medium">Allowed</th>
            <th className="px-3 py-2 font-medium">Disallowed</th>
            <th className="px-3 py-2 font-medium">Schedule</th>
          </tr>
        </thead>
        <tbody>
          {tasks.map((task) => (
            <tr
              key={task.task_id}
              className="cursor-pointer border-b border-border/60 hover:bg-accent"
              onClick={() => onOpenTask(task)}
            >
              <td className="px-3 py-2 font-medium text-foreground">{task.title}</td>
              <td className="px-3 py-2">{providerLabel(task.assignee_provider)}</td>
              <td className="px-3 py-2">{providerLabel(task.review_provider)}</td>
              <td className="px-3 py-2 text-muted-foreground">
                {permissionLabel(task.permission_mode)}
              </td>
              <td className="px-3 py-2 text-muted-foreground">
                {task.tools?.allowedCommands?.length ?? 0}
              </td>
              <td className="px-3 py-2 text-muted-foreground">
                {task.tools?.disallowedCommands?.length ?? 0}
              </td>
              <td className="px-3 py-2 font-mono text-xs text-muted-foreground">
                {task.schedule_cron ?? '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
