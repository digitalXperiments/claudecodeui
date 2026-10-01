/**
 * Strict (gateway-enforced) Grok runs for Bot Runtime v2.
 *
 * A bot run with `options.botGatewayStrict` must reach MCP tools only through
 * `cloudcli-tool-gateway` and must have every built-in tool (shell, file edits,
 * web fetch, ...) decided by `options.builtinToolGate`. This module holds the
 * pieces grok-cli.js needs for that:
 *
 *  - a per-run GROK_HOME built from scratch (never from the user's config), so
 *    none of the user's `[mcp_servers]`, plugins, remembered "always allow"
 *    grants or trusted folders can leak in;
 *  - the env that switches off every other MCP source grok knows about;
 *  - the mapping from a Grok ACP `session/request_permission` to the gate's
 *    tool names, and the allow/deny answer back.
 *
 * Grok behaviour relied on here was checked against grok 1.0.46: `grok inspect
 * --json` for config and env handling, and the CLI's embedded user guide for
 * permission-rule semantics. Where a behaviour could only be read, not run, it
 * is marked ASSUMED in gateway/providers/grok.md.
 */

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { toGrokAcpMcpServers, type ResolvedMcpConnection } from './grok-acp-managed-mcp.js';

type AnyRecord = Record<string, unknown>;

export const GROK_GATEWAY_SERVER_NAME = 'cloudcli-tool-gateway';
export const GROK_GATEWAY_BINDING_SECRET_ENV = 'CLOUDCLI_BOT_GATEWAY_BINDING_SECRET';
const GATEWAY_TOOL_PREFIX = `${GROK_GATEWAY_SERVER_NAME}__`;
const GATE_GATEWAY_PREFIX = `mcp__${GROK_GATEWAY_SERVER_NAME}__`;

/** Strict run homes older than this are leftovers of a crashed server and are swept. */
const STALE_RUN_HOME_MS = 12 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Environment

/**
 * Env that turns off every MCP source except what CloudCLI passes over ACP. Env outranks
 * config.toml in grok's precedence, so these hold even if a config layer says otherwise.
 * (`grok inspect --json` reports `source: "env"` for the compat cells.)
 */
export const STRICT_GROK_MCP_ENV: Readonly<Record<string, string>> = {
  GROK_CLAUDE_MCPS_ENABLED: 'false',
  GROK_CURSOR_MCPS_ENABLED: 'false',
  GROK_CODEX_MCPS_ENABLED: 'false',
  GROK_MANAGED_MCPS_ENABLED: 'false',
  GROK_MANAGED_MCP_GATEWAY_TOOLS_ENABLED: 'false',
  GROK_DISABLE_AUTOUPDATER: '1',
};

/**
 * Inherited variables that could re-open what the strict home closes: config overlays, a
 * folder-trust kill switch (GROK_FOLDER_TRUST=0 ungates project-scoped MCP servers), a
 * permission-mode override, and a shared leader socket.
 */
export const STRICT_GROK_STRIPPED_ENV: readonly string[] = [
  'GROK_CONFIG',
  'GROK_CONFIG_PATH',
  'GROK_FOLDER_TRUST',
  'GROK_DEFAULT_PERMISSION_MODE',
  'GROK_AUTO_PERMISSION_MODE',
  'GROK_LEADER_SOCKET',
];

/** Env for the grok child of a strict run (merged over process.env by the caller). */
export function buildStrictGrokEnv(homeDir: string): Record<string, string> {
  return { ...STRICT_GROK_MCP_ENV, GROK_HOME: homeDir };
}

/** Removes the variables in STRICT_GROK_STRIPPED_ENV from a child env, in place. */
export function stripStrictGrokEnv(env: Record<string, string | undefined>): void {
  for (const key of STRICT_GROK_STRIPPED_ENV) delete env[key];
}

// ---------------------------------------------------------------------------
// Per-run GROK_HOME

