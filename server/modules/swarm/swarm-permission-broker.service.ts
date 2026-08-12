/**
 * Swarm permission broker — answers provider `permission_request` events for
 * detached swarm runs so no seat ever hangs on an interactive approval.
 *
 * Policy tiers:
 * - Read-only seats (explorer / reviewer / orchestrator): read-only operations
 *   are auto-approved, anything that mutates state is auto-denied. Never
 *   escalates — read-only seats fail fast.
 * - Worker seats (implementer / custom): operations scoped inside the swarm
 *   workspace are auto-approved; risky requests (outside-workspace paths,
 *   package installs, non-localhost network, destructive commands, secret
 *   access, privilege escalation) are escalated to a single bounded
 *   orchestrator adjudication run. Unclassifiable requests escalate.
 * - Adjudication runs register themselves with escalation disabled, so a
 *   prompt raised by the adjudicator itself can never recurse.
 *
 * Interactive tools are handled separately, because they are questions rather
 * than permission checks and there is no human to answer them:
 * - Detached orchestrators resolve their own interactive tools locally: user
 *   questions are skipped and plan-mode exit is approved. The orchestrator
 *   remains a read-only seat, so later mutation requests are still denied.
 * - `AskUserQuestion`: the orchestrator answers on the human's behalf, choosing
 *   from the offered options (validated against them). An unanswerable question
 *   resolves as a skip, never a denial.
 * - `ExitPlanMode`: the orchestrator reviews the proposed plan and approves or
 *   rejects with an actionable reason. Read-only seats are refused by policy.
 *
 * Every decision (auto, adjudicated, or answered) is appended to the swarm
 * blackboard — that is the operator-visible audit trail.
 */

import { realpathSync } from 'node:fs';
import path from 'node:path';

import { parseJsonFromAgentText } from '@/modules/mission-control/index.js';
import { providerCapabilitiesService } from '@/modules/providers/index.js';
import { runService } from '@/modules/runs/index.js';
import { redactSwarmText, swarmDb } from '@/modules/swarm/swarm.repository.js';
import type { SwarmAgentSpec } from '@/modules/swarm/swarm.types.js';
import type { AnyRecord, LLMProvider } from '@/shared/types.js';

const DEFAULT_ADJUDICATION_TIMEOUT_MS = 2 * 60 * 1000;

/** Bounded single-shot orchestrator adjudication budget (well below the step timeout). */
export function adjudicationTimeoutMs(): number {
  const raw = Number(process.env.CLOUDCLI_SWARM_ADJUDICATION_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_ADJUDICATION_TIMEOUT_MS;
}

export type SwarmPermissionContext = {
  swarmId: string;
  memberId?: string | null;
  /** Roster seat kind: orchestrator | explorer | implementer | reviewer | custom. */
  seatKind: string;
  seatLabel?: string | null;
  /** The swarm worktree root — the only writable area for the run. */
  workspaceRoot: string;
  permissionMode?: string | null;
  provider: LLMProvider;
  /**
   * Whether risky requests may escalate to an orchestrator adjudication run.
   * Defaults to true for worker seats and is always false for read-only seats
   * and adjudication runs (recursion guard).
   */
  allowEscalation?: boolean;
};

export type PermissionDecision = {
  allow: boolean;
  updatedInput?: unknown;
  message?: string;
};

export type PermissionDecisionResolver = (requestId: string, decision: PermissionDecision) => void;

export type SwarmPermissionOutcome = {
  requestId: string;
  allow: boolean;
  reason: string;
  via: 'policy' | 'orchestrator';
  latencyMs: number;
};

export type PermissionRequestDetails = {
  toolName: string | null;
  command: string | null;
  paths: string[];
  cwd: string | null;
  rawInput: unknown;
};

export type PermissionTier = 'approve' | 'deny' | 'escalate';

export type PermissionClassification = { tier: PermissionTier; reason: string };

type AdjudicateFn = (
  ctx: SwarmPermissionContext,
  details: PermissionRequestDetails,
) => Promise<{ approve: boolean; reason: string }>;

const READ_ONLY_SEAT_KINDS = new Set(['explorer', 'reviewer', 'orchestrator']);

export function isReadOnlySeatKind(kind: string): boolean {
  return READ_ONLY_SEAT_KINDS.has(kind);
}

// ————————————————————————————————————————————————————————————————————————
// Request detail extraction (tolerant of today's sparse payloads and the
// enriched contract the hardened runtimes emit under `unattended`).
// ————————————————————————————————————————————————————————————————————————

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function pushPath(target: string[], value: unknown): void {
  const text = asString(value);
  if (text) target.push(text);
}

const EXEC_TOOL_KEYWORDS = ['bash', 'shell', 'exec', 'command', 'terminal', 'run'];
const READ_TOOL_KEYWORDS = ['read', 'grep', 'glob', 'search', 'list', 'ls', 'view', 'cat', 'fetchfile'];
const WRITE_TOOL_KEYWORDS = ['write', 'edit', 'create', 'patch', 'replace', 'delete', 'remove', 'move', 'rename', 'mkdir', 'notebookedit'];
const NETWORK_TOOL_KEYWORDS = ['webfetch', 'websearch', 'fetch', 'http', 'download', 'browser'];

function toolNameLooksLike(toolName: string | null, keywords: string[]): boolean {
  if (!toolName) return false;
  const lowered = toolName.toLowerCase();
  return keywords.some((keyword) => lowered.includes(keyword));
}

export function extractPermissionRequestDetails(message: AnyRecord): PermissionRequestDetails {
  const rawInput = message.input ?? message.toolInput ?? null;
  const inputObj =
    rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput)
      ? (rawInput as AnyRecord)
      : null;
  const toolName = asString(message.toolName) ?? asString(message.tool) ?? null;

  let command =
    asString(message.command) ??
    (inputObj
      ? asString(inputObj.command) ?? asString(inputObj.cmd) ?? asString(inputObj.script)
      : null);
  if (!command && inputObj && Array.isArray(inputObj.command)) {
    command = (inputObj.command as unknown[])
      .filter((part): part is string => typeof part === 'string')
      .join(' ');
  }
  if (!command && typeof rawInput === 'string' && toolNameLooksLike(toolName, EXEC_TOOL_KEYWORDS)) {
    command = rawInput;
  }

  const paths: string[] = [];
  if (Array.isArray(message.paths)) {
    for (const entry of message.paths as unknown[]) pushPath(paths, entry);
  }
  if (inputObj) {
    for (const key of ['file_path', 'filePath', 'path', 'abs_path', 'absPath', 'notebook_path', 'target_file', 'file']) {
      pushPath(paths, inputObj[key]);
    }
    for (const key of ['paths', 'files', 'file_paths']) {
      const entry = inputObj[key];
      if (Array.isArray(entry)) for (const value of entry as unknown[]) pushPath(paths, value);
    }
    if (Array.isArray(inputObj.edits)) {
      for (const edit of inputObj.edits as unknown[]) {
        if (edit && typeof edit === 'object') pushPath(paths, (edit as AnyRecord).file_path);
      }
    }
  }

  const cwd = asString(message.cwd) ?? (inputObj ? asString(inputObj.cwd) : null);
  return { toolName, command: command?.trim() || null, paths, cwd, rawInput };
}

// ————————————————————————————————————————————————————————————————————————
// Classification (pure; exported for tests).
// ————————————————————————————————————————————————————————————————————————

/**
 * Canonicalize a path even when it does not exist yet: resolve symlinks on the
 * nearest existing ancestor and re-attach the non-existing tail. This is what
 * defeats `worktree/link -> /etc` style tricks the same way the workspace
 * guards do (realpath + prefix check).
 */
