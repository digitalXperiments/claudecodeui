/**
 * Agent action permission classifier.
 *
 * A pure policy function: it maps one provider `permission_request` to a tier,
 * and it is the single source of truth for what counts as a read, a scoped
 * write, or something risky. Agent Relay layers its own envelope rules on top
 * (see `agent-relay-permission.service.ts`); this module has no opinion about
 * who asked or what happens next.
 *
 * Policy tiers, by seat view:
 * - Read-only view: read-only operations are approved, anything that mutates
 *   state is denied. Never escalates — a read-only assignment fails fast.
 * - Writer view: operations scoped inside the declared workspace root are
 *   approved; risky requests (outside-workspace paths, package installs,
 *   non-localhost network, destructive commands, secret access, privilege
 *   escalation) escalate. Anything unclassifiable escalates too — unknown is
 *   deliberately treated as risky, never as safe.
 *
 * Extracted from the retired Agent Swarm module, which originally owned it.
 * The behaviour is unchanged; only the swarm-specific broker around it is gone.
 */

import { realpathSync } from 'node:fs';
import path from 'node:path';

import type { AnyRecord } from '@/shared/types.js';

export type PermissionRequestDetails = {
  toolName: string | null;
  command: string | null;
  paths: string[];
  cwd: string | null;
  rawInput: unknown;
};

export type PermissionTier = 'approve' | 'deny' | 'escalate';

export type PermissionClassification = { tier: PermissionTier; reason: string };

const READ_ONLY_SEAT_KINDS = new Set(['explorer', 'reviewer', 'orchestrator']);

export function isReadOnlySeatKind(kind: string): boolean {
  return READ_ONLY_SEAT_KINDS.has(kind);
}

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

function normalizeToolKey(toolName: string | null): string {
  return toolName?.toLowerCase().replace(/[^a-z0-9]/g, '') ?? '';
}

function toolNameLooksLike(toolName: string | null, keywords: string[]): boolean {
  if (!toolName) return false;
  const lowered = toolName.toLowerCase();
  return keywords.some((keyword) => lowered.includes(keyword));
}

function asRecord(value: unknown): AnyRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as AnyRecord) : null;
}

const MCP_WRAPPER_KEYS = new Set(['usetool', 'searchtool']);
const INNER_MCP_READ_TOKENS = new Set(['get', 'query', 'find', 'info', 'stat']);
const INNER_MCP_WRITE_TOKENS = new Set(['put', 'set', 'update', 'insert', 'upsert', 'post']);

function isMcpWrapperTool(toolName: string | null): boolean {
  return MCP_WRAPPER_KEYS.has(normalizeToolKey(toolName));
}

function pickStringField(obj: AnyRecord | null, keys: string[]): string | null {
  if (!obj) return null;
  for (const key of keys) {
    const value = asString(obj[key]);
    if (value) return value;
  }
  return null;
}

/**
 * Grok MCP calls arrive as `use_tool` / `search_tool` with the catalog identity
 * nested in arguments. Classify that inner tool, not the unclassifiable wrapper.
 */
function unwrapMcpInnerIdentity(rawInput: unknown): { toolName: string | null; command: string | null } {
  const roots: AnyRecord[] = [];
  const top = asRecord(rawInput);
  if (top) {
    roots.push(top);
    for (const key of ['arguments', 'args', 'input', 'toolInput', 'params', 'parameters', 'tool_input']) {
      const nested = asRecord(top[key]);
      if (nested) roots.push(nested);
    }
  }
  let toolName: string | null = null;
  let command: string | null = null;
  for (const obj of roots) {
    if (!toolName) {
      toolName = pickStringField(obj, ['tool_name', 'toolName', 'name', 'tool']);
    }
    if (!command) {
      command = pickStringField(obj, ['command', 'cmd', 'script']);
    }
  }
  return { toolName, command };
}

