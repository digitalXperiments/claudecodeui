/**
 * OS-level sandbox for Agent Relay workers.
 *
 * The relay's approval envelope used to rest entirely on classifying command
 * strings, which is wrong in both directions: it bounced routine work
 * (`python3 -m pytest`, heredoc writes, project scripts) to the lead, and it
 * approved commands that run arbitrary code (`cargo run`, `awk system()`).
 * Here the boundary is enforced by the kernel instead, so anything a worker
 * does inside its sandbox can be auto-approved and only boundary crossings
 * need a decision.
 *
 * A spec is computed once per job by the relay service and handed to the
 * provider adapter as `options.relaySandbox`:
 *
 *   {
 *     mode: 'read_only' | 'isolated_write',
 *     enforcement: 'process' | 'provider',
 *     cwd: string,               // the worker's working root
 *     writableRoots: string[],   // writers: cwd + the git dirs its branch needs
 *     protectedRoots: string[],  // primary checkout / repository root
 *     scratchRoots: string[],    // tmp/cloudcli dirs, writable in both modes
 *     network: 'open' | 'restricted',
 *     allowedDomains: string[],  // for providers that filter by domain
 *   }
 *
 * `process` enforcement wraps the whole provider CLI in `sandbox-exec`
 * (macOS Seatbelt); every child it spawns inherits the profile. `provider`
 * enforcement uses the provider's own sandbox (Claude SDK sandbox, Codex
 * workspace-write seatbelt), because nesting Seatbelt profiles fails.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const SANDBOX_EXEC_PATH = '/usr/bin/sandbox-exec';

/** Default domains a worker may reach when the provider filters by domain. */
export const DEFAULT_WORKER_ALLOWED_DOMAINS = Object.freeze([
  'localhost',
  '127.0.0.1',
  'registry.npmjs.org',
  '*.npmjs.org',
  'registry.yarnpkg.com',
  'pypi.org',
  'files.pythonhosted.org',
  'github.com',
  '*.github.com',
  '*.githubusercontent.com',
  'crates.io',
  'static.crates.io',
  'proxy.golang.org',
]);

/**
 * Home-relative paths a worker must never write, even though dot-directories
 * are otherwise writable (provider CLIs keep their own state there).
 */
export const SENSITIVE_HOME_PATHS = Object.freeze([
  '.ssh',
  '.gnupg',
  '.aws',
  '.azure',
  '.kube',
  '.docker/config.json',
  '.netrc',
  '.npmrc',
  '.pypirc',
  '.gitconfig',
  '.git-credentials',
  '.config/git',
  '.config/gh',
  '.zshrc',
  '.zprofile',
  '.zshenv',
  '.zlogin',
  '.bashrc',
  '.bash_profile',
  '.profile',
  '.claude.json',
  '.claude/settings.json',
  '.codex/config.toml',
  '.cloudcli/secrets.key',
  '.cloudcli/hooks.json',
  '.cloudcli/local-server.json',
  '.cloudcli/mcp',
  '.cloudcli/skills',
  'Library/Keychains',
  'Library/LaunchAgents',
]);

/** Prefix patterns (regex) under home that must never be written. */
const SENSITIVE_HOME_PREFIXES = Object.freeze(['.cloudcli/auth.db', '.cloudcli/sessions.db']);

/** Absolute roots outside home that hold user-writable tooling. */
const PROTECTED_SYSTEM_ROOTS = Object.freeze(['/opt', '/usr/local', '/Volumes', '/private/etc']);

export function processSandboxAvailable(platform = process.platform) {
  if (platform !== 'darwin') return false;
  try {
    return fs.existsSync(SANDBOX_EXEC_PATH);
  } catch {
    return false;
  }
}