function canonicalizePath(target: string): string {
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

function isInsideWorkspace(candidate: string, workspaceRoot: string, cwd: string | null): boolean {
  const base = cwd && path.isAbsolute(cwd) ? cwd : path.resolve(workspaceRoot);
  const resolved = canonicalizePath(path.resolve(base, candidate));
  const root = canonicalizePath(path.resolve(workspaceRoot));
  return resolved === root || resolved.startsWith(`${root}${path.sep}`);
}

const SENSITIVE_PATH_PATTERN =
  /(^|[\\/.])(\.env(\.[\w-]+)?|\.ssh|\.aws|\.gnupg|\.netrc|\.npmrc|\.pypirc|id_rsa|id_ed25519|credentials|\.kube)([\\/]|$)/i;

function isSensitivePath(candidate: string): boolean {
  return SENSITIVE_PATH_PATTERN.test(candidate);
}

/** Category is seat-independent; seat policy maps it to a tier. */
type ActionCategory = 'read' | 'workspace-write' | 'risky';

type CategoryResult = { category: ActionCategory; reason: string };

const READ_COMMANDS = new Set([
  'cat', 'head', 'tail', 'less', 'more', 'grep', 'rg', 'ugrep', 'egrep', 'fgrep', 'ls', 'pwd',
  'wc', 'which', 'whereis', 'file', 'stat', 'du', 'df', 'tree', 'echo', 'printf', 'sort',
  'uniq', 'cut', 'diff', 'cmp', 'basename', 'dirname', 'md5sum', 'shasum', 'sha256sum',
  'realpath', 'readlink', 'type', 'true', 'date', 'uname', 'nproc', 'jq', 'awk', 'column', 'xxd',
  // Platform/repository inspection commonly emitted by Grok explorers.
  'lpstat', 'system_profiler', 'otool', 'nm', 'strings', 'sw_vers',
]);

const SAFE_EXEC_COMMANDS = new Set([
  'node', 'tsx', 'ts-node', 'tsc', 'eslint', 'jest', 'vitest', 'mocha', 'pytest', 'make',
  'prettier', 'deno', 'xcodebuild',
]);

const WRITE_COMMANDS = new Set(['mkdir', 'touch', 'cp', 'mv', 'ln', 'tee', 'chmod', 'patch', 'unzip', 'tar']);

const NETWORK_COMMANDS = new Set([
  'curl', 'wget', 'nc', 'ncat', 'netcat', 'telnet', 'ssh', 'scp', 'sftp', 'rsync', 'ftp', 'ping', 'dig', 'nslookup', 'openssl',
]);

const PACKAGE_MANAGERS = new Set([
  'brew', 'apt', 'apt-get', 'yum', 'dnf', 'pacman', 'apk', 'gem', 'pipx',
]);

const ALWAYS_RISKY_COMMANDS = new Set([
  'sudo', 'doas', 'su', 'dd', 'mkfs', 'shred', 'truncate', 'kill', 'killall', 'pkill',
  'launchctl', 'systemctl', 'crontab', 'security', 'osascript', 'npx', 'pnpx', 'bunx', 'xargs',
  'eval', 'source', 'sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'env', 'printenv', 'export',
]);

/**
 * Shells that show up as command *wrappers*. Several provider CLIs (codex and
 * grok most notably) never emit a bare command — every Bash tool call arrives
 * as `/bin/zsh -lc "<real command>"`. Classifying the wrapper instead of its
 * payload marked EVERY such request risky, which denied read-only seats their
 * own typecheck/lint and pushed writable seats through a bounded orchestrator
 * adjudication per tool call (the source of the step timeouts). The payload is
 * what actually carries risk, so it is unwrapped and classified instead.
 */
const SHELL_WRAPPER_COMMANDS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish']);

/** `-c`, `-lc`, `-lic`, `-ec`, … — the "run this string" flag family. */
const SHELL_PAYLOAD_FLAG_PATTERN = /^-[a-z]*c$/i;

/** Wrapper unwraps are bounded: a shell inside a shell inside a shell stops here. */
const MAX_SHELL_UNWRAP_DEPTH = 3;

const LOCALHOST_PATTERN = /^(https?:\/\/)?(localhost|127\.0\.0\.1|\[?::1\]?|0\.0\.0\.0)([:/]|$)/i;

const GIT_READ_SUBCOMMANDS = new Set([
  'status', 'log', 'diff', 'show', 'blame', 'rev-parse', 'ls-files', 'ls-tree', 'describe',
  'shortlog', 'grep', 'branch', 'remote', 'reflog', 'cat-file', 'var', 'version', 'config',
]);

const GIT_WORKSPACE_SUBCOMMANDS = new Set([
  'add', 'commit', 'checkout', 'switch', 'restore', 'stash', 'mv', 'rm', 'tag', 'merge',
  'rebase', 'cherry-pick', 'apply', 'am', 'revert', 'reset', 'notes',
]);

const GIT_RISKY_SUBCOMMANDS = new Set([
  'push', 'pull', 'fetch', 'clone', 'submodule', 'clean', 'gc', 'prune', 'worktree', 'filter-branch',
]);

function splitCommandSegments(command: string): string[] {
  // Split only on shell operators outside quotes. The old regex shredded
  // `node -e "a(); b()"` and treated leading `# read-only probe` comments as
  // executable commands, producing false denials that terminate Grok turns.
  const segments: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let escaped = false;
  let inComment = false;

  const push = () => {
    const value = current.trim();
    if (value) segments.push(value);
    current = '';
  };

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    const next = command[index + 1];
    if (inComment) {
      if (char === '\n') {
        inComment = false;
        push();
      }
      continue;
    }
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (quote) {
      current += char;
      if (char === '\\' && quote === '"') escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (char === '#' && (current.trim().length === 0 || /\s/.test(command[index - 1] ?? ' '))) {
      inComment = true;
      continue;
    }
    if (char === '\n' || char === ';' || char === '|') {
      push();
      if (next === char) index += 1;
      continue;
    }
    if (char === '&' && next === '&') {
      push();
      index += 1;
      continue;
    }
    current += char;
  }
  push();
  return segments;
}

/**
 * Quote-aware tokenizer, used only to find a shell wrapper's payload. Unlike
 * `commandTokens` it keeps a quoted string as ONE token so the inner command of
 * `zsh -lc "a && b"` survives intact.
 */
function tokenizeQuoteAware(command: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let started = false;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (quote) {
      if (char === '\\' && quote === '"' && index + 1 < command.length) {
        current += command[index + 1];
        index += 1;
        continue;
      }
      if (char === quote) {
        quote = null;
        continue;
      }
      current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      started = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (started) tokens.push(current);
      current = '';
      started = false;
      continue;
    }
    current += char;
    started = true;
  }
  if (started) tokens.push(current);
  return tokens;
}

/**
 * If `command` is a shell wrapper (`zsh -lc "…"`) or a pure `env VAR=v <cmd>`
 * prefix, return the wrapped command. Returns null when there is nothing to
 * unwrap, so the caller falls back to classifying the command as written.
 */
function unwrapShellPayload(command: string): string | null {
  const tokens = tokenizeQuoteAware(command);
  let index = 0;
  // Skip inline environment assignments (`FOO=bar cmd`).
  while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index])) index += 1;
  if (index >= tokens.length) return null;

  const head = tokens[index].replace(/^.*\//, '').toLowerCase();

  // `env FOO=bar <cmd>` — only when a real command follows the assignments.
  // A bare `env` (or `env -0`) still exposes the environment and stays risky.
  if (head === 'env') {
    let cursor = index + 1;
    while (cursor < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[cursor])) cursor += 1;
    if (cursor === index + 1 || cursor >= tokens.length) return null;
    if (tokens[cursor].startsWith('-')) return null;
    return tokens.slice(cursor).join(' ');
  }

  if (!SHELL_WRAPPER_COMMANDS.has(head)) return null;
  const flagIndex = tokens.findIndex(
    (token, position) => position > index && SHELL_PAYLOAD_FLAG_PATTERN.test(token),
  );
  if (flagIndex === -1) {
    // `zsh script.sh` / interactive `zsh` — no inspectable payload.
    return null;
  }
  const payload = tokens[flagIndex + 1];
  return payload && payload.trim() ? payload : null;
}

