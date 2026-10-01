/**
 * Gateway-bound ("bot runtime v2") runs on Antigravity.
 *
 * Everything here is driven by what the Antigravity ACP server (1.1.1) actually does, read from the
 * Python source bundled inside `agy_acp_server.par` (no live session was started: that needs a Google
 * sign-in, which this code must never trigger in tests). The facts the design rests on:
 *
 *  - MCP servers are the union of the client's `session/new` `mcpServers` and
 *    `<GEMINI_HOME>/config/mcp_config.json` (`load_global_mcp_configs` + `merge_mcp_servers`). Hooks come
 *    from `<GEMINI_HOME>/config/hooks.json` and, for a *trusted* workspace, `<cwd>/.agents/hooks.json`;
 *    trust lives in `<GEMINI_HOME>/antigravity-acp/trusted_workspaces.json`.
 *  - Permissions: `policy.safe_defaults` allows the read-only builtins (list/search/find/view, finish)
 *    and `ask_user("*")` for everything else, including every MCP tool. The ask goes out as the ACP
 *    `session/request_permission` request. It is skipped only by session mode `yolo` (all), `auto_edit`
 *    (edit tools) and the per-session "Allow Always" cache.
 *  - A second, unrelated kind of `request_permission` is the interaction prompt (`ask_question`, the
 *    workspace-trust question). Its options have arbitrary ids and the tool call carries no `kind`.
 *  - `view_file` (and the client file tools) refuse paths outside cwd + `GEMINI_HOME` + the skills dirs.
 *    `client_view_file` / `client_create_file` / `client_edit_file` go through the ACP `fs/*` methods.
 *
 * So a gateway-bound run is made enforced by: (1) giving the child a relocated `GEMINI_HOME` whose
 * `config/` is empty and whose credentials/conversations are symlinks that the agent's own read tools
 * refuse to follow, (2) attaching only the gateway through `session/new`, (3) forcing session mode
 * `default`, and (4) answering every tool permission request with the built-in tool gate and never
 * with "Allow Always".
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { antigravityProfileDirectory } from './antigravity-auth-support.js';

type AnyRecord = Record<string, unknown>;

export const ANTIGRAVITY_GATEWAY_MCP_NAME = 'cloudcli-tool-gateway';
const GATEWAY_TOOL_PREFIX = `mcp__${ANTIGRAVITY_GATEWAY_MCP_NAME}__`;

export type AntigravityGateDecision = { behavior: 'allow' } | { behavior: 'deny'; message: string };
/** Structural twin of `BuiltinToolGate` (bots/gate/builtin-tool-gate.ts); typed locally to keep modules decoupled. */
export type AntigravityGateFn = (toolName: string, input: unknown) => Promise<AntigravityGateDecision>;