/**
 * Generated config for a strict run. Built from scratch, never from `~/.grok/config.toml`, so it
 * carries no `[mcp_servers]` and no user permission rules.
 *
 * When `gated`, every tool call (reads and read-only shell commands included) must ask, which is
 * what makes grok send `session/request_permission` for it. `ask` outranks `allow` whatever file
 * the allow rule came from (project `.grok/config.toml`, `.claude/settings*.json`), and the
 * permission mode stays at `default` (never always-approve).
 */
export function buildStrictGrokConfigToml(options: { gated: boolean; configPermissionMode?: string } = { gated: true }): string {
  const mode = options.gated ? 'default' : options.configPermissionMode || 'default';
  const lines = [
    '# CloudCLI strict bot run: generated per run, deleted after it. Never edit by hand.',
    '[ui]',
    `permission_mode = "${mode}"`,
    `yolo = ${mode === 'always-approve' ? 'true' : 'false'}`,
  ];
  if (options.gated) {
    lines.push(
      'remember_tool_approvals = false',
      '',
      '[permission]',
      'ask = ["*"]',
    );
  }
  lines.push(
    '',
    '[cli]',
    'use_leader = false',
    'auto_update = false',
    '',
    '[compat.claude]',
    'mcps = false',
    '',
    '[compat.cursor]',
    'mcps = false',
    '',
    '[compat.codex]',
    'mcps = false',
    '',
    '[managed_mcps]',
    'enabled = false',
    'gateway_tools_enabled = false',
    '',
  );
  return lines.join('\n');
}

/** The user's real grok home, unwrapping a CloudCLI-managed GROK_HOME the same way ensureManagedGrokHome does. */
export function resolveSourceGrokHome(): string {
  const configured = process.env.GROK_HOME || path.join(os.homedir(), '.grok');
  const nested = [`${path.sep}.cloudcli${path.sep}grok-runtime${path.sep}`, `${path.sep}.cloudcli${path.sep}grok-strict-runs${path.sep}`];
  return nested.some((segment) => configured.includes(segment)) ? path.join(os.homedir(), '.grok') : configured;
}

export function resolveStrictRunsRoot(): string {
  // Deliberately NOT under ~/.cloudcli/grok-runtime: ensureManagedGrokHome scans that folder and
  // would copy credentials and a sessions symlink into every subdirectory.
  return path.join(os.homedir(), '.cloudcli', 'grok-strict-runs');
}

export interface StrictGrokHome {
  /** Pass as GROK_HOME. */
  dir: string;
  /**
   * Writes back what must outlive the run: a rotated login (newest wins, never resurrecting a
   * logged-out home) and the new session transcripts (never `permission*.toml` grants).
   * One-shot: later calls do nothing.
   */
  syncBack(): void;
  /** syncBack() then deletes the directory. Idempotent. */
  cleanup(): void;
}

const activeHomes = new Set<StrictGrokHome>();
let exitHookInstalled = false;

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on('exit', () => {
    for (const home of [...activeHomes]) {
      try {
        home.cleanup();
      } catch {
        // Best effort at process exit; the next run sweeps leftovers.
      }
    }
  });
}

function writePrivateFile(target: string, content: Buffer | string): void {
  fs.writeFileSync(target, content, { mode: 0o600 });
  // writeFileSync honours the mode only when it creates the file.
  fs.chmodSync(target, 0o600);
}

function copyPrivateFile(source: string, target: string): boolean {
  let content: Buffer;
  let mtime: Date;
  try {
    content = fs.readFileSync(source);
    mtime = fs.statSync(source).mtime;
  } catch {
    return false;
  }
  writePrivateFile(target, content);
  // Keep the source's age so a refreshed copy (newer mtime) is recognisable at sync-back.
  fs.utimesSync(target, mtime, mtime);
  return true;
}

