import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_CLAUDE_COMMAND = 'claude';
const CLAUDE_SCRIPT_EXTENSIONS = new Set(['.cjs', '.js', '.jsx', '.mjs', '.ts', '.tsx']);
const CLAUDE_WRAPPER_SEGMENTS = ['node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'] as const;

/**
 * Where Claude Code installs itself on macOS/Linux, in priority order and
 * relative to `$HOME`.
 *
 * GUI-launched processes (the Electron app) inherit launchd's minimal PATH,
 * which contains none of these — so resolving `claude` through PATH alone
 * silently reports "Claude Code is not installed" and makes CloudCLI prompt for
 * auth even though the user's shell is logged in. Probing the real install
 * locations keeps CloudCLI on the *same binary* as the terminal, which is what
 * keeps it in sync with the system Claude profile (same keychain, same OAuth).
 */
const POSIX_CLAUDE_HOME_CANDIDATES = [
  ['.local', 'bin', 'claude'], // native installer (current default)
  ['.claude', 'local', 'claude'], // legacy local installer
  ['.bun', 'bin', 'claude'],
  ['.npm-global', 'bin', 'claude'],
  ['.deno', 'bin', 'claude'],
] as const;

/** Machine-wide locations, checked after the per-user ones. */
const POSIX_CLAUDE_SYSTEM_CANDIDATES = [
  '/opt/homebrew/bin/claude',
  '/usr/local/bin/claude',
  '/usr/bin/claude',
] as const;

export type ResolveClaudeCodeExecutablePathDependencies = {
  execFileSync?: typeof execFileSync;
  existsSync?: typeof fs.existsSync;
  homedir?: typeof os.homedir;
  pathEnv?: string;
  platform?: NodeJS.Platform;
  readFileSync?: typeof fs.readFileSync;
};

function getPathApi(platform: NodeJS.Platform) {
  return platform === 'win32' ? path.win32 : path;
}

function stripWrappingQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function isPathLike(value: string): boolean {
  return value.includes('/') || value.includes('\\');
}

function resolveClaudeWrapperBinary(
  wrapperPath: string,
  deps: Required<ResolveClaudeCodeExecutablePathDependencies>,
): string | null {
  const pathApi = getPathApi(deps.platform);
  const directCandidate = pathApi.resolve(pathApi.dirname(wrapperPath), ...CLAUDE_WRAPPER_SEGMENTS);

  if (deps.existsSync(directCandidate)) {
    return directCandidate;
  }

  let content: string;
  try {
    content = deps.readFileSync(wrapperPath, 'utf8');
  } catch {
    return null;
  }

  const matches = content.matchAll(/["']([^"'\\\r\n]*claude\.exe)["']/gi);
  for (const match of matches) {
    const rawTarget = match[1]
      .replace(/^\$basedir[\\/]/i, '')
      .replace(/^%dp0%[\\/]/i, '')
      .replace(/^%~dp0[\\/]/i, '');
    const normalizedTarget = rawTarget.replace(/[\\/]/g, pathApi.sep);
    const candidate = pathApi.isAbsolute(normalizedTarget)
      ? normalizedTarget
      : pathApi.resolve(pathApi.dirname(wrapperPath), normalizedTarget);

    if (deps.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

function resolveWindowsClaudeExecutablePath(
  configuredPath: string,
  deps: Required<ResolveClaudeCodeExecutablePathDependencies>,
): string {
  const pathApi = getPathApi(deps.platform);
  const extension = pathApi.extname(configuredPath).toLowerCase();
  const explicitPath = isPathLike(configuredPath) || pathApi.isAbsolute(configuredPath);

  if (CLAUDE_SCRIPT_EXTENSIONS.has(extension)) {
    return configuredPath;
  }

  if (explicitPath && extension === '.exe') {
    return configuredPath;
  }

  if (explicitPath) {
    return resolveClaudeWrapperBinary(configuredPath, deps) ?? configuredPath;
  }

  try {
    const stdout = deps.execFileSync('where.exe', [configuredPath], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    const candidates = stdout
      .split(/\r?\n/)
      .map((entry) => entry.trim())
      .filter(Boolean);

    for (const candidate of candidates) {
      if (pathApi.extname(candidate).toLowerCase() === '.exe') {
        return candidate;
      }
    }

    for (const candidate of candidates) {
      const resolved = resolveClaudeWrapperBinary(candidate, deps);
      if (resolved) {
        return resolved;
      }
    }
  } catch {
    return configuredPath;
  }

  return configuredPath;
}

/**
 * Turns a bare `claude` command into an absolute path on macOS/Linux.
 *
 * Walks `PATH` first so a shell-launched server keeps using exactly what the
 * user's shell would, then falls back to the known install locations for the
 * GUI case where `PATH` is launchd's minimal default. Returns null when nothing
 * on disk matches, so callers can keep the bare command and surface the normal
 * "not installed" path.
 */
function resolvePosixClaudeExecutablePath(
  command: string,
  deps: Required<ResolveClaudeCodeExecutablePathDependencies>,
): string | null {
  for (const entry of deps.pathEnv.split(path.delimiter)) {
    const dir = entry.trim();
    if (!dir) continue;
    const candidate = path.join(dir, command);
    if (deps.existsSync(candidate)) {
      return candidate;
    }
  }

  let home = '';
  try {
    home = deps.homedir();
  } catch {
    home = '';
  }

  if (home) {
    for (const segments of POSIX_CLAUDE_HOME_CANDIDATES) {
      const candidate = path.join(home, ...segments);
      if (deps.existsSync(candidate)) {
        return candidate;
      }
    }
  }

  for (const candidate of POSIX_CLAUDE_SYSTEM_CANDIDATES) {
    if (deps.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

export function resolveClaudeCodeExecutablePath(
  configuredPath: string | undefined = process.env.CLAUDE_CLI_PATH,
  dependencies: ResolveClaudeCodeExecutablePathDependencies = {},
): string {
  const deps: Required<ResolveClaudeCodeExecutablePathDependencies> = {
    execFileSync: dependencies.execFileSync ?? execFileSync,
    existsSync: dependencies.existsSync ?? fs.existsSync,
    homedir: dependencies.homedir ?? os.homedir,
    pathEnv: dependencies.pathEnv ?? process.env.PATH ?? '',
    platform: dependencies.platform ?? process.platform,
    readFileSync: dependencies.readFileSync ?? fs.readFileSync,
  };

  const normalizedPath = stripWrappingQuotes(configuredPath || DEFAULT_CLAUDE_COMMAND);
  if (deps.platform !== 'win32') {
    // An explicit path from CLAUDE_CLI_PATH is always honoured as-is.
    if (isPathLike(normalizedPath) || path.isAbsolute(normalizedPath)) {
      return normalizedPath;
    }
    return resolvePosixClaudeExecutablePath(normalizedPath, deps) ?? normalizedPath;
  }

  return resolveWindowsClaudeExecutablePath(normalizedPath, deps);
}
