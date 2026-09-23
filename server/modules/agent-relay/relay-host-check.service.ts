import { access, mkdir, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

import spawn from 'cross-spawn';

import { projectsDb } from '@/modules/database/index.js';
import { classifyPermissionRequest } from '@/modules/permissions/index.js';
import { parseShipConfig } from '@/modules/ship/index.js';
import { secretsService } from '@/modules/secrets/index.js';
import { workspaceService } from '@/modules/workspaces/index.js';
import { runGit, type WorkspaceService } from '@/modules/workspaces/index.js';
import { CloudError } from '@/shared/run-events.js';
import { wrapCommandForSandbox } from '@/shared/worker-sandbox.js';
import { hostCheckSandboxSpec, type RelaySandboxSpec } from '@/modules/agent-relay/relay-sandbox.js';

/**
 * CloudCLI's own process environment must never reach project checks: an
 * inherited DATABASE_PATH pointed every test suite at the live Relay
 * database, where a test's queue drain failed real queued jobs.
 */
const HOST_CHECK_ENV_DENYLIST = /^(DATABASE_PATH|CLOUDCLI_|PORT$|HOST$|JWT_SECRET$|SESSION_SECRET$)/;

export function hostCheckEnv(scratchDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!HOST_CHECK_ENV_DENYLIST.test(key)) env[key] = value;
  }
  env.CLOUDCLI_HOST_CHECK = '1';
  // Anything that still opens "the" CloudCLI database gets a throwaway one.
  env.DATABASE_PATH = path.join(scratchDir, 'host-check-auth.db');
  return env;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 15 * 60_000;
const MIN_TIMEOUT_MS = 50;
const MAX_COMMANDS = 20;
const MAX_COMMAND_LENGTH = 2_000;
const MAX_OUTPUT_BYTES = 30_000;
const KILL_GRACE_MS = 1_000;
const SHA_RE = /^[0-9a-f]{40}$/i;

