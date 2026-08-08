/**
 * WorkspaceService (PRD §5.5) — isolated agent workspaces backed by git
 * worktrees, with a `sandbox_copy` fallback for non-git projects.
 *
 * Invariants enforced here:
 * - Path policy (§5.4): roots only under `<project>/.cloudcli/worktrees/` or
 *   `<tmpRoot>/worktrees/<project_id>/`; workspace ids are charset-validated
 *   and resolved paths prefix-checked (path traversal guard).
 * - Per-project async mutex around worktree add/remove/merge.
 * - `.cloudcli/worktrees/` kept in the project `.gitignore`.
 * - Never `git checkout` / `git switch` on the primary project path.
 */

import {
  access,
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';

import { projectsDb } from '@/modules/database/index.js';
import { broadcastSystemEvent } from '@/modules/websocket/index.js';
import { CloudError } from '@/shared/run-events.js';
import { newWorkspaceId } from '@/shared/ids.js';
import * as git from '@/modules/workspaces/workspace-git.service.js';
import { workspaceDb } from '@/modules/workspaces/workspace.repository.js';
import type {
  AgentWorkspace,
  CreateWorkspaceInput,
  DiffResult,
  DiscardOptions,
  GetDiffOptions,
  MergeResult,
  MergeStrategy,
  MergeToBaseOptions,
  WorkspaceEventHandler,
  WorkspaceEventType,
  WorkspaceMode,
  WorkspaceService,
  WorkspaceServiceOptions,
  WorkspaceStatus,
} from '@/modules/workspaces/workspace.types.js';

const GITIGNORE_ENTRY = '.cloudcli/worktrees/';
const WORKSPACE_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const WORKTREES_MARKER = `${path.sep}.cloudcli${path.sep}worktrees${path.sep}`;

/** In-process per-project mutex (promise chain) for worktree add/remove/merge. */
const projectLocks = new Map<string, Promise<void>>();

/**
 * Cross-process file lock under `<project>/.cloudcli/locks/<name>.lock`
 * (PRD §5.5). Best-effort: if the project path is missing we still use the
 * in-process mutex so single-process tests keep working.
 */
async function acquireFileLock(
  projectPath: string | null,
  lockName: string,
): Promise<() => Promise<void>> {
  if (!projectPath) {
    return async () => undefined;
  }
  const lockDir = path.join(projectPath, '.cloudcli', 'locks');
  const lockPath = path.join(lockDir, `${lockName}.lock`);
  await mkdir(lockDir, { recursive: true });
  const handle = await open(lockPath, 'w');
  try {
    await handle.writeFile(`${process.pid}\n${new Date().toISOString()}\n`);
  } catch {
    // Contents are diagnostic only.
  }
  return async () => {
    try {
      await handle.close();
    } catch {
      // ignore
    }
    try {
      await rm(lockPath, { force: true });
    } catch {
      // ignore
    }
  };
}

async function withProjectLock<T>(
  projectId: string,
  fn: () => Promise<T>,
  projectPathForFileLock?: string | null,
): Promise<T> {
  const tail = projectLocks.get(projectId) ?? Promise.resolve();
  let release!: () => void;
  const ours = new Promise<void>((resolve) => {
    release = resolve;
  });
  const newTail = tail.then(() => ours);
  projectLocks.set(projectId, newTail);
  await tail;
  const releaseFile = await acquireFileLock(projectPathForFileLock ?? null, projectId);
  try {
    return await fn();
  } finally {
    await releaseFile();
    release();
    if (projectLocks.get(projectId) === newTail) {
      projectLocks.delete(projectId);
    }
  }
}

/** `Fix the checkout bug` → `fix-the-checkout-bug` (≤ 40 chars, dashed). */
function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 40);
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

async function realpathOrSelf(target: string): Promise<string> {
  try {
    return await realpath(target);
  } catch {
    return target;
  }
}

