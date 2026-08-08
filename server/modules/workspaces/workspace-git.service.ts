/**
 * Git operations for the workspace service (PRD §5.5 "Git commands").
 *
 * Async counterpart to `git-branch.service.ts` (which must stay sync for the
 * kanban task queue). All invocations use cross-spawn with argv arrays —
 * never string-interpolated shell — and return `{ code, stdout, stderr }`
 * instead of rejecting on non-zero exit, so callers decide what is fatal.
 */

// cross-spawn: drop-in spawn with Windows .cmd/PATHEXT resolution.
import spawn from 'cross-spawn';
import { realpath } from 'node:fs/promises';
import path from 'node:path';

import type { DiffFile, MergeStrategy, WorkspaceDirtyFile } from '@/modules/workspaces/workspace.types.js';

export type GitResult = { code: number | null; stdout: string; stderr: string };

/** Run git inside `cwd`, resolving with the exit result (never rejects on git failure). */
export function runGit(cwd: string, args: string[]): Promise<GitResult> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('git', args, { cwd });
    } catch (error) {
      resolve({ code: null, stdout: '', stderr: error instanceof Error ? error.message : String(error) });
      return;
    }
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', (error) => {
      resolve({ code: null, stdout, stderr: stderr || error.message });
    });
    child.on('close', (code) => {
      resolve({ code, stdout, stderr });
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