function commandTokens(segment: string): string[] {
  const tokens = segment.split(/\s+/).filter(Boolean);
  let index = 0;
  while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index])) index += 1;
  while (index < tokens.length && ['command', 'time', 'nice', 'nohup'].includes(tokens[index])) index += 1;
  return tokens.slice(index);
}

function pathLikeArgs(tokens: string[]): string[] {
  return tokens
    .slice(1)
    .filter((token) => !token.startsWith('-'))
    .filter((token) => token.includes('/') || token.includes('\\') || /^[.~]/.test(token) || /\.[A-Za-z0-9]+$/.test(token));
}

function redirectTargets(segment: string): string[] {
  const targets: string[] = [];
  const pattern = />>?\s*([^\s;&|>]+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(segment)) !== null) {
    const target = match[1];
    if (target === '&1' || target === '&2' || target === '/dev/null' || target === '/dev/stderr' || target === '/dev/stdout') continue;
    targets.push(target);
  }
  return targets;
}

function worst(a: CategoryResult, b: CategoryResult): CategoryResult {
  const rank: Record<ActionCategory, number> = { read: 0, 'workspace-write': 1, risky: 2 };
  return rank[b.category] > rank[a.category] ? b : a;
}

function classifyPathSet(
  paths: string[],
  workspaceRoot: string,
  cwd: string | null,
  actionLabel: string,
): CategoryResult {
  for (const candidate of paths) {
    if (isSensitivePath(candidate)) {
      return { category: 'risky', reason: `${actionLabel} touches a sensitive path: ${candidate}` };
    }
  }
  const outside = paths.find((candidate) => !isInsideWorkspace(candidate, workspaceRoot, cwd));
  if (outside) {
    return { category: 'risky', reason: `${actionLabel} targets a path outside the swarm workspace: ${outside}` };
  }
  return { category: 'workspace-write', reason: `${actionLabel} scoped inside the swarm workspace` };
}

function classifyGitSegment(tokens: string[], workspaceRoot: string, cwd: string | null): CategoryResult {
  const args = tokens.slice(1).filter((token) => !token.startsWith('--git-dir') && !token.startsWith('-C'));
  const sub = args.find((token) => !token.startsWith('-')) ?? '';
  const rest = args.slice(args.indexOf(sub) + 1);

  if (GIT_RISKY_SUBCOMMANDS.has(sub)) {
    return { category: 'risky', reason: `git ${sub} reaches beyond the local worktree` };
  }
  if (sub === 'branch') {
    if (rest.some((token) => token === '-D' || token === '-d' || token === '--delete')) {
      return { category: 'risky', reason: 'git branch deletion is destructive' };
    }
    return { category: 'read', reason: 'git branch listing is read-only' };
  }
  if (sub === 'remote') {
    if (rest.some((token) => ['add', 'set-url', 'remove', 'rm', 'rename'].includes(token))) {
      return { category: 'risky', reason: 'git remote mutation can redirect pushes' };
    }
    return { category: 'read', reason: 'git remote inspection is read-only' };
  }
  if (sub === 'config') {
    if (rest.some((token) => token === '--get' || token === '--list' || token === '-l')) {
      return { category: 'read', reason: 'git config read' };
    }
    return { category: 'workspace-write', reason: 'git config write (local repo scope)' };
  }
  if (sub === 'stash' && rest.length > 0 && !['push', 'pop', 'apply', 'drop', 'clear', ''].includes(rest[0])) {
    return { category: 'read', reason: 'git stash inspection' };
  }
  if (GIT_READ_SUBCOMMANDS.has(sub)) {
    return { category: 'read', reason: `git ${sub || '(none)'} is read-only` };
  }
  if (GIT_WORKSPACE_SUBCOMMANDS.has(sub)) {
    const paths = pathLikeArgs(rest.map((token) => token));
    if (paths.length > 0) {
      const check = classifyPathSet(paths, workspaceRoot, cwd, `git ${sub}`);
      if (check.category === 'risky') return check;
    }
    return { category: 'workspace-write', reason: `git ${sub} inside the worktree` };
  }
  return { category: 'risky', reason: `unrecognized git subcommand "${sub}"` };
}

/** Flags that take a value, so the token after them is not the subcommand. */
const PACKAGE_MANAGER_VALUE_FLAGS = new Set([
  '-F', '--filter', '-C', '--dir', '-w', '--workspace', '--prefix', '--cwd', '--workspace-root',
]);

function classifyNodePackageManager(
  head: string,
  tokens: string[],
  workspaceRoot: string,
  cwd: string | null,
  depth: number,
): CategoryResult {
  // Find the real subcommand: `pnpm -F @scope/pkg exec tsc` must resolve to
  // "exec", not to the "-F" flag (which previously fell through to risky and
  // denied reviewers their own typecheck).
  let index = 1;
  while (index < tokens.length && tokens[index].startsWith('-')) {
    const flag = tokens[index];
    index += 1;
    if (PACKAGE_MANAGER_VALUE_FLAGS.has(flag) && !flag.includes('=')) index += 1;
  }
  const sub = tokens[index] ?? '';
  const rest = tokens.slice(index + 1);

  if (['install', 'i', 'ci', 'add', 'update', 'upgrade', 'uninstall', 'remove', 'link', 'publish', 'dlx', 'x', 'create'].includes(sub)) {
    return { category: 'risky', reason: `${head} ${sub} installs or executes remote packages` };
  }
  // `pnpm exec` / `yarn exec` runs an ALREADY-INSTALLED local binary (unlike
  // dlx/npx, which fetch). Classify what it actually runs.
  if (sub === 'exec' && rest.length > 0) {
    if (depth >= MAX_SHELL_UNWRAP_DEPTH) {
      return { category: 'risky', reason: `${head} exec nested too deeply to classify` };
    }
    return classifyCommandSegment(rest.join(' '), workspaceRoot, cwd, depth + 1);
  }
  if (sub === 'exec') {
    return { category: 'risky', reason: `${head} exec with no inspectable command` };
  }
  if (['test', 't', 'run', 'lint', 'build', 'check', 'typecheck', 'tsc', 'format', 'fmt'].includes(sub)) {
    return { category: 'read', reason: `${head} ${sub} is a project test/lint/build script` };
  }
  if (['ls', 'list', 'why', 'root', 'bin', 'pkg', 'view', 'outdated', 'audit'].includes(sub)) {
    return { category: 'read', reason: `${head} ${sub} is informational` };
  }
  return { category: 'risky', reason: `unrecognized ${head} subcommand "${sub}"` };
}