export type AcpPermissionResponse = { outcome: { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' } };

const asRecord = (value: unknown): AnyRecord | null => (
  value && typeof value === 'object' && !Array.isArray(value) ? value as AnyRecord : null
);
const asText = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

/** True when the run was started with `botGatewayStrict` (gateway-bound bot run). */
export function isAntigravityGatewayStrict(options: AnyRecord | null | undefined): boolean {
  return options?.botGatewayStrict === true;
}

/** Permission policy of a gateway-bound run: ask mode, never auto-approve, regardless of the requested mode. */
export function antigravityGatewayPolicy(): { mode: 'default'; autoApprove: false; env: Record<string, never> } {
  return { mode: 'default', autoApprove: false, env: {} };
}

// ---------------------------------------------------------------------------
// MCP: only the gateway, stamped with the run's identity.

export type ResolvedMcpLike = {
  name: string;
  transport?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  [key: string]: unknown;
};

/**
 * Reduces the resolved catalog servers to the gateway alone and stamps the stdio entry with the
 * session id (both spellings the gateway child reads) and the per-binding secret. The secret goes on
 * this entry only. Throws (fail closed) when the gateway is not bound to antigravity or the run lacks
 * the identity the gateway needs.
 */
export function selectGatewayOnlyServers(
  resolved: ResolvedMcpLike[],
  identity: { appSessionId?: string | null; bindingSecret?: string | null },
): ResolvedMcpLike[] {
  const entry = (Array.isArray(resolved) ? resolved : []).find((server) => server?.name === ANTIGRAVITY_GATEWAY_MCP_NAME);
  if (!entry) {
    throw new Error(`A required work-session MCP server is unavailable: ${ANTIGRAVITY_GATEWAY_MCP_NAME} is not bound to antigravity.`);
  }
  const transport = entry.transport || (entry.command ? 'stdio' : '');
  if (transport !== 'stdio' || !asText(entry.command)) {
    throw new Error(`${ANTIGRAVITY_GATEWAY_MCP_NAME} must be a stdio MCP server for gateway-bound runs.`);
  }
  const appSessionId = asText(identity.appSessionId);
  if (!appSessionId) throw new Error('A gateway-bound Antigravity run needs an appSessionId.');
  const bindingSecret = asText(identity.bindingSecret);
  if (!bindingSecret) throw new Error('A gateway-bound Antigravity run needs the gateway binding secret (botGatewaySecret).');
  return [{
    ...entry,
    env: {
      ...(entry.env ?? {}),
      CLOUDCLI_SESSION_ID: appSessionId,
      CLOUDCLI_LEAD_SESSION_ID: appSessionId,
      CLOUDCLI_BOT_GATEWAY_BINDING_SECRET: bindingSecret,
    },
  }];
}

// ---------------------------------------------------------------------------
// Relocated GEMINI_HOME for a gateway-bound run.

const SHARED_PROFILE_SKIP = new Set(['settings.json', 'trusted_workspaces.json']);
const RUN_HOME_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function sameLink(linkPath: string, target: string): boolean {
  try {
    return fs.lstatSync(linkPath).isSymbolicLink() && fs.readlinkSync(linkPath) === target;
  } catch {
    return false;
  }
}

function pruneStaleRunHomes(runsDir: string): void {
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(runsDir);
  } catch {
    return;
  }
  const realRuns = fs.realpathSync(runsDir);
  for (const name of entries) {
    const candidate = path.join(runsDir, name);
    try {
      if (Date.now() - fs.statSync(candidate).mtimeMs < RUN_HOME_MAX_AGE_MS) continue;
      // fs.rmSync never follows symlinks, and the realpath check keeps it inside the runs directory.
      if (path.dirname(fs.realpathSync(candidate)) !== realRuns) continue;
      fs.rmSync(candidate, { recursive: true, force: true });
    } catch {
      // Best effort; a stale directory of symlinks is harmless.
    }
  }
}

/**
 * A per-run `GEMINI_HOME` for a gateway-bound run, `<profile>/runs/<hash>`:
 *  - `config/` is a real, empty directory, so no global MCP servers, hooks or skills are loaded;
 *  - `antigravity-acp/` has its own `settings.json` and NO `trusted_workspaces.json`, so workspace
 *    hooks are never trusted (the trust prompt is cancelled by the guard) and nothing is persisted;
 *  - every other entry of the shared profile (token, conversations, brain) is a symlink. The ACP
 *    server follows them, but its own file tools resolve symlinks before the allowed-directory check,
 *    so `view_file` cannot read the OAuth token or other sessions' transcripts.
 * `AGY_ACP_DISABLE_WORKSPACE_TRUST` is forced off so the host environment cannot trust workspaces.
 */
export function prepareAntigravityStrictHome(
  runKey: string,
  env: NodeJS.ProcessEnv = process.env,
): { home: string; env: Record<string, string> } {
  const key = asText(runKey);
  if (!key) throw new Error('A gateway-bound Antigravity run needs a run key for its private home.');
  const profile = antigravityProfileDirectory(env);
  const profileAcp = path.join(profile, 'antigravity-acp');
  fs.mkdirSync(profileAcp, { recursive: true, mode: 0o700 });
  for (const required of ['conversations', 'brain']) {
    fs.mkdirSync(path.join(profileAcp, required), { recursive: true, mode: 0o700 });
  }

  const runsDir = path.join(profile, 'runs');
  fs.mkdirSync(runsDir, { recursive: true, mode: 0o700 });
  const home = path.join(runsDir, createHash('sha256').update(key).digest('hex').slice(0, 24));
  const runAcp = path.join(home, 'antigravity-acp');
  fs.mkdirSync(path.join(home, 'config'), { recursive: true, mode: 0o700 });
  fs.mkdirSync(runAcp, { recursive: true, mode: 0o700 });
  // Touch our own home first so pruning (which keys on mtime) can never take a live run's directory.
  const now = new Date();
  fs.utimesSync(home, now, now);
  pruneStaleRunHomes(runsDir);
  fs.writeFileSync(path.join(runAcp, 'settings.json'), `${JSON.stringify({ auth: { type: 'oauth-personal' } })}\n`, 'utf8');
  // A leftover trust file or global config (re-run of the same key) must not survive.
  for (const stale of [path.join(runAcp, 'trusted_workspaces.json'), path.join(home, 'config', 'mcp_config.json'), path.join(home, 'config', 'hooks.json')]) {
    fs.rmSync(stale, { force: true });
  }

  for (const entry of fs.readdirSync(profileAcp)) {
    if (SHARED_PROFILE_SKIP.has(entry)) continue;
    const target = path.join(profileAcp, entry);
    const link = path.join(runAcp, entry);
    if (sameLink(link, target)) continue;
    fs.rmSync(link, { recursive: true, force: true });
    fs.symlinkSync(target, link);
  }
  return { home, env: { GEMINI_HOME: home, AGY_ACP_DISABLE_WORKSPACE_TRUST: '0' } };
}

// ---------------------------------------------------------------------------
// Permission request -> built-in tool gate.

export type GateCall =
  | { kind: 'gate'; toolName: string; input: AnyRecord; writePath?: string }
  | { kind: 'deny'; reason: string }
  | { kind: 'cancel'; reason: string };

const PATH_KEYS = ['TargetFile', 'target_file', 'FilePath', 'file_path', 'AbsolutePath', 'absolute_path', 'path'] as const;
const CREATE_TOOLS = new Set(['create_file', 'client_create_file', 'write_to_file', 'write_file']);

function parseRawInput(value: unknown): AnyRecord {
  const direct = asRecord(value);
  if (direct) return direct;
  if (typeof value === 'string') {
    try {
      return asRecord(JSON.parse(value)) ?? {};
    } catch {
      return {};
    }
  }
  return {};
}

function firstString(record: AnyRecord, keys: readonly string[]): string {
  for (const key of keys) {
    const value = asText(record[key]);
    if (value) return value;
  }
  return '';
}

function targetPath(toolCall: AnyRecord, input: AnyRecord): string {
  const locations = Array.isArray(toolCall.locations) ? toolCall.locations : [];
  for (const location of locations) {
    const candidate = asText(asRecord(location)?.path);
    if (candidate) return candidate;
  }
  return firstString(input, PATH_KEYS);
}

/** The server name Antigravity reports can differ in `-`/`_` spelling; the gateway is matched on either. */
function canonicalServerName(server: string): string {
  return /^cloudcli[-_]tool[-_]gateway$/i.test(server) ? ANTIGRAVITY_GATEWAY_MCP_NAME : server;
}

/**
 * True when the request is a tool-approval prompt built by the ACP server's `_permission_handler`:
 * it always offers `allow` (allow_once) and a reject option, and the tool call has a `kind`. The
 * interaction prompts (`ask_question`, workspace trust) have neither.
 */
export function isToolApprovalRequest(params: AnyRecord | null | undefined): boolean {
  const options = Array.isArray(params?.options) ? params!.options as unknown[] : [];
  const toolCall = asRecord(params?.toolCall);
  const hasAllow = options.some((option) => asRecord(option)?.kind === 'allow_once' && asRecord(option)?.optionId === 'allow');
  const hasReject = options.some((option) => asRecord(option)?.kind === 'reject_once');
  return hasAllow && hasReject && typeof toolCall?.kind === 'string' && toolCall.kind.length > 0;
}

/**
 * Maps one Antigravity permission request onto the Claude-shaped call the built-in tool gate
 * understands: Bash {command} / Write|Edit {file_path} / WebFetch {url} / WebSearch {query} /
 * Read {file_path}, and `mcp__<server>__<tool>` for MCP calls (the gate passes only the gateway's).
 * A call whose target cannot be determined is denied rather than guessed at.
 */
export function mapAntigravityPermissionToGateCall(params: AnyRecord | null | undefined, toolNameHint?: string): GateCall {
  if (!isToolApprovalRequest(params)) {
    return { kind: 'cancel', reason: 'interaction prompts (ask_question, workspace trust) are never answered in gateway-bound runs' };
  }
  const toolCall = asRecord(params?.toolCall) ?? {};
  const kind = String(toolCall.kind);
  const title = asText(toolCall.title) || asText(toolNameHint);
  const rawInput = parseRawInput(toolCall.rawInput);
  const named = /^Run (.+)\?$/.exec(title)?.[1]?.trim() || '';

  const mcp = asRecord(asRecord(toolCall._meta)?.mcp);
  if (mcp) {
    const tool = asText(mcp.tool);
    if (!tool) return { kind: 'deny', reason: 'MCP call without a tool name' };
    const server = canonicalServerName(asText(mcp.server) || 'unknown');
    return { kind: 'gate', toolName: `mcp__${server}__${tool}`, input: asRecord(rawInput.arguments) ?? {} };
  }

  if (kind === 'execute') {
    const command = firstString(rawInput, ['CommandLine', 'command_line', 'command', 'cmd']) || title;
    if (!command) return { kind: 'deny', reason: 'shell call without a command line' };
    return { kind: 'gate', toolName: 'Bash', input: { command } };
  }

  if (kind === 'edit') {
    const filePath = targetPath(toolCall, rawInput);
    if (!filePath) return { kind: 'deny', reason: `${named || 'file edit'} without a target path` };
    const toolName = CREATE_TOOLS.has(named) ? 'Write' : 'Edit';
    return { kind: 'gate', toolName, input: { file_path: filePath }, writePath: filePath };
  }

  if (kind === 'fetch') {
    const url = firstString(rawInput, ['Url', 'url', 'URL', 'uri']);
    if (!url) return { kind: 'deny', reason: 'web fetch without a URL' };
    return { kind: 'gate', toolName: 'WebFetch', input: { url } };
  }

  if (named === 'search_web') {
    return { kind: 'gate', toolName: 'WebSearch', input: { query: firstString(rawInput, ['Query', 'query', 'q']) } };
  }

  if (kind === 'read') {
    const filePath = targetPath(toolCall, rawInput);
    if (!filePath) return { kind: 'deny', reason: `${named || 'file read'} without a target path` };
    return { kind: 'gate', toolName: 'Read', input: { file_path: filePath } };
  }

  if (kind === 'search') {
    const searchPath = targetPath(toolCall, rawInput);
    return { kind: 'gate', toolName: 'Grep', input: searchPath ? { path: searchPath } : {} };
  }

  // Everything else (generate_image, start_subagent, ...): hand the gate the tool's own name.
  return { kind: 'gate', toolName: named || title || kind, input: rawInput };
}

function selectedOption(offered: unknown, kind: 'allow_once' | 'reject_once'): AcpPermissionResponse {
  const options = Array.isArray(offered) ? offered : [];
  const found = options.map(asRecord).find((option) => option?.kind === kind && typeof option.optionId === 'string');
  return found ? { outcome: { outcome: 'selected', optionId: String(found.optionId) } } : { outcome: { outcome: 'cancelled' } };
}

export interface AntigravityGatewayGuard {
  /** Answer one `session/request_permission` request. Never selects an "always" option. */
  respondToPermission(params: AnyRecord | null | undefined, toolNameHint?: string): Promise<AcpPermissionResponse>;
  /** Decide an ACP `fs/*` request (the client file tools). Writes the permission step already approved pass through once. */
  guardFs(method: string, absolutePath: string): Promise<{ allow: true } | { allow: false; reason: string }>;
}

export function createAntigravityGatewayGuard(options: {
  /** `options.builtinToolGate` of the run; without it every built-in action is denied. */
  gate: AntigravityGateFn | null;
  workingDir: string;
  log?: (message: string) => void;
}): AntigravityGatewayGuard {
  const log = options.log ?? (() => undefined);
  const approvedWrites = new Map<string, number>();
  const resolvePath = (target: string) => path.resolve(options.workingDir || process.cwd(), target);

  const decide = async (toolName: string, input: AnyRecord): Promise<AntigravityGateDecision> => {
    // The gateway's own tools are governed by the gateway (Action Gate), whether or not a built-in gate exists.
    if (toolName.startsWith(GATEWAY_TOOL_PREFIX)) return { behavior: 'allow' };
    if (!options.gate) return { behavior: 'deny', message: 'No built-in tool gate is installed for this run.' };
    try {
      return await options.gate(toolName, input);
    } catch (error) {
      return { behavior: 'deny', message: `Built-in tool gate failed: ${(error as Error)?.message || String(error)}` };
    }
  };

  return {
    async respondToPermission(params, toolNameHint) {
      const mapped = mapAntigravityPermissionToGateCall(params, toolNameHint);
      if (mapped.kind === 'cancel') {
        log(`[antigravity-gateway] cancelled: ${mapped.reason}`);
        return { outcome: { outcome: 'cancelled' } };
      }
      if (mapped.kind === 'deny') {
        log(`[antigravity-gateway] denied: ${mapped.reason}`);
        return selectedOption(params?.options, 'reject_once');
      }
      const verdict = await decide(mapped.toolName, mapped.input);
      if (verdict.behavior === 'deny') {
        log(`[antigravity-gateway] denied ${mapped.toolName}: ${verdict.message}`);
        return selectedOption(params?.options, 'reject_once');
      }
      if (mapped.writePath) {
        const key = resolvePath(mapped.writePath);
        approvedWrites.set(key, (approvedWrites.get(key) ?? 0) + 1);
      }
      return selectedOption(params?.options, 'allow_once');
    },

    async guardFs(method, absolutePath) {
      const target = resolvePath(absolutePath);
      if (method === 'fs/write_text_file') {
        const pending = approvedWrites.get(target) ?? 0;
        if (pending > 0) {
          approvedWrites.set(target, pending - 1);
          return { allow: true };
        }
        const verdict = await decide('Write', { file_path: target });
        return verdict.behavior === 'allow' ? { allow: true } : { allow: false, reason: verdict.message };
      }
      const verdict = await decide('Read', { file_path: target });
      return verdict.behavior === 'allow' ? { allow: true } : { allow: false, reason: verdict.message };
    },
  };
}

/** Evidence-based description for the adapter; kept next to the mechanism it describes. */
export const ANTIGRAVITY_GATEWAY_COVERAGE = {
  covered: [
    'MCP: only cloudcli-tool-gateway is attached through session/new; the child runs with a private GEMINI_HOME whose config/ is empty, so no global MCP servers, hooks or skills load',
    'built-in tools that ask (shell, file create/edit, web fetch/search, image generation, subagents, every MCP call): each session/request_permission is decided by the built-in tool gate, never auto-approved, never "Allow Always"',
    'session mode is forced to default; live switches to bypass are refused',
    'ACP fs/read_text_file and fs/write_text_file (the client file tools) are checked by the gate',
    'interaction prompts, including workspace trust, are cancelled',
  ],
  notCovered: [
    'read-only built-ins (list/search/find/view_file) never ask: Antigravity itself confines them to the workspace and the run home, they are not decided by the gate',
    'an "Allow Always" cached in a resumed session by an earlier non-bot chat is honoured by Antigravity before it asks',
    'behaviour was derived from the bundled ACP server source (1.1.1), not exercised against a live session',
  ],
} as const;
