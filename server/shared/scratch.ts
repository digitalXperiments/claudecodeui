/**
 * Scratch-directory helpers for the strict `tmp/cloudcli/` temp rule: every
 * temporary directory created by the server, by an agent session, or by a test
 * lives under `<cwd>/tmp/cloudcli/`.
 *
 * `tmp/` is gitignored, so the root is absent in any freshly-materialised
 * checkout — a new `git clone`, a CI runner, or a new git worktree. Calling
 * `mkdtemp` straight into it therefore fails with ENOENT until something
 * creates it. Always go through these helpers instead.
 */

import { mkdir, mkdtemp } from 'node:fs/promises';
import path from 'node:path';

/** Absolute path of the scratch root for the current working directory. */
export function scratchRoot(): string {
  return path.resolve('tmp', 'cloudcli');
}

/** Create the scratch root if absent. Idempotent. */
export async function ensureScratchRoot(): Promise<string> {
  const root = scratchRoot();
  await mkdir(root, { recursive: true });
  return root;
}

/**
 * Create a uniquely-named scratch directory, creating the scratch root first.
 * `prefix` is a name fragment, e.g. `'swarm-'` → `tmp/cloudcli/swarm-a1b2c3`.
 */
export async function makeScratchDir(prefix: string): Promise<string> {
  const root = await ensureScratchRoot();
  return mkdtemp(path.join(root, prefix));
}
