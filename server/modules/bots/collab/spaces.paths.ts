/**
 * Path safety for Spaces. A space file must live under the owning bot's `<home>/spaces` or under
 * an operator-allowlisted external root (env CLOUDCLI_SPACES_ROOTS, colon-separated absolute
 * directories). Containment is checked on real paths so symlinks cannot escape, and macOS
 * TCC-protected folders (Documents, Desktop, Downloads) are refused outright: the server daemon
 * cannot be granted access to them, and touching them triggers prompts.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { resolveBotHome } from '@/modules/bots/bots-home.js';

const TCC_FOLDERS = ['Documents', 'Desktop', 'Downloads'];

/** `realpath` for paths that may not exist yet: resolve the deepest existing ancestor, re-append the rest. */
export function realpathLoose(target: string): string {
  const absolute = path.resolve(target);
  const pending: string[] = [];
  let current = absolute;
  for (;;) {
    try {
      const real = fs.realpathSync.native(current);
      return pending.length ? path.join(real, ...pending.reverse()) : real;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return absolute;
      pending.push(path.basename(current));
      current = parent;
    }
  }
}

export function isInside(child: string, root: string): boolean {
  const relative = path.relative(root, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function tccRoots(): string[] {
  const homes = new Set<string>();
  const home = os.homedir();
  homes.add(path.resolve(home));
  try {
    homes.add(fs.realpathSync.native(home));
  } catch {
    // unresolvable home: lexical check only
  }
  const roots: string[] = [];
  for (const base of homes) for (const folder of TCC_FOLDERS) roots.push(path.join(base, folder));
  return roots;
}

/** True when the path (lexically or after resolving symlinks) sits inside a TCC-protected folder. */
export function isTccPath(target: string): boolean {
  const candidates = [path.resolve(target), realpathLoose(target)];
  const roots = tccRoots();
  return candidates.some((candidate) => roots.some((root) => isInside(candidate, root)));
}

/** Allowlisted external roots: absolute, not TCC, real paths. Read from the environment on every call. */
export function listSpacesRoots(): string[] {
  const raw = process.env.CLOUDCLI_SPACES_ROOTS ?? '';
  const roots: string[] = [];
  for (const entry of raw.split(':')) {
    const value = entry.trim();
    if (!value || !path.isAbsolute(value)) continue;
    if (isTccPath(value)) continue;
    const real = realpathLoose(value);
    if (!roots.includes(real)) roots.push(real);
  }
  return roots;
}

/** `<botHome>/spaces` (real path; not created). */
export function defaultSpacesDir(botId: string): string {
  return realpathLoose(path.join(resolveBotHome(botId, { create: false }), 'spaces'));
}

export class SpacePathError extends Error {}

/** Resolve a stored space path to the real file path, or throw when it escapes the allowed roots. */
export function resolveSpaceFile(botId: string, storedPath: string): string {
  if (!path.isAbsolute(storedPath)) throw new SpacePathError('Space path is not absolute.');
  const real = realpathLoose(storedPath);
  if (isTccPath(real)) throw new SpacePathError('Space files cannot live in Documents, Desktop or Downloads.');
  const roots = [defaultSpacesDir(botId), ...listSpacesRoots()];
  if (!roots.some((root) => isInside(real, root))) {
    throw new SpacePathError('Space path is outside its allowed root.');
  }
  return real;
}

/** Turn a title into a filename stem. Never empty, never a dotfile. */
export function slugifyTitle(title: string): string {
  const slug = title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
  return slug || 'space';
}