export function createWorkspaceService(options: WorkspaceServiceOptions = {}): WorkspaceService {
  const onEvent: WorkspaceEventHandler = options.onEvent ?? (() => {});
  const tmpRoot = options.tmpRoot ?? path.resolve('tmp/cloudcli');

  const emit = (type: WorkspaceEventType, workspace: AgentWorkspace): void => {
    try {
      onEvent(type, workspace);
    } catch {
      // A broken listener must never break workspace lifecycle transitions.
    }
    broadcastSystemEvent({ kind: 'workspace_updated', workspace });
  };

  const requireWorkspace = (workspaceId: string): AgentWorkspace => {
    const workspace = workspaceDb.get(workspaceId);
    if (!workspace) {
      throw new CloudError('WORKSPACE_NOT_FOUND', `Workspace not found: ${workspaceId}`);
    }
    return workspace;
  };

  /**
   * Primary repo path for a workspace. Prefer the project registry (works for
   * tmp-fallback roots too); fall back to parsing the in-project path shape.
   */
  const resolveProjectPath = (workspace: AgentWorkspace): string => {
    const registered = projectsDb.getProjectPathById(workspace.project_id);
    if (registered) {
      return path.resolve(registered);
    }
    const markerIndex = workspace.root_path.indexOf(WORKTREES_MARKER);
    if (markerIndex > 0) {
      return workspace.root_path.slice(0, markerIndex);
    }
    throw new CloudError(
      'WORKSPACE_NOT_FOUND',
      `Cannot resolve the primary project path for workspace ${workspace.workspace_id}`,
    );
  };

  /**
   * Resolve the two allowed roots for a workspace and pick one. Preferred:
   * `<project>/.cloudcli/worktrees/<id>`; fallback `<tmpRoot>/worktrees/<pid>/<id>`
   * when the project directory is not writable. Anything else is refused.
   */
  const chooseRootPath = async (
    projectPath: string,
    projectId: string,
    workspaceId: string,
  ): Promise<string> => {
    if (!WORKSPACE_ID_PATTERN.test(workspaceId) || !WORKSPACE_ID_PATTERN.test(projectId)) {
      throw new CloudError(
        'WORKSPACE_CREATE_FAILED',
        `Refusing workspace path for unsafe id segment (project=${projectId}, workspace=${workspaceId})`,
      );
    }
    const preferred = path.resolve(projectPath, '.cloudcli', 'worktrees', workspaceId);
    const fallback = path.resolve(tmpRoot, 'worktrees', projectId, workspaceId);

    const preferredParent = path.dirname(preferred);
    try {
      await mkdir(preferredParent, { recursive: true });
      await access(preferredParent);
      return preferred;
    } catch {
      // Project directory not writable — fall back to tmp root.
    }
    try {
      await mkdir(path.dirname(fallback), { recursive: true });
      return fallback;
    } catch (error) {
      throw new CloudError(
        'WORKSPACE_CREATE_FAILED',
        `Cannot create a workspace root under either allowed root: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  };

  /** Final traversal guard: the chosen root must stay inside an allowed root. */
  const assertRootAllowed = (rootPath: string, projectPath: string, projectId: string): void => {
    const preferredRoot = path.resolve(projectPath, '.cloudcli', 'worktrees') + path.sep;
    const fallbackRoot = path.resolve(tmpRoot, 'worktrees', projectId) + path.sep;
    const resolved = path.resolve(rootPath) + path.sep;
    if (!resolved.startsWith(preferredRoot) && !resolved.startsWith(fallbackRoot)) {
      throw new CloudError(
        'WORKSPACE_CREATE_FAILED',
        `Workspace root escapes allowed roots: ${rootPath}`,
      );
    }
  };

  /** Ensure `.cloudcli/worktrees/` is gitignored in the project (§5.4). */
  const ensureWorktreesGitignored = async (projectPath: string): Promise<void> => {
    try {
      const gitignorePath = path.join(projectPath, '.gitignore');
      let existing = '';
      try {
        existing = await readFile(gitignorePath, 'utf8');
      } catch {
        // No .gitignore yet — create one below.
      }
      const covered = existing
        .split('\n')
        .map((line) => line.trim())
        .some(
          (line) =>
            line === GITIGNORE_ENTRY || line === '.cloudcli/worktrees' || line === '.cloudcli/',
        );
      if (covered) {
        return;
      }
      const block = `# CloudCLI agent workspaces\n${GITIGNORE_ENTRY}\n`;
      await writeFile(
        gitignorePath,
        existing.length > 0 ? `${existing.trimEnd()}\n${block}` : block,
      );
    } catch (error) {
      console.warn('[Workspaces] could not update .gitignore; continuing', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  /** Copy the project tree into the sandbox root, excluding heavy/nested dirs. */
  const copySandboxTree = async (projectPath: string, rootPath: string): Promise<void> => {
    // The destination is intentionally allowed to live inside the project by
    // the path policy. Node's recursive cp rejects a source→descendant copy
    // before its filter runs, so copy entries explicitly and skip the target
    // subtree before descending into it.
    const worktreesRoot = path.resolve(projectPath, '.cloudcli', 'worktrees') + path.sep;
    const destinationRoot = path.resolve(rootPath);

    const shouldSkip = (source: string): boolean => {
      const resolved = path.resolve(source);
      if (resolved === destinationRoot || resolved.startsWith(`${destinationRoot}${path.sep}`)) {
        return true;
      }
      if (resolved.startsWith(worktreesRoot)) {
        return true;
      }
      const base = path.basename(resolved);
      return base === 'node_modules' || base === '.git';
    };

    const copyEntry = async (source: string, destination: string): Promise<void> => {
      if (shouldSkip(source)) {
        return;
      }
      const info = await lstat(source);
      if (info.isSymbolicLink()) {
        // Do not reproduce links that could escape the allowed workspace root.
        return;
      }
      if (info.isDirectory()) {
        await mkdir(destination, { recursive: true });
        for (const entry of await readdir(source)) {
          await copyEntry(path.join(source, entry), path.join(destination, entry));
        }
        return;
      }
      if (info.isFile()) {
        await mkdir(path.dirname(destination), { recursive: true });
        await copyFile(source, destination);
      }
    };

    await mkdir(destinationRoot, { recursive: true });
    for (const entry of await readdir(projectPath)) {
      await copyEntry(path.join(projectPath, entry), path.join(destinationRoot, entry));
    }
  };

  /** Remove the worktree + dir; tolerates an already-missing directory. */
  const destroyWorktree = async (
    projectPath: string,
    workspace: AgentWorkspace,
  ): Promise<void> => {
    if (workspace.mode === 'sandbox_copy') {
      await rm(workspace.root_path, { recursive: true, force: true });
      return;
    }
    if (await pathExists(workspace.root_path)) {
      const removed = await git.worktreeRemove(projectPath, workspace.root_path);
      if (removed.code !== 0) {
        // Belt and braces: drop the directory even if git refused.
        await rm(workspace.root_path, { recursive: true, force: true });
      }
    }
  };

  const create = async (input: CreateWorkspaceInput): Promise<AgentWorkspace> => {
    const projectPath = path.resolve(input.projectPath);
    if (!(await pathExists(projectPath))) {
      throw new CloudError(
        'WORKSPACE_CREATE_FAILED',
        `Project path does not exist: ${projectPath}`,
      );
    }

    const workspaceId = newWorkspaceId();
    const gitRepo = await git.isGitRepo(projectPath);
    const mode: WorkspaceMode = input.mode ?? (gitRepo ? 'git_worktree' : 'sandbox_copy');
    if (mode === 'git_worktree' && !gitRepo) {
      throw new CloudError(
        'WORKSPACE_CREATE_FAILED',
        `Project is not a git repository; use sandbox_copy mode: ${projectPath}`,
      );
    }
    // sandbox_copy forced on a git repo is allowed (explicit opt-out of isolation).

    return withProjectLock(
      input.projectId,
      async () => {
      const rootPath = await chooseRootPath(projectPath, input.projectId, workspaceId);
      assertRootAllowed(rootPath, projectPath, input.projectId);

      if (mode === 'sandbox_copy') {
        await copySandboxTree(projectPath, rootPath);
        const workspace = workspaceDb.insert({
          workspace_id: workspaceId,
          project_id: input.projectId,
          run_id: input.runId ?? null,
          task_id: input.taskId ?? null,
          mode,
          root_path: rootPath,
          base_branch: '',
          base_sha: null,
          feature_branch: '',
          head_sha: null,
          status: 'active',
        });
        emit('workspace.created', workspace);
        return workspace;
      }

      const baseBranch =
        input.baseBranch ??
        ((await git.currentBranch(projectPath)) ||
          ((await git.branchExists(projectPath, 'main')) ? 'main' : 'master'));
      const baseSha = await git.revParse(projectPath, baseBranch);
      if (!baseSha) {
        throw new CloudError(
          'WORKSPACE_CREATE_FAILED',
          `Base branch not resolvable: ${baseBranch} in ${projectPath}`,
        );
      }
      const featureBranch =
        input.branchName ?? `feat/${slugify(input.taskId ?? input.runId ?? workspaceId)}`;

      const add = (await git.branchExists(projectPath, featureBranch))
        ? await git.worktreeAddExisting(projectPath, rootPath, featureBranch)
        : await git.worktreeAdd(projectPath, rootPath, featureBranch, baseSha);
      if (add.code !== 0) {
        await rm(rootPath, { recursive: true, force: true });
        throw new CloudError(
          'WORKSPACE_CREATE_FAILED',
          `git worktree add failed: ${add.stderr.trim().slice(0, 500)}`,
        );
      }
      await ensureWorktreesGitignored(projectPath);

      const workspace = workspaceDb.insert({
        workspace_id: workspaceId,
        project_id: input.projectId,
        run_id: input.runId ?? null,
        task_id: input.taskId ?? null,
        mode,
        root_path: rootPath,
        base_branch: baseBranch,
        base_sha: baseSha,
        feature_branch: featureBranch,
        head_sha: baseSha,
        status: 'active',
      });
      emit('workspace.created', workspace);
      return workspace;
      },
      projectPath,
    );
  };

  const get = (workspaceId: string): AgentWorkspace | null => workspaceDb.get(workspaceId);

  const list = (projectId: string, filter?: { status?: string[] }): AgentWorkspace[] =>
    workspaceDb.listByProject(projectId, filter);

  const refreshStatus = async (workspaceId: string): Promise<WorkspaceStatus> => {
    const workspace = requireWorkspace(workspaceId);
    const empty: WorkspaceStatus = {
      workspace_id: workspaceId,
      status: workspace.status,
      head_sha: workspace.head_sha,
      ahead: 0,
      behind: 0,
      dirty_files: [],
      conflicts: [],
    };
    if (workspace.mode === 'sandbox_copy') {
      if (!(await pathExists(workspace.root_path))) {
        workspaceDb.setStatus(workspaceId, 'orphan', 'workspace directory is missing');
        const updated = requireWorkspace(workspaceId);
        emit('workspace.orphaned', updated);
        return { ...empty, status: 'orphan' };
      }
      return empty;
    }
    if (!(await pathExists(workspace.root_path))) {
      workspaceDb.setStatus(workspaceId, 'orphan', 'workspace directory is missing');
      const updated = requireWorkspace(workspaceId);
      emit('workspace.orphaned', updated);
      return { ...empty, status: 'orphan' };
    }
    const [headSha, status, counts] = await Promise.all([
      git.revParse(workspace.root_path, 'HEAD'),
      git.statusPorcelain(workspace.root_path),
      git.aheadBehind(workspace.root_path, workspace.base_branch, 'HEAD'),
    ]);
    workspaceDb.setHeadSha(workspaceId, headSha);
    const refreshed = requireWorkspace(workspaceId);
    emit('workspace.updated', refreshed);
    return {
      workspace_id: workspaceId,
      status: refreshed.status,
      head_sha: headSha,
      ahead: counts.ahead,
      behind: counts.behind,
      dirty_files: status.dirtyFiles,
      conflicts: status.conflicts,
    };
  };

  const getDiff = async (workspaceId: string, opts?: GetDiffOptions): Promise<DiffResult> => {
    const workspace = requireWorkspace(workspaceId);
    if (workspace.mode === 'sandbox_copy') {
      return { files: [], summary: { additions: 0, deletions: 0 } };
    }
    const fromRef =
      opts?.base === 'base_sha'
        ? (workspace.base_sha ??
          (await git.mergeBase(workspace.root_path, workspace.base_branch, 'HEAD')))
        : ((await git.mergeBase(workspace.root_path, workspace.base_branch, 'HEAD')) ??
          workspace.base_sha);
    if (!fromRef) {
      throw new CloudError(
        'WORKSPACE_CREATE_FAILED',
        `Cannot resolve a diff base for workspace ${workspaceId}`,
      );
    }
    return git.computeDiff(workspace.root_path, fromRef);
  };

  const mergeToBase = async (
    workspaceId: string,
    opts?: MergeToBaseOptions,
  ): Promise<MergeResult> => {
    const strategy: MergeStrategy = opts?.strategy ?? 'merge';
    const workspace = requireWorkspace(workspaceId);
    if (workspace.mode === 'sandbox_copy') {
      return {
        merged: false,
        strategy,
        status: workspace.status,
        merge_sha: null,
        message: 'sandbox_copy workspaces have no git history; merge the files manually',
      };
    }
    if (workspace.status !== 'active' && workspace.status !== 'error') {
      throw new CloudError(
        'WORKSPACE_DIRTY_CONFLICT',
        `Workspace ${workspaceId} is not mergeable in status "${workspace.status}"`,
      );
    }
    const projectPath = resolveProjectPath(workspace);
    return withProjectLock(
      workspace.project_id,
      async () => {
      const dirty = await git.statusPorcelain(workspace.root_path);
      if (dirty.dirtyFiles.length > 0) {
        throw new CloudError(
          'WORKSPACE_DIRTY_CONFLICT',
          `Workspace ${workspaceId} has ${dirty.dirtyFiles.length} uncommitted change(s); commit or discard before merging`,
        );
      }
      // The primary checkout must sit on the base branch — we merge in place
      // and never `git checkout` the user's tree (PRD §5.5).
      const checkedOut = await git.currentBranch(projectPath);
      if (checkedOut !== workspace.base_branch) {
        throw new CloudError(
          'WORKSPACE_DIRTY_CONFLICT',
          `Primary checkout is on "${checkedOut}", expected base branch "${workspace.base_branch}"; refusing to merge`,
        );
      }

      workspaceDb.setStatus(workspaceId, 'merging');
      const merge = await git.mergeBranch(
        projectPath,
        workspace.feature_branch,
        strategy,
        `Squash merge ${workspace.feature_branch} (workspace ${workspaceId})`,
      );
      if (merge.code !== 0) {
        await git.mergeAbort(projectPath);
        const message = `merge of ${workspace.feature_branch} failed: ${merge.stderr.trim().slice(0, 300)}`;
        workspaceDb.setStatus(workspaceId, 'error', message);
        emit('workspace.error', requireWorkspace(workspaceId));
        throw new CloudError('WORKSPACE_DIRTY_CONFLICT', message);
      }

      const mergeSha = await git.revParse(projectPath, 'HEAD');
      workspaceDb.setHeadSha(workspaceId, mergeSha);
      workspaceDb.setStatus(workspaceId, 'merged');
      let merged = requireWorkspace(workspaceId);
      emit('workspace.merged', merged);

      if (opts?.deleteAfter) {
        await destroyWorktree(projectPath, merged);
        if (await git.branchExists(projectPath, workspace.feature_branch)) {
          await git.deleteBranch(projectPath, workspace.feature_branch);
        }
        await git.worktreePrune(projectPath);
        workspaceDb.markCleaned(workspaceId);
        merged = requireWorkspace(workspaceId);
        emit('workspace.cleaned', merged);
      }
      return { merged: true, strategy, status: merged.status, merge_sha: mergeSha };
      },
      projectPath,
    );
  };

  const discard = async (workspaceId: string, opts?: DiscardOptions): Promise<void> => {
    const workspace = requireWorkspace(workspaceId);
    const projectPath =
      workspace.mode === 'git_worktree' ? resolveProjectPath(workspace) : null;
    await withProjectLock(
      workspace.project_id,
      async () => {
      if (workspace.mode === 'sandbox_copy') {
        await rm(workspace.root_path, { recursive: true, force: true });
      } else {
        await destroyWorktree(projectPath!, workspace);
        if (opts?.deleteBranch && (await git.branchExists(projectPath!, workspace.feature_branch))) {
          await git.deleteBranch(projectPath!, workspace.feature_branch);
        }
        await git.worktreePrune(projectPath!);
      }
      workspaceDb.setStatus(workspaceId, 'discarded');
      workspaceDb.markCleaned(workspaceId);
      emit('workspace.discarded', requireWorkspace(workspaceId));
      },
      projectPath ?? resolveProjectPath(workspace),
    );
  };

  /** Remove worktree dir + `git worktree prune`; keeps branch and status. */
  const cleanup = async (workspaceId: string): Promise<void> => {
    const workspace = requireWorkspace(workspaceId);
    const projectPath =
      workspace.mode === 'git_worktree' ? resolveProjectPath(workspace) : null;
    await withProjectLock(
      workspace.project_id,
      async () => {
      if (workspace.mode === 'sandbox_copy') {
        await rm(workspace.root_path, { recursive: true, force: true });
      } else {
        await destroyWorktree(projectPath!, workspace);
        await git.worktreePrune(projectPath!);
      }
      workspaceDb.markCleaned(workspaceId);
      emit('workspace.cleaned', requireWorkspace(workspaceId));
      },
      projectPath ?? resolveProjectPath(workspace),
    );
  };

  const resolveCwd = (workspaceId: string): string => requireWorkspace(workspaceId).root_path;

  const bindRun = (workspaceId: string, runId: string | null): AgentWorkspace => {
    requireWorkspace(workspaceId);
    workspaceDb.setRunId(workspaceId, runId);
    const updated = requireWorkspace(workspaceId);
    emit('workspace.updated', updated);
    return updated;
  };

  /**
   * Boot-time reconcile (§5.10): DB rows vs `git worktree list` + filesystem.
   * Rows whose root directory vanished (or that git no longer tracks) become
   * `orphan`. Returns the workspaces newly marked as orphaned.
   */
  const reconcileOrphanedWorkspaces = async (projectId?: string): Promise<AgentWorkspace[]> => {
    const rows = projectId
      ? workspaceDb.listByProject(projectId, { status: ['active', 'merging', 'error'] })
      : workspaceDb.listAll({ status: ['active', 'merging', 'error'] });
    const worktreesByProject = new Map<string, string[]>();
    const orphaned: AgentWorkspace[] = [];

    for (const workspace of rows) {
      let missing = !(await pathExists(workspace.root_path));
      if (!missing && workspace.mode === 'git_worktree') {
        let listed = worktreesByProject.get(workspace.project_id);
        if (!listed) {
          try {
            const projectPath = resolveProjectPath(workspace);
            const paths = await git.worktreeList(projectPath);
            listed = await Promise.all(paths.map((entry) => realpathOrSelf(entry)));
          } catch {
            listed = [];
          }
          worktreesByProject.set(workspace.project_id, listed);
        }
        missing = !listed.includes(await realpathOrSelf(workspace.root_path));
      }
      if (missing) {
        workspaceDb.setStatus(
          workspace.workspace_id,
          'orphan',
          'workspace directory is missing',
        );
        const updated = requireWorkspace(workspace.workspace_id);
        emit('workspace.orphaned', updated);
        orphaned.push(updated);
      }
    }
    return orphaned;
  };

  return {
    create,
    get,
    list,
    refreshStatus,
    getDiff,
    mergeToBase,
    discard,
    cleanup,
    bindRun,
    resolveCwd,
    reconcileOrphanedWorkspaces,
  };
};

/** Default singleton used by the HTTP routes. */
export const workspaceService = createWorkspaceService();
