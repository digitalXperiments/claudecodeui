/**
 * Enforced Tool Gateway runs for Codex (see bots/gateway/providers/codex.ts and ENFORCEMENT.md).
 *
 * A gateway-bound bot run (`options.botGatewayStrict`) must not reach any capability that the
 * gate cannot see. Codex gets there with four layers, all verified against codex-cli 0.156:
 *
 *  1. Managed CODEX_HOME. `--config mcp_servers={}` does NOT clear the user's MCP servers (config
 *     tables are merged, an empty override is a no-op), so the run gets a throwaway CODEX_HOME that
 *     holds no config.toml, a link to the login (auth.json) and one execpolicy rules file. User
 *     config.toml (MCP servers, hooks, plugins, trusted projects) is simply never read, and an
 *     untrusted project's `.codex/config.toml` is ignored.
 *  2. Per-run `--config` overrides: the gateway is the only MCP server, built-in surfaces that
 *     bypass approvals are switched off (web_search, view_image, apps/connectors, plugins,
 *     browser/computer use, sub-agents, hooks), and a permission profile denies reads of the
 *     credential directories at the OS sandbox.
 *  3. Approval policy `untrusted` with approvals reviewer `user`: Codex asks for every shell
 *     command and every patch. A rules file additionally forces a prompt for the commands Codex
 *     treats as "known safe" in older builds.
 *  4. Every approval request is answered by `options.builtinToolGate`, never auto-approved.
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { guardedLoginWriteBack, snapshotFile } from '../../shared/login/login-writeback.js';

export const CODEX_GATEWAY_SERVER_NAME = 'cloudcli-tool-gateway';
/** Name of the permission profile written into the per-run config. */
export const CODEX_STRICT_PROFILE = 'cloudcli_bot_gate';

const SESSION_ENV = 'CLOUDCLI_SESSION_ID';
const SECRET_ENV = 'CLOUDCLI_BOT_GATEWAY_BINDING_SECRET';
const API_URL_ENV = 'CLOUDCLI_BOT_GATEWAY_API_URL';
const TOKEN_ENV = 'CLOUDCLI_BOT_GATEWAY_MCP_TOKEN';
/** Forwarded by name from the app-server env so the secrets never appear on a command line. */
export const GATEWAY_FORWARDED_ENV = Object.freeze([SESSION_ENV, SECRET_ENV, TOKEN_ENV, API_URL_ENV]);

/** Gateway calls can block on a human (10 min) or a handoff (30 min); Codex defaults to 60 s. */
const GATEWAY_TOOL_TIMEOUT_SEC = 2100;
const GATEWAY_STARTUP_TIMEOUT_SEC = 60;

/** Codex capabilities that act outside approvals or outside the gateway. */
const DISABLED_FEATURES = Object.freeze([
  'apps',
  'plugins',
  'remote_plugin',
  'plugin_sharing',
  'tool_suggest',
  'skill_mcp_dependency_install',
  'browser_use',
  'browser_use_external',
  'browser_use_full_cdp_access',
  'computer_use',
  'in_app_browser',
  'image_generation',
  'view_image',
  'multi_agent',
  'multi_agent_v2',
  'hooks',
  'memories',
  'goals',
  // The snapshot re-exports the server's full environment into every command, defeating
  // shell_environment_policy (verified: credentials leaked through it when logged in).
  'shell_snapshot',
  'shell_snapshot_v2',
]);

/** Home-relative paths no bot shell may read, mirroring the built-in gate denylist plus common credential stores. */
const DENY_READ_HOME_PATHS = Object.freeze([
  '.codex',
  '.claude',
  '.claude.json',
  '.grok',
  '.cursor',
  '.config',
  '.cloudcli',
  '.ssh',
  '.aws',
  '.gnupg',
  '.azure',
  '.kube',
  '.netrc',
  '.git-credentials',
  '.gemini',
  '.docker',
  '.zsh_history',
  '.bash_history',
  path.join('Library', 'Keychains'),
  // Browser profiles, app tokens and other apps' stores. The codex binary's own install dir (which
  // can live here) is re-allowed by strictAllowReadPaths: more specific entries win.
  path.join('Library', 'Application Support'),
]);