function classifyCommandSegment(
  segment: string,
  workspaceRoot: string,
  cwd: string | null,
  depth = 0,
): CategoryResult {
  // A wrapped command (`zsh -lc "…"`, `env FOO=1 …`) is classified by its
  // payload, which may itself be a multi-segment pipeline.
  if (depth < MAX_SHELL_UNWRAP_DEPTH) {
    const payload = unwrapShellPayload(segment);
    if (payload !== null) {
      return classifyCommand(payload, workspaceRoot, cwd, depth + 1);
    }
  }

  const tokens = commandTokens(segment);
  if (tokens.length === 0) return { category: 'read', reason: 'empty command segment' };
  const head = (tokens[0] ?? '').replace(/^.*\//, '').toLowerCase();

  let result: CategoryResult;

  if (ALWAYS_RISKY_COMMANDS.has(head)) {
    result = { category: 'risky', reason: `"${head}" requires privilege, spawns arbitrary code, or exposes the environment` };
  } else if (head === 'cd') {
    const target = tokens.slice(1).find((token) => !token.startsWith('-')) ?? '.';
    result = target === '-' || !isInsideWorkspace(target, workspaceRoot, cwd)
      ? { category: 'risky', reason: `cd targets a path outside the swarm workspace: ${target}` }
      : { category: 'read', reason: 'cd stays inside the swarm workspace' };
  } else if (head === 'rm') {
    const flagTokens = tokens.slice(1).filter((token) => token.startsWith('-'));
    let recursive = flagTokens.includes('--recursive');
    let force = flagTokens.includes('--force');
    for (const flag of flagTokens) {
      if (flag.startsWith('--')) continue;
      if (/[rR]/.test(flag)) recursive = true;
      if (flag.includes('f')) force = true;
    }
    if (recursive && force) {
      result = { category: 'risky', reason: 'rm -rf is destructive' };
    } else {
      const targets = tokens.slice(1).filter((token) => !token.startsWith('-'));
      if (targets.some((target) => target === '/' || target.includes('*') && target.startsWith('/'))) {
        result = { category: 'risky', reason: 'rm with a root-anchored glob is destructive' };
      } else {
        result = classifyPathSet(targets, workspaceRoot, cwd, 'rm');
      }
    }
  } else if (head === 'find') {
    if (tokens.includes('-delete') || tokens.includes('-exec') || tokens.includes('-execdir')) {
      result = { category: 'risky', reason: 'find with -delete/-exec mutates or executes' };
    } else {
      result = { category: 'read', reason: 'find without mutation flags is read-only' };
    }
  } else if (head === 'sed') {
    if (tokens.some((token) => token === '-i' || token.startsWith('-i'))) {
      result = classifyPathSet(pathLikeArgs(tokens), workspaceRoot, cwd, 'sed -i');
    } else {
      result = { category: 'read', reason: 'sed without -i is read-only' };
    }
  } else if (head === 'codesign') {
    const mutating = tokens.some((token) =>
      token === '-s'
      || token === '--sign'
      || token.startsWith('--sign=')
      || token === '--remove-signature'
      || token === '--generate-entitlement-der',
    );
    result = mutating
      ? { category: 'risky', reason: 'codesign request changes a binary signature' }
      : { category: 'read', reason: 'codesign display/verify is read-only' };
  } else if (head === 'plutil') {
    const mutating = tokens.some((token) => ['-replace', '-insert', '-remove', '-convert'].includes(token));
    result = mutating
      ? { category: 'risky', reason: 'plutil request mutates a property list' }
      : { category: 'read', reason: 'plutil inspection is read-only' };
  } else if (head === 'swift') {
    const sub = tokens[1] ?? '';
    const packageSub = tokens[2] ?? '';
    const safe = sub === '--version'
      || sub === '-version'
      || ['build', 'test', 'run'].includes(sub)
      || (sub === 'package' && ['describe', 'dump-package', 'show-dependencies'].includes(packageSub));
    result = safe
      ? { category: 'read', reason: `swift ${sub} is a local build/test/inspection command` }
      : { category: 'risky', reason: `unrecognized or stateful swift command "${[sub, packageSub].filter(Boolean).join(' ')}"` };
  } else if (head === 'dns-sd') {
    result = tokens.some((token) => ['-B', '-L', '-Q', '-G', '-Z'].includes(token))
      ? { category: 'read', reason: 'dns-sd local discovery/query is read-only' }
      : { category: 'risky', reason: 'dns-sd request may register or mutate a service' };
  } else if (head === 'ippfind') {
    result = tokens.some((token) => token === '--exec' || token === '-x')
      ? { category: 'risky', reason: 'ippfind --exec executes another command' }
      : { category: 'read', reason: 'ippfind discovery is read-only' };
  } else if (head === 'ipptool') {
    const testFile = tokens.find((token) => /\.test$/i.test(token)) ?? '';
    result = /(^|\/)get-[^/]*\.test$/i.test(testFile)
      ? { category: 'read', reason: 'ipptool get-* probe is read-only' }
      : { category: 'risky', reason: 'ipptool request is not a recognized read-only get probe' };
  } else if (head === 'git') {
    result = classifyGitSegment(tokens, workspaceRoot, cwd);
  } else if (head === 'npm' || head === 'yarn' || head === 'pnpm' || head === 'bun') {
    result = classifyNodePackageManager(head, tokens, workspaceRoot, cwd, depth);
  } else if (head === 'pip' || head === 'pip3' || head === 'uv') {
    const sub = tokens[1] ?? '';
    result = ['list', 'show', 'freeze', 'check'].includes(sub)
      ? { category: 'read', reason: `${head} ${sub} is informational` }
      : { category: 'risky', reason: `${head} ${sub || '(none)'} can install packages` };
  } else if (head === 'cargo' || head === 'go') {
    const sub = tokens[1] ?? '';
    if (['install', 'get', 'add', 'publish'].includes(sub)) {
      result = { category: 'risky', reason: `${head} ${sub} installs packages` };
    } else if (['build', 'test', 'check', 'clippy', 'vet', 'fmt', 'version', 'run'].includes(sub)) {
      result = { category: 'read', reason: `${head} ${sub} is a local build/test command` };
    } else {
      result = { category: 'risky', reason: `unrecognized ${head} subcommand "${sub}"` };
    }
  } else if (PACKAGE_MANAGERS.has(head)) {
    result = { category: 'risky', reason: `"${head}" is a system package manager` };
  } else if (NETWORK_COMMANDS.has(head)) {
    const hostArgs = tokens.slice(1).filter((token) => !token.startsWith('-'));
    const allLocal = hostArgs.length > 0 && hostArgs.every((arg) => LOCALHOST_PATTERN.test(arg) || !/[.:]|localhost/i.test(arg));
    const hasLocal = hostArgs.some((arg) => LOCALHOST_PATTERN.test(arg));
    result = allLocal && hasLocal
      ? { category: 'read', reason: `"${head}" limited to localhost` }
      : { category: 'risky', reason: `"${head}" reaches the network beyond localhost` };
  } else if (READ_COMMANDS.has(head) || SAFE_EXEC_COMMANDS.has(head)) {
    const sensitive = tokens.slice(1).find((token) => isSensitivePath(token));
    result = sensitive
      ? { category: 'risky', reason: `"${head}" reads a sensitive path: ${sensitive}` }
      : { category: 'read', reason: `"${head}" is read-only or a local test/build tool` };
  } else if (WRITE_COMMANDS.has(head)) {
    const paths = pathLikeArgs(tokens);
    result = paths.length > 0
      ? classifyPathSet(paths, workspaceRoot, cwd, `"${head}"`)
      : { category: 'workspace-write', reason: `"${head}" mutates files (no explicit target; assumed cwd)` };
  } else {
    result = { category: 'risky', reason: `unrecognized command "${head}"` };
  }

  // Redirections turn any segment into a write against the redirect target.
  const redirects = redirectTargets(segment);
  if (redirects.length > 0) {
    result = worst(result, classifyPathSet(redirects, workspaceRoot, cwd, 'output redirection'));
  }
  return result;
}

export function classifyCommand(
  command: string,
  workspaceRoot: string,
  cwd: string | null,
  depth = 0,
): CategoryResult {
  // Unwrap BEFORE splitting: `zsh -lc "find x && rg y"` must not be shredded
  // into `zsh -lc "find x` + `rg y"` by the segment splitter.
  if (depth < MAX_SHELL_UNWRAP_DEPTH) {
    const payload = unwrapShellPayload(command);
    if (payload !== null) {
      return classifyCommand(payload, workspaceRoot, cwd, depth + 1);
    }
  }
  const segments = splitCommandSegments(command);
  if (segments.length === 0) return { category: 'risky', reason: 'empty command' };
  let result: CategoryResult = { category: 'read', reason: 'read-only command' };
  for (const segment of segments) {
    result = worst(result, classifyCommandSegment(segment, workspaceRoot, cwd, depth));
    if (result.category === 'risky') break;
  }
  return result;
}

/**
 * Pure classification of one permission request into a seat-policy tier.
 * Read-only seats never see 'escalate' (mutations map straight to 'deny');
 * worker seats never see 'deny' (risk maps to 'escalate' for adjudication).
 */
export function classifyPermissionRequest(input: {
  seatKind: string;
  workspaceRoot: string;
  toolName?: string | null;
  command?: string | null;
  paths?: string[] | null;
  cwd?: string | null;
  rawInput?: unknown;
}): PermissionClassification {
  const readOnlySeat = isReadOnlySeatKind(input.seatKind);
  const toolName = input.toolName ?? null;
  const cwd = input.cwd ?? null;
  const paths = (input.paths ?? []).filter(Boolean);

  let categorized: CategoryResult;
  if (input.command) {
    categorized = classifyCommand(input.command, input.workspaceRoot, cwd);
  } else if (toolNameLooksLike(toolName, NETWORK_TOOL_KEYWORDS)) {
    const url = typeof input.rawInput === 'object' && input.rawInput !== null
      ? asString((input.rawInput as AnyRecord).url)
      : asString(input.rawInput);
    categorized = url && LOCALHOST_PATTERN.test(url)
      ? { category: 'read', reason: 'network tool limited to localhost' }
      : { category: 'risky', reason: `tool "${toolName}" reaches the network beyond localhost` };
  } else if (toolNameLooksLike(toolName, WRITE_TOOL_KEYWORDS)) {
    categorized = paths.length > 0
      ? classifyPathSet(paths, input.workspaceRoot, cwd, `tool "${toolName}"`)
      : { category: 'risky', reason: `tool "${toolName}" mutates files but declared no paths` };
  } else if (toolNameLooksLike(toolName, EXEC_TOOL_KEYWORDS)) {
    categorized = { category: 'risky', reason: `tool "${toolName}" executes a command that could not be extracted` };
  } else if (toolNameLooksLike(toolName, READ_TOOL_KEYWORDS)) {
    const sensitive = paths.find((candidate) => isSensitivePath(candidate));
    categorized = sensitive
      ? { category: 'risky', reason: `tool "${toolName}" reads a sensitive path: ${sensitive}` }
      : { category: 'read', reason: `tool "${toolName}" is read-only` };
  } else {
    categorized = { category: 'risky', reason: `unclassifiable tool "${toolName ?? '(unknown)'}"` };
  }

  if (readOnlySeat) {
    return categorized.category === 'read'
      ? { tier: 'approve', reason: categorized.reason }
      : { tier: 'deny', reason: `read-only seat (${input.seatKind}) may not mutate state: ${categorized.reason}` };
  }
  if (categorized.category === 'risky') {
    return { tier: 'escalate', reason: categorized.reason };
  }
  return { tier: 'approve', reason: categorized.reason };
}

// ————————————————————————————————————————————————————————————————————————
// Broker: registration, decision resolution, escalation, audit trail.
// ————————————————————————————————————————————————————————————————————————

const registry = new Map<string, SwarmPermissionContext & { registeredAt: number }>();

let resolverOverride: PermissionDecisionResolver | null = null;
let adjudicatorOverride: AdjudicateFn | null = null;

/** Test/bootstrap hook: replace the claude-sdk resolveToolApproval bridge. */
export function configureSwarmPermissionResolver(resolver: PermissionDecisionResolver | null): void {
  resolverOverride = resolver;
}

/** Test hook: replace the orchestrator adjudication run. */
export function configureSwarmPermissionAdjudicator(adjudicator: AdjudicateFn | null): void {
  adjudicatorOverride = adjudicator;
}

async function resolveDecision(requestId: string, decision: PermissionDecision): Promise<void> {
  if (resolverOverride) {
    resolverOverride(requestId, decision);
    return;
  }
  // Same process-wide pendingToolApprovals registry every runtime waits on.
  // claude-sdk.js is a legacy root runtime file outside the module graph, so
  // the boundaries plugin cannot classify it; the import is lazy (module cache
  // shared with server/index.js) and overridable via
  // configureSwarmPermissionResolver for tests/bootstrap.
  // eslint-disable-next-line boundaries/no-unknown
  const sdk = (await import('@/claude-sdk.js')) as unknown as {
    resolveToolApproval: PermissionDecisionResolver;
  };
  sdk.resolveToolApproval(requestId, decision);
}

/**
 * `parseJsonFromAgentText` THROWS on prose ("candidate is not JSON-shaped"),
 * which would surface as an internal-error reason instead of the intended
 * "returned no parseable verdict". Every orchestrator consultation goes through
 * this instead.
 */
function tryParseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed = parseJsonFromAgentText(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function newAuditMessageId(): string {
  return `smsg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function summarizeRequest(details: PermissionRequestDetails): string {
  const parts: string[] = [];
  if (details.toolName) parts.push(`tool=${details.toolName}`);
  if (details.command) parts.push(`command=${JSON.stringify(details.command.slice(0, 200))}`);
  if (details.paths.length > 0) parts.push(`paths=${details.paths.slice(0, 4).join(', ')}`);
  if (parts.length === 0 && details.rawInput != null) {
    try {
      parts.push(`input=${JSON.stringify(details.rawInput).slice(0, 200)}`);
    } catch {
      parts.push('input=(unserializable)');
    }
  }
  return parts.join(' ') || '(no request details)';
}

function recordDecision(
  ctx: SwarmPermissionContext,
  details: PermissionRequestDetails,
  outcome: SwarmPermissionOutcome,
): void {
  try {
    swarmDb.appendMessage(ctx.swarmId, {
      id: newAuditMessageId(),
      from: ctx.seatLabel || ctx.seatKind,
      kind: 'system',
      content: redactSwarmText([
        `[permission] ${outcome.allow ? 'APPROVED' : 'DENIED'} (${outcome.via})`,
        summarizeRequest(details),
        `— ${outcome.reason}`,
        `[seat=${ctx.seatKind} provider=${ctx.provider} mode=${ctx.permissionMode ?? 'n/a'} ${outcome.latencyMs}ms]`,
      ].join(' ')),
      stepId: null,
      at: new Date().toISOString(),
    });
  } catch (error) {
    console.error('[SwarmPermissionBroker] Failed to record decision on the blackboard', error);
  }
}

function pickOrchestratorSeat(swarmId: string): SwarmAgentSpec | null {
  const swarm = swarmDb.get(swarmId);
  if (!swarm) return null;
  return (
    swarm.config?.orchestrator ??
    swarm.roles.find((seat) => seat.kind === 'orchestrator') ??
    null
  );
}

function buildAdjudicationPrompt(input: {
  goal: string;
  workspaceRoot: string;
  ctx: SwarmPermissionContext;
  details: PermissionRequestDetails;
  reason: string;
}): string {
  let rawInputText = '(none)';
  try {
    rawInputText = JSON.stringify(input.details.rawInput ?? null).slice(0, 2000);
  } catch {
    rawInputText = '(unserializable)';
  }
  return [
    'You are the swarm orchestrator acting as a permission adjudicator.',
    'A worker agent asked to perform an action the automatic policy flagged as risky.',
    'Do NOT perform the action yourself and do NOT run any tools that mutate state.',
    'Respond with ONLY a JSON object (no markdown fences):',
    '{"approve": true or false, "reason": "one short sentence"}',
    '',
    `## Swarm goal`,
    input.goal,
    '',
    '## Request',
    `- seat: ${input.ctx.seatLabel || input.ctx.seatKind} (${input.ctx.seatKind}, provider ${input.ctx.provider})`,
    `- tool: ${input.details.toolName ?? '(unknown)'}`,
    `- command: ${input.details.command ?? '(none)'}`,
    `- paths: ${input.details.paths.join(', ') || '(none)'}`,
    `- raw input: ${rawInputText}`,
    `- flagged because: ${input.reason}`,
    '',
    '## Policy',
    `- The only writable area is the swarm workspace: ${input.workspaceRoot}`,
    '- Approve only when the action is clearly required for the goal and stays inside the workspace.',
    '- Deny package installs, non-localhost network access, destructive commands, secret/credential access,',
    '  privilege escalation, and anything touching paths outside the workspace unless the goal explicitly demands it.',
    '- When in doubt, deny.',
  ].join('\n');
}

/**
 * One bounded, read-only orchestrator consultation. Shared by every path that
 * needs the orchestrator's judgement mid-run (risky permissions, worker
 * questions, plan-exit review) so they all inherit the same budget, the same
 * recursion guard, and the same failure semantics.
 */
async function consultOrchestrator(
  ctx: SwarmPermissionContext,
  input: { prompt: string; title: string; phase: string },
): Promise<{ ok: true; text: string } | { ok: false; reason: string }> {
  const swarm = swarmDb.get(ctx.swarmId);
  if (!swarm) return { ok: false, reason: 'swarm not found' };
  const orchestrator = pickOrchestratorSeat(ctx.swarmId);

  // Dynamic import breaks the static cycle (agent service imports this broker).
  const agentModule = await import('@/modules/swarm/swarm-agent.service.js');
  const provider = agentModule.resolveSwarmProvider(orchestrator?.provider ?? ctx.provider);
  if (!agentModule.getSwarmSpawnFn(provider)) {
    return { ok: false, reason: `no runtime available for orchestrator provider "${provider}"` };
  }
  const capabilities = providerCapabilitiesService.getProviderCapabilities(provider);
  const permissionMode = capabilities.permissionModes.includes('plan')
    ? 'plan'
    : capabilities.defaultPermissionMode;

  const run = runService.create({
    source: 'swarm',
    projectId: swarm.project_id,
    parentRunId: swarm.parent_run_id,
    rootRunId: swarm.parent_run_id,
    workspaceId: swarm.workspace_id,
    provider,
    model: orchestrator?.model ?? null,
    effort: null,
    permissionMode,
    title: `${input.title} (${ctx.seatLabel || ctx.seatKind})`,
    trigger: `swarm-${input.phase}:${ctx.swarmId}`,
    status: 'running',
    meta: { swarmId: ctx.swarmId, role: 'orchestrator', phase: input.phase },
  });

  try {
    const outcome = await agentModule.runSwarmAgent({
      projectId: swarm.project_id,
      projectPath: ctx.workspaceRoot,
      provider,
      model: orchestrator?.model ?? null,
      effort: null,
      permissionMode,
      prompt: input.prompt,
      runId: run.run_id,
      title: input.title,
      timeoutMs: adjudicationTimeoutMs(),
      // A consultation must never be killed by stall detection: its whole job
      // is one short answer, and the hard budget above already bounds it.
      stallTimeoutMs: null,
      // Recursion guard: the consulted orchestrator is a read-only seat that can
      // never escalate — its own prompts are auto-answered by tier-a policy.
      permission: {
        swarmId: ctx.swarmId,
        seatKind: 'orchestrator',
        seatLabel: input.title,
        workspaceRoot: ctx.workspaceRoot,
        allowEscalation: false,
      },
    });

    if (outcome.timedOut) {
      return { ok: false, reason: `orchestrator ${input.phase} timed out after ${adjudicationTimeoutMs()}ms` };
    }
    if (!outcome.success || !outcome.text.trim()) {
      return { ok: false, reason: `orchestrator ${input.phase} failed: ${outcome.errorMessage ?? 'no output'}` };
    }
    return { ok: true, text: outcome.text };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: `orchestrator ${input.phase} errored: ${message}` };
  } finally {
    try {
      const current = runService.get(run.run_id);
      if (current && !['succeeded', 'failed', 'aborted', 'timed_out'].includes(current.status)) {
        runService.markTerminal(run.run_id, { status: 'succeeded' });
      }
    } catch {
      /* optional */
    }
  }
}

