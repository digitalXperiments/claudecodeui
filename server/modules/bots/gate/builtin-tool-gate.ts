import os from 'node:os';
import path from 'node:path';
import { realpathSync } from 'node:fs';

import { missionControlDb } from '@/modules/mission-control/index.js';
import { classifyCommand, classifyPermissionRequest, extractPermissionRequestDetails } from '@/modules/permissions/index.js';
import { botGoalsDb } from '@/modules/bots/kernel/bot-goals.repository.js';
import { actionGate, recordGateDenial } from '@/modules/bots/gate/action-gate.service.js';
import type { GateContext, GateRequest, Risk } from '@/modules/bots/gate/gate.types.js';
import { botGateDecisionsDb } from '@/modules/bots/gate/bot-gate-decisions.repository.js';
import { assessFileTool, assessShellCommand, type StrictFinding } from '@/modules/bots/gate/strict-guard.js';

export const BUILTIN_GATE_SERVER = 'builtin';
const GATEWAY_TOOL_PREFIX = 'mcp__cloudcli-tool-gateway__';
const APPROVAL_TIMEOUT_MS = 10 * 60_000;
/** Tools that touch nothing outside the model's own context. */
const HARMLESS_TOOLS = new Set(['TodoWrite']);

export type BuiltinToolDecision = { behavior: 'allow' } | { behavior: 'deny'; message: string };

export interface BuiltinToolGateContext {
  botId: string;
  episodeId?: string;
  runId?: string;
  /** The run's project directory: the only place a worker seat may write without asking. */
  workspaceRoot: string;
  /** The bot's own home directory (`~/.cloudcli/bots/<id>/home`); exempt from the `.cloudcli` denylist. */
  botHome: string;
  /** Pass a function so taint picked up mid-run is seen on the next call. */
  tainted: boolean | (() => boolean);
  /** When given and false after an approval wait, the call is denied ("run ended"). */
  isBound?: () => boolean;
  approvalTimeoutMs?: number;
}

export type BuiltinToolGate = (toolName: string, input: unknown) => Promise<BuiltinToolDecision>;

// ---------------------------------------------------------------------------
// Hard denylist (never loosened by rules, approvals, or bypass)

const PROTECTED_DIRS = ['.claude', '.codex', '.grok', '.cursor', '.config', '.cloudcli'] as const;
const PROTECTED_FILES = ['.claude.json'] as const;
const DB_FILE = /\.(?:db|sqlite3?|db-wal|db-shm)$/i;

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function safeRealpath(target: string): string {
  try {
    return realpathSync(target);
  } catch {
    return target;
  }
}

function homes(): string[] {
  const home = os.homedir();
  return [...new Set([home, safeRealpath(home)])];
}

/** Reason the path is off-limits, or null. Symlinks are resolved when the path exists. */
export function protectedPathReason(rawPath: string, workspaceRoot: string, botHome: string): string | null {
  if (!rawPath) return null;
  let expanded = rawPath.trim();
  if (expanded === '~' || expanded.startsWith('~/')) expanded = path.join(os.homedir(), expanded.slice(1));
  const absolute = path.resolve(workspaceRoot || '/', expanded);
  const candidates = [...new Set([absolute, safeRealpath(absolute)])];
  const botHomes = [...new Set([path.resolve(botHome), safeRealpath(path.resolve(botHome))])];
  for (const candidate of candidates) {
    if (DB_FILE.test(candidate)) return `database files are off-limits (${rawPath})`;
    if (botHomes.some((bh) => isInside(candidate, bh))) continue;
    for (const home of homes()) {
      for (const file of PROTECTED_FILES) {
        if (candidate === path.join(home, file)) return `${file} holds provider credentials (${rawPath})`;
      }
      for (const dir of PROTECTED_DIRS) {
        if (isInside(candidate, path.join(home, dir))) return `~/${dir} is protected (${rawPath})`;
      }
    }
  }
  return null;
}

