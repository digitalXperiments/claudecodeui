/**
 * Git operations for the workspace service (PRD §5.5 "Git commands").
 *
 * Async counterpart to `git-branch.service.ts` (which must stay sync for the
 * kanban task queue). All invocations use cross-spawn with argv arrays —
 * never string-interpolated shell — and return `{ code, stdout, stderr }`
 * instead of rejecting on non-zero exit, so callers decide what is fatal.
 */

import { realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';

// cross-spawn: drop-in spawn with Windows .cmd/PATHEXT resolution.
import spawn from 'cross-spawn';

import type { DiffFile, MergeStrategy, WorkspaceDirtyFile } from '@/modules/workspaces/workspace.types.js';

export type GitResult = { code: number | null; stdout: string; stderr: string };

export type RunGitOptions = {
  /** Hard deadline for the subprocess. */
  timeoutMs?: number;
  /** Combined stdout/stderr capture ceiling. */
  maxOutputBytes?: number;
};

const DEFAULT_GIT_TIMEOUT_MS = 30_000;
const DEFAULT_GIT_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const GIT_KILL_GRACE_MS = 1_000;

/** Run git inside `cwd`, resolving with the exit result (never rejects on git failure). */
export function runGit(
  cwd: string,
  args: string[],
  options: RunGitOptions = {},
): Promise<GitResult> {
  return new Promise((resolve) => {
    const timeoutMs = Math.max(1, options.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS);
    const maxOutputBytes = Math.max(1, options.maxOutputBytes ?? DEFAULT_GIT_MAX_OUTPUT_BYTES);
    let child;
    try {
      child = spawn('git', args, {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: '0',
          GCM_INTERACTIVE: 'Never',
          GIT_PAGER: 'cat',
          PAGER: 'cat',
        },
      });
    } catch (error) {
      resolve({ code: null, stdout: '', stderr: error instanceof Error ? error.message : String(error) });
      return;
    }
    let stdout = '';
    let stderr = '';
    let capturedBytes = 0;
    let settled = false;
    let terminationReason: string | null = null;
    let killTimer: NodeJS.Timeout | null = null;
    let forceSettleTimer: NodeJS.Timeout | null = null;

    const terminate = (reason: string): void => {
      if (terminationReason) return;
      terminationReason = reason;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => {
        child.kill('SIGKILL');
        // A broken child-process implementation must not keep the caller
        // pending forever even if it never emits `close` after SIGKILL.
        forceSettleTimer = setTimeout(() => finish(null), GIT_KILL_GRACE_MS);
        forceSettleTimer.unref();
      }, GIT_KILL_GRACE_MS);
      killTimer.unref();
    };

    const append = (target: 'stdout' | 'stderr', chunk: unknown): void => {
      const value = String(chunk);
      const remaining = maxOutputBytes - capturedBytes;
      if (remaining <= 0) {
        terminate(`output exceeded ${maxOutputBytes} bytes`);
        return;
      }
      const buffer = Buffer.from(value);
      const accepted = buffer.subarray(0, remaining).toString();
      capturedBytes += Buffer.byteLength(accepted);
      if (target === 'stdout') stdout += accepted;
      else stderr += accepted;
      if (buffer.byteLength > remaining) {
        terminate(`output exceeded ${maxOutputBytes} bytes`);
      }
    };

    const finish = (code: number | null, error?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      if (forceSettleTimer) clearTimeout(forceSettleTimer);
      const diagnostic = terminationReason ?? error;
      resolve({
        code: diagnostic ? null : code,
        stdout,
        stderr: diagnostic ? `${stderr}${stderr ? '\n' : ''}git terminated: ${diagnostic}` : stderr,
      });
    };

    const timeout = setTimeout(() => terminate(`timed out after ${timeoutMs}ms`), timeoutMs);
    timeout.unref();
    child.stdout?.on('data', (chunk) => {
      append('stdout', chunk);
    });
    child.stderr?.on('data', (chunk) => {
      append('stderr', chunk);
    });
    child.on('error', (error) => {
      finish(null, error.message);
    });
    child.on('close', (code) => {
      finish(code);
    });
  });
}

/** Like `runGit`, but throws an Error carrying stderr when git exits non-zero. */
export async function runGitOrThrow(cwd: string, args: string[]): Promise<GitResult> {
  const result = await runGit(cwd, args);
  if (result.code !== 0) {
    throw new Error(
      `git ${args[0]} failed (exit ${result.code ?? 'spawn error'}): ${result.stderr.trim().slice(0, 500)}`,
    );
  }
  return result;
}