async function adjudicateWithOrchestrator(
  ctx: SwarmPermissionContext,
  details: PermissionRequestDetails,
  flaggedReason: string,
): Promise<{ approve: boolean; reason: string }> {
  if (adjudicatorOverride) {
    return adjudicatorOverride(ctx, details);
  }
  const swarm = swarmDb.get(ctx.swarmId);
  if (!swarm) return { approve: false, reason: 'swarm not found for adjudication' };

  const consult = await consultOrchestrator(ctx, {
    prompt: buildAdjudicationPrompt({
      goal: swarm.goal,
      workspaceRoot: ctx.workspaceRoot,
      ctx,
      details,
      reason: flaggedReason,
    }),
    title: 'Swarm permission adjudication',
    phase: 'adjudication',
  });
  if (!consult.ok) return { approve: false, reason: consult.reason };

  const record = tryParseJsonObject(consult.text);
  if (record && typeof record.approve === 'boolean') {
    const reason = asString(record.reason) ?? '(no reason given)';
    return { approve: record.approve, reason: `orchestrator ${record.approve ? 'approved' : 'denied'}: ${reason}` };
  }
  return { approve: false, reason: 'orchestrator adjudication returned no parseable {"approve": …} verdict' };
}

// ————————————————————————————————————————————————————————————————————————
// Interactive tools: worker questions and plan-exit review.
//
// These are NOT permission checks — a worker is asking the human something.
// In a swarm there is no human, and leaving them unanswered was expensive: the
// runtime waited out its whole unattended budget (10 min) and then denied with
// no information, burning an attempt for nothing. The orchestrator is the right
// respondent: it wrote the plan and holds the goal and the blackboard.
// ————————————————————————————————————————————————————————————————————————