function innerMcpLooksLike(innerName: string, keywords: string[], extraTokens: Set<string>): boolean {
  if (toolNameLooksLike(innerName, keywords)) return true;
  const tokens = innerName.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  return tokens.some((token) => extraTokens.has(token) || keywords.includes(token));
}

const NAMED_PERMISSION_TOOLS = new Set([
  'bash', 'shell', 'exec', 'command', 'terminal', 'run',
  'read', 'grep', 'glob', 'write', 'edit', 'filechanges',
  'codexpermissions', 'askuserquestion', 'exitplanmode',
]);

function toolNameLooksLikeCommandLine(toolName: string | null): boolean {
  if (!toolName) return false;
  const trimmed = toolName.trim();
  if (!trimmed) return false;
  const normalized = trimmed.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (NAMED_PERMISSION_TOOLS.has(normalized)) return false;
  return /\s/.test(trimmed) || trimmed.includes('/') || trimmed.includes('\\');
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
  // OpenCode/Grok ACP often put the shell line in `toolCall.title` and leave
  // `command` empty. "git status" then looks like an unknown tool and every
  // explorer bash is denied. Treat a title that is clearly a command line as
  // the command itself.
  if (!command && toolNameLooksLikeCommandLine(toolName)) {
    command = toolName;
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
  'cat', 'lsof', 'ps', 'pgrep', 'head', 'tail', 'less', 'more', 'grep', 'rg', 'ugrep', 'egrep', 'fgrep', 'ls', 'pwd',
  'wc', 'which', 'whereis', 'file', 'stat', 'du', 'df', 'tree', 'echo', 'printf', 'sort',
  'uniq', 'cut', 'diff', 'cmp', 'basename', 'dirname', 'md5sum', 'shasum', 'sha256sum',
  'realpath', 'readlink', 'type', 'true', 'false', 'test', 'date', 'uname', 'nproc', 'jq', 'awk', 'column', 'xxd',
  // Formatting and pacing helpers commonly used in inspection pipelines.
  'nl', 'sleep',
  'fd', 'fdfind', 'bat', 'ag', 'ack',
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

function isInsideWorkspaceCwd(workspaceRoot: string, cwd: string | null): boolean {
  return Boolean(cwd && path.isAbsolute(cwd) && isInsideWorkspace('.', workspaceRoot, cwd));
}

function classifyLocalTestCommand(
  head: string,
  tokens: string[],
  workspaceRoot: string,
  cwd: string | null,
): CategoryResult | null {
  if (!['node', 'tsx', 'ts-node'].includes(head) || !tokens.slice(1).includes('--test')) return null;
  if (!isInsideWorkspaceCwd(workspaceRoot, cwd)) {
    return { category: 'risky', reason: `${head} --test must run inside the worker workspace` };
  }
  const testPaths = pathLikeArgs(tokens);
  if (testPaths.length > 0) {
    const scoped = classifyPathSet(testPaths, workspaceRoot, cwd, `${head} --test`);
    if (scoped.category === 'risky') return scoped;
  }
  return { category: 'workspace-write', reason: `${head} --test is a local test run in the worker workspace` };
}

const PYTHON_HEADS = new Set(['python', 'python3']);
const PYTHON_TOOL_HEADS = new Set(['pytest', 'ruff', 'mypy', 'black', 'isort', 'flake8', 'pyright']);
const SCRIPT_RUNNER_HEADS = new Set(['node', 'tsx', 'ts-node', 'bun', 'deno', 'bash', 'sh', 'zsh']);

/**
 * Running the project's own code or tooling from inside the worker's
 * workspace: `python3 -m pytest`, `pytest`, `ruff`, `make`, `node scripts/x.js`,
 * `bash scripts/check.sh`. These are what a writer needs to verify its work,
 * so they are workspace-scoped actions (writers may, read-only seats may not)
 * rather than unknown commands. Inline code (`-c`, `-e`, `--eval`) stays risky:
 * it is not project code, and it can do anything.
 */
function classifyProjectExecution(
  head: string,
  tokens: string[],
  workspaceRoot: string,
  cwd: string | null,
): CategoryResult | null {
  const args = tokens.slice(1);
  const inline = args.some((token) => ['-c', '-e', '--eval', '-p', '--print'].includes(token) || /^-[a-z]*c$/i.test(token));
  let label: string | null = null;
  let scriptPaths: string[] = [];
  if (PYTHON_HEADS.has(head)) {
    if (inline) return null;
    const moduleIndex = args.indexOf('-m');
    if (moduleIndex >= 0) {
      label = `${head} -m ${args[moduleIndex + 1] ?? ''}`.trim();
    } else {
      const script = args.find((token) => !token.startsWith('-'));
      if (!script) return null;
      label = `${head} ${script}`;
      scriptPaths = [script];
    }
  } else if (PYTHON_TOOL_HEADS.has(head)) {
    label = head;
  } else if (head === 'make' || head === 'just' || head === 'ninja' || head === 'cmake') {
    label = head;
  } else if (SCRIPT_RUNNER_HEADS.has(head)) {
    if (inline) return null;
    const script = args.find((token) => !token.startsWith('-'));
    if (!script || !/[./]/.test(script)) return null;
    label = `${head} ${script}`;
    scriptPaths = [script];
  } else if (head.startsWith('./') || head.startsWith('scripts/') || head.startsWith('bin/')) {
    label = head;
    scriptPaths = [head];
  }
  if (!label) return null;
  if (!isInsideWorkspaceCwd(workspaceRoot, cwd)) {
    return { category: 'risky', reason: `${label} must run inside the worker workspace` };
  }
  if (scriptPaths.length > 0) {
    const scoped = classifyPathSet(scriptPaths, workspaceRoot, cwd, label);
    if (scoped.category === 'risky') return scoped;
  }
  return { category: 'workspace-write', reason: `${label} runs project code inside the worker workspace` };
}

function isLocalPackageCheck(
  head: string,
  tokens: string[],
  workspaceRoot: string,
  cwd: string | null,
): boolean {
  if (!['npm', 'yarn', 'pnpm', 'bun'].includes(head)) return false;
  if (!isInsideWorkspaceCwd(workspaceRoot, cwd)) return false;
  let index = 1;
  while (index < tokens.length && tokens[index].startsWith('-')) {
    const flag = tokens[index];
    index += 1;
    const inlineValue = flag.match(/^--(?:prefix|cwd|dir|workspace-root)=(.+)$/)?.[1];
    if (inlineValue && !isInsideWorkspace(inlineValue, workspaceRoot, cwd)) return false;
    if (PACKAGE_MANAGER_VALUE_FLAGS.has(flag) && !flag.includes('=')) {
      const value = tokens[index];
      if (!value || (['-C', '--dir', '--prefix', '--cwd', '--workspace-root'].includes(flag)
        && !isInsideWorkspace(value, workspaceRoot, cwd))) return false;
      index += 1;
    }
  }
  const sub = tokens[index] ?? '';
  // `run <script>` executes a script the project itself defines, from inside
  // the worker's own checkout — the same trust as `npm test`.
  if ((sub === 'run' || sub === 'run-script') && /^[a-z0-9:._@/-]+$/i.test(tokens[index + 1] ?? '')) return true;
  return /^(?:test(?::[a-z0-9._-]+)?|build(?::[a-z0-9._-]+)?|lint(?::[a-z0-9._-]+)?|typecheck|check|tsc)$/.test(sub);
}

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
  'push', 'pull', 'fetch', 'clone', 'submodule', 'clean', 'gc', 'prune', 'filter-branch',
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
  // Keep quoted arguments intact. Besides shell payloads, this matters for
  // ordinary commands such as `git -C "/path with spaces" status`: the path
  // is an option value, not the git subcommand.
  const tokens = tokenizeQuoteAware(segment);
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
    return { category: 'risky', reason: `${actionLabel} targets a path outside the workspace: ${outside}` };
  }
  return { category: 'workspace-write', reason: `${actionLabel} scoped inside the workspace` };
}