function sbplString(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function regexEscape(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

function canonical(target) {
  try {
    return fs.realpathSync(target);
  } catch {
    return path.resolve(target);
  }
}

/** Both the given and canonical spellings (/var vs /private/var on macOS). */
function spellings(target) {
  const resolved = path.resolve(target);
  const real = canonical(target);
  return real === resolved ? [resolved] : [resolved, real];
}

function subpaths(targets) {
  return [...new Set(targets.flatMap(spellings))].map((target) => `(subpath ${sbplString(target)})`);
}

/**
 * Seatbelt profile for a worker. Later rules win in SBPL, so the order is:
 * allow everything → deny writes under home and user tooling roots → re-allow
 * CLI state dirs → deny credentials/shell rc/CloudCLI state → deny the
 * primary checkout → re-allow the worker's own writable roots and scratch.
 */
export function buildSeatbeltProfile(spec, { homeDir = os.homedir() } = {}) {
  const home = canonical(homeDir);
  const lines = ['(version 1)', '(allow default)'];

  lines.push(`(deny file-write* ${subpaths([home, ...PROTECTED_SYSTEM_ROOTS]).join(' ')})`);
  lines.push(
    `(allow file-write* (regex #"^${regexEscape(home)}/\\.") ${subpaths([
      path.join(home, 'Library', 'Caches'),
      path.join(home, 'Library', 'Application Support'),
      path.join(home, 'Library', 'Logs'),
      path.join(home, 'Library', 'Preferences'),
    ]).join(' ')})`,
  );

  const sensitive = SENSITIVE_HOME_PATHS.map((entry) => {
    const absolute = path.join(home, entry);
    return `(subpath ${sbplString(absolute)})`;
  });
  const sensitivePrefixes = SENSITIVE_HOME_PREFIXES.map(
    (entry) => `(regex #"^${regexEscape(path.join(home, entry))}")`,
  );
  lines.push(`(deny file-write* ${[...sensitive, ...sensitivePrefixes].join(' ')})`);

  const protectedRoots = (spec.protectedRoots ?? []).filter(Boolean);
  if (protectedRoots.length > 0) {
    lines.push(`(deny file-write* ${subpaths(protectedRoots).join(' ')})`);
  }

  const reallowed = [
    ...(spec.scratchRoots ?? []),
    ...(spec.mode === 'isolated_write' ? spec.writableRoots ?? [] : []),
  ].filter(Boolean);
  if (reallowed.length > 0) {
    lines.push(`(allow file-write* ${subpaths(reallowed).join(' ')})`);
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Wrap a provider CLI launch in `sandbox-exec` when the spec asks for process
 * enforcement and the host supports it. Returns the launch unchanged
 * otherwise, together with whether the sandbox was actually applied.
 */
export function wrapCommandForSandbox(command, args, spec, options = {}) {
  if (!spec || spec.enforcement !== 'process' || !processSandboxAvailable(options.platform)) {
    return { command, args, sandboxed: false };
  }
  const profile = buildSeatbeltProfile(spec, options);
  return {
    command: SANDBOX_EXEC_PATH,
    args: ['-p', profile, command, ...args],
    sandboxed: true,
  };
}

/**
 * Claude Agent SDK `sandbox` option for a spec. The SDK sandbox confines Bash
 * to the cwd plus `allowWrite`; `allowUnsandboxedCommands: false` removes the
 * model's `dangerouslyDisableSandbox` escape hatch, and failing closed keeps
 * an unavailable sandbox from silently running auto-allowed Bash unconfined.
 */
export function claudeSdkSandboxSettings(spec) {
  if (!spec || spec.enforcement !== 'provider') return null;
  const extraWrite = [
    ...(spec.scratchRoots ?? []),
    ...(spec.mode === 'isolated_write' ? (spec.writableRoots ?? []).filter((root) => root !== spec.cwd) : []),
  ];
  const settings = {
    enabled: true,
    failIfUnavailable: true,
    autoAllowBashIfSandboxed: true,
    allowUnsandboxedCommands: false,
    network: {
      allowLocalBinding: true,
      ...(spec.network === 'open' ? { allowedDomains: [...(spec.allowedDomains ?? DEFAULT_WORKER_ALLOWED_DOMAINS)] } : {}),
    },
    filesystem: {
      ...(extraWrite.length ? { allowWrite: extraWrite } : {}),
      ...(spec.mode === 'read_only' && spec.cwd ? { denyWrite: [spec.cwd] } : {}),
    },
  };
  return settings;
}

/** Codex `--config` overrides for a writer's workspace-write sandbox. */
export function codexSandboxConfig(spec) {
  if (!spec || spec.enforcement !== 'provider' || spec.mode !== 'isolated_write') return {};
  return {
    sandbox_workspace_write: {
      network_access: spec.network === 'open',
      writable_roots: [...new Set([
        ...(spec.writableRoots ?? []).filter((root) => root !== spec.cwd),
        ...(spec.scratchRoots ?? []),
      ])],
    },
  };
}
