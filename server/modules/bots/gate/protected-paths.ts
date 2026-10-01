/**
 * The hard denylist of locations a gated bot may never touch, evaluated on REAL paths.
 *
 * Shared by the built-in tool gate (file tools, shell words) and the command scanner (symlink
 * operands, glob matches, symlinks found inside a searched tree). A path is judged after symlinks
 * are resolved: for a path that does not exist yet the nearest existing ancestor is resolved and the
 * missing tail re-attached, so `ws/link/new-file` (with `link -> ~/.grok`) is `~/.grok/new-file`.
 */
import os from 'node:os';
import path from 'node:path';
import { realpathSync } from 'node:fs';

import { protectedSegmentsReason } from '@/modules/bots/gate/strict-guard.js';

export const PROTECTED_DIRS = ['.claude', '.codex', '.grok', '.cursor', '.config', '.cloudcli'] as const;
export const PROTECTED_FILES = ['.claude.json'] as const;
const DB_FILE = /\.(?:db|sqlite3?|db-wal|db-shm)$/i;

export function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Resolves symlinks on the nearest existing ancestor and re-attaches the missing tail. */
export function canonicalize(target: string): string {
  let prefix = target;
  let suffix = '';
  for (;;) {
    try {
      const real = realpathSync(prefix);
      return suffix ? path.join(real, suffix) : real;
    } catch {
      const parent = path.dirname(prefix);
      if (parent === prefix) return target;
      suffix = suffix ? path.join(path.basename(prefix), suffix) : path.basename(prefix);
      prefix = parent;
    }
  }
}

function safeRealpath(target: string): string {
  try {
    return realpathSync(target);
  } catch {
    return target;
  }
}

export function homes(): string[] {
  const home = os.homedir();
  return [...new Set([home, safeRealpath(home)])];
}

export function expandHome(text: string): string {
  if (text === '~') return os.homedir();
  if (text.startsWith('~/')) return path.join(os.homedir(), text.slice(2));
  return text;
}

/** Reason the path is off-limits, or null. Symlinks are resolved (see the file header). */
export function protectedPathReason(rawPath: string, workspaceRoot: string, botHome: string): string | null {
  if (!rawPath) return null;
  let expanded = rawPath.trim();
  if (expanded === '~' || expanded.startsWith('~/')) expanded = path.join(os.homedir(), expanded.slice(1));
  const absolute = path.resolve(workspaceRoot || '/', expanded);
  const candidates = [...new Set([absolute, canonicalize(absolute)])];
  const botHomes = [...new Set([path.resolve(botHome), safeRealpath(path.resolve(botHome))])];
  for (const candidate of candidates) {
    if (DB_FILE.test(candidate)) return `database files are off-limits (${rawPath})`;
    if (botHomes.some((bh) => isInside(candidate, bh))) continue;
    for (const home of homes()) {
      for (const file of PROTECTED_FILES) {
        if (candidate === path.join(home, file)) return `${file} holds provider credentials (${rawPath})`;
      }
      for (const dir of PROTECTED_DIRS) {
        if (isInside(candidate, path.join(home, dir))) return `~/${dir} is protected (${rawPath})`;
      }
    }
  }
  return null;
}

const forms = (target: string): string[] => [...new Set([path.resolve(target), canonicalize(path.resolve(target))])];

/**
 * Why `target` (an operand as written: relative to `base` or the workspace, `~` expanded) is
 * protected once its symlinks are resolved, or null. The bot's own home is exempt; a real path that
 * stays inside the workspace is only judged by name (relative to the workspace), so a workspace that
 * happens to live below a dot-folder is not itself "protected".
 */
export function realPathProtectedReason(
  target: string,
  scope: { workspaceRoot: string; botHome: string },
  base?: string | null,
): string | null {
  if (!target || target.includes('\0')) return null;
  const absolute = path.resolve(base || scope.workspaceRoot || '/', expandHome(target.trim()));
  const real = canonicalize(absolute);
  if (forms(scope.botHome).some((root) => isInside(real, root))) return null;
  for (const root of forms(scope.workspaceRoot || '/')) {
    if (isInside(real, root) && root !== '/') {
      const below = path.relative(root, real);
      const reason = protectedSegmentsReason(below === '' ? [] : below.split(path.sep));
      return reason ? `${reason} (${target})` : null;
    }
  }
  const direct = protectedPathReason(real, scope.workspaceRoot, scope.botHome);
  if (direct) return direct.endsWith(`(${real})`) ? `${direct.slice(0, -real.length - 1)}${target})` : direct;
  for (const home of homes()) {
    if (isInside(real, home)) {
      const reason = protectedSegmentsReason(path.relative(home, real).split(path.sep));
      if (reason) return `${reason} (${target})`;
    }
  }
  const reason = protectedSegmentsReason(real.split(path.sep));
  return reason ? `${reason} (${target})` : null;
}