function sweepStaleRunHomes(root: string, now: number): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('run-')) continue;
    const full = path.join(root, entry.name);
    try {
      if (now - fs.statSync(full).mtimeMs > STALE_RUN_HOME_MS) fs.rmSync(full, { recursive: true, force: true });
    } catch {
      // Vanished or unreadable: leave it.
    }
  }
}

function syncAuthBack(runDir: string, sourceHome: string): void {
  const runAuth = path.join(runDir, 'auth.json');
  const sourceAuth = path.join(sourceHome, 'auth.json');
  // A source file that is gone means an explicit logout; never resurrect it from a run copy.
  if (!fs.existsSync(runAuth) || !fs.existsSync(sourceAuth)) return;
  const runStat = fs.statSync(runAuth);
  if (runStat.mtimeMs <= fs.statSync(sourceAuth).mtimeMs) return;
  const content = fs.readFileSync(runAuth);
  if (content.equals(fs.readFileSync(sourceAuth))) return;
  const tmp = `${sourceAuth}.cloudcli-strict-${process.pid}.tmp`;
  writePrivateFile(tmp, content);
  fs.renameSync(tmp, sourceAuth);
  fs.utimesSync(sourceAuth, runStat.mtime, runStat.mtime);
}

function mergeSessionDir(source: string, target: string): void {
  fs.mkdirSync(target, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (entry.isSymbolicLink() || entry.name.endsWith('.lock')) continue;
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    if (entry.isDirectory()) {
      mergeSessionDir(from, to);
    } else if (entry.isFile()) {
      if (entry.name === 'chat_history.jsonl' && fs.existsSync(to) && fs.statSync(to).size > 0) {
        // A forked session's transcript was pre-seeded with the prior turns; append this run's.
        const existing = fs.readFileSync(to, 'utf8');
        const addition = fs.readFileSync(from, 'utf8');
        fs.writeFileSync(to, `${existing}${existing.endsWith('\n') || !addition ? '' : '\n'}${addition}`);
      } else {
        fs.copyFileSync(from, to);
      }
    }
  }
}

function syncSessionsBack(runDir: string, sourceHome: string): void {
  const runSessions = path.join(runDir, 'sessions');
  const targetRoot = path.join(sourceHome, 'sessions');
  let projects: fs.Dirent[];
  try {
    projects = fs.readdirSync(runSessions, { withFileTypes: true });
  } catch {
    return;
  }
  for (const project of projects) {
    if (!project.isDirectory()) continue; // loose files at this level are not transcripts
    const projectDir = path.join(runSessions, project.name);
    for (const session of fs.readdirSync(projectDir, { withFileTypes: true })) {
      // Only session directories. `permission*.toml` (remembered grants) and prompt history sit
      // next to them as plain files and must not reach the user's real home.
      if (!session.isDirectory()) continue;
      mergeSessionDir(path.join(projectDir, session.name), path.join(targetRoot, project.name, session.name));
    }
  }
}