const LOCAL_HOST = String.raw`(?:127\.\d+\.\d+\.\d+|localhost|0\.0\.0\.0|\[?::1\]?)`;
const COMMAND_RULES: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\bsqlite3?\b/i, reason: 'sqlite access is off-limits' },
  { pattern: /\.(?:db|sqlite3?)\b/i, reason: 'database files are off-limits' },
  { pattern: /\bkeychain\b|\bsecurity\s+(?:-\S+\s+)*\S*(?:password|keychain|certificate|identity|cms|authorization)/i, reason: 'keychain access is off-limits' },
  { pattern: /(?:^|[;&|`(]\s*|\n\s*|\bsudo\s+)printenv\b/, reason: 'environment dumps are off-limits' },
  { pattern: /(?:^|[;&|`(]\s*|\n\s*|\bsudo\s+)env\s*(?:$|[|;&>)`]|-0\b|-i\b)/m, reason: 'environment dumps are off-limits' },
  { pattern: /(?:^|[;&|`(]\s*|\n\s*)(?:export|declare|typeset)\s*(?:-[px]+\s*)?(?:$|[|;&>)`])/m, reason: 'environment dumps are off-limits' },
  { pattern: /\/proc\/[^\s/]*\/environ/, reason: 'reading process environments is off-limits' },
  // `ps eww <pid>` / `ps auxe` / `ps -E` print another process's environment (the server's secrets).
  { pattern: /(?:^|[;&|`(]\s*|\n\s*|\bsudo\s+)ps\s+(?:-[A-Za-z]+(?:\s+\d+)?\s+)*[A-Za-z]*e[A-Za-z]*(?:\s|$)/m, reason: 'reading process environments is off-limits' },
  { pattern: /(?:^|[;&|`(]\s*|\n\s*|\bsudo\s+)ps(?:\s[^\n;|&]*)?\s-[A-Za-z]*E/m, reason: 'reading process environments is off-limits' },
  { pattern: /\bprocess\.env\b|\bos\.environ\b|\bENV\[/, reason: 'reading the process environment is off-limits' },
  // awk/gawk/mawk expose the environment as ENVIRON[]; jq exposes it as `env` / `$ENV`.
  { pattern: /\bENVIRON\b/, reason: 'reading the process environment is off-limits' },
  { pattern: /\bjq\b[^\n;|&]*(?:\$ENV\b|\benv\b)/, reason: 'reading the process environment is off-limits' },
  {
    pattern: new RegExp(String.raw`\b(?:curl|wget|nc|ncat|netcat|socat|http|https|xh)\b[^\n;|&]*${LOCAL_HOST}`, 'i'),
    reason: 'the CloudCLI API on localhost is off-limits',
  },
  { pattern: new RegExp(String.raw`/dev/tcp/${LOCAL_HOST}`, 'i'), reason: 'the CloudCLI API on localhost is off-limits' },
  { pattern: /\b(?:npx|uvx|bunx|pipx\s+run|pnpm\s+dlx|npm\s+exec|yarn\s+dlx)\b[^\n;|&]*(?:mcp|modelcontextprotocol)/i, reason: 'launching MCP servers is off-limits' },
  { pattern: /\b(?:claude|codex|grok|cursor-agent|opencode)\s+mcp\b/i, reason: 'managing MCP servers is off-limits' },
];

/** Reason a shell command is off-limits, or null. `botHome` references are not counted as protected. */
export function protectedCommandReason(command: string, botHome: string): string | null {
  for (const rule of COMMAND_RULES) {
    if (rule.pattern.test(command)) return rule.reason;
  }
  let scrubbed = command;
  const botHomeForms = [...new Set([botHome, safeRealpath(botHome), botHome.replace(os.homedir(), '~'), botHome.replace(os.homedir(), '$HOME')])];
  for (const form of botHomeForms) {
    if (!form) continue;
    if (command.includes(`${form}/..`)) return 'path traversal out of the bot home is off-limits';
    scrubbed = scrubbed.split(form).join('<bot-home>');
  }
  for (const home of homes()) {
    const variants = [home, '~', '$HOME', '${HOME}'];
    for (const base of variants) {
      for (const file of PROTECTED_FILES) {
        if (scrubbed.includes(`${base}/${file}`)) return `${file} holds provider credentials`;
      }
      for (const dir of PROTECTED_DIRS) {
        if (scrubbed.includes(`${base}/${dir}`)) return `~/${dir} is protected`;
      }
    }
  }
  // Bare relative spellings (cd ~ && cat .claude.json) are caught by the dotfile names themselves.
  if (/(?:^|[\s/='"])\.claude\.json\b/.test(scrubbed)) return '.claude.json holds provider credentials';
  return null;
}

function collectPaths(input: Record<string, unknown>, details: { paths: string[] }): string[] {
  const paths = [...details.paths];
  for (const key of ['pattern', 'glob', 'directory', 'dir', 'cwd']) {
    const value = input[key];
    if (typeof value === 'string' && value.trim() && /^(?:~|\/|\.\.)/.test(value.trim())) paths.push(value);
  }
  return paths;
}

/**
 * Strict (gateway-bound run) findings: credential stores in any spelling, protected env vars, and
 * anything that cannot be shown to stay inside the workspace / bot home / temp. See strict-guard.ts.
 * This gate only ever serves gateway-bound bot runs, so none of it reaches interactive sessions.
 */
function assessStrictCall(
  toolName: string,
  record: Record<string, unknown>,
  details: { command: string | null; paths: string[] },
  scope: { workspaceRoot: string; botHome: string },
): StrictFinding {
  const cwd = typeof record.cwd === 'string' && record.cwd.trim() ? record.cwd : null;
  const findings: StrictFinding[] = [];
  if (details.command) findings.push(assessShellCommand(details.command, { ...scope, cwd }));
  findings.push(assessFileTool(toolName, record, details.paths, scope));
  return {
    deny: findings.find((finding) => finding.deny)?.deny ?? null,
    escalate: findings.find((finding) => finding.escalate)?.escalate ?? null,
  };
}

function recordOf(input: unknown): Record<string, unknown> {
  return input && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
}

/** Hard denylist for a built-in tool call; returns the reason, or null when nothing matches. */
export function builtinDenylistReason(
  toolName: string,
  input: unknown,
  scope: { workspaceRoot: string; botHome: string },
): string | null {
  const record = recordOf(input);
  const details = extractPermissionRequestDetails({ toolName, input });
  for (const candidate of collectPaths(record, details)) {
    const reason = protectedPathReason(candidate, scope.workspaceRoot, scope.botHome);
    if (reason) return reason;
  }
  if (details.command) {
    const reason = protectedCommandReason(details.command, scope.botHome);
    if (reason) return reason;
  }
  const url = typeof record.url === 'string' ? record.url : '';
  if (url && new RegExp(LOCAL_HOST, 'i').test(url)) return 'the CloudCLI API on localhost is off-limits';
  return assessStrictCall(toolName, record, details, scope).deny;
}

/**
 * Reason a gateway-bound call must be decided by a human even though the classifier would approve
 * it (reads outside the workspace, shell paths that cannot be proven local, other `$VAR`s ...), or
 * null. Evaluated after `builtinDenylistReason` found nothing to hard-deny.
 */
export function builtinEscalationReason(
  toolName: string,
  input: unknown,
  scope: { workspaceRoot: string; botHome: string },
): string | null {
  const record = recordOf(input);
  const details = extractPermissionRequestDetails({ toolName, input });
  return assessStrictCall(toolName, record, details, scope).escalate;
}

// ---------------------------------------------------------------------------

function mapRisk(toolName: string, reason: string): Risk {
  const lowered = toolName.toLowerCase();
  if (/webfetch|websearch|fetch|http|browser|download/.test(lowered)) return 'send';
  if (/sensitive path/.test(reason)) return 'credential';
  return 'prod_change';
}

function buildGateContext(ctx: BuiltinToolGateContext, tainted: boolean): GateContext {
  let operatorInstructions = '';
  let goals: string[] = [];
  try {
    operatorInstructions = missionControlDb.getSection(ctx.botId)?.produce_prompt ?? '';
  } catch {
    // Best effort; the request itself is still gated.
  }
  try {
    goals = botGoalsDb.list(ctx.botId, 'active').map((goal) => goal.statement);
  } catch {
    // A missing goals table must not open the gate.
  }
  return { botId: ctx.botId, episodeId: ctx.episodeId, runId: ctx.runId, tainted, operatorInstructions, goals };
}

function allInside(paths: string[], root: string, workspaceRoot: string): boolean {
  if (paths.length === 0) return false;
  const resolvedRoot = path.resolve(root);
  return paths.every((entry) => {
    const expanded = entry === '~' || entry.startsWith('~/') ? path.join(os.homedir(), entry.slice(1)) : entry;
    return isInside(path.resolve(workspaceRoot, expanded), resolvedRoot);
  });
}

/**
 * Gate for Claude's built-in tools (Bash, Read, Write, Edit, WebFetch ...) on a gateway-bound run.
 * Order: MCP/gateway pass-through, hard denylist, seat classification (worker seat), then the
 * Action Gate for anything the classifier escalates.
 */
export function createBuiltinToolGate(ctx: BuiltinToolGateContext): BuiltinToolGate {
  const isTainted = () => (typeof ctx.tainted === 'function' ? ctx.tainted() : ctx.tainted);
  const deny = (message: string): BuiltinToolDecision => ({ behavior: 'deny', message });

  return async (toolName, input) => {
    if (toolName.startsWith(GATEWAY_TOOL_PREFIX)) return { behavior: 'allow' };
    if (toolName.startsWith('mcp__')) {
      return deny('MCP tools must go through the tool gateway (cloudcli-tool-gateway).');
    }
    if (HARMLESS_TOOLS.has(toolName)) return { behavior: 'allow' };

    const args = input && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
    const gateRequest: GateRequest = { server: BUILTIN_GATE_SERVER, tool: toolName, args };
    const tainted = isTainted();
    const gateCtx = buildGateContext(ctx, tainted);

    const denied = builtinDenylistReason(toolName, input, ctx);
    if (denied) {
      recordGateDenial(gateCtx, gateRequest, 'credential', 'denylist', `Built-in tool denylist: ${denied}`);
      return deny(`Blocked: ${denied}.`);
    }

    const details = extractPermissionRequestDetails({ toolName, input });
    const classification = classifyPermissionRequest({
      seatKind: 'worker',
      workspaceRoot: ctx.workspaceRoot,
      toolName,
      command: details.command,
      paths: details.paths,
      cwd: ctx.workspaceRoot,
      rawInput: input,
    });

    if (classification.tier === 'deny') return deny(classification.reason);

    // The classifier alone would approve reads anywhere and shell paths it cannot see through.
    // A gateway-bound run adds: strict path/shell findings, and no unattended mutation once tainted.
    let escalationReason: string | null = null;
    let fromClassifier = false;
    const strictEscalation = builtinEscalationReason(toolName, input, ctx);
    if (classification.tier === 'escalate') {
      escalationReason = classification.reason;
      fromClassifier = true;
    } else if (strictEscalation) {
      escalationReason = `Gateway-bound run: ${strictEscalation}`;
    } else if (tainted && details.command && classifyCommand(details.command, ctx.workspaceRoot, ctx.workspaceRoot).category !== 'read') {
      escalationReason = 'The run read untrusted content; only pure reads inside the workspace and bot home run without a human';
    }
    if (!escalationReason) return { behavior: 'allow' };

    // Escalated by the classifier alone. File tools confined to the bot's own home are fine.
    if (fromClassifier && !strictEscalation && !details.command && allInside(details.paths, ctx.botHome, ctx.workspaceRoot)) {
      return { behavior: 'allow' };
    }

    const risk = mapRisk(toolName, escalationReason);
    const verdict = await actionGate.evaluate(gateCtx, { ...gateRequest, riskOverride: risk, description: escalationReason });
    if (verdict.decision === 'deny') return deny(`Blocked by the action gate (${verdict.risk}): ${verdict.reason}`);
    if (verdict.decision === 'ask') {
      const answer = await actionGate.awaitHuman(verdict.decisionId, { timeoutMs: ctx.approvalTimeoutMs ?? APPROVAL_TIMEOUT_MS });
      if (answer === 'rejected') return deny(`The operator rejected this call (${verdict.risk}).`);
      if (answer === 'expired') return deny('No operator decision before the approval expired; the call was not made.');
      if (ctx.isBound && !ctx.isBound()) {
        actionGate.recordOutcome(verdict.decisionId, 'expired');
        return deny('The run ended before the approval arrived; the call was not made.');
      }
    }
    botGateDecisionsDb.recordOutcome(verdict.decisionId, 'executed');
    return { behavior: 'allow' };
  };
}
