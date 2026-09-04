/**
 * Managed-runtime layout and binary resolution for the Antigravity ACP agent.
 *
 * Antigravity is not an npm CLI: Google ships a self-contained ACP executable
 * plus a `localharness_external` sidecar in a per-host archive. CloudCLI keeps
 * them under a versioned managed root, exactly like the Electron shell keeps
 * versioned server bundles:
 *
 *   ~/.cloudcli/antigravity/<version>/agy_acp_server[.par|.exe]
 *   ~/.cloudcli/antigravity/<version>/localharness_external
 *   ~/.cloudcli/antigravity/<version>/.installed.json
 *
 * Binary resolution differs from every other ACP provider on purpose. The other
 * runtimes pass a bare command (`opencode`, `qwen`) through
 * `resolveAcpCliCommand`, which falls back to PATH. Antigravity has no PATH
 * presence to fall back to, and silently running some unrelated
 * `agy_acp_server` found on PATH after the user typed an explicit path would be
 * worse than failing. So:
 *
 * - a non-empty explicit override WINS, and an override that is not an
 *   executable file is an ERROR (never a silent PATH fallback);
 * - an empty override uses the managed runtime, then PATH;
 * - the resolved value is always ABSOLUTE when it comes from the managed root,
 *   which makes `resolveAcpCliCommand` short-circuit rather than re-search.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  ANTIGRAVITY_RUNTIME_VERSION,
  antigravityPlatformKey,
  resolveAntigravityManifest,
} from './antigravity-releases.js';

/**
 * Candidate executable names inside the archive, in probe order.
 *
 * Google has shipped the ACP entry point both as a bare executable and as a
 * `.par` (Python archive) bundle depending on host; T3 Code probes rather than
 * assuming. Probing keeps a runtime whose layout shifted from looking like a
 * failed install.
 */
export const ANTIGRAVITY_EXECUTABLE_NAMES = [
  'agy_acp_server',
  'agy_acp_server.par',
  'agy_acp_server.exe',
] as const;

/** The sidecar the ACP server needs at runtime; an install without it is broken. */
export const ANTIGRAVITY_HARNESS_NAME = 'localharness_external';

export type AntigravityInstallMarker = {
  version: string;
  platformKey: string;
  executable: string;
  sha256: string;
  size: number;
  installedAt: string;
};

/** Root of the managed runtime tree. `CLOUDCLI_ANTIGRAVITY_DIR` overrides it (tests, custom layouts). */
export function antigravityInstallRoot(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.CLOUDCLI_ANTIGRAVITY_DIR?.trim();
  return configured ? path.resolve(configured) : path.join(os.homedir(), '.cloudcli', 'antigravity');
}

/** The version CloudCLI installs and expects; follows an operator manifest override. */
export function antigravityRuntimeVersion(env: NodeJS.ProcessEnv = process.env): string {
  return resolveAntigravityManifest(env).version || ANTIGRAVITY_RUNTIME_VERSION;
}

export function antigravityVersionDir(
  version: string = antigravityRuntimeVersion(),
  env: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(antigravityInstallRoot(env), version);
}

export function antigravityMarkerPath(
  version: string = antigravityRuntimeVersion(),
  env: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(antigravityVersionDir(version, env), '.installed.json');
}

/** Where the Settings UI persists the runtime's user-facing configuration. */
export function antigravityConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(antigravityInstallRoot(env), 'config.json');
}

export type AntigravityRuntimeConfig = {
  /** Explicit ACP executable path. Empty string means "use the managed runtime". */
  binaryPath: string;
  /**
   * Which ACP `authenticate` method to use. `oauth-personal` (personal Google)
   * is the only method CloudCLI ships enabled; the others are accepted so a
   * user with an enterprise/Vertex entitlement can select one without a code
   * change, and are passed through to `authenticate` verbatim.
   */
  authMethod: string;
};

export const ANTIGRAVITY_DEFAULT_AUTH_METHOD = 'oauth-personal';

/**
 * Auth methods Antigravity's ACP `initialize` has been observed to advertise.
 * `oauth-personal` is required for v1; the rest are configuration-only and are
 * never selected automatically — in particular an `api-key` method must never
 * be picked as a fallback, because that silently moves the user onto metered
 * Gemini API billing.
 */
export const ANTIGRAVITY_AUTH_METHODS = [
  'oauth-personal',
  'gemini-enterprise',
  'api-key',
  'vertex',
] as const;

export const ANTIGRAVITY_DEFAULT_RUNTIME_CONFIG: AntigravityRuntimeConfig = {
  binaryPath: '',
  authMethod: ANTIGRAVITY_DEFAULT_AUTH_METHOD,
};

/** Read the runtime config; a missing or malformed file yields the defaults. */
export function readAntigravityRuntimeConfig(env: NodeJS.ProcessEnv = process.env): AntigravityRuntimeConfig {
  try {
    const parsed = JSON.parse(fs.readFileSync(antigravityConfigPath(env), 'utf8')) as Record<string, unknown>;
    const binaryPath = typeof parsed.binaryPath === 'string' ? parsed.binaryPath.trim() : '';
    const authMethod = typeof parsed.authMethod === 'string' && parsed.authMethod.trim()
      ? parsed.authMethod.trim()
      : ANTIGRAVITY_DEFAULT_AUTH_METHOD;
    return { binaryPath, authMethod };
  } catch {
    return { ...ANTIGRAVITY_DEFAULT_RUNTIME_CONFIG };
  }
}