type WorkerQuestion = {
  question: string;
  header: string | null;
  multiSelect: boolean;
  options: Array<{ label: string; description: string | null }>;
};

/** Pull the `AskUserQuestion` payload out of a permission-request input. */
export function extractWorkerQuestions(rawInput: unknown): WorkerQuestion[] {
  const container =
    rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput)
      ? (rawInput as AnyRecord)
      : null;
  const raw = container?.questions;
  if (!Array.isArray(raw)) return [];
  const questions: WorkerQuestion[] = [];
  for (const entry of raw as unknown[]) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as AnyRecord;
    const question = asString(record.question);
    if (!question) continue;
    const options: Array<{ label: string; description: string | null }> = [];
    if (Array.isArray(record.options)) {
      for (const option of record.options as unknown[]) {
        if (typeof option === 'string') {
          if (option.trim()) options.push({ label: option, description: null });
          continue;
        }
        if (!option || typeof option !== 'object') continue;
        const label = asString((option as AnyRecord).label);
        if (label) options.push({ label, description: asString((option as AnyRecord).description) });
      }
    }
    questions.push({
      question,
      header: asString(record.header),
      multiSelect: Boolean(record.multiSelect),
      options,
    });
  }
  return questions;
}

/** Recent blackboard context so the orchestrator answers with the run in mind. */
function recentBlackboard(swarmId: string, maxChars = 4_000): string {
  try {
    const messages = swarmDb.get(swarmId)?.blackboard ?? [];
    const text = messages
      .slice(-12)
      .map((message) => `- ${message.from} (${message.kind}): ${message.content.slice(0, 400)}`)
      .join('\n');
    return text.slice(-maxChars) || '(nothing on the blackboard yet)';
  } catch {
    return '(blackboard unavailable)';
  }
}