/**
 * Commands older Codex builds run without asking under `untrusted` ("known safe"). 0.156 asks for
 * all of them already; the rules keep that true on builds that do not.
 */
const KNOWN_SAFE_PROGRAMS = Object.freeze([
  'cat', 'cd', 'cut', 'echo', 'expr', 'false', 'grep', 'head', 'id', 'ls', 'nl', 'paste', 'pwd',
  'rev', 'seq', 'stat', 'tail', 'tr', 'true', 'uname', 'uniq', 'wc', 'which', 'whoami',
  'base64', 'find', 'rg', 'git', 'sed', 'sort', 'diff', 'date', 'printf', 'basename', 'dirname',
  'realpath', 'readlink', 'file', 'du', 'df', 'tree', 'less', 'more', 'hostname', 'env', 'printenv',
]);

export function buildStrictRules() {
  const programs = KNOWN_SAFE_PROGRAMS.map((name) => JSON.stringify(name)).join(', ');
  return [
    '# Managed by CloudCLI for a gateway-bound bot run. Do not edit.',
    `prefix_rule(pattern=[[${programs}]], decision="prompt", justification="Bot Tool Gateway reviews every command")`,
    '',
  ].join('\n');
}

/**
 * The Codex sandbox / approval settings for a gateway-bound run. `plan` keeps its read-only
 * sandbox; everything else (including the bot default `bypassPermissions`) is workspace-write.
 * Approval is always `untrusted` with the user as reviewer: the gate is that user.
 */
export function resolveStrictPolicy(permissionMode) {
  return {
    baseProfile: permissionMode === 'plan' ? ':read-only' : ':workspace',
    approvalPolicy: 'untrusted',
    approvalsReviewer: 'user',
  };
}

function realpathOrSelf(target) {
  try {
    return fs.realpathSync(target);
  } catch {
    return target;
  }
}

/**
 * Absolute paths the sandbox must hide from bot shells (home credential stores + the real CODEX_HOME).
 * @param {{ home?: string, codexHome?: string }} [options]
 * @returns {string[]}
 */
export function strictDenyReadPaths({ home = os.homedir(), codexHome = process.env.CODEX_HOME } = {}) {
  const roots = [...new Set([home, realpathOrSelf(home)])];
  const paths = new Set();
  for (const root of roots) {
    for (const entry of DENY_READ_HOME_PATHS) paths.add(path.join(root, entry));
  }
  if (typeof codexHome === 'string' && codexHome.trim()) paths.add(path.resolve(codexHome.trim()));
  return [...paths].sort();
}

/**
 * Codex marks the project as trusted when a thread starts with a writable sandbox, which then
 * loads `<project>/.codex/config.toml` (MCP servers, hooks, exec policies) and bypasses the
 * managed home. Pinning `trust_level = "untrusted"` for the working directory, every ancestor
 * (the trust key is the git root) and the main checkout of a linked worktree keeps the project
 * layer disabled; an explicit entry is also never overwritten by the auto-trust.
 */