function classifyGitSegment(tokens: string[], workspaceRoot: string, cwd: string | null): CategoryResult {
  const args: string[] = [];
  // `git -C <dir>` / `--git-dir` / `--work-tree` retarget the whole command.
  // Anything but inspection against another repository crosses the envelope.
  const retargets: string[] = [];
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === '-C' || token === '--git-dir' || token === '--work-tree') {
      if (tokens[index + 1]) retargets.push(tokens[index + 1]);
    } else if (/^-C.+/.test(token)) {
      retargets.push(token.slice(2));
    } else if (/^--(?:git-dir|work-tree)=/.test(token)) {
      retargets.push(token.slice(token.indexOf('=') + 1));
    }
  }
  const outsideTarget = retargets.find((target) => !isInsideWorkspace(target, workspaceRoot, cwd));
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    // These global git options consume the following token when they are not
    // written as --option=value / -Cpath. The old filter removed `-C` but left
    // its directory behind, then called that directory the subcommand.
    if (token === '-C' || token === '--git-dir' || token === '--work-tree' || token === '--namespace') {
      index += 1;
      continue;
    }
    if (/^-C.+/.test(token) || /^--(?:git-dir|work-tree|namespace)=/.test(token)) continue;
    // Other global switches do not consume a value.
    if (['--no-pager', '--paginate', '-p', '--literal-pathspecs', '--no-literal-pathspecs'].includes(token)) continue;
    args.push(token);
  }
  const sub = args.find((token) => !token.startsWith('-')) ?? '';
  const rest = args.slice(args.indexOf(sub) + 1);

  if (outsideTarget && !(GIT_READ_SUBCOMMANDS.has(sub) && sub !== 'config' && sub !== 'branch' && sub !== 'remote')) {
    return { category: 'risky', reason: `git targets a repository outside the workspace: ${outsideTarget}` };
  }
  if (GIT_RISKY_SUBCOMMANDS.has(sub)) {
    return { category: 'risky', reason: `git ${sub} reaches beyond the local worktree` };
  }
  if (sub === 'worktree') {
    // `git worktree list` (and a bare `git worktree`, which git rejects) is
    // inspection. add/remove/move/lock/unlock/prune/repair mutate other
    // checkouts and stay risky — Grok orchestrators routinely list worktrees
    // during planning, and a deny aborts the entire Grok turn.
    const action = rest.find((token) => !token.startsWith('-')) ?? 'list';
    if (action === 'list') {
      return { category: 'read', reason: 'git worktree list is read-only' };
    }
    return { category: 'risky', reason: `git worktree ${action} reaches beyond the local worktree` };
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
    if (rest.some((token) => token === '--get'
      || token === '--get-all'
      || token === '--get-regexp'
      || token === '--get-urlmatch'
      || token === '--list'
      || token === '-l')) {
      return { category: 'read', reason: 'git config read' };
    }
    // Even without --global/--system, a linked worktree's local config lives
    // in shared git metadata outside the isolated checkout. Treat every config
    // mutation as an envelope crossing instead of guessing its eventual scope.
    return { category: 'risky', reason: 'git config mutation can write outside the isolated worktree' };
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
    // package.json scripts are arbitrary shell programs. Their friendly name
    // does not make them read-only: a build can curl, delete, or rewrite
    // anything, so never let a read-only seat auto-approve one.
    return { category: 'risky', reason: `${head} ${sub} runs an arbitrary project script` };
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

  let tokens = commandTokens(segment);
  // POSIX control-flow is split at `;`/newlines by splitCommandSegments. Strip
  // the structural prefix so the command inside `do <cmd>` / `then <cmd>` is
  // still classified, while loop declarations and closing keywords are inert.
  while (tokens.length > 0 && ['do', 'then', 'else'].includes(tokens[0])) tokens = tokens.slice(1);
  if (tokens.length === 0) return { category: 'read', reason: 'empty command segment' };
  const head = (tokens[0] ?? '').replace(/^.*\//, '').toLowerCase();

  // Unlike `for` declarations, while/until/if/elif headers execute their
  // trailing command as a condition. Classify that command recursively.
  if (['while', 'until', 'if', 'elif'].includes(head)) {
    return tokens.length > 1
      ? classifyCommandSegment(tokens.slice(1).join(' '), workspaceRoot, cwd, depth + 1)
      : { category: 'read', reason: `empty shell ${head} condition` };
  }

  let result: CategoryResult;

  const localTest = classifyLocalTestCommand(head, tokens, workspaceRoot, cwd)
    ?? classifyProjectExecution(head, tokens, workspaceRoot, cwd);
  if (localTest) {
    result = localTest;
  } else if ((head === 'awk' || head === 'gawk' || head === 'nawk')
    && /system\s*\(|\|\s*"|>\s*"|getline|-i\s*inplace/.test(segment)) {
    result = { category: 'risky', reason: `${head} program executes commands or writes files` };
  } else if (head === 'npx' && tokens[1] === '--no-install' && tokens.length > 2) {
    result = isInsideWorkspaceCwd(workspaceRoot, cwd)
      ? classifyCommandSegment(tokens.slice(2).join(' '), workspaceRoot, cwd, depth + 1)
      : { category: 'risky', reason: 'npx --no-install must run inside the worker workspace' };
  } else if (head === 'for' || head === 'case'
    || head === 'done' || head === 'fi' || head === 'esac') {
    // The body/condition is classified as its own segment. These tokens only
    // describe shell control flow and do not mutate state by themselves.
    result = { category: 'read', reason: `shell control-flow keyword "${head}"` };
  } else if (ALWAYS_RISKY_COMMANDS.has(head)) {
    result = { category: 'risky', reason: `"${head}" requires privilege, spawns arbitrary code, or exposes the environment` };
  } else if (head === 'cd') {
    const target = tokens.slice(1).find((token) => !token.startsWith('-')) ?? '.';
    result = target === '-' || !isInsideWorkspace(target, workspaceRoot, cwd)
      ? { category: 'risky', reason: `cd targets a path outside the workspace: ${target}` }
      : { category: 'read', reason: 'cd stays inside the workspace' };
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
    const builds = ['build', 'test', 'run'].includes(sub);
    result = safe && builds
      ? isInsideWorkspaceCwd(workspaceRoot, cwd)
        ? { category: 'workspace-write', reason: `swift ${sub} builds/runs project code in the worker workspace` }
        : { category: 'risky', reason: `swift ${sub} must run inside the worker workspace` }
      : safe
      ? { category: 'read', reason: `swift ${sub} is a local inspection command` }
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
    if (isLocalPackageCheck(head, tokens, workspaceRoot, cwd)) {
      result = { category: 'workspace-write', reason: `${head} ${tokens.slice(1).join(' ')} runs a local package check in the worker workspace` };
    } else {
      result = classifyNodePackageManager(head, tokens, workspaceRoot, cwd, depth);
    }
  } else if (head === 'pip' || head === 'pip3' || head === 'uv') {
    const sub = tokens[1] ?? '';
    result = ['list', 'show', 'freeze', 'check'].includes(sub)
      ? { category: 'read', reason: `${head} ${sub} is informational` }
      : { category: 'risky', reason: `${head} ${sub || '(none)'} can install packages` };
  } else if (head === 'cargo' || head === 'go') {
    const sub = tokens[1] ?? '';
    if (['install', 'get', 'add', 'publish'].includes(sub)) {
      result = { category: 'risky', reason: `${head} ${sub} installs packages` };
    } else if (sub === 'version') {
      result = { category: 'read', reason: `${head} version is informational` };
    } else if (['build', 'test', 'check', 'clippy', 'vet', 'fmt', 'run'].includes(sub)) {
      // Builds write target/ and `run` executes project code: workspace-scoped,
      // never a read (read-only seats must not run them).
      result = isInsideWorkspaceCwd(workspaceRoot, cwd)
        ? { category: 'workspace-write', reason: `${head} ${sub} builds/runs project code in the worker workspace` }
        : { category: 'risky', reason: `${head} ${sub} must run inside the worker workspace` };
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
    if (sensitive) {
      result = { category: 'risky', reason: `"${head}" reads a sensitive path: ${sensitive}` };
    } else if (['node', 'tsx', 'ts-node', 'deno'].includes(head)) {
      const versionOrHelp = tokens.slice(1).every((token) => ['-v', '--version', '-h', '--help'].includes(token));
      result = versionOrHelp
        ? { category: 'read', reason: `"${head}" version/help is read-only` }
        : { category: 'risky', reason: `"${head}" can execute arbitrary code` };
    } else if (head === 'make') {
      result = tokens.slice(1).includes('-n') || tokens.slice(1).includes('--dry-run')
        ? { category: 'read', reason: 'make dry-run is read-only' }
        : { category: 'risky', reason: 'make runs arbitrary project recipes' };
    } else if (head === 'xcodebuild') {
      result = { category: 'risky', reason: 'xcodebuild can write build products and invoke scripts' };
    } else if (head === 'prettier' && tokens.slice(1).some((token) => token === '--write' || token === '-w')) {
      result = { category: 'workspace-write', reason: 'prettier --write mutates project files' };
    } else if (head === 'eslint' && tokens.slice(1).includes('--fix')) {
      result = { category: 'workspace-write', reason: 'eslint --fix mutates project files' };
    } else if (head === 'tsc') {
      result = !tokens.slice(1).includes('--noEmit')
        ? { category: 'workspace-write', reason: 'tsc emits project files' }
        : cwd && isInsideWorkspace('.', workspaceRoot, cwd)
          ? { category: 'read', reason: 'tsc --noEmit is a local read-only typecheck' }
          : { category: 'risky', reason: 'tsc --noEmit must run inside the worker workspace' };
    } else {
      result = { category: 'read', reason: `"${head}" is a read-only local check` };
    }
  } else if (WRITE_COMMANDS.has(head)) {
    const paths = pathLikeArgs(tokens);
    // Bare filenames such as `tee secretfile` are intentionally not treated
    // as path-like by the generic argument extractor. When that happens, the
    // command still inherits its cwd: approve only if that cwd is provably
    // inside the worker workspace.
    result = paths.length > 0
      ? classifyPathSet(paths, workspaceRoot, cwd, `"${head}"`)
      : cwd
        ? classifyPathSet(['.'], workspaceRoot, cwd, `"${head}" cwd`)
        : { category: 'risky', reason: `"${head}" mutates files but supplied no cwd to scope the write` };
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

/**
 * Drop heredoc bodies (`cat > f <<'EOF' … EOF`). The body is data fed to the
 * command's stdin, not shell to execute; classifying each body line as its own
 * command produced denials like "unrecognized command const". The command line
 * itself (and its redirect target) is still classified.
 */
export function stripHeredocBodies(command: string): string {
  if (!command.includes('<<')) return command;
  const lines = command.split('\n');
  const output: string[] = [];
  let pending: Array<{ delimiter: string; stripTabs: boolean }> = [];
  for (const line of lines) {
    if (pending.length > 0) {
      const current = pending[0];
      const candidate = current.stripTabs ? line.replace(/^\t+/, '') : line;
      if (candidate === current.delimiter) pending = pending.slice(1);
      continue;
    }
    output.push(line);
    const pattern = /<<(-?)\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(line)) !== null) {
      if (line[match.index + 2] === '<') continue; // here-string <<<
      pending.push({ delimiter: match[3], stripTabs: match[1] === '-' });
    }
  }
  return output.join('\n');
}

export function classifyCommand(
  command: string,
  workspaceRoot: string,
  cwd: string | null,
  depth = 0,
): CategoryResult {
  command = stripHeredocBodies(command);
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
  const normalizedToolName = normalizeToolKey(toolName);
  const mcpInner = isMcpWrapperTool(toolName) ? unwrapMcpInnerIdentity(input.rawInput) : null;
  const command = input.command
    || mcpInner?.command
    || (toolNameLooksLikeCommandLine(toolName) ? toolName : null);

  let categorized: CategoryResult;
  if (normalizedToolName === 'searchtool') {
    categorized = { category: 'read', reason: 'MCP search_tool is discovery-only' };
  } else if (normalizedToolName === 'usetool') {
    const innerName = mcpInner?.toolName ?? null;
    if (!innerName) {
      categorized = { category: 'risky', reason: 'MCP use_tool with no inner tool identity' };
    } else if (innerMcpLooksLike(innerName, NETWORK_TOOL_KEYWORDS, new Set())) {
      categorized = { category: 'risky', reason: `MCP tool "${innerName}" reaches the network beyond localhost` };
    } else if (innerMcpLooksLike(innerName, WRITE_TOOL_KEYWORDS, INNER_MCP_WRITE_TOKENS)) {
      categorized = paths.length > 0
        ? classifyPathSet(paths, input.workspaceRoot, cwd, `MCP tool "${innerName}"`)
        : { category: 'risky', reason: `MCP tool "${innerName}" mutates files` };
    } else if (innerMcpLooksLike(innerName, EXEC_TOOL_KEYWORDS, new Set())) {
      categorized = command
        ? classifyCommand(command, input.workspaceRoot, cwd)
        : { category: 'risky', reason: `MCP tool "${innerName}" executes a command that could not be extracted` };
    } else if (command) {
      categorized = classifyCommand(command, input.workspaceRoot, cwd);
    } else if (innerMcpLooksLike(innerName, READ_TOOL_KEYWORDS, INNER_MCP_READ_TOKENS)) {
      const sensitive = paths.find((candidate) => isSensitivePath(candidate));
      categorized = sensitive
        ? { category: 'risky', reason: `MCP tool "${innerName}" reads a sensitive path: ${sensitive}` }
        : { category: 'read', reason: `MCP tool "${innerName}" is read-only` };
    } else {
      categorized = { category: 'risky', reason: `unclassifiable MCP tool "${innerName}"` };
    }
  } else if (command) {
    categorized = classifyCommand(command, input.workspaceRoot, cwd);
  } else if (toolNameLooksLike(toolName, NETWORK_TOOL_KEYWORDS)) {
    const url = typeof input.rawInput === 'object' && input.rawInput !== null
      ? asString((input.rawInput as AnyRecord).url)
      : asString(input.rawInput);
    categorized = url && LOCALHOST_PATTERN.test(url)
      ? { category: 'read', reason: 'network tool limited to localhost' }
      : { category: 'risky', reason: `tool "${toolName}" reaches the network beyond localhost` };
  } else if (normalizedToolName === 'codexpermissions') {
    // Codex asks once for a session capability grant. The sandbox/envelope
    // still applies to later execs; denying this grant blocks every explorer
    // bash even when the sandbox is already read-only.
    categorized = { category: 'read', reason: 'Codex session permission grant (sandbox/envelope still apply per command)' };
  } else if (normalizedToolName === 'filechanges' && paths.length === 0 && cwd) {
    // Codex emits a synthetic FileChanges approval after applying a patch. It
    // carries the worktree cwd but no individual paths, so classify that cwd
    // against the host-enforced envelope instead of escalating every patch as
    // an unknown tool.
    categorized = classifyPathSet(['.'], input.workspaceRoot, cwd, 'tool "FileChanges"');
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
