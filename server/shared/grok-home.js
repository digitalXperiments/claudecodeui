import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Managed GROK_HOME handling for CloudCLI.
 *
 * Grok is spawned with GROK_HOME pointed at a per-permission-mode overlay of
 * the user's real `~/.grok`, so CloudCLI can force its chosen permission mode
 * without touching the user's personal `config.toml` (a personal
 * `permission_mode = "always-approve"` would otherwise make every chatbar
 * mode behave like Bypass Permissions).
 *
 * Shared by the ACP chat path (grok-cli.js) and the interactive Shell tab
 * (shell-websocket.service.ts) so both resolve the same managed home.
 */

/**
 * Force `[ui] permission_mode` / `yolo` in a TOML blob without a full parser.
 * Replaces existing keys when present; otherwise inserts them under `[ui]`.
 * Keeps MCP servers, marketplace, models, and other user settings intact.
 */
function applyPermissionModeToConfigToml(tomlText, configPermissionMode) {
  let next = typeof tomlText === 'string' ? tomlText : '';

  if (/^\s*permission_mode\s*=/m.test(next)) {
    next = next.replace(
      /^\s*permission_mode\s*=\s*.*$/m,
      `permission_mode = "${configPermissionMode}"`,
    );
  } else if (/^\[ui\]/m.test(next)) {
    next = next.replace(/^\[ui\][ \t]*$/m, `[ui]\npermission_mode = "${configPermissionMode}"`);
  } else {
    next = `${next.trimEnd()}\n\n[ui]\npermission_mode = "${configPermissionMode}"\n`;
  }

  if (/^\s*yolo\s*=/m.test(next)) {
    next = next.replace(/^\s*yolo\s*=\s*.*$/m, 'yolo = false');
  } else if (/^\[ui\]/m.test(next)) {
    next = next.replace(
      /^\[ui\][ \t]*\n(?:permission_mode\s*=\s*.*\n)?/m,
      (match) => `${match}yolo = false\n`,
    );
  }

  const banner = '# CloudCLI-managed permission_mode overlay — regenerated each spawn.\n';
  if (!next.includes('CloudCLI-managed permission_mode overlay')) {
    next = banner + next;
  }
  return next.endsWith('\n') ? next : `${next}\n`;
}

/** Write via temp + rename so concurrent spawns never read a half-written file. */
function writeFileAtomic(targetPath, content) {
  const tmp = `${targetPath}.cloudcli-${process.pid}.tmp`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, targetPath);
}

/**
 * Newest-wins sync for credential files shared between the real Grok home and
 * every managed home.
 *
 * Why: Grok access tokens live ~30 minutes and the refresh token rotates on
 * each refresh. The CLI rewrites `auth.json` atomically (temp + rename), which
 * breaks hard links — so the fresh token ends up stranded in whichever managed
 * home the session ran under, while the real `~/.grok` keeps the rotated-out
 * one. Re-linking from the real home on every spawn then wipes the only valid
 * token: the "logged out every few hours" bug. The same atomic rewrite in the
 * other direction (e.g. `grok login` in a plain terminal) left managed homes
 * pointing at the pre-login file, so CloudCLI never picked up fresh logins.
 *
 * Fix: find the newest copy of each shared file across the real home and all
 * managed homes, and propagate its content everywhere (plain copies — hard
 * links and symlinks both break under atomic rewrites). If the real home's
 * file is gone entirely, treat that as an explicit logout and drop the managed
 * copies instead of resurrecting a stale token.
 */