export function createStrictGrokHome(options: {
  gated: boolean;
  configPermissionMode?: string;
  /** Test seams. */
  sourceHome?: string;
  root?: string;
  now?: () => number;
}): StrictGrokHome {
  const sourceHome = options.sourceHome ?? resolveSourceGrokHome();
  const root = options.root ?? resolveStrictRunsRoot();
  const now = options.now ?? Date.now;

  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  fs.chmodSync(root, 0o700);
  sweepStaleRunHomes(root, now());

  const dir = fs.mkdtempSync(path.join(root, `run-${randomBytes(3).toString('hex')}-`));
  fs.chmodSync(dir, 0o700);

  writePrivateFile(path.join(dir, 'config.toml'), buildStrictGrokConfigToml({
    gated: options.gated,
    configPermissionMode: options.configPermissionMode,
  }));
  // Login only. Nothing else from the real home is copied: no config.toml, no
  // mcp_credentials.json, no trusted_folders.toml, no plugins/skills, no permission grants.
  copyPrivateFile(path.join(sourceHome, 'auth.json'), path.join(dir, 'auth.json'));
  copyPrivateFile(path.join(sourceHome, 'models_cache.json'), path.join(dir, 'models_cache.json'));
  fs.mkdirSync(path.join(dir, 'sessions'), { recursive: true, mode: 0o700 });

  let synced = false;
  let removed = false;
  const home: StrictGrokHome = {
    dir,
    syncBack() {
      if (synced || removed) return;
      synced = true;
      try {
        syncAuthBack(dir, sourceHome);
      } catch (error) {
        console.warn('[grok-strict] could not write the refreshed login back:', error instanceof Error ? error.message : error);
      }
      try {
        syncSessionsBack(dir, sourceHome);
      } catch (error) {
        console.warn('[grok-strict] could not write session transcripts back:', error instanceof Error ? error.message : error);
      }
    },
    cleanup() {
      if (removed) return;
      home.syncBack();
      removed = true;
      activeHomes.delete(home);
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
  activeHomes.add(home);
  installExitHook();
  return home;
}

// ---------------------------------------------------------------------------
// ACP session/new mcpServers

/**
 * The only MCP server a strict run may be given: `cloudcli-tool-gateway`, with the run's identity
 * stamped on its stdio env. The binding secret goes to the gateway child only.
 * Throws when the gateway is not resolvable: running without it would leave the bot ungated.
 */
export function buildStrictAcpMcpServers(
  resolved: ResolvedMcpConnection[],
  options: { spawnEnv: Record<string, string>; bindingSecret?: string },
): Array<Record<string, unknown>> {
  const gateway = resolved.filter((server) => server.name === GROK_GATEWAY_SERVER_NAME && server.transport === 'stdio');
  if (gateway.length === 0) {
    throw new Error(
      `Bot tool gateway "${GROK_GATEWAY_SERVER_NAME}" is not registered for grok; refusing to run this bot without it.`,
    );
  }
  const servers = toGrokAcpMcpServers(gateway, options.spawnEnv);
  const secret = options.bindingSecret?.trim();
  return servers.map((server) => {
    const env = (Array.isArray(server.env) ? server.env : []) as Array<{ name: string; value: string }>;
    const withoutSecret = env.filter((entry) => entry.name !== GROK_GATEWAY_BINDING_SECRET_ENV);
    return {
      ...server,
      env: secret ? [...withoutSecret, { name: GROK_GATEWAY_BINDING_SECRET_ENV, value: secret }] : withoutSecret,
    };
  });
}

// ---------------------------------------------------------------------------
// Permission requests -> built-in tool gate

const IDENTIFIER = /^[A-Za-z0-9_.-]+$/;

/** Grok built-in tool name (as seen in session events) -> the gate's tool name. */
const GROK_TOOL_TO_GATE: Record<string, string> = {
  run_terminal_command: 'Bash',
  bash: 'Bash',
  read_file: 'Read',
  grep: 'Grep',
  grep_search: 'Grep',
  glob: 'Glob',
  list_dir: 'Glob',
  search_replace: 'Edit',
  edit: 'Edit',
  write: 'Write',
  write_file: 'Write',
  web_fetch: 'WebFetch',
  web_search: 'WebSearch',
  // Bookkeeping that touches nothing outside the run (todo list, the run's own background tasks).
  todo_write: 'TodoWrite',
  get_command_or_subagent_output: 'TodoWrite',
  kill_command_or_subagent: 'TodoWrite',
};

/** ACP `kind` -> Grok tool, used only when the request carries no structured tool name. */
const ACP_KIND_TO_GROK_TOOL: Record<string, string> = {
  execute: 'run_terminal_command',
  read: 'read_file',
  search: 'grep',
  edit: 'search_replace',
  delete: 'search_replace',
  move: 'search_replace',
  fetch: 'web_fetch',
};

function asRecord(value: unknown): AnyRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as AnyRecord) : null;
}

