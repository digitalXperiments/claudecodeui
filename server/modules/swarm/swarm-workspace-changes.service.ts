import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';

/**
 * Provider runs may execute in a git worktree or in a plain `sandbox_copy`.
 * A per-step filesystem snapshot works for both and, unlike `git status`, can
 * tell whether this particular step changed the workspace when earlier steps
 * already left it dirty.
 */
export type WorkspaceMutationSnapshot = Map<string, string>;

const IGNORED_DIRECTORY_NAMES = new Set([
  '.git',
  '.worktrees',
  'node_modules',
  '.build',
  'build',
  'dist',
  'coverage',
  '.cache',
  'target',
]);

const IGNORED_PROJECT_STATE_NAMES = new Set([
  '.agents',
  '.claude',
  '.cloudcli',
  '.codex',
  '.cursor',
  '.grok',
  '.kimi-code',
  '.opencode',
  '.kilo',
  '.kilocode',
]);

function shouldIgnoreDirectory(relativePath: string, name: string): boolean {
  if (IGNORED_DIRECTORY_NAMES.has(name)) return true;
  // Studio prototypes live under .cloudcli/studio. Those writes *are* the
  // implementation diff for design swarms — ignore the rest of .cloudcli.
  if (name === '.cloudcli') return false;
  if (relativePath === path.join('.cloudcli', 'studio') || relativePath.startsWith(`${path.join('.cloudcli', 'studio')}${path.sep}`)) {
    return false;
  }
  if (relativePath === '.cloudcli' || relativePath.startsWith(`.cloudcli${path.sep}`)) return true;
  if (IGNORED_PROJECT_STATE_NAMES.has(name)) return true;
  return relativePath === 'tmp' || relativePath.startsWith(`tmp${path.sep}`);
}

/**
 * Capture source-tree metadata without following symlinks. Size + nanosecond
 * mtime catches normal writes cheaply; mode catches executable-bit changes.
 * Generated dependency/build/temp trees are deliberately excluded so running
 * a compiler alone cannot satisfy an implementation step's change contract.
 */
export async function captureWorkspaceMutationSnapshot(
  workspaceRoot: string,
): Promise<WorkspaceMutationSnapshot> {
  const root = path.resolve(workspaceRoot);
  const snapshot: WorkspaceMutationSnapshot = new Map();

  const visit = async (absoluteDir: string, relativeDir: string): Promise<void> => {
    const entries = await readdir(absoluteDir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const relativePath = relativeDir ? path.join(relativeDir, entry.name) : entry.name;
      if (entry.isDirectory()) {
        if (!shouldIgnoreDirectory(relativePath, entry.name)) {
          await visit(path.join(absoluteDir, entry.name), relativePath);
        }
        continue;
      }
      if (!entry.isFile()) continue;
      const info = await lstat(path.join(absoluteDir, entry.name), { bigint: true });
      snapshot.set(
        relativePath,
        `${info.size}:${info.mtimeNs}:${info.mode & 0o7777n}`,
      );
    }
  };

  await visit(root, '');
  return snapshot;
}

export function workspaceMutationDetected(
  before: WorkspaceMutationSnapshot,
  after: WorkspaceMutationSnapshot,
): boolean {
  if (before.size !== after.size) return true;
  for (const [relativePath, signature] of before) {
    if (after.get(relativePath) !== signature) return true;
  }
  return false;
}