function syncSharedGrokFiles(sourceHome, managedRoot, managedHome) {
  const shareNames = [
    'auth.json',
    'mcp_credentials.json',
    'models_cache.json',
    'trusted_folders.toml',
  ];

  let managedModeDirs;
  try {
    managedModeDirs = fs
      .readdirSync(managedRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(managedRoot, entry.name));
  } catch {
    managedModeDirs = [managedHome];
  }
  if (!managedModeDirs.includes(managedHome)) {
    managedModeDirs.push(managedHome);
  }

  for (const name of shareNames) {
    const src = path.join(sourceHome, name);
    if (!fs.existsSync(src)) {
      // Explicit logout (or never logged in): don't resurrect stale tokens.
      for (const dir of managedModeDirs) {
        try {
          fs.unlinkSync(path.join(dir, name));
        } catch {
          // Already absent.
        }
      }
      continue;
    }

    const dest = path.join(managedHome, name);
    const candidates = [src, ...managedModeDirs.map((dir) => path.join(dir, name))].filter(
      (candidate) => fs.existsSync(candidate),
    );

    let newest = null;
    for (const candidate of candidates) {
      try {
        const { mtimeMs } = fs.statSync(candidate);
        if (!newest || mtimeMs > newest.mtimeMs) {
          newest = { path: candidate, mtimeMs };
        }
      } catch {
        // Vanished mid-scan; skip.
      }
    }
    if (!newest) {
      continue;
    }

    let content;
    try {
      content = fs.readFileSync(newest.path);
    } catch {
      continue;
    }

    const targets = new Set([dest, ...candidates]);
    targets.delete(newest.path);
    for (const target of targets) {
      try {
        writeFileAtomic(target, content);
        // Keep the source's mtime so copies reflect the token's true age —
        // otherwise a propagated copy would outrank a genuinely newer login.
        fs.utimesSync(target, new Date(), new Date(newest.mtimeMs));
      } catch {
        // Auth may still work from default paths; non-fatal.
      }
    }
  }
}

/**
 * Build a per-mode GROK_HOME that reuses the user's real auth/credentials and
 * most of their config, but forces CloudCLI's chosen permission mode. That
 * isolation is required because a personal `~/.grok/config.toml` with
 * `permission_mode = "always-approve"` would otherwise make every chatbar mode
 * behave like Bypass Permissions.
 */
function ensureManagedGrokHome(configPermissionMode) {
  const userGrokHome = process.env.GROK_HOME || path.join(os.homedir(), '.grok');
  // If CloudCLI is already nested under a managed home, use the original user
  // home for sources (avoid stacking overlays).
  const sourceHome = userGrokHome.includes(`${path.sep}.cloudcli${path.sep}grok-runtime${path.sep}`)
    ? path.join(os.homedir(), '.grok')
    : userGrokHome;

  const managedRoot = path.join(os.homedir(), '.cloudcli', 'grok-runtime');
  const managedHome = path.join(managedRoot, configPermissionMode);

  fs.mkdirSync(managedHome, { recursive: true });

  syncSharedGrokFiles(sourceHome, managedRoot, managedHome);

  // Reuse heavyweight caches without full duplication.
  for (const dirName of ['marketplace-cache', 'sessions', 'skills', 'bundled', 'docs']) {
    const userDir = path.join(sourceHome, dirName);
    const linkPath = path.join(managedHome, dirName);
    if (!fs.existsSync(userDir)) {
      continue;
    }
    try {
      if (fs.existsSync(linkPath) || fs.lstatSync(linkPath).isSymbolicLink()) {
        // Already linked/copied.
      } else {
        fs.symlinkSync(userDir, linkPath, 'dir');
      }
    } catch {
      try {
        if (!fs.existsSync(linkPath)) {
          fs.symlinkSync(userDir, linkPath, 'dir');
        }
      } catch {
        // Optional.
      }
    }
  }

  let userConfig = '';
  const userConfigPath = path.join(sourceHome, 'config.toml');
  try {
    userConfig = fs.readFileSync(userConfigPath, 'utf8');
  } catch {
    userConfig = '';
  }

  const configPath = path.join(managedHome, 'config.toml');
  fs.writeFileSync(
    configPath,
    applyPermissionModeToConfigToml(userConfig, configPermissionMode),
    'utf8',
  );

  return managedHome;
}

export { applyPermissionModeToConfigToml, ensureManagedGrokHome };