function asText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function parseRawInput(rawInput: unknown): AnyRecord {
  const direct = asRecord(rawInput);
  if (direct) return direct;
  if (typeof rawInput === 'string') {
    try {
      return asRecord(JSON.parse(rawInput)) ?? {};
    } catch {
      return {};
    }
  }
  return {};
}

/**
 * The Grok tool a permission request is for. The structured `_meta['x.ai/tool'].name` wins; the
 * human title is only trusted when it is a bare identifier, because a shell tool's title is the
 * command line itself and must never be taken for a tool name.
 */
export function resolveGrokToolName(toolCall: AnyRecord): string {
  const meta = asRecord(asRecord(toolCall._meta)?.['x.ai/tool']);
  const structured = asText(meta?.name);
  if (structured) {
    // An MCP tool the agent reports as (server, name) has the identity `server__name`.
    const server = asText(meta?.server_name) ?? asText(meta?.serverName);
    return server && !structured.startsWith(`${server}__`) ? `${server}__${structured}` : structured;
  }
  const title = asText(toolCall.title) ?? asText(toolCall.name);
  if (title && IDENTIFIER.test(title)) return title;
  const kind = asText(toolCall.kind);
  if (kind && ACP_KIND_TO_GROK_TOOL[kind]) return ACP_KIND_TO_GROK_TOOL[kind];
  return title ?? 'unknown_tool';
}

function firstText(source: AnyRecord, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = asText(source[key]);
    if (value) return value;
  }
  return undefined;
}

function gatewayGateName(rest: string): string {
  return `${GATE_GATEWAY_PREFIX}${rest}`;
}

/** `server__tool` (Grok's MCP identity) -> the gate's `mcp__server__tool`. */
function mcpGateName(identity: string): string {
  if (identity.startsWith(GATEWAY_TOOL_PREFIX)) return gatewayGateName(identity.slice(GATEWAY_TOOL_PREFIX.length));
  return `mcp__${identity || 'unknown'}`;
}

export interface GrokGateCall {
  /** Name the built-in tool gate understands (Bash, Read, Edit, Write, WebFetch, mcp__...). */
  toolName: string;
  input: AnyRecord;
  /** The Grok tool name the request carried, for logs and denial messages. */
  grokTool: string;
}

/** Maps a Grok `toolCall` onto the (toolName, input) pair `options.builtinToolGate` takes. */
export function mapGrokToolCallToGate(toolCall: AnyRecord, workspaceRoot?: string): GrokGateCall {
  const grokTool = resolveGrokToolName(toolCall);
  const raw = parseRawInput(toolCall.rawInput);

  // MCP: Grok reaches MCP tools through `use_tool { tool_name: "server__tool", tool_input }`, or
  // directly as `server__tool`. Only the gateway is allowed; the gate denies the rest.
  if (grokTool === 'use_tool') {
    const inner = firstText(raw, ['tool_name', 'toolName', 'name']) ?? '';
    return { toolName: mcpGateName(inner), input: parseRawInput(raw.tool_input ?? raw.arguments ?? raw.input), grokTool };
  }
  if (/^[A-Za-z0-9_-]+__.+/.test(grokTool) && IDENTIFIER.test(grokTool)) {
    return { toolName: mcpGateName(grokTool), input: raw, grokTool };
  }

  const gateName = GROK_TOOL_TO_GATE[grokTool];
  if (!gateName) return { toolName: grokTool, input: raw, grokTool };

  const filePath = firstText(raw, ['file_path', 'filePath', 'target_file', 'path', 'abs_path', 'file']);
  const directory = firstText(raw, ['target_directory', 'directory', 'dir', 'path']);
  switch (gateName) {
    case 'Bash':
      return {
        toolName: gateName,
        // No command extracted means the gate cannot classify it and escalates; never guess from the title.
        input: { ...raw, command: firstText(raw, ['command', 'cmd', 'script']), ...(workspaceRoot ? { cwd: raw.cwd ?? workspaceRoot } : {}) },
        grokTool,
      };
    case 'Read':
    case 'Edit':
    case 'Write':
      return { toolName: gateName, input: { ...raw, ...(filePath ? { file_path: filePath } : {}) }, grokTool };
    case 'Glob':
    case 'Grep': {
      const where = directory ?? filePath;
      return { toolName: gateName, input: { ...raw, ...(where ? { path: where, directory: where } : {}) }, grokTool };
    }
    case 'WebFetch':
      return { toolName: gateName, input: { ...raw, url: firstText(raw, ['url', 'uri']) ?? '' }, grokTool };
    default:
      return { toolName: gateName, input: raw, grokTool };
  }
}