/**
 * Resolve symlinks when possible so macOS `/var` vs `/private/var` (and similar
 * alias paths) still compare equal. Falls back to path.resolve when the path
 * does not exist yet.
 */
async function canonicalPath(target: string): Promise<string> {
  try {
    return await realpath(target);
  } catch {
    return path.resolve(target);
  }
}

export async function isGitRepo(projectPath: string): Promise<boolean> {
  const result = await runGit(projectPath, ['rev-parse', '--show-toplevel']);
  if (result.code !== 0) {
    return false;
  }
  // A project may live inside another repository (tests and monorepos do this
  // frequently). Worktree isolation must not accidentally operate on the
  // ancestor repository, so only the repository root itself is eligible for
  // git_worktree mode; nested paths use sandbox_copy.
  // Compare via realpath: git often prints the canonical path while callers
  // pass the non-canonical form (e.g. /var/... vs /private/var/... on macOS).
  const toplevel = await canonicalPath(result.stdout.trim());
  const project = await canonicalPath(projectPath);
  return toplevel === project;
}

const AUTO_INIT_GITIGNORE = [
  'node_modules/',
  'dist/',
  'build/',
  '.venv/',
  '__pycache__/',
  '.DS_Store',
  '*.log',
  '',
].join('\n');

/**
 * Turn a plain (non-git, or nested-inside-another-repo) project directory
 * into its own git repository with one commit, so it becomes eligible for
 * `git_worktree` mode instead of the merge-dead-end `sandbox_copy` fallback.
 * Idempotent: safe to call on a path that already has an initialized-but-
 * empty `.git` (e.g. a previous call that raced).
 */