/** @param {string | undefined} cwd @returns {string[]} */
export function strictUntrustedProjectPaths(cwd) {
  if (!cwd) return [];
  const start = path.resolve(cwd);
  const paths = new Set();
  const add = (target) => {
    let current = target;
    for (;;) {
      paths.add(current);
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  };
  add(start);
  add(realpathOrSelf(start));
  for (const dir of [...paths]) {
    // A linked worktree's `.git` is a file pointing into the main checkout's `.git/worktrees/<name>`.
    try {
      const gitFile = path.join(dir, '.git');
      if (!fs.statSync(gitFile).isFile()) continue;
      const match = /^gitdir:\s*(.+?)\s*$/m.exec(fs.readFileSync(gitFile, 'utf8'));
      const gitDir = match ? path.resolve(dir, match[1]) : '';
      const marker = `${path.sep}.git${path.sep}`;
      const index = gitDir.indexOf(marker);
      if (index > 0) add(gitDir.slice(0, index));
    } catch {
      // Not a linked worktree.
    }
  }
  return [...paths].sort();
}

/**
 * Paths Codex itself must read inside the sandbox: its own binary (the fs sandbox helper re-executes
 * `codex`) even when it lives under a denied directory such as ~/.codex/packages.
 *
 * @param {{ launcherCommand?: string, denyReadPaths?: string[] }} [options]
 * @returns {string[]}
 */
export function strictAllowReadPaths({ launcherCommand, denyReadPaths = [] } = {}) {
  if (typeof launcherCommand !== 'string' || !path.isAbsolute(launcherCommand)) return [];
  const real = realpathOrSelf(launcherCommand);
  const binDir = path.dirname(real);
  const installRoot = path.basename(binDir) === 'bin' ? path.dirname(binDir) : binDir;
  const allowed = new Set([launcherCommand, real, installRoot]);
  // `current -> releases/<version>` style links live inside the denied directory, so the whole
  // packages folder has to stay readable for the helper to resolve them.
  for (const denied of denyReadPaths) {
    const packages = path.join(denied, 'packages');
    for (const candidate of [launcherCommand, real]) {
      if (isInside(candidate, denied) || isInside(realpathOrSelf(candidate), denied)) allowed.add(packages);
    }
  }
  return [...allowed];
}

function isInside(child, parent) {
  const relative = path.relative(parent, child);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/**
 * The gateway MCP entry plus its env wiring. `gateway` is the launch spec from the bots module:
 * `{ command, args, env: { CLOUDCLI_BOT_GATEWAY_API_URL, CLOUDCLI_BOT_GATEWAY_MCP_TOKEN } }`.
 */
function buildGatewayServerEntry({ gateway, appSessionId }) {
  return {
    command: gateway.command,
    args: [...(gateway.args || [])],
    // Not secret: the loopback API URL and the session this child serves.
    env: {
      [SESSION_ENV]: appSessionId,
      [API_URL_ENV]: gateway.env?.[API_URL_ENV],
    },
    // Secret: forwarded by name from the app-server environment (no argv exposure).
    env_vars: [SECRET_ENV, TOKEN_ENV],
    // The gateway is the gate. Codex must not add its own per-tool prompt in front of it.
    default_tools_approval_mode: 'approve',
    startup_timeout_sec: GATEWAY_STARTUP_TIMEOUT_SEC,
    tool_timeout_sec: GATEWAY_TOOL_TIMEOUT_SEC,
  };
}

/**
 * The `--config` object for a strict run (flattened to TOML overrides by codex-app-server.js).
 * @param {{ gateway: any, appSessionId: string, policy: { baseProfile: string, approvalPolicy: string, approvalsReviewer: string }, cwd?: string, denyReadPaths: string[], allowReadPaths?: string[] }} input
 * @returns {Record<string, any>}
 */
export function buildStrictCodexConfig({ gateway, appSessionId, policy, cwd, denyReadPaths, allowReadPaths = [] }) {
  const writable = policy.baseProfile === ':workspace';
  const filesystem = {};
  for (const denied of denyReadPaths) filesystem[denied] = 'deny';
  for (const allowed of allowReadPaths) filesystem[allowed] = 'read';
  // The run's own working directory stays usable even when it sits under a denied parent
  // (a bot's home is under ~/.cloudcli). More specific entries win over the deny.
  if (cwd) filesystem[path.resolve(cwd)] = writable ? 'write' : 'read';
  return {
    mcp_servers: { [CODEX_GATEWAY_SERVER_NAME]: buildGatewayServerEntry({ gateway, appSessionId }) },
    projects: Object.fromEntries(strictUntrustedProjectPaths(cwd).map((target) => [target, { trust_level: 'untrusted' }])),
    default_permissions: CODEX_STRICT_PROFILE,
    permissions: { [CODEX_STRICT_PROFILE]: { extends: policy.baseProfile, filesystem } },
    // approval_policy is deliberately NOT set here: 0.156 rejects `untrusted` in config. The thread
    // and every turn carry approvalPolicy / approvalsReviewer instead (openai-codex.js).
    approvals_reviewer: policy.approvalsReviewer,
    web_search: 'disabled',
    features: Object.fromEntries(DISABLED_FEATURES.map((name) => [name, false])),
    // Keep gateway credentials and the managed home out of every shell the model starts.
    shell_environment_policy: {
      ignore_default_excludes: false,
      exclude: ['CLOUDCLI_*', 'CODEX_HOME', '*PASSWORD*', '*CREDENTIAL*', 'SSH_AUTH_SOCK'],
    },
  };
}

/**
 * The app-server process env: managed home plus the gateway credentials forwarded to the MCP child.
 * @param {{ baseEnv: Record<string, string | undefined>, home: string, appSessionId: string, bindingSecret: string, gateway: any }} input
 * @returns {Record<string, string | undefined>}
 */
export function buildStrictCodexEnv({ baseEnv, home, appSessionId, bindingSecret, gateway }) {
  const env = { ...baseEnv };
  // Nothing inherited from the server process may speak for a gateway session.
  for (const name of Object.keys(env)) {
    if (name.startsWith('CLOUDCLI_BOT_GATEWAY_')) delete env[name];
  }
  return {
    ...env,
    CODEX_HOME: home,
    [SESSION_ENV]: appSessionId,
    [SECRET_ENV]: bindingSecret,
    [TOKEN_ENV]: gateway.env?.[TOKEN_ENV] || '',
    [API_URL_ENV]: gateway.env?.[API_URL_ENV] || '',
  };
}

/**
 * Validates the pieces a strict run cannot start without. Throws so the run fails closed.
 * @param {{ gateway: any, appSessionId?: string, bindingSecret?: string }} input
 */
export function assertStrictRunInputs({ gateway, appSessionId, bindingSecret }) {
  if (!gateway || typeof gateway.command !== 'string' || !gateway.command) {
    throw new Error('Codex gateway-bound run is missing the Tool Gateway launch spec (options.codexGatewayMcp).');
  }
  if (!gateway.env?.[TOKEN_ENV] || !gateway.env?.[API_URL_ENV]) {
    throw new Error('Codex gateway-bound run is missing the Tool Gateway API url or token.');
  }
  if (!appSessionId) {
    throw new Error('Codex gateway-bound run needs an appSessionId to bind the Tool Gateway.');
  }
  if (!bindingSecret) {
    throw new Error('Codex gateway-bound run needs the gateway binding secret (options.botGatewaySecret).');
  }
}

/** Root for per-run managed homes. Under `node --test` it is a temp folder so tests never touch ~/.cloudcli. */
export function resolveStrictHomeRoot() {
  const override = process.env.CLOUDCLI_CODEX_BOT_HOMES?.trim();
  if (override) return path.resolve(override);
  if (process.env.NODE_TEST_CONTEXT) return path.join(os.tmpdir(), 'cloudcli-test-codex-bot-homes');
  return path.join(os.homedir(), '.cloudcli', 'codex-bot-homes');
}

function safeSegment(value) {
  return String(value || 'run').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64) || 'run';
}

/** Managed homes older than this belong to a run that never cleaned up (server crash). */
const STALE_HOME_MS = 24 * 60 * 60 * 1000;

function sweepStaleHomes(root, now = Date.now()) {
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    try {
      if (now - fs.statSync(dir).mtimeMs > STALE_HOME_MS) fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best effort: another process may be removing it.
    }
  }
}