export type GrokBuiltinToolGate = (toolName: string, input: unknown) => Promise<{ behavior: 'allow' } | { behavior: 'deny'; message: string }>;

export interface GrokGateDecision {
  allow: boolean;
  /** Why it was denied (also when the gate itself failed). */
  message?: string;
  call: GrokGateCall;
}

/** Asks the built-in tool gate about a permission request. Anything but an explicit allow is a deny. */
export async function decideGrokToolPermission(
  gate: GrokBuiltinToolGate,
  toolCall: AnyRecord,
  workspaceRoot?: string,
): Promise<GrokGateDecision> {
  const call = mapGrokToolCallToGate(toolCall, workspaceRoot);
  try {
    const verdict = await gate(call.toolName, call.input);
    if (verdict && verdict.behavior === 'allow') return { allow: true, call };
    const message = verdict && verdict.behavior === 'deny' && verdict.message ? verdict.message : 'Denied by the bot tool gate.';
    return { allow: false, message, call };
  } catch (error) {
    return { allow: false, message: `The bot tool gate failed: ${error instanceof Error ? error.message : String(error)}`, call };
  }
}

export type GrokPermissionOption = { optionId?: string; kind?: string };

/**
 * The `session/request_permission` outcome for a decision. Allow only ever picks `allow_once`
 * (never `allow_always`, which persists a grant, nor an "enable always-approve" row); a missing
 * allow option is a deny. A deny with no reject option cancels the request.
 */
export function buildGrokPermissionOutcome(
  options: GrokPermissionOption[] | undefined,
  allow: boolean,
): { outcome: { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' } } {
  const list = Array.isArray(options) ? options : [];
  if (allow) {
    const once = list.find((option) => option.kind === 'allow_once' && typeof option.optionId === 'string' && option.optionId);
    if (once?.optionId) return { outcome: { outcome: 'selected', optionId: once.optionId } };
  }
  const reject = list.find((option) => option.kind === 'reject_once' && option.optionId)
    ?? list.find((option) => typeof option.kind === 'string' && option.kind.startsWith('reject') && option.optionId);
  if (reject?.optionId) return { outcome: { outcome: 'selected', optionId: reject.optionId } };
  return { outcome: { outcome: 'cancelled' } };
}

// ---------------------------------------------------------------------------
// Project-scoped config that grok would read from the working directory

const PROJECT_MCP_FILES = ['.grok/config.toml', '.mcp.json', '.cursor/mcp.json'] as const;

/**
 * Project files (cwd up to the git root) that can declare MCP servers. Grok only starts those for
 * a trusted folder and the strict home has no trusted folders, but the operator should hear about
 * them. Returns the paths found.
 */
export function findProjectMcpConfigs(cwd: string): string[] {
  const found: string[] = [];
  let dir = path.resolve(cwd);
  for (let depth = 0; depth < 32; depth += 1) {
    for (const rel of PROJECT_MCP_FILES) {
      const candidate = path.join(dir, rel);
      try {
        if (fs.statSync(candidate).isFile()) found.push(candidate);
      } catch {
        // Not there.
      }
    }
    if (fs.existsSync(path.join(dir, '.git'))) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return found;
}
