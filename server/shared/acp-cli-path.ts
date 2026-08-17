import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Resolves a bare ACP CLI command (`opencode`, `kilo`) to an absolute path.
 *
 * Both installers drop the binary in `~/.<name>/bin` and rely on shell profiles
 * to put it on PATH. GUI-launched servers (Electron/launchd) never source those
 * profiles, so spawning the bare command fails with ENOENT even though the CLI
 * is installed — the same failure class resolveClaudeCodeExecutablePath handles
 * for Claude (see claude-cli-path.ts). PATH is walked first so a shell-launched
 * server keeps using exactly what the user's shell would; the well-known
 * install location is the GUI fallback. Returns the bare command when nothing
 * matches so callers keep the normal "not installed" error path.
 */
export type ResolveAcpCliCommandDeps = {
  pathEnv?: string;
  homedir?: string;
  platform?: NodeJS.Platform;
};

export function resolveAcpCliCommand(command: string, deps: ResolveAcpCliCommandDeps = {}): string {
  const platform = deps.platform ?? process.platform;
  // Windows resolves through cross-spawn's PATHEXT handling; bare command stays.
  if (platform === 'win32' || command.includes('/') || command.includes('\\')) {
    return command;
  }

  const pathEnv = deps.pathEnv ?? process.env.PATH ?? '';
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) {
      continue;
    }
    const candidate = path.join(dir, command);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // keep looking
    }
  }

  const home = deps.homedir ?? os.homedir();
  const installCandidate = path.join(home, `.${command}`, 'bin', command);
  try {
    fs.accessSync(installCandidate, fs.constants.X_OK);
    return installCandidate;
  } catch {
    return command;
  }
}