function buildQuestionPrompt(input: {
  goal: string;
  ctx: SwarmPermissionContext;
  questions: WorkerQuestion[];
  blackboard: string;
}): string {
  const questionBlock = input.questions
    .map((question, index) => {
      const options = question.options.length
        ? question.options
            .map((option) => `    - "${option.label}"${option.description ? ` — ${option.description}` : ''}`)
            .join('\n')
        : '    (no options offered — answer in your own words)';
      return [
        `${index + 1}. ${question.question}`,
        question.header ? `   topic: ${question.header}` : '',
        question.multiSelect ? '   (multiple choices allowed)' : '',
        '   options:',
        options,
      ]
        .filter(Boolean)
        .join('\n');
    })
    .join('\n\n');

  return [
    'You are the swarm orchestrator. A worker agent you dispatched has stopped to ask a question.',
    'There is no human in this run — YOU answer, on the human\'s behalf, so the worker can continue.',
    'Answer decisively from the goal and the plan. Do NOT run tools and do NOT do the work yourself.',
    '',
    '## Swarm goal',
    input.goal,
    '',
    `## Who is asking`,
    `${input.ctx.seatLabel || input.ctx.seatKind} (${input.ctx.seatKind}, provider ${input.ctx.provider})`,
    '',
    '## Recent blackboard',
    input.blackboard,
    '',
    '## The question(s)',
    questionBlock,
    '',
    '## How to answer',
    '- Pick the option that best serves the swarm goal. Prefer an offered option, copied EXACTLY.',
    '- For a multi-choice question, join your picks with ", ".',
    '- Only write a free-form answer when no offered option fits.',
    '- Never leave an answer blank: a blank answer stalls the worker.',
    '',
    'Return ONLY a JSON object (no markdown fences) keyed by the exact question text:',
    `{"answers": {${input.questions.map((question) => `"${question.question.replace(/"/g, '\\"').slice(0, 120)}": "<your answer>"`).join(', ')}}}`,
  ].join('\n');
}

/**
 * Answer a worker's question as the orchestrator. Answers are validated against
 * the offered options (case-insensitively, and per-item for multi-select) so a
 * hallucinated label can never reach the provider; unmatched free-form text is
 * kept only when the question offered no options.
 */
async function answerQuestionWithOrchestrator(
  ctx: SwarmPermissionContext,
  details: PermissionRequestDetails,
): Promise<{ answers: Record<string, string>; reason: string }> {
  const swarm = swarmDb.get(ctx.swarmId);
  if (!swarm) return { answers: {}, reason: 'swarm not found; skipping the question' };
  const questions = extractWorkerQuestions(details.rawInput);
  if (questions.length === 0) {
    return { answers: {}, reason: 'no parseable questions in the request; skipping' };
  }

  const consult = await consultOrchestrator(ctx, {
    prompt: buildQuestionPrompt({
      goal: swarm.goal,
      ctx,
      questions,
      blackboard: recentBlackboard(ctx.swarmId),
    }),
    title: 'Swarm question answer',
    phase: 'question',
  });
  if (!consult.ok) return { answers: {}, reason: `${consult.reason}; skipping the question` };

  const rawAnswers = tryParseJsonObject(consult.text)?.answers;
  if (!rawAnswers || typeof rawAnswers !== 'object' || Array.isArray(rawAnswers)) {
    return { answers: {}, reason: 'orchestrator returned no parseable {"answers": …}; skipping' };
  }

  const answers: Record<string, string> = {};
  const notes: string[] = [];
  for (const question of questions) {
    const value = (rawAnswers as AnyRecord)[question.question];
    const text = asString(value);
    if (!text) continue;
    if (question.options.length === 0) {
      answers[question.question] = text.slice(0, 2_000);
      continue;
    }
    const byLower = new Map(question.options.map((option) => [option.label.toLowerCase(), option.label]));
    const picked = (question.multiSelect ? text.split(',') : [text])
      .map((part) => byLower.get(part.trim().toLowerCase()))
      .filter((label): label is string => Boolean(label));
    if (picked.length > 0) {
      answers[question.question] = [...new Set(picked)].join(', ');
    } else {
      // Not one of the offered labels: keep it, but say so — a swarm stalling
      // is worse than a slightly off-script answer.
      answers[question.question] = text.slice(0, 2_000);
      notes.push(`"${text.slice(0, 60)}" matched no offered option`);
    }
  }

  if (Object.keys(answers).length === 0) {
    return { answers: {}, reason: 'orchestrator answered nothing usable; skipping the question' };
  }
  const summary = Object.entries(answers)
    .map(([question, answer]) => `${question.slice(0, 60)} → ${answer.slice(0, 80)}`)
    .join('; ');
  return {
    answers,
    reason: `orchestrator answered: ${summary}${notes.length ? ` (${notes.join('; ')})` : ''}`,
  };
}

/** Review a worker's ExitPlanMode request as the orchestrator. */
async function reviewPlanExitWithOrchestrator(
  ctx: SwarmPermissionContext,
  details: PermissionRequestDetails,
): Promise<{ approve: boolean; reason: string }> {
  const swarm = swarmDb.get(ctx.swarmId);
  if (!swarm) return { approve: false, reason: 'swarm not found for plan review' };
  let planText = '(the worker supplied no plan text)';
  const container =
    details.rawInput && typeof details.rawInput === 'object' && !Array.isArray(details.rawInput)
      ? (details.rawInput as AnyRecord)
      : null;
  const plan = container ? asString(container.plan) ?? asString(container.markdown) : null;
  if (plan) planText = plan.slice(0, 6_000);

  const consult = await consultOrchestrator(ctx, {
    prompt: [
      'You are the swarm orchestrator. A worker agent you dispatched entered plan mode and now',
      'asks to leave it and start making changes. There is no human in this run — you decide.',
      'Do NOT do the work yourself and do NOT run tools that mutate state.',
      '',
      '## Swarm goal',
      swarm.goal,
      '',
      `## Who is asking`,
      `${ctx.seatLabel || ctx.seatKind} (${ctx.seatKind}, provider ${ctx.provider})`,
      '',
      '## Their proposed plan',
      planText,
      '',
      '## Recent blackboard',
      recentBlackboard(ctx.swarmId),
      '',
      '## How to decide',
      '- Approve when the plan advances the assigned step and stays inside the swarm workspace.',
      '- Reject when it contradicts the plan, expands scope, or would touch things outside its step —',
      '  your reason is fed back to the worker, so make it actionable.',
      '',
      'Return ONLY a JSON object (no markdown fences):',
      '{"approve": true or false, "reason": "one short sentence the worker can act on"}',
    ].join('\n'),
    title: 'Swarm plan-exit review',
    phase: 'plan-review',
  });
  if (!consult.ok) return { approve: false, reason: consult.reason };

  const record = tryParseJsonObject(consult.text);
  if (record && typeof record.approve === 'boolean') {
    const reason = asString(record.reason) ?? '(no reason given)';
    return {
      approve: record.approve,
      reason: `orchestrator ${record.approve ? 'approved the plan' : 'rejected the plan'}: ${reason}`,
    };
  }
  return { approve: false, reason: 'orchestrator plan review returned no parseable {"approve": …} verdict' };
}

/** Blackboard audit for an interactive-tool decision (question / plan review). */
function recordInteractiveDecision(
  ctx: SwarmPermissionContext,
  label: string,
  outcome: SwarmPermissionOutcome,
): void {
  try {
    swarmDb.appendMessage(ctx.swarmId, {
      id: newAuditMessageId(),
      from: ctx.seatLabel || ctx.seatKind,
      kind: 'question',
      content: redactSwarmText([
        `[${label}] ${outcome.allow ? 'ANSWERED' : 'BLOCKED'} (${outcome.via})`,
        `— ${outcome.reason}`,
        `[seat=${ctx.seatKind} provider=${ctx.provider} ${outcome.latencyMs}ms]`,
      ].join(' ')),
      stepId: null,
      at: new Date().toISOString(),
    });
  } catch (error) {
    console.error('[SwarmPermissionBroker] Failed to record interactive decision', error);
  }
}

/**
 * `AskUserQuestion` from a worker: consult the orchestrator, then resolve with
 * `updatedInput.answers` in the shape every runtime already expects from the
 * interactive UI (`{ [question text]: "Label" }`). An unanswerable question
 * resolves as an empty-answers skip rather than a denial — a skip lets the
 * worker proceed on its own judgement, a denial usually kills its turn.
 */
