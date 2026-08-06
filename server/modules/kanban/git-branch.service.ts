// cross-spawn: drop-in spawn with Windows .cmd/PATHEXT resolution.
import spawn from 'cross-spawn';

import type { KanbanTask } from '@/modules/kanban/kanban.types.js';

type GitResult = { code: number | null; stdout: string; stderr: string };

/**
 * Run a git command synchronously inside `projectPath`. Spawn-sync (rather than
 * async) keeps `kanbanRunner.runTask`'s synchronous pre-start section intact —
 * the run queue relies on the run *starting* synchronously before the queue
 * call returns, so an awaited git round-trip would change task-queue timing.
 */
function runGitSync(projectPath: string, args: string[]): GitResult {
  try {
    const result = spawn.sync('git', args, { cwd: projectPath, encoding: 'utf8' });
    return {
      code: result.status,
      stdout: String(result.stdout ?? ''),
      stderr: String(result.stderr ?? ''),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { code: null, stdout: '', stderr: message };
  }
}

/** `Fix the checkout bug` → `fix-the-checkout-bug` (≤ 40 chars, dashed). */
function slugifyTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 40);
}

/**
 * Ensure an implementation run has a dedicated feature branch, creating one if
 * the task doesn't reference one yet. Best-effort: if the project isn't a git
 * repo, the branch already exists, or the checkout fails (dirty worktree, …),
 * the run is NOT affected — we log and skip.
 *
 * Returns the branch name when the task is now on it, otherwise null.
 */
export function ensureFeatureBranch(projectPath: string, task: KanbanTask): string | null {
  try {
    const inside = runGitSync(projectPath, ['rev-parse', '--is-inside-work-tree']);
    if (inside.code !== 0) {
      // Not a git repo — skip silently (noisy setups would log on every run).
      return null;
    }

    const branch = `feat/${task.task_id}-${slugifyTitle(task.title)}`;
    const create = runGitSync(projectPath, ['checkout', '-b', branch]);
    if (create.code === 0) {
      return branch;
    }
    if (create.stderr.toLowerCase().includes('already exists')) {
      const checkout = runGitSync(projectPath, ['checkout', branch]);
      if (checkout.code === 0) {
        return branch;
      }
    }
    console.warn('[Kanban] could not create feature branch; continuing on current branch', {
      taskId: task.task_id,
      branch,
      stderr: create.stderr.slice(0, 300),
    });
    return null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn('[Kanban] feature branch creation skipped', { taskId: task.task_id, error: message });
    return null;
  }
}