export function writeAntigravityRuntimeConfig(
  config: AntigravityRuntimeConfig,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const configPath = antigravityConfigPath(env);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

/** The configured override, env var first so a relay/CI host can set it without a config file. */
export function antigravityBinaryOverride(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.ANTIGRAVITY_ACP_PATH?.trim();
  if (fromEnv) return fromEnv;
  return readAntigravityRuntimeConfig(env).binaryPath;
}

const isExecutableFile = (candidate: string): boolean => {
  try {
    if (!fs.statSync(candidate).isFile()) return false;
  } catch {
    return false;
  }
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    // Windows reports X_OK inconsistently for downloaded files; an existing
    // regular file is enough there since cross-spawn handles execution.
    return process.platform === 'win32';
  }
};

/** Absolute path of the managed executable for `version`, or null when absent. */
export function findManagedAntigravityExecutable(
  version: string = antigravityRuntimeVersion(),
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const versionDir = antigravityVersionDir(version, env);
  for (const name of ANTIGRAVITY_EXECUTABLE_NAMES) {
    const candidate = path.join(versionDir, name);
    if (isExecutableFile(candidate)) return candidate;
  }
  return null;
}

export function readAntigravityInstallMarker(
  version: string = antigravityRuntimeVersion(),
  env: NodeJS.ProcessEnv = process.env,
): AntigravityInstallMarker | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(antigravityMarkerPath(version, env), 'utf8')) as AntigravityInstallMarker;
    return typeof parsed?.version === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * A managed install counts as present only when the marker, the executable and
 * the `localharness_external` sidecar are all there. A partially extracted
 * archive must read as "not installed" so `Install` repairs it instead of the
 * runtime failing later with a confusing ACP error.
 */
export function isAntigravityRuntimeInstalled(
  version: string = antigravityRuntimeVersion(),
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const marker = readAntigravityInstallMarker(version, env);
  if (!marker || marker.version !== version) return false;
  if (!findManagedAntigravityExecutable(version, env)) return false;
  return fs.existsSync(path.join(antigravityVersionDir(version, env), ANTIGRAVITY_HARNESS_NAME));
}

export type AntigravityBinaryResolution =
  | { ok: true; command: string; source: 'override' | 'managed' | 'path' }
  | { ok: false; code: 'INVALID_OVERRIDE' | 'NOT_INSTALLED' | 'UNSUPPORTED_PLATFORM'; message: string };

/**
 * Resolve the command to spawn.
 *
 * Order is deliberate and NOT a chain of silent fallbacks:
 *  1. explicit override — wins outright; invalid is an error, never a fallback;
 *  2. managed runtime — absolute path;
 *  3. PATH — only for users who installed Antigravity themselves.
 */
export function resolveAntigravityBinary(
  env: NodeJS.ProcessEnv = process.env,
  deps: { platform?: NodeJS.Platform; arch?: string } = {},
): AntigravityBinaryResolution {
  const override = antigravityBinaryOverride(env);
  if (override) {
    const resolved = path.resolve(override);
    if (!isExecutableFile(resolved)) {
      return {
        ok: false,
        code: 'INVALID_OVERRIDE',
        message: `Antigravity binary path "${override}" is not an executable file. Fix the path in Settings or clear it to use the managed runtime.`,
      };
    }
    return { ok: true, command: resolved, source: 'override' };
  }

  const managed = findManagedAntigravityExecutable(antigravityRuntimeVersion(env), env);
  if (managed) {
    return { ok: true, command: managed, source: 'managed' };
  }

  for (const name of ANTIGRAVITY_EXECUTABLE_NAMES) {
    for (const dir of (env.PATH ?? '').split(path.delimiter)) {
      if (!dir) continue;
      const candidate = path.join(dir, name);
      if (isExecutableFile(candidate)) {
        return { ok: true, command: candidate, source: 'path' };
      }
    }
  }

  const platform = deps.platform ?? process.platform;
  const arch = deps.arch ?? process.arch;
  if (!antigravityPlatformKey(platform, arch)) {
    return {
      ok: false,
      code: 'UNSUPPORTED_PLATFORM',
      message: antigravityUnsupportedPlatformMessage(platform, arch),
    };
  }

  return {
    ok: false,
    code: 'NOT_INSTALLED',
    message: 'The Antigravity runtime is not installed. Open Settings › Agents › Antigravity and run Install.',
  };
}

export function antigravityUnsupportedPlatformMessage(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string {
  if (platform === 'darwin' && arch !== 'arm64') {
    return 'Google does not publish an Antigravity ACP runtime for Intel Macs. Apple Silicon, Linux (x64/arm64) and Windows (x64/arm64) are supported.';
  }
  return `Google does not publish an Antigravity ACP runtime for ${platform}-${arch}. Supported hosts are macOS arm64, Linux x64/arm64 and Windows x64/arm64.`;
}

/**
 * ACP invocation arguments.
 *
 * Antigravity's ACP server is the process entry point itself — there is no
 * `acp --cwd <dir>` subcommand like OpenCode's, so the working directory is
 * carried by `session/new` instead. On Linux the registry requires the calling
 * uid so the harness can locate the per-user runtime directory.
 *
 * `uid` is taken as a rest parameter rather than a defaulted one on purpose: a
 * JS default fires for an *explicitly* passed `undefined` too, which would make
 * a caller saying "this host has no uid" silently pick up the current process's
 * uid. Omitting the argument means "ask this process"; passing `undefined` means
 * "there is no uid", and must emit no `--uid` flag.
 */
export function antigravityAcpArgs(
  platform: NodeJS.Platform = process.platform,
  ...uidArg: [uid?: number | undefined]
): string[] {
  const uid = uidArg.length > 0
    ? uidArg[0]
    : (typeof process.getuid === 'function' ? process.getuid() : undefined);
  if (platform === 'linux' && typeof uid === 'number') {
    return [`--uid=${uid}`];
  }
  return [];
}