async function answerWorkerQuestion(
  ctx: SwarmPermissionContext,
  requestId: string,
  message: AnyRecord,
): Promise<SwarmPermissionOutcome> {
  const startedAt = Date.now();
  let answers: Record<string, string> = {};
  let reason = 'permission broker internal error';
  try {
    const details = extractPermissionRequestDetails(message);
    const result = await answerQuestionWithOrchestrator(ctx, details);
    answers = result.answers;
    reason = result.reason;
  } catch (error) {
    reason = `question handling errored: ${error instanceof Error ? error.message : String(error)}`;
  }

  const answered = Object.keys(answers).length > 0;
  const outcome: SwarmPermissionOutcome = {
    requestId,
    allow: answered,
    reason,
    via: 'orchestrator',
    latencyMs: Date.now() - startedAt,
  };

  try {
    const baseInput =
      message.input && typeof message.input === 'object' && !Array.isArray(message.input)
        ? (message.input as AnyRecord)
        : {};
    // Always `allow` so the runtime treats this as an answered interview; an
    // empty `answers` map is the established "skip" signal.
    await resolveDecision(requestId, { allow: true, updatedInput: { ...baseInput, answers } });
  } catch (error) {
    console.error('[SwarmPermissionBroker] Failed to resolve a worker question', error);
  }

  recordInteractiveDecision(ctx, 'question', outcome);
  return outcome;
}

/**
 * `ExitPlanMode` from a worker: the orchestrator reviews the proposed plan.
 * Read-only seats are refused without consulting anyone — leaving plan mode is
 * how they would start writing, and that guarantee is not the orchestrator's to
 * trade away.
 */
async function reviewWorkerPlanExit(
  ctx: SwarmPermissionContext,
  requestId: string,
  message: AnyRecord,
): Promise<SwarmPermissionOutcome> {
  const startedAt = Date.now();
  let allow = false;
  let reason = 'permission broker internal error';
  let via: SwarmPermissionOutcome['via'] = 'orchestrator';

  if (isReadOnlySeatKind(ctx.seatKind)) {
    via = 'policy';
    reason = `read-only seat (${ctx.seatKind}) may not leave plan mode to start writing`;
  } else {
    try {
      const details = extractPermissionRequestDetails(message);
      const verdict = await reviewPlanExitWithOrchestrator(ctx, details);
      allow = verdict.approve;
      reason = verdict.reason;
    } catch (error) {
      reason = `plan review errored: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  const outcome: SwarmPermissionOutcome = {
    requestId,
    allow,
    reason,
    via,
    latencyMs: Date.now() - startedAt,
  };

  try {
    await resolveDecision(
      requestId,
      allow
        ? { allow: true, updatedInput: message.input }
        : { allow: false, message: `Swarm orchestrator did not approve leaving plan mode: ${reason}` },
    );
  } catch (error) {
    console.error('[SwarmPermissionBroker] Failed to resolve a plan-exit request', error);
  }

  recordInteractiveDecision(ctx, 'plan-review', outcome);
  return outcome;
}

/**
 * Swarm orchestrators are always detached from the chat connection. There is
 * no human UI capable of resolving their own interactive request, and asking
 * another orchestrator would recurse. Release the provider deterministically:
 * skip interviews and allow it to finish leaving plan mode. Read-only policy
 * continues to block any mutation request that may follow.
 */
async function resolveDetachedOrchestratorInteractiveTool(
  ctx: SwarmPermissionContext,
  requestId: string,
  message: AnyRecord,
  toolName: 'askuserquestion' | 'exitplanmode',
): Promise<SwarmPermissionOutcome> {
  const startedAt = Date.now();
  const baseInput =
    message.input && typeof message.input === 'object' && !Array.isArray(message.input)
      ? (message.input as AnyRecord)
      : {};
  const isQuestion = toolName === 'askuserquestion';
  const reason = isQuestion
    ? 'detached orchestrator has no interactive user; skipped the question'
    : 'detached orchestrator may finish leaving plan mode; read-only policy remains enforced';
  const outcome: SwarmPermissionOutcome = {
    requestId,
    allow: true,
    reason,
    via: 'policy',
    latencyMs: Date.now() - startedAt,
  };

  try {
    await resolveDecision(requestId, {
      allow: true,
      updatedInput: isQuestion ? { ...baseInput, answers: {} } : message.input,
    });
  } catch (error) {
    console.error('[SwarmPermissionBroker] Failed to resolve an orchestrator interactive request', error);
  }

  recordInteractiveDecision(ctx, isQuestion ? 'question' : 'plan-review', outcome);
  return outcome;
}

export const swarmPermissionBroker = {
  /** Register a live swarm agent run so its permission prompts get answered. */
  register(runId: string, ctx: SwarmPermissionContext): void {
    registry.set(runId, {
      ...ctx,
      allowEscalation: ctx.allowEscalation ?? !isReadOnlySeatKind(ctx.seatKind),
      registeredAt: Date.now(),
    });
  },

  deregister(runId: string): void {
    registry.delete(runId);
  },

  getRegistration(runId: string): SwarmPermissionContext | null {
    return registry.get(runId) ?? null;
  },

  /** Exposed for tests. */
  clearAll(): void {
    registry.clear();
  },

  /**
   * Answer one normalized `permission_request` event for a registered run.
   * Never throws and always resolves the request (deny on internal failure)
   * so a broker bug can never leave a runtime hanging on its own timeout.
   */
  async handlePermissionRequest(
    runId: string,
    message: AnyRecord,
  ): Promise<SwarmPermissionOutcome | null> {
    const ctx = registry.get(runId);
    const requestId = asString(message.requestId);
    if (!ctx || !requestId) return null;

    const normalizedToolName = asString(message.toolName)?.toLowerCase().replace(/[^a-z0-9]/g, '');

    // Interactive tools are not permission checks. Worker requests are
    // delegated to the orchestrator; the detached orchestrator's own requests
    // are resolved locally so they can never wait for a UI that does not exist.
    const isInteractiveTool = normalizedToolName === 'askuserquestion' || normalizedToolName === 'exitplanmode';
    if (isInteractiveTool && ctx.seatKind === 'orchestrator') {
      return await resolveDetachedOrchestratorInteractiveTool(
        ctx,
        requestId,
        message,
        normalizedToolName as 'askuserquestion' | 'exitplanmode',
      );
    }
    if (normalizedToolName === 'askuserquestion') {
      return await answerWorkerQuestion(ctx, requestId, message);
    }
    if (normalizedToolName === 'exitplanmode') {
      return await reviewWorkerPlanExit(ctx, requestId, message);
    }

    const startedAt = Date.now();
    let details: PermissionRequestDetails = { toolName: null, command: null, paths: [], cwd: null, rawInput: null };
    let allow = false;
    let reason = 'permission broker internal error';
    let via: SwarmPermissionOutcome['via'] = 'policy';

    try {
      details = extractPermissionRequestDetails(message);
      const classification = classifyPermissionRequest({
        seatKind: ctx.seatKind,
        workspaceRoot: ctx.workspaceRoot,
        toolName: details.toolName,
        command: details.command,
        paths: details.paths,
        cwd: details.cwd,
        rawInput: details.rawInput,
      });

      if (classification.tier === 'approve') {
        allow = true;
        reason = classification.reason;
      } else if (classification.tier === 'deny' || !ctx.allowEscalation) {
        allow = false;
        reason =
          classification.tier === 'escalate'
            ? `${classification.reason} (escalation is disabled for this seat)`
            : classification.reason;
      } else {
        via = 'orchestrator';
        const verdict = await adjudicateWithOrchestrator(ctx, details, classification.reason);
        allow = verdict.approve;
        reason = verdict.reason;
      }
    } catch (error) {
      allow = false;
      reason = `permission broker error: ${error instanceof Error ? error.message : String(error)}`;
    }

    const outcome: SwarmPermissionOutcome = {
      requestId,
      allow,
      reason,
      via,
      latencyMs: Date.now() - startedAt,
    };

    try {
      await resolveDecision(
        requestId,
        allow
          ? { allow: true, updatedInput: message.input }
          : { allow: false, message: `Swarm permission broker denied this request: ${reason}` },
      );
    } catch (error) {
      console.error('[SwarmPermissionBroker] Failed to resolve tool approval', error);
    }

    recordDecision(ctx, details, outcome);
    return outcome;
  },
};