export async function initRepo(projectPath: string): Promise<void> {
  await runGitOrThrow(projectPath, ['init', '-b', 'main']);
  // A fresh `git init` has no identity configured; commits fail without one
  // and this repo has no human author to fall back to.
  await runGit(projectPath, ['config', 'user.email', 'swarm@cloudcli.local']);
  await runGit(projectPath, ['config', 'user.name', 'CloudCLI Swarm']);
  const gitignorePath = path.join(projectPath, '.gitignore');
  try {
    // 'ax': create only if absent, fail loudly on any other error — never
    // clobber a .gitignore the project already has.
    await writeFile(gitignorePath, AUTO_INIT_GITIGNORE, { flag: 'ax' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  await runGit(projectPath, ['add', '-A']);
  await runGit(projectPath, [
    'commit',
    '-m',
    'Initial commit (auto-created for workspace isolation)',
    '--allow-empty',
  ]);
}

/** Current branch of the primary checkout; '' when detached. */
export async function currentBranch(projectPath: string): Promise<string> {
  const result = await runGit(projectPath, ['branch', '--show-current']);
  return result.code === 0 ? result.stdout.trim() : '';
}

export async function branchExists(projectPath: string, branch: string): Promise<boolean> {
  const result = await runGit(projectPath, ['rev-parse', '--verify', `refs/heads/${branch}`]);
  return result.code === 0;
}

/** Resolve a ref to a SHA (`git rev-parse --verify`); null when unresolvable. */
export async function revParse(projectPath: string, ref: string): Promise<string | null> {
  const result = await runGit(projectPath, ['rev-parse', '--verify', ref]);
  return result.code === 0 ? result.stdout.trim() || null : null;
}

/**
 * `owner/name` for a remote URL, or null when it is not a recognisable
 * GitHub/GitLab-style remote. Handles `https://host/owner/name(.git)`,
 * `git@host:owner/name(.git)` and `ssh://git@host/owner/name(.git)`.
 */
export function parseRemoteSlug(remoteUrl: string): string | null {
  const url = remoteUrl.trim().replace(/\.git$/, '');
  if (!url) return null;
  const scp = url.match(/^[^@/]+@[^:]+:([^/]+)\/(.+)$/);
  if (scp) return `${scp[1]}/${scp[2]}`;
  const full = url.match(/^[a-z][a-z0-9+.-]*:\/\/[^/]+\/([^/]+)\/(.+)$/i);
  if (full) return `${full[1]}/${full[2]}`;
  return null;
}

/**
 * Repo slug that `gh`/`glab` must be pinned to for this checkout.
 *
 * These CLIs resolve the base repo to the *upstream parent* on a fork, so on a
 * fork-based checkout `gh pr create` without `--repo` opens the PR against
 * upstream — where the just-pushed branch does not exist, which surfaces as
 * "Head ref must be a branch" / "No commits between ...". Feature branches are
 * pushed to `origin`, so the change request must target `origin` too.
 */
export async function remoteRepoSlug(cwd: string, remote = 'origin'): Promise<string | null> {
  const result = await runGit(cwd, ['remote', 'get-url', remote]);
  if (result.code !== 0) return null;
  return parseRemoteSlug(result.stdout);
}

/** Resolve a path inside the repository's private git directory. */
export async function resolveGitPath(cwd: string, gitPath: string): Promise<string | null> {
  const result = await runGit(cwd, ['rev-parse', '--git-path', gitPath]);
  if (result.code !== 0 || !result.stdout.trim()) return null;
  const resolved = result.stdout.trim();
  return path.isAbsolute(resolved) ? resolved : path.resolve(cwd, resolved);
}

/** `git worktree add -b <branch> <rootPath> <base>` — creates branch + worktree. */
export async function worktreeAdd(
  projectPath: string,
  rootPath: string,
  branch: string,
  base: string,
): Promise<GitResult> {
  return runGit(projectPath, ['worktree', 'add', '-b', branch, rootPath, base]);
}

/** Attach a new worktree to an existing branch (used for task retries/reviews). */
export async function worktreeAddExisting(
  projectPath: string,
  rootPath: string,
  branch: string,
): Promise<GitResult> {
  return runGit(projectPath, ['worktree', 'add', rootPath, branch]);
}

/** `git worktree remove --force <rootPath>` — tolerates dirty trees. */
export async function worktreeRemove(projectPath: string, rootPath: string): Promise<GitResult> {
  return runGit(projectPath, ['worktree', 'remove', '--force', rootPath]);
}

export async function worktreePrune(projectPath: string): Promise<GitResult> {
  return runGit(projectPath, ['worktree', 'prune']);
}

/** Absolute paths of all registered worktrees (`git worktree list --porcelain`). */
export async function worktreeList(projectPath: string): Promise<string[]> {
  const result = await runGit(projectPath, ['worktree', 'list', '--porcelain']);
  if (result.code !== 0) {
    return [];
  }
  return result.stdout
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length).trim())
    .filter((line) => line.length > 0);
}

/** `git branch -D <branch>` — force delete (used after discard). */
export async function deleteBranch(projectPath: string, branch: string): Promise<GitResult> {
  return runGit(projectPath, ['branch', '-D', branch]);
}

/** Parse `git status --porcelain` (v1) into dirty files + conflicted paths. */
export function parseStatusPorcelain(stdout: string): {
  dirtyFiles: WorkspaceDirtyFile[];
  conflicts: string[];
} {
  const dirtyFiles: WorkspaceDirtyFile[] = [];
  const conflicts: string[] = [];
  for (const line of stdout.split('\n')) {
    if (line.length < 4) {
      continue;
    }
    const code = line.slice(0, 2);
    // Renames/copies show as `XY old -> new`; keep the new path.
    const rawPath = line.slice(3);
    const filePath = rawPath.includes(' -> ') ? rawPath.split(' -> ').pop()! : rawPath;
    dirtyFiles.push({ path: filePath, status: code });
    // Unmerged states: DD, AU, UD, UA, DU, AA, UU.
    if (code === 'UU' || code === 'AA' || code === 'DD' || code.includes('U')) {
      conflicts.push(filePath);
    }
  }
  return { dirtyFiles, conflicts };
}

export async function statusPorcelain(worktreePath: string): Promise<{
  dirtyFiles: WorkspaceDirtyFile[];
  conflicts: string[];
}> {
  const result = await runGit(worktreePath, ['status', '--porcelain']);
  if (result.code !== 0) {
    return { dirtyFiles: [], conflicts: [] };
  }
  return parseStatusPorcelain(result.stdout);
}

/**
 * Ahead/behind of `headRef` relative to `baseRef` via
 * `git rev-list --left-right --count base...head`
 * (left = commits only on base = behind, right = only on head = ahead).
 */
export async function aheadBehind(
  repoPath: string,
  baseRef: string,
  headRef: string,
): Promise<{ ahead: number; behind: number }> {
  const result = await runGit(repoPath, [
    'rev-list',
    '--left-right',
    '--count',
    `${baseRef}...${headRef}`,
  ]);
  if (result.code !== 0) {
    return { ahead: 0, behind: 0 };
  }
  const [left, right] = result.stdout.trim().split(/\s+/);
  return { ahead: Number(right) || 0, behind: Number(left) || 0 };
}

export async function mergeBase(
  repoPath: string,
  refA: string,
  refB: string,
): Promise<string | null> {
  const result = await runGit(repoPath, ['merge-base', refA, refB]);
  return result.code === 0 ? result.stdout.trim() || null : null;
}

const NAME_STATUS_MAP: Record<string, string> = {
  A: 'added',
  M: 'modified',
  D: 'deleted',
  R: 'renamed',
  C: 'copied',
  T: 'typechanged',
  U: 'unmerged',
};

/**
 * Diff `<fromRef>` against the current working tree of `worktreePath`
 * (committed feature-branch changes plus uncommitted edits — the "live diff").
 */
export async function diffNameStatus(
  worktreePath: string,
  fromRef: string,
): Promise<{ path: string; status: string }[]> {
  const result = await runGit(worktreePath, ['diff', '--name-status', fromRef]);
  if (result.code !== 0) {
    return [];
  }
  const files: { path: string; status: string }[] = [];
  for (const line of result.stdout.split('\n')) {
    if (!line.trim()) {
      continue;
    }
    const parts = line.split('\t');
    const code = parts[0].charAt(0);
    // Rename/copy lines carry old + new path; report the new one.
    const filePath = parts.length > 2 ? parts[2] : parts[1];
    files.push({ path: filePath, status: NAME_STATUS_MAP[code] ?? code.toLowerCase() });
  }
  return files;
}

/** Unified patch for one file (`git diff <fromRef> -- <path>`). */
export async function diffFilePatch(
  worktreePath: string,
  fromRef: string,
  filePath: string,
): Promise<string | undefined> {
  const result = await runGit(worktreePath, ['diff', fromRef, '--', filePath]);
  if (result.code !== 0 || !result.stdout) {
    return undefined;
  }
  return result.stdout;
}

/** `{additions, deletions}` totals via `git diff --numstat` (binary files count as 0). */
export async function diffSummary(
  worktreePath: string,
  fromRef: string,
): Promise<{ additions: number; deletions: number }> {
  const result = await runGit(worktreePath, ['diff', '--numstat', fromRef]);
  if (result.code !== 0) {
    return { additions: 0, deletions: 0 };
  }
  let additions = 0;
  let deletions = 0;
  for (const line of result.stdout.split('\n')) {
    const [added, removed] = line.split('\t');
    additions += Number(added) || 0; // binary entries show '-' → NaN → 0
    deletions += Number(removed) || 0;
  }
  return { additions, deletions };
}

export type DiffComputation = {
  files: DiffFile[];
  summary: { additions: number; deletions: number };
};

/** Full diff: name-status + per-file patch + numstat summary. */
export async function computeDiff(worktreePath: string, fromRef: string): Promise<DiffComputation> {
  const [nameStatus, summary] = await Promise.all([
    diffNameStatus(worktreePath, fromRef),
    diffSummary(worktreePath, fromRef),
  ]);
  const files: DiffFile[] = await Promise.all(
    nameStatus.map(async (file) => ({
      path: file.path,
      status: file.status,
      patch: await diffFilePatch(worktreePath, fromRef, file.path),
    })),
  );
  return { files, summary };
}

/**
 * Merge `<branch>` into the branch currently checked out at `primaryPath`.
 * - 'merge'   → `git merge --no-ff --no-edit <branch>`
 * - 'ff-only' → `git merge --ff-only <branch>`
 * - 'squash'  → `git merge --squash <branch>` + explicit commit
 *
 * Runs in the PRIMARY repo path — never `git checkout` (PRD §5.5).
 */
export async function mergeBranch(
  primaryPath: string,
  branch: string,
  strategy: MergeStrategy,
  squashMessage: string,
): Promise<GitResult> {
  if (strategy === 'ff-only') {
    return runGit(primaryPath, ['merge', '--ff-only', branch]);
  }
  if (strategy === 'squash') {
    const squash = await runGit(primaryPath, ['merge', '--squash', branch]);
    if (squash.code !== 0) {
      return squash;
    }
    return runGit(primaryPath, ['commit', '--no-edit', '-m', squashMessage]);
  }
  return runGit(primaryPath, ['merge', '--no-ff', '--no-edit', branch]);
}

export async function mergeAbort(primaryPath: string): Promise<GitResult> {
  return runGit(primaryPath, ['merge', '--abort']);
}