/** Shell syntax is deliberately rejected; checks are always spawned as argv. */
const SHELL_SYNTAX = /[;&|`$<>(){}\\\n\r]/;
const SHELL_WRAPPERS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'cmd', 'powershell', 'pwsh']);
const INTERPRETER_EVAL_FLAGS = new Set(['-e', '--eval', '-c', '--command', '-p', '--print']);
const CHECK_SCRIPT_NAMES = /(?:^|[-_:./])(test|tests|typecheck|types|lint|build|check|verify)(?:$|[-_:./])/i;
const PROJECT_CHECK_SUBCOMMANDS = new Set(['test', 't', 'lint', 'build', 'check', 'typecheck', 'run']);

type ParsedCommand = { file: string; args: string[]; tokens: string[] };

export type RelayHostCheckEvidence = {
  command: string;
  cwd: string;
  testedCommit: string | null;
  exitCode: number | null;
  timedOut: boolean;
  cancelled: boolean;
  capped: boolean;
  output: string;
  stdout: string;
  stderr: string;
  passed: boolean;
  reason?: string;
};

export type RelayHostChecksInput = {
  workspaceId: string;
  commands?: string[];
  timeoutMs?: number;
  signal?: AbortSignal;
};

export type RelayHostChecksResult = {
  workspaceId: string;
  cwd: string;
  testedCommit: string | null;
  evidence: RelayHostCheckEvidence[];
  passed: boolean;
  unavailable: boolean;
  message?: string;
};

type CommandRunResult = {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  cancelled: boolean;
  capped: boolean;
  errorCode?: string;
};

type RelayHostCheckServiceOptions = {
  workspaceService?: Pick<WorkspaceService, 'get' | 'resolveCwd'>;
  getProjectPathById?: (projectId: string) => string | null;
};

function clampTimeout(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.floor(value!)));
}

function redact(value: string): string {
  let redacted = value;
  try {
    redacted = secretsService.redact(value);
  } catch {
    // The deterministic patterns below still redact common credential shapes.
  }
  return redacted
    .replace(/gh[pous]_[A-Za-z0-9_-]{8,}/g, '***REDACTED***')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{4,}/gi, 'Bearer ***REDACTED***');
}

/** Parse only the small argv subset needed by project check commands. */
function parseCommand(command: string): ParsedCommand | null {
  const trimmed = command.trim();
  if (!trimmed || trimmed.length > MAX_COMMAND_LENGTH || SHELL_SYNTAX.test(trimmed)) return null;

  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let started = false;
  for (let index = 0; index < trimmed.length; index += 1) {
    const char = trimmed[index];
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      started = true;
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
  if (quote || tokens.length >= MAX_COMMANDS * 100) return null;
  if (started) tokens.push(current);
  const file = tokens[0] ?? '';
  if (!file || file.startsWith('-') || file.includes('..') || file.includes('/') || file.includes('\\')) return null;
  return { file, args: tokens.slice(1), tokens };
}

function basename(file: string): string {
  return path.basename(file).toLowerCase();
}

/**
 * The shared classifier remains authoritative for ordinary safe commands.
 * The exception is deliberately narrow: package-manager check script names
 * are explicit project checks, while installs and arbitrary scripts remain
 * denied. This preserves the existing safety policy's no-arbitrary-code rule.
 */
function isExplicitProjectCheck(parsed: ParsedCommand): boolean {
  const head = basename(parsed.file);
  if (!['npm', 'pnpm', 'yarn', 'bun'].includes(head)) return false;
  let index = 0;
  while (index < parsed.args.length && parsed.args[index].startsWith('-')) {
    index += 1;
    if (['-C', '--prefix', '--cwd', '--dir', '--filter', '-F'].includes(parsed.args[index - 1] ?? '')) index += 1;
  }
  const subcommand = parsed.args[index] ?? '';
  if (!PROJECT_CHECK_SUBCOMMANDS.has(subcommand)) return false;
  if (subcommand === 'run') {
    const script = parsed.args[index + 1] ?? '';
    return CHECK_SCRIPT_NAMES.test(script);
  }
  return ['test', 't', 'lint', 'build', 'check', 'typecheck'].includes(subcommand);
}

function hasUnsafeInterpreterArgs(parsed: ParsedCommand): boolean {
  const head = basename(parsed.file);
  if (SHELL_WRAPPERS.has(head)) return true;
  if (['node', 'tsx', 'ts-node', 'deno', 'python', 'python3', 'ruby', 'perl'].includes(head)) {
    return parsed.args.some((arg) => INTERPRETER_EVAL_FLAGS.has(arg));
  }
  return false;
}

async function validateCommandPaths(parsed: ParsedCommand, root: string, cwd: string): Promise<string | null> {
  for (let index = 0; index < parsed.args.length; index += 1) {
    const raw = parsed.args[index];
    if (!raw || raw === '--' || raw.startsWith('@')) continue;
    const candidate = raw.includes('=') ? raw.slice(raw.indexOf('=') + 1) : raw;
    if (!candidate || candidate.startsWith('-') || candidate.startsWith('@')) continue;
    if (
      candidate === '..'
      || candidate.startsWith('../')
      || candidate.startsWith('..' + path.sep)
      || candidate.startsWith('~')
      || path.isAbsolute(candidate)
      || candidate.includes('/')
      || candidate.includes('\\')
    ) {
      const canonical = await canonicalPathWithMissingTail(path.resolve(cwd, candidate));
      if (!isInside(root, canonical)) return `command path escapes the isolated workspace: ${candidate}`;
    }
  }
  return null;
}

async function authorizeCommand(command: string, root: string, cwd: string): Promise<{ allowed: boolean; reason?: string }> {
  const parsed = parseCommand(command);
  if (!parsed) return { allowed: false, reason: 'command is not allowed: unsafe argv syntax or invalid executable' };
  if (hasUnsafeInterpreterArgs(parsed)) {
    return { allowed: false, reason: 'shell wrappers and interpreter eval flags are not allowed' };
  }
  const pathError = await validateCommandPaths(parsed, root, cwd);
  if (pathError) return { allowed: false, reason: pathError };

  const policy = classifyPermissionRequest({
    seatKind: 'explorer',
    workspaceRoot: root,
    cwd,
    command,
  });
  if (policy.tier === 'approve') return { allowed: true };
  if (isExplicitProjectCheck(parsed)) return { allowed: true };
  return { allowed: false, reason: `command rejected by host safety policy: ${policy.reason}` };
}

async function canonicalPathWithMissingTail(target: string): Promise<string> {
  let prefix = path.resolve(target);
  const suffix: string[] = [];
  for (;;) {
    try {
      const canonical = await realpath(prefix);
      return path.join(canonical, ...suffix.reverse());
    } catch {
      const parent = path.dirname(prefix);
      if (parent === prefix) return path.resolve(target);
      suffix.push(path.basename(prefix));
      prefix = parent;
    }
  }
}

function isInside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

async function resolveSafeCwd(root: string, configuredCwd?: string): Promise<string> {
  const candidate = path.resolve(root, configuredCwd?.trim() || '.');
  const canonicalRoot = await realpath(root);
  const canonicalCandidate = await canonicalPathWithMissingTail(candidate);
  if (!isInside(canonicalRoot, canonicalCandidate)) {
    throw new CloudError('WORKSPACE_CREATE_FAILED', 'Host check cwd must stay inside the isolated workspace');
  }
  try {
    await access(canonicalCandidate);
  } catch {
    throw new CloudError('WORKSPACE_CREATE_FAILED', `Host check cwd does not exist: ${configuredCwd || '.'}`);
  }
  return canonicalCandidate;
}

async function loadConfiguredCheck(root: string): Promise<{ command: string; cwd?: string } | null> {
  for (const fileName of ['ship.yaml', 'ship.yml', 'ship.json']) {
    try {
      const parsed = parseShipConfig(await readFile(path.join(root, '.cloudcli', fileName), 'utf8')) as {
        test?: { command?: unknown; cwd?: unknown };
      };
      const command = typeof parsed.test?.command === 'string' ? parsed.test.command.trim() : '';
      if (command) {
        return {
          command,
          cwd: typeof parsed.test?.cwd === 'string' ? parsed.test.cwd : undefined,
        };
      }
    } catch {
      // Match integration rehearsal: try each supported config filename.
    }
  }
  try {
    const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')) as {
      scripts?: Record<string, unknown>;
    };
    if (typeof packageJson.scripts?.test === 'string' && packageJson.scripts.test.trim()) return { command: 'npm test' };
    if (typeof packageJson.scripts?.typecheck === 'string' && packageJson.scripts.typecheck.trim()) {
      return { command: 'npm run typecheck' };
    }
  } catch {
    // A project without a package manifest may still have no configured check.
  }
  return null;
}

function runArgv(
  file: string,
  args: string[],
  options: { cwd: string; timeoutMs: number; signal?: AbortSignal; env?: NodeJS.ProcessEnv; sandbox?: RelaySandboxSpec | null },
): Promise<CommandRunResult> {
  return new Promise((resolve) => {
    let child;
    try {
      const launch = wrapCommandForSandbox(file, args, options.sandbox ?? null);
      child = spawn(launch.command, launch.args, {
        cwd: options.cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: options.env ?? hostCheckEnv(path.join(options.cwd, 'tmp', 'cloudcli')),
        shell: false,
        detached: process.platform !== 'win32',
        windowsHide: true,
      });
    } catch (error) {
      resolve({
        code: null,
        stdout: '',
        stderr: error instanceof Error ? error.message : String(error),
        timedOut: false,
        cancelled: false,
        capped: false,
      });
      return;
    }

    let stdout = '';
    let stderr = '';
    let capturedBytes = 0;
    let timedOut = false;
    let cancelled = false;
    let capped = false;
    let errorCode: string | undefined;
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;
    let forceSettleTimer: NodeJS.Timeout | undefined;
    let terminationReason: 'timeout' | 'cancel' | 'cap' | null = null;

    const terminate = (reason: 'timeout' | 'cancel' | 'cap', signal: NodeJS.Signals = 'SIGTERM'): void => {
      if (terminationReason) return;
      terminationReason = reason;
      if (reason === 'timeout') timedOut = true;
      if (reason === 'cancel') cancelled = true;
      if (reason === 'cap') capped = true;
      if (child.pid && process.platform !== 'win32') {
        try {
          process.kill(-child.pid, signal);
        } catch {
          child.kill(signal);
        }
      } else {
        child.kill(signal);
      }
      killTimer = setTimeout(() => {
        try {
          if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
          else child.kill('SIGKILL');
        } catch {
          // The process may have exited between TERM and KILL.
        }
        forceSettleTimer = setTimeout(() => finish(null), KILL_GRACE_MS);
        forceSettleTimer.unref();
      }, KILL_GRACE_MS);
      killTimer.unref();
    };

    const append = (target: 'stdout' | 'stderr', chunk: unknown): void => {
      const buffer = Buffer.from(String(chunk));
      const remaining = MAX_OUTPUT_BYTES - capturedBytes;
      if (remaining <= 0) {
        terminate('cap');
        return;
      }
      const accepted = buffer.subarray(0, remaining).toString();
      capturedBytes += Buffer.byteLength(accepted);
      if (target === 'stdout') stdout += accepted;
      else stderr += accepted;
      if (buffer.byteLength > remaining) terminate('cap');
    };

    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (forceSettleTimer) clearTimeout(forceSettleTimer);
      resolve({
        code: terminationReason ? null : code,
        stdout,
        stderr,
        timedOut,
        cancelled,
        capped,
        ...(errorCode ? { errorCode } : {}),
      });
    };

    const timer = setTimeout(() => terminate('timeout'), options.timeoutMs);
    timer.unref();
    const abort = (): void => terminate('cancel');
    if (options.signal?.aborted) {
      abort();
    } else {
      options.signal?.addEventListener('abort', abort, { once: true });
    }
    child.stdout?.on('data', (chunk) => append('stdout', chunk));
    child.stderr?.on('data', (chunk) => append('stderr', chunk));
    child.on('error', (error: NodeJS.ErrnoException) => {
      errorCode = error.code;
      if (!stderr) stderr = error.message;
      finish(null);
    });
    child.on('close', (code) => finish(code));
  });
}

async function readTestedCommit(root: string, fallback: string | null): Promise<string | null> {
  const result = await runGit(root, ['rev-parse', '--verify', 'HEAD']);
  const commit = result.code === 0 ? result.stdout.trim() : '';
  return SHA_RE.test(commit) ? commit : (fallback && SHA_RE.test(fallback) ? fallback : null);
}

function unavailableResult(workspaceId: string, cwd: string, testedCommit: string | null): RelayHostChecksResult {
  return {
    workspaceId,
    cwd,
    testedCommit,
    evidence: [],
    passed: false,
    unavailable: true,
    message: 'No project test/check command is configured for this workspace',
  };
}

export function createRelayHostCheckService(options: RelayHostCheckServiceOptions = {}) {
  const workspaces = options.workspaceService ?? workspaceService;
  const getProjectPathById = options.getProjectPathById ?? ((projectId: string) => projectsDb.getProjectPathById(projectId));

  const run = async (input: RelayHostChecksInput): Promise<RelayHostChecksResult> => {
    const workspace = workspaces.get(input.workspaceId);
    if (!workspace) throw new CloudError('WORKSPACE_NOT_FOUND', `Workspace not found: ${input.workspaceId}`);
    if (workspace.status === 'discarded' || workspace.status === 'orphan') {
      throw new CloudError('WORKSPACE_NOT_FOUND', `Workspace is not available in status "${workspace.status}"`);
    }

    // Calling the real workspace API is intentional: it re-applies the service's
    // persisted-root policy before any command or git inspection can run.
    const resolvedRoot = workspaces.resolveCwd(input.workspaceId);
    const root = await realpath(resolvedRoot);
    const projectPath = getProjectPathById(workspace.project_id);
    if (!projectPath) throw new CloudError('WORKSPACE_NOT_FOUND', `Project not found: ${workspace.project_id}`);
    const projectRoot = await realpath(projectPath);
    if (root === projectRoot) {
      throw new CloudError('WORKSPACE_CREATE_FAILED', 'Host checks cannot run in the primary checkout');
    }
    const cwd = await resolveSafeCwd(root);
    const testedCommit = await readTestedCommit(root, workspace.head_sha);

    const explicitCommands = Boolean(
      Array.isArray(input.commands)
      && input.commands.some((command) => typeof command === 'string' && Boolean(command.trim())),
    );
    let commands = explicitCommands
      ? input.commands!.filter((command): command is string => typeof command === 'string' && Boolean(command.trim())).slice(0, MAX_COMMANDS)
      : [];
    let configuredCwd: string | undefined;
    if (!explicitCommands) {
      const configured = await loadConfiguredCheck(root);
      if (!configured) return unavailableResult(input.workspaceId, cwd, testedCommit);
      commands = [configured.command];
      configuredCwd = configured.cwd;
    }
    const commandCwd = await resolveSafeCwd(root, configuredCwd);
    const timeoutMs = clampTimeout(input.timeoutMs);
    const sandbox = await hostCheckSandboxSpec({
      worktreeRoot: workspace.root_path,
      cwd: root,
      projectPath: projectRoot,
      branch: workspace.feature_branch || null,
    }).catch(() => null);
    const scratchDir = path.join(root, 'tmp', 'cloudcli');
    await mkdir(scratchDir, { recursive: true }).catch(() => undefined);
    const env = hostCheckEnv(scratchDir);
    const evidence: RelayHostCheckEvidence[] = [];

    for (const command of commands) {
      if (input.signal?.aborted) {
        evidence.push({
          command,
          cwd: commandCwd,
          testedCommit,
          exitCode: null,
          timedOut: false,
          cancelled: true,
          capped: false,
          output: '',
          stdout: '',
          stderr: '',
          passed: false,
          reason: 'host checks cancelled before command execution',
        });
        break;
      }
      const authorization = await authorizeCommand(command, root, commandCwd);
      if (!authorization.allowed) {
        evidence.push({
          command,
          cwd: commandCwd,
          testedCommit,
          exitCode: null,
          timedOut: false,
          cancelled: false,
          capped: false,
          output: '',
          stdout: '',
          stderr: '',
          passed: false,
          reason: authorization.reason,
        });
        continue;
      }
      const parsed = parseCommand(command)!;
      const result = await runArgv(parsed.file, parsed.args, {
        cwd: commandCwd,
        timeoutMs,
        signal: input.signal,
        env,
        sandbox,
      });
      const output = redact([result.stdout, result.stderr].filter(Boolean).join(result.stdout && result.stderr ? '\n' : ''));
      const reason = result.errorCode === 'ENOENT'
        ? 'executable_not_found'
        : result.cancelled
          ? 'cancelled'
          : result.capped
            ? 'output_capped'
            : result.timedOut
              ? `timed_out_after_${timeoutMs}ms`
              : undefined;
      evidence.push({
        command,
        cwd: commandCwd,
        testedCommit,
        exitCode: result.code,
        timedOut: result.timedOut,
        cancelled: result.cancelled,
        capped: result.capped,
        output,
        stdout: redact(result.stdout),
        stderr: redact(result.stderr),
        passed: result.code === 0 && !result.timedOut && !result.cancelled && !result.capped,
        ...(reason ? { reason } : {}),
      });
      if (result.cancelled) break;
    }

    return {
      workspaceId: input.workspaceId,
      cwd: commandCwd,
      testedCommit,
      evidence,
      passed: evidence.length > 0 && evidence.every((item) => item.passed),
      unavailable: false,
    };
  };

  return { runRelayHostChecks: run };
}

const relayHostCheckService = createRelayHostCheckService();

export const runRelayHostChecks = (input: RelayHostChecksInput): Promise<RelayHostChecksResult> =>
  relayHostCheckService.runRelayHostChecks(input);