/**
 * Creates the per-run CODEX_HOME. auth.json is a symlink to the operator's login so a token
 * refresh that writes in place goes straight to the real file (never lost, never racing a copy).
 * If Codex instead replaces the link with a fresh regular file (temp + rename, which is what most
 * token writers do), cleanup considers copying that file back, but only through
 * `guardedLoginWriteBack`: the real login is fingerprinted (mtime, size, sha256) when the run
 * starts and the run's file is written back only if the real one is still exactly that AND the
 * run's file is newer, via a temp file + atomic rename with the fingerprint re-checked just before.
 * Anything else discards the run's copy with a log line; the real login is never overwritten blindly.
 *
 * @param {{ root?: string, appSessionId?: string, authHome?: string }} [options]
 * @returns {{ home: string, cleanup: () => void }}
 */
export function prepareStrictCodexHome({ root = resolveStrictHomeRoot(), appSessionId, authHome } = {}) {
  sweepStaleHomes(root);
  const home = path.join(root, `${safeSegment(appSessionId)}-${randomBytes(4).toString('hex')}`);
  fs.mkdirSync(path.join(home, 'rules'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(home, 'rules', 'default.rules'), buildStrictRules(), { mode: 0o600 });

  const sourceHome = authHome || process.env.CODEX_HOME?.trim() || path.join(os.homedir(), '.codex');
  const realAuth = path.join(sourceHome, 'auth.json');
  const managedAuth = path.join(home, 'auth.json');
  // Fingerprint BEFORE the run can touch it; null when there is no login (nothing is ever created from a run copy).
  const startSnapshot = snapshotFile(realAuth);
  if (fs.existsSync(realAuth)) fs.symlinkSync(realAuth, managedAuth);

  let cleaned = false;
  return {
    home,
    cleanup() {
      if (cleaned) return;
      cleaned = true;
      guardedLoginWriteBack({ realFile: realAuth, runFile: managedAuth, startSnapshot, label: 'Codex' });
      try {
        fs.rmSync(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      } catch (error) {
        console.warn('[Codex] Could not remove managed bot home:', error instanceof Error ? error.message : error);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Approval requests -> builtinToolGate

/**
 * Codex wraps every shell command as `<shell> -lc <script>`. The gate classifier works on the
 * script, so unwrap one layer when it parses cleanly; otherwise return the text unchanged (the
 * gate then sees an unknown program and escalates, which is the safe direction).
 */
export function unwrapShellCommand(command) {
  const text = String(command ?? '').trim();
  const match = /^(?:\S*\/)?(?:bash|zsh|sh|dash|ksh)\s+-[A-Za-z]*c\s+([\s\S]+)$/.exec(text);
  if (!match) return text;
  const body = match[1].trim();
  if (body.startsWith("'") && body.endsWith("'") && body.length >= 2) {
    const raw = body.slice(1, -1);
    // A quote that is not part of the `'\''` escape means the "single argument" assumption is wrong.
    if (raw.replace(/'\\''/g, '').includes("'")) return text;
    return raw.replace(/'\\''/g, "'");
  }
  if (body.startsWith('"') && body.endsWith('"') && body.length >= 2) {
    const inner = body.slice(1, -1);
    // An unescaped double quote means the "single argument" assumption is wrong.
    if (/(^|[^\\])(?:\\\\)*"/.test(inner)) return text;
    return inner.replace(/\\(["\\$`])/g, '$1');
  }
  return /\s/.test(body) ? text : body;
}

function legacyCommandText(command) {
  if (!Array.isArray(command)) return typeof command === 'string' ? command : '';
  const [program, flag, script] = command;
  if (typeof script === 'string' && command.length === 3 && /^-[A-Za-z]*c$/.test(String(flag)) && /(?:^|\/)(?:bash|zsh|sh|dash|ksh)$/.test(String(program))) {
    return script;
  }
  return command.join(' ');
}

function networkUrl(context) {
  const host = String(context?.host || '').trim();
  if (!host) return '';
  const protocol = String(context?.protocol || '').toLowerCase();
  const scheme = protocol === 'https' ? 'https' : protocol === 'http' ? 'http' : 'tcp';
  return `${scheme}://${host}`;
}

/**
 * Extracts `{ tool, path }` pairs from a v2 fileChange item or a legacy fileChanges map.
 * @param {{ changes?: any, legacyChanges?: any, grantRoot?: string }} input
 * @returns {Array<{ tool: string, path: string }>}
 */
export function fileChangeTargets({ changes, legacyChanges, grantRoot }) {
  const targets = [];
  const add = (kind, target) => {
    if (typeof target === 'string' && target) targets.push({ tool: kind === 'add' ? 'Write' : 'Edit', path: target });
  };
  for (const change of Array.isArray(changes) ? changes : []) {
    const kind = change?.kind?.type;
    add(kind, change?.path);
    if (kind === 'update' && change?.kind?.move_path) add('add', change.kind.move_path);
  }
  if (legacyChanges && typeof legacyChanges === 'object') {
    for (const [target, change] of Object.entries(legacyChanges)) {
      add(change?.type, target);
      if (change?.type === 'update' && change?.move_path) add('add', change.move_path);
    }
  }
  if (typeof grantRoot === 'string' && grantRoot) targets.push({ tool: 'Write', path: grantRoot });
  return targets;
}

/**
 * Decides one Codex approval request through the built-in gate. Returns `{ allow, message }`.
 * Only the request kinds that grant a capability are gated here; anything unrecognised is denied.
 * Every thrown gate error denies (fail closed).
 *
 * @param {{ method: string, params?: Record<string, any>, gate: (toolName: string, input: unknown) => Promise<{ behavior: string, message?: string }>, fileChangeItems?: Map<string, any>, cwd?: string }} input
 * @returns {Promise<{ allow: boolean, message?: string }>}
 */
export async function decideStrictApproval({ method, params = {}, gate, fileChangeItems, cwd }) {
  const deny = (message) => ({ allow: false, message });
  const run = async (toolName, input) => {
    let decision;
    try {
      decision = await gate(toolName, input);
    } catch (error) {
      return deny(`Gate error: ${error instanceof Error ? error.message : String(error)}`);
    }
    return decision?.behavior === 'allow' ? { allow: true } : deny(decision?.message || 'Denied by the bot gate.');
  };

  if (method === 'item/commandExecution/requestApproval' || method === 'execCommandApproval') {
    const raw = method === 'execCommandApproval' ? legacyCommandText(params.command) : params.command;
    const commandCwd = params.cwd || cwd;
    const checks = [];
    if (params.networkApprovalContext) {
      const url = networkUrl(params.networkApprovalContext);
      if (!url) return deny('Network access request without a host.');
      checks.push(['WebFetch', { url }]);
    } else {
      if (typeof raw !== 'string' || !raw.trim()) return deny('Command approval without a command text.');
      checks.push(['Bash', { command: unwrapShellCommand(raw), cwd: commandCwd }]);
    }
    const extra = params.additionalPermissions;
    if (extra && typeof extra === 'object') {
      for (const read of extra.fileSystem?.read ?? []) checks.push(['Read', { file_path: String(read) }]);
      for (const write of extra.fileSystem?.write ?? []) checks.push(['Write', { file_path: String(write) }]);
      if (extra.network?.enabled) checks.push(['WebFetch', { url: 'network://sandbox-escape' }]);
    }
    for (const [toolName, input] of checks) {
      const verdict = await run(toolName, input);
      if (!verdict.allow) return verdict;
    }
    return { allow: true };
  }

  if (method === 'item/fileChange/requestApproval' || method === 'applyPatchApproval') {
    const tracked = method === 'applyPatchApproval' ? null : fileChangeItems?.get(params.itemId);
    const targets = fileChangeTargets({
      changes: tracked,
      legacyChanges: method === 'applyPatchApproval' ? params.fileChanges : undefined,
      grantRoot: params.grantRoot,
    });
    if (targets.length === 0) return deny('File change approval without any target path.');
    for (const target of targets) {
      const verdict = await run(target.tool, { file_path: path.resolve(cwd || '/', target.path) });
      if (!verdict.allow) return verdict;
    }
    return { allow: true };
  }

  return deny(`Codex request "${method}" is not allowed on a gateway-bound run.`);
}
