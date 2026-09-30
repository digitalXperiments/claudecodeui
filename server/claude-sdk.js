/**
 * Claude SDK Integration
 *
 * This module provides SDK-based integration with Claude using the @anthropic-ai/claude-agent-sdk.
 * It mirrors the interface of claude-cli.js but uses the SDK internally for better performance
 * and maintainability.
 *
 * Key features:
 * - Direct SDK integration without child processes
 * - Session management with abort capability
 * - Options mapping between CLI and SDK formats
 * - WebSocket message streaming
 */

import crypto from 'crypto';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

import { query } from '@anthropic-ai/claude-agent-sdk';

import { buildClaudeUserContent, normalizeImageDescriptors } from './shared/image-attachments.js';
import { CLAUDE_FALLBACK_MODELS } from './modules/providers/list/claude/claude-models.provider.js';
import { providerModelsService } from './modules/providers/services/provider-models.service.js';
import { resolveClaudeCodeExecutablePath } from './shared/claude-cli-path.js';
import { applyClaudeSpawnAuthEnv, invalidateClaudeSpawnAuthEnvCache } from './shared/claude-spawn-auth-env.js';
import {
  createNotificationEvent,
  notifyRunFailed,
  notifyRunStopped,
  notifyUserIfEnabled
} from './services/notification-orchestrator.js';
import { sessionsService } from './modules/providers/services/sessions.service.js';
import { getMemoryPreamble } from './modules/providers/services/project-memory.service.js';

import { providerAuthService } from './modules/providers/services/provider-auth.service.js';
import { obsidianSettingsService } from './modules/providers/services/obsidian-settings.service.js';
import {
  buildObsidianMcpServerInput,
  OBSIDIAN_MCP_SERVER_NAME,
} from './modules/providers/shared/memory/obsidian-mcp.config.js';
import { createCompleteMessage, createNormalizedMessage } from './shared/utils.js';
import { TOOLS_REQUIRING_INTERACTION } from './shared/interactive-tools.js';
import { claudeSdkSandboxSettings, workerGitGuardEnv } from './shared/worker-sandbox.js';
import { filterMcpServersForRun } from './shared/mcp-server-filter.js';
import { buildClaudeTokenBudgetFromUsage } from './modules/providers/list/claude/claude-token-usage.js';

const activeSessions = new Map();
const pendingToolApprovals = new Map();
// Sessions cancelled via abort-session. The abort handler already sent the
// terminal `complete` (aborted: true) to the client, so the run loop must not
// emit a second one when its generator winds down.
const abortedSessionIds = new Set();

function consumeAbortedFlag(...ids) {
  let aborted = false;
  for (const id of ids) {
    if (id && abortedSessionIds.delete(id)) {
      aborted = true;
    }
  }
  return aborted;
}

function dropSessionKeys(...ids) {
  for (const id of ids) {
    if (id) {
      removeSession(id);
    }
  }
}
// app session id -> provider session id (chat mid-run inject addressing).
const appSessionAliases = new Map();
// app session id -> SDKUserMessage[] buffered before provider id is known.
const pendingInjections = new Map();
// After a successful `result`, wait this long for a late inject before ending
// the run: the process then either parks in the warm pool (see "Warm Claude
// sessions" below) or has its stdin closed so it exits. Chat runs only
// (appSessionId set).
const RUN_DRAIN_GRACE_MS = 750;

function readDrainGraceMs() {
  const raw = process.env.CLOUDCLI_CLAUDE_DRAIN_GRACE_MS;
  if (raw === undefined || raw === '') {
    return RUN_DRAIN_GRACE_MS;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : RUN_DRAIN_GRACE_MS;
}

// Default for non-interactive / automated callers. Chat UI paths should pass
// timeoutMs: 0 (wait indefinitely) so users are not cancelled mid-approval.
// Override with CLAUDE_TOOL_APPROVAL_TIMEOUT_MS if needed (0 = never timeout).
const TOOL_APPROVAL_TIMEOUT_MS = (() => {
  const raw = process.env.CLAUDE_TOOL_APPROVAL_TIMEOUT_MS;
  if (raw === undefined || raw === '') {
    // No short default for chat: waiting on a human is expected. Automation
    // that needs a deadline can set CLAUDE_TOOL_APPROVAL_TIMEOUT_MS explicitly.
    return 0;
  }
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : 0;
})();

// Unattended (headless/swarm) runs must never wait forever on an approval:
// the swarm permission broker listens for the normalized `permission_request`
// event and answers via resolveToolApproval, but if nothing answers within
// this budget the wait expires and the request is denied (the provider's
// normal deny path), instead of hanging until an outer step timeout.
const DEFAULT_UNATTENDED_APPROVAL_TIMEOUT_MS = 10 * 60_000;

// Approval wait budget for a run. Interactive chat keeps timeoutMs 0 (wait
// indefinitely for the human); unattended runs get a bounded window resolved
// from, in order: options.approvalTimeoutMs, the
// CLOUDCLI_UNATTENDED_APPROVAL_TIMEOUT_MS env var, then the 10-minute default.
// Non-positive/unparseable values fall through to the next source so a
// misconfigured 0 can never reintroduce an infinite headless wait.
function resolveApprovalTimeoutMs({ unattended = false, approvalTimeoutMs } = {}) {
  if (!unattended) {
    return 0;
  }
  const explicit = Number(approvalTimeoutMs);
  if (Number.isFinite(explicit) && explicit > 0) {
    return explicit;
  }
  const fromEnv = Number(process.env.CLOUDCLI_UNATTENDED_APPROVAL_TIMEOUT_MS);
  if (Number.isFinite(fromEnv) && fromEnv > 0) {
    return fromEnv;
  }
  return DEFAULT_UNATTENDED_APPROVAL_TIMEOUT_MS;
}

// Best-effort extraction of file paths from a tool input so the permission
// broker's policy engine can classify a `permission_request` without
// provider-specific knowledge of every input shape. Unknown shapes simply
// yield an empty list.
function extractPermissionPaths(input) {
  if (!input || typeof input !== 'object') {
    return [];
  }
  const paths = [];
  const pushPath = (value) => {
    if (typeof value === 'string' && value.trim()) {
      paths.push(value);
    }
  };
  for (const key of ['file_path', 'filePath', 'path', 'notebook_path']) {
    pushPath(input[key]);
  }
  for (const key of ['paths', 'files', 'file_paths']) {
    if (Array.isArray(input[key])) {
      input[key].forEach(pushPath);
    }
  }
  // Codex applyPatchApproval shape: { changes: { "/abs/path": {...}, ... } }
  if (input.changes && typeof input.changes === 'object' && !Array.isArray(input.changes)) {
    Object.keys(input.changes).forEach(pushPath);
  }
  return paths;
}

function resolveClaudeEffort(model, effort, modelsDefinition = CLAUDE_FALLBACK_MODELS) {
  const selectedModel = modelsDefinition?.OPTIONS?.find((option) => option.value === model) || null;
  const allowedEfforts = selectedModel?.effort?.values
    ?.map((value) => value.value) || [];
  return typeof effort === 'string' && effort !== 'default' && allowedEfforts.includes(effort)
    ? effort
    : undefined;
}

function createRequestId() {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return crypto.randomBytes(16).toString('hex');
}

function waitForToolApproval(requestId, options = {}) {
  const { timeoutMs = TOOL_APPROVAL_TIMEOUT_MS, signal, onCancel, metadata } = options;

  return new Promise(resolve => {
    let settled = false;

    const finalize = (decision) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(decision);
    };

    let timeout;

    const cleanup = () => {
      pendingToolApprovals.delete(requestId);
      if (timeout) clearTimeout(timeout);
      if (signal && abortHandler) {
        signal.removeEventListener('abort', abortHandler);
      }
    };

    // timeoutMs 0 = wait indefinitely (interactive tools)
    if (timeoutMs > 0) {
      timeout = setTimeout(() => {
        onCancel?.('timeout');
        finalize(null);
      }, timeoutMs);
    }

    const abortHandler = () => {
      onCancel?.('cancelled');
      finalize({ cancelled: true });
    };

    if (signal) {
      if (signal.aborted) {
        onCancel?.('cancelled');
        finalize({ cancelled: true });
        return;
      }
      signal.addEventListener('abort', abortHandler, { once: true });
    }

    const resolver = (decision) => {
      finalize(decision);
    };
    // Attach metadata for getPendingApprovalsForSession lookup
    if (metadata) {
      Object.assign(resolver, metadata);
    }
    pendingToolApprovals.set(requestId, resolver);
  });
}

export async function updateClaudePermissionMode(sessionId, mode, appSessionId) {
  const entry = activeSessions.get(appSessionId) || activeSessions.get(sessionId);
  const live = [...liveSessions].find((item) => !item.closed &&
    ((appSessionId && item.appSessionId === appSessionId) || item.providerSessionId === sessionId));
  const instance = entry?.instance || live?.queryInstance;
  const sdkOptions = entry?.sdkOptions || live?.sdkOptions;
  if (!instance?.setPermissionMode || !sdkOptions) return false;
  // A run under the bot built-in tool gate must keep consulting canUseTool.
  if (builtinToolGates.has(sdkOptions) && mode !== 'default') return false;
  await instance.setPermissionMode(mode);
  sdkOptions.permissionMode = mode;
  if (mode === 'bypassPermissions') {
    const ids = new Set([sessionId, appSessionId, live?.providerSessionId].filter(Boolean));
    for (const [requestId, resolver] of pendingToolApprovals) {
      if (!ids.has(resolver._sessionId) || TOOLS_REQUIRING_INTERACTION.has(resolver._toolName)) continue;
      if ((sdkOptions.disallowedTools || []).some((rule) => matchesToolPermission(rule, resolver._toolName, resolver._input))) continue;
      resolver({ allow: true });
      (entry?.writer || live?.turn?.ws)?.send(createNormalizedMessage({
        kind: 'permission_cancelled', requestId, reason: 'permission_mode_changed',
        sessionId: resolver._sessionId, provider: 'claude',
      }));
    }
  }
  return true;
}

function resolveToolApproval(requestId, decision) {
  const resolver = pendingToolApprovals.get(requestId);
  if (resolver) {
    resolver(decision);
  }
}

// Match stored permission entries against a tool + input combo.
// This only supports exact tool names and the Bash(command:*) shorthand
// used by the UI; it intentionally does not implement full glob semantics,
// introduced to stay consistent with the UI's "Allow rule" format.
function matchesToolPermission(entry, toolName, input) {
  if (!entry || !toolName) {
    return false;
  }

  if (entry === toolName) {
    return true;
  }

  const bashMatch = entry.match(/^Bash\((.+):\*\)$/);
  if (toolName === 'Bash' && bashMatch) {
    const allowedPrefix = bashMatch[1];
    let command = '';

    if (typeof input === 'string') {
      command = input.trim();
    } else if (input && typeof input === 'object' && typeof input.command === 'string') {
      command = input.command.trim();
    }

    if (!command) {
      return false;
    }

    return command.startsWith(allowedPrefix);
  }

  return false;
}

const PLAN_MODE_TOOLS = ['Read', 'Task', 'exit_plan_mode', 'TodoRead', 'TodoWrite', 'WebFetch', 'WebSearch'];

/**
 * Plan mode injects inspect tools so Claude can explore without writes.
 * Relay scouts (and any run that already disallows Task) must not get Task
 * re-injected — nested Task/Agent would fan out outside Relay ownership.
 */
function applyPlanModeAllowedTools(allowedTools, { relayWorker = false, disallowedTools = [] } = {}) {
  const next = [...allowedTools];
  const disallowed = new Set(disallowedTools);
  const skipTask = Boolean(relayWorker) || disallowed.has('Task');
  for (const tool of PLAN_MODE_TOOLS) {
    if (tool === 'Task' && skipTask) continue;
    if (!next.includes(tool)) next.push(tool);
  }
  return next;
}

function mapCliOptionsToSDK(options = {}) {
  const { sessionId, cwd, toolsSettings, permissionMode, effort, appSessionId, projectPath, relayWorker } = options;

  const sdkOptions = {};

  // Forward all host env vars (e.g. ANTHROPIC_BASE_URL) to the subprocess.
  // Since SDK 0.2.113, options.env replaces process.env instead of overlaying it.
  sdkOptions.env = { ...process.env };

  // Peer mailbox identity: the Claude Code CLI subprocess inherits these when
  // it spawns its own configured MCP servers (including cloudcli-session-mailbox),
  // so that server can identify which app session is calling it.
  if (appSessionId) {
    sdkOptions.env.CLOUDCLI_SESSION_ID = appSessionId;
    sdkOptions.env.CLOUDCLI_PROVIDER = 'claude';
    if (cwd || projectPath) {
      sdkOptions.env.CLOUDCLI_PROJECT_PATH = cwd || projectPath;
    }
  }

  // Resolve the executable eagerly on Windows because the SDK uses raw child_process.spawn,
  // which does not reliably follow npm's shell wrappers like cross-spawn does.
  sdkOptions.pathToClaudeCodeExecutable = resolveClaudeCodeExecutablePath(process.env.CLAUDE_CLI_PATH);

  if (cwd) {
    sdkOptions.cwd = cwd;
  }

  if (permissionMode && permissionMode !== 'default') {
    sdkOptions.permissionMode = permissionMode;
  }

  const settings = toolsSettings || {
    allowedTools: [],
    disallowedTools: [],
    skipPermissions: false
  };

  if (settings.skipPermissions && permissionMode !== 'plan') {
    sdkOptions.permissionMode = 'bypassPermissions';
  }

  // Enable the SDK's live switch into bypass for interactive chat. This does
  // not activate bypass; the selected permissionMode still governs the turn.
  if (appSessionId && !relayWorker) {
    sdkOptions.allowDangerouslySkipPermissions = true;
  }

  let allowedTools = [...(settings.allowedTools || [])];

  if (permissionMode === 'plan') {
    allowedTools = applyPlanModeAllowedTools(allowedTools, {
      relayWorker: Boolean(options.relayWorker),
      disallowedTools: settings.disallowedTools || [],
    });
  }

  sdkOptions.allowedTools = allowedTools;

  // Use the tools preset to make all default built-in tools available (including AskUserQuestion).
  // This was introduced in SDK 0.1.57. Omitting this preserves existing behavior (all tools available),
  // but being explicit ensures forward compatibility and clarity.
  sdkOptions.tools = { type: 'preset', preset: 'claude_code' };

  sdkOptions.disallowedTools = settings.disallowedTools || [];

  sdkOptions.model = options.model || CLAUDE_FALLBACK_MODELS.DEFAULT;

  const resolvedEffort = resolveClaudeEffort(
    sdkOptions.model,
    effort,
    options.effortModels || CLAUDE_FALLBACK_MODELS,
  );
  if (resolvedEffort) {
    sdkOptions.effort = resolvedEffort;
  }

  sdkOptions.systemPrompt = {
    type: 'preset',
    preset: 'claude_code'
  };

  // App-level memory bookend: when the workspace has Obsidian memory enabled,
  // instruct the agent to read context first and record proceedings at the end.
  // Best-effort — a lookup failure must never block a run.
  try {
    const memoryPreamble = getMemoryPreamble(cwd);
    if (memoryPreamble) {
      sdkOptions.systemPrompt.append = memoryPreamble;
    }
  } catch {
    // Ignore memory preamble failures.
  }

  // Relay workers must run the model the lead requested. Loading the
  // operator's project/user/local Claude settings here lets their pinned
  // default model (and other machine-local overrides) silently win over an
  // explicit relay job model, so relay workers get none of those sources.
  sdkOptions.settingSources = relayWorker ? [] : ['project', 'user', 'local'];

  // Relay workers run inside the SDK's OS sandbox: Bash is confined to the
  // worktree (plus its branch's git state) and auto-allowed, so routine
  // commands never reach the relay broker; only file-tool writes (checked by
  // path) and genuine boundary crossings do.
  const relaySandbox = relayWorker ? claudeSdkSandboxSettings(options.relaySandbox) : null;
  if (relaySandbox) {
    sdkOptions.sandbox = relaySandbox;
  }
  if (relayWorker) {
    // No worker push can reach a remote, sandbox or not.
    Object.assign(sdkOptions.env, workerGitGuardEnv(sdkOptions.env));
  }

  if (sessionId) {
    sdkOptions.resume = sessionId;
  }

  return sdkOptions;
}

/**
 * Adds a session to the active sessions map
 * @param {string} sessionId - Session identifier
 * @param {Object} queryInstance - SDK query instance
 * @param {Object} writer - WebSocket writer for reconnect support
 * @param {Object} [extras]
 * @param {Object|null} [extras.channel] - Open input channel (chat inject mode)
 * @param {string|null} [extras.appSessionId]
 * @param {Promise|null} [extras.donePromise]
 */
function addSession(sessionId, queryInstance, writer = null, extras = {}) {
  activeSessions.set(sessionId, {
    instance: queryInstance,
    sdkOptions: extras.sdkOptions || null,
    startTime: Date.now(),
    status: 'active',
    writer,
    channel: extras.channel || null,
    appSessionId: extras.appSessionId || null,
    donePromise: extras.donePromise || null,
  });
}

/**
 * Removes a session from the active sessions map
 * @param {string} sessionId - Session identifier
 */
function removeSession(sessionId) {
  activeSessions.delete(sessionId);
}

/**
 * Records app → provider session alias and flushes any buffered injects.
 * @param {string} appSessionId
 * @param {string} providerSessionId
 * @param {Object} channel
 */
function registerAppSessionAlias(appSessionId, providerSessionId, channel) {
  if (!appSessionId || !providerSessionId || !channel) {
    return;
  }
  appSessionAliases.set(appSessionId, providerSessionId);
  const buffered = pendingInjections.get(appSessionId);
  if (buffered && buffered.length > 0) {
    pendingInjections.delete(appSessionId);
    for (const message of buffered) {
      channel.push(message);
    }
  }
}

/**
 * Push-based input channel for streaming-input mode (chat mid-run inject).
 * Generator stays open until `end()` so follow-up user messages can be pushed.
 */
function createInputChannel() {
  const queue = [];
  let parked = null;
  let ended = false;

  const channel = {
    get ended() {
      return ended;
    },
    push(message) {
      if (ended) {
        return false;
      }
      if (parked) {
        const resolve = parked;
        parked = null;
        resolve({ value: message, done: false });
      } else {
        queue.push(message);
      }
      return true;
    },
    end() {
      if (ended) {
        return;
      }
      ended = true;
      if (parked) {
        const resolve = parked;
        parked = null;
        resolve({ value: undefined, done: true });
      }
    },
    iterator: (async function* () {
      while (true) {
        if (queue.length > 0) {
          yield queue.shift();
          continue;
        }
        if (ended) {
          return;
        }
        const result = await new Promise((resolve) => {
          parked = resolve;
        });
        if (result.done) {
          return;
        }
        yield result.value;
      }
    })(),
  };

  return channel;
}

/**
 * Gets a session from the active sessions map
 * @param {string} sessionId - Session identifier
 * @returns {Object|undefined} Session data or undefined
 */
function getSession(sessionId) {
  return activeSessions.get(sessionId);
}

/**
 * Gets all active session IDs
 * @returns {Array<string>} Array of active session IDs
 */
function getAllSessions() {
  return Array.from(activeSessions.keys());
}

/**
 * Transforms SDK messages to WebSocket format expected by frontend
 * @param {Object} sdkMessage - SDK message object
 * @returns {Object} Transformed message ready for WebSocket
 */
function transformMessage(sdkMessage) {
  // Extract parent_tool_use_id for subagent tool grouping
  if (sdkMessage.parent_tool_use_id) {
    return {
      ...sdkMessage,
      parentToolUseId: sdkMessage.parent_tool_use_id
    };
  }
  return sdkMessage;
}

function readNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Extracts token usage from SDK messages.
 * Prefers per-step `message.usage` (Claude message payload), then falls back
 * to result-level usage/modelUsage for compatibility across SDK versions.
 * Exposes contextUsed (latest input+cache = context fill) separately from
 * cumulative spend fields so the badge matches context occupancy.
 * @param {Object} sdkMessage - SDK stream message
 * @returns {Object|null} Token budget object or null
 */
function extractTokenBudget(sdkMessage) {
  if (!sdkMessage || typeof sdkMessage !== 'object') {
    return null;
  }

  // Result messages carry a run-level aggregate. The stream has already
  // emitted one usage snapshot for each assistant API response, so treating
  // this aggregate as one more response double-counts a large portion of the
  // run (the production inflation was consistently ~1.5x on long runs).
  // Completed runs are reconciled from Claude's authoritative JSONL by the
  // runs maintenance path, which also captures work not forwarded live.
  if (sdkMessage.type === 'result') {
    return null;
  }

  const messageUsage = sdkMessage.message?.usage || sdkMessage.usage;
  const model =
    (typeof sdkMessage.message?.model === 'string' && sdkMessage.message.model) ||
    (typeof sdkMessage.model === 'string' && sdkMessage.model) ||
    null;

  if (messageUsage && typeof messageUsage === 'object') {
    return buildClaudeTokenBudgetFromUsage(messageUsage, model);
  }

  if (!sdkMessage.modelUsage || typeof sdkMessage.modelUsage !== 'object') {
    return null;
  }

  // Fallback for older SDK messages with only modelUsage — prefer non-cumulative
  // fields when present so we do not treat lifetime totals as context fill.
  const modelKey = Object.keys(sdkMessage.modelUsage)[0];
  const modelData = sdkMessage.modelUsage[modelKey];

  if (!modelData || typeof modelData !== 'object') {
    return null;
  }

  const inputTokens = readNumber(modelData.inputTokens ?? modelData.cumulativeInputTokens);
  const outputTokens = readNumber(modelData.outputTokens ?? modelData.cumulativeOutputTokens);
  return buildClaudeTokenBudgetFromUsage(
    {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
    },
    modelKey || model,
  );
}

/**
 * Builds one SDKUserMessage (text + optional image blocks).
 * @param {string} command
 * @param {Array} images
 * @param {string} cwd
 * @returns {Promise<Object>}
 */
async function buildSDKUserMessage(command, images, cwd) {
  const content = await buildClaudeUserContent(command, images, cwd);
  return {
    type: 'user',
    message: {
      role: 'user',
      content
    },
    parent_tool_use_id: null,
    timestamp: new Date().toISOString()
  };
}

/**
 * Builds the SDK `prompt` payload for one turn (non-inject / headless path).
 *
 * Plain text turns pass the string through unchanged. Turns with image
 * attachments use a one-shot streaming generator that closes after the first
 * message — same as the proven pre-inject behaviour.
 *
 * @param {string} command - User prompt
 * @param {Array} images - Image descriptors ({ path, name?, mimeType? })
 * @param {string} cwd - Project working directory image paths resolve against
 * @returns {Promise<string|AsyncIterable>} SDK prompt payload
 */
async function buildPromptPayload(command, images, cwd) {
  if (normalizeImageDescriptors(images).length === 0) {
    return command;
  }

  const message = await buildSDKUserMessage(command, images, cwd);
  return (async function* () {
    yield message;
  })();
}

const TERMINAL_TASK_STATUSES = new Set(['completed', 'failed', 'killed', 'stopped']);

/**
 * Maintains the set of in-flight SDK tasks (background Bash, subagents) from
 * the `task_started` / `task_updated` / `task_notification` system events.
 * @param {Object} message - Raw SDK message
 * @param {Set<string>} inflightTaskIds - Mutated in place
 */
function trackBackgroundTask(message, inflightTaskIds) {
  if (message?.type !== 'system' || typeof message.task_id !== 'string') {
    return;
  }
  if (message.subtype === 'task_started') {
    inflightTaskIds.add(message.task_id);
  } else if (message.subtype === 'task_notification') {
    inflightTaskIds.delete(message.task_id);
  } else if (message.subtype === 'task_updated' && TERMINAL_TASK_STATUSES.has(message.patch?.status)) {
    inflightTaskIds.delete(message.task_id);
  }
}

/**
 * True for SDK messages that mean the model is working a turn (as opposed to
 * status/bookkeeping frames that can trail a `result`).
 * @param {Object} message - Raw SDK message
 * @returns {boolean}
 */
function isTurnActivityMessage(message) {
  return message?.type === 'assistant' || message?.type === 'stream_event';
}

/**
 * True when this query should keep an open stdin channel for mid-run inject.
 * Chat passes `appSessionId`; headless/git/agent paths do not and keep the
 * classic one-shot prompt path (avoids streaming-mode edge cases there).
 * @param {Object} options
 * @returns {boolean}
 */
function shouldEnableMidRunInject(options = {}) {
  return Boolean(options.appSessionId) || options.enableMidRunInject === true;
}

/**
 * Pending interactive permission prompts for a provider session (or any if id null).
 * @param {string|null} sessionId
 * @returns {number}
 */
function countPendingApprovalsForSession(sessionId) {
  if (!sessionId) {
    return pendingToolApprovals.size;
  }
  let count = 0;
  for (const resolver of pendingToolApprovals.values()) {
    if (resolver._sessionId === sessionId) {
      count += 1;
    }
  }
  return count;
}

/**
 * Loads MCP server configurations from ~/.claude.json
 * @param {string} cwd - Current working directory for project-specific configs
 * @returns {Object|null} MCP servers object or null if none found
 */
/**
 * Tells CloudCLI-managed MCP servers which chat session they are serving.
 *
 * The Agent Relay MCP needs this to attribute a delegation to the lead that
 * asked for it — without it every relay job looks unattributed and every chat
 * sees every other chat's workers. Claude spawns MCP children itself from this
 * config object, so the value has to travel on the server entry rather than on
 * the (process-wide, run-shared) `process.env`.
 */
const BOT_GATEWAY_SERVER_NAME = 'cloudcli-tool-gateway';
const BOT_GATEWAY_TOOL_PATTERN = 'mcp__cloudcli-tool-gateway__*';

function stampLeadSessionOnMcpServers(mcpServers, appSessionId, bindingSecret) {
  if (!appSessionId) return mcpServers;
  const stamped = {};
  for (const [name, entry] of Object.entries(mcpServers)) {
    // Only stdio children inherit an env; remote transports have no process.
    if (!(entry && typeof entry === 'object' && entry.command)) {
      stamped[name] = entry;
      continue;
    }
    const env = { ...(entry.env || {}), CLOUDCLI_LEAD_SESSION_ID: appSessionId };
    // The per-binding secret goes ONLY to the gateway child, never to third-party servers.
    if (bindingSecret && name === BOT_GATEWAY_SERVER_NAME) {
      env.CLOUDCLI_BOT_GATEWAY_BINDING_SECRET = bindingSecret;
    }
    stamped[name] = { ...entry, env };
  }
  return stamped;
}

// sdkOptions -> built-in tool gate. Kept out of the options object so the SDK never sees it.
const builtinToolGates = new WeakMap();

/**
 * Gateway-bound runs: every built-in tool (Bash/Read/Write/...) must be decided by the bot's
 * built-in tool gate, so nothing may be pre-approved (allowedTools, bypass mode, user/project
 * settings allow rules) - canUseTool has to be consulted.
 */
function installBuiltinToolGate(sdkOptions, gate) {
  builtinToolGates.set(sdkOptions, gate);
  sdkOptions.permissionMode = 'default';
  delete sdkOptions.allowDangerouslySkipPermissions;
  sdkOptions.allowedTools = (sdkOptions.allowedTools || []).filter((entry) => entry === BOT_GATEWAY_TOOL_PATTERN);
  // Settings files can carry allow rules and hooks that would pre-approve a call.
  sdkOptions.settingSources = [];
}

// Parsed-JSON cache keyed by path and invalidated by mtime+size. loadMcpConfig
// runs before every Claude turn and ~/.claude.json alone is ~100KB; a stat is
// far cheaper than a read + JSON.parse. Parse failures are never cached.
const jsonFileCache = new Map();

async function readJsonFileCached(filePath) {
  let info;
  try {
    info = await fs.stat(filePath);
  } catch (error) {
    jsonFileCache.delete(filePath);
    throw error;
  }
  const signature = `${info.mtimeMs}:${info.size}`;
  const hit = jsonFileCache.get(filePath);
  if (hit && hit.signature === signature) {
    return hit.value;
  }
  const value = JSON.parse(await fs.readFile(filePath, 'utf8'));
  jsonFileCache.set(filePath, { signature, value });
  return value;
}

async function loadMcpConfig(cwd) {
  try {
    const claudeConfigPath = path.join(os.homedir(), '.claude.json');

    // Read and parse config file (a missing file means no MCP config).
    let claudeConfig;
    try {
      claudeConfig = await readJsonFileCached(claudeConfigPath);
    } catch (error) {
      if (error?.code === 'ENOENT') {
        return null;
      }
      console.error('Failed to parse ~/.claude.json:', error.message);
      return null;
    }

    // Extract MCP servers, merged lowest-to-highest precedence:
    //   1. global ~/.claude.json `mcpServers`
    //   2. ~/.claude.json `projects[cwd].mcpServers` (native Claude per-project)
    //   3. `<cwd>/.mcp.json` `mcpServers` (project-scoped file)
    let mcpServers = {};

    // 1. Global MCP servers.
    if (claudeConfig.mcpServers && typeof claudeConfig.mcpServers === 'object') {
      mcpServers = { ...claudeConfig.mcpServers };
    }

    // 2. Per-project overrides from ~/.claude.json. Claude stores these under
    //    `projects` — the previous `claudeProjects` key never matched anything,
    //    so this branch was dead code.
    if (claudeConfig.projects && cwd) {
      const projectConfig = claudeConfig.projects[cwd];
      if (projectConfig && projectConfig.mcpServers && typeof projectConfig.mcpServers === 'object') {
        mcpServers = { ...mcpServers, ...projectConfig.mcpServers };
      }
    }

    // 3. Project-scoped `<cwd>/.mcp.json` wins. This is where cloudcli's
    //    project-memory fan-out installs the `obsidian` server (and where the
    //    native `claude` CLI reads project servers from). Previously this file
    //    was never read here, so a cloudcli-launched Claude only saw per-project
    //    servers if they were also registered globally — which is exactly why
    //    memory silently failed in projects that relied on the injected file.
    if (cwd) {
      try {
        const projectMcpPath = path.join(cwd, '.mcp.json');
        const projectMcp = await readJsonFileCached(projectMcpPath);
        if (projectMcp && projectMcp.mcpServers && typeof projectMcp.mcpServers === 'object') {
          mcpServers = { ...mcpServers, ...projectMcp.mcpServers };
        }
      } catch (error) {
        // A missing file (ENOENT) is normal for non-memory projects; only a
        // malformed .mcp.json is worth surfacing.
        if (error.code !== 'ENOENT') {
          console.error(`Failed to read project .mcp.json in ${cwd}:`, error.message);
        }
      }
    }

    // 4. Ensure the CloudCLI Obsidian MCP is available even for global /
    //    home-cwd runs (Mission Control sections, etc.). Project `.mcp.json`
    //    only covers workspaces where memory was enabled; global settings are
    //    the single source of truth for vault credentials.
    if (!mcpServers[OBSIDIAN_MCP_SERVER_NAME]) {
      try {
        const settings = obsidianSettingsService.getSettings();
        if (settings.restApiKey && settings.restApiKey.trim()) {
          const input = buildObsidianMcpServerInput(settings);
          mcpServers[OBSIDIAN_MCP_SERVER_NAME] = {
            type: 'stdio',
            command: input.command,
            args: input.args ?? [],
            env: input.env ?? {},
          };
        } else {
          // Fall back: scavenge env from any known project .mcp.json that has
          // an obsidian entry (user may have configured it only per-project).
          const candidates = [
            path.join(os.homedir(), 'Development', 'cloudcli-fork', '.mcp.json'),
            path.join(os.homedir(), 'Sites', 'mission_control', '.mcp.json'),
          ];
          for (const candidate of candidates) {
            try {
              const raw = await readJsonFileCached(candidate);
              const entry = raw?.mcpServers?.[OBSIDIAN_MCP_SERVER_NAME];
              if (entry && typeof entry === 'object') {
                mcpServers[OBSIDIAN_MCP_SERVER_NAME] = entry;
                break;
              }
            } catch {
              // skip missing/malformed
            }
          }
        }
      } catch (error) {
        console.warn(
          '[Claude SDK] Could not inject Obsidian MCP:',
          error instanceof Error ? error.message : error,
        );
      }
    }

    // Return null if no servers found
    if (Object.keys(mcpServers).length === 0) {
      return null;
    }
    // Entries reference the shared parsed-file cache; hand callers their own
    // copy so nothing downstream can mutate the cached config.
    return structuredClone(mcpServers);
  } catch (error) {
    console.error('Error loading MCP config:', error.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Warm Claude sessions
//
// Chat runs use streaming input (an open stdin channel). Historically stdin
// was closed RUN_DRAIN_GRACE_MS after every turn `result`, so the CLI exited
// and the next chat.send paid for a brand-new process: resume + every stdio
// MCP server restarted (2-8s before the first token). A "live" session keeps
// the SDK query and its channel open after the turn is reported complete, and
// parks it in a small LRU pool keyed by provider session id. The next send for
// the same session (with materially identical options) pushes its message into
// the parked process instead of spawning a new one.
//
// Lifecycle contract preserved for the UI / run registry:
//   - Each queryClaudeSDK call is one run: it emits exactly one terminal
//     `complete` and resolves after it, whether the process parks or exits.
//   - A parked process is removed from `activeSessions` before `complete` is
//     sent, so it never looks "processing" and never accepts mid-run injects.
//   - Abort ends the channel + interrupts: the process exits and is not reused.
//   - Options that change the spawn (model, permission mode, cwd, tools, MCP
//     set, settings, system prompt, auth) evict the warm process first.
//   - A warm process that died before producing output for a new turn falls
//     back transparently to a fresh query.
//
// Flags: CLOUDCLI_WARM_CLAUDE_SESSIONS=0 disables (old behaviour);
// CLOUDCLI_CLAUDE_WARM_TTL_MS idle TTL (default 10 min, 0 disables);
// CLOUDCLI_CLAUDE_WARM_MAX parked-session cap (default 4, LRU eviction);
// CLOUDCLI_CLAUDE_PREWARM=0 disables prewarm (chat.prewarm) only.
//
// Prewarm (prewarmClaudeSession) parks a process for a session BEFORE its
// first send, so the process + MCP boot overlaps with the user reading and
// typing. Concurrency contract (never two CLIs resuming one transcript):
//   - At most one prewarm per provider session is in flight (deduped).
//   - A run "claims" its session ids (sendClaims) before it looks at the
//     warm pool, after waiting (bounded) for an in-flight prewarm to park.
//     A prewarm re-checks claims + active runs right before it spawns and
//     spawns synchronously after that check, so either the run finds the
//     prewarmed process in the pool (and reuses it, even mid-boot: its
//     first message is buffered on stdin) or the prewarm gives up.
//   - LRU eviction skips pool entries whose session is claimed by a run.
// ---------------------------------------------------------------------------

const DEFAULT_WARM_TTL_MS = 10 * 60_000;
const DEFAULT_WARM_MAX = 4;
// After ending stdin on an evicted process, hard-close it if it has not
// exited on its own within this window.
const WARM_CLOSE_GRACE_MS = 1_500;

// Upper bound a run waits for an in-flight prewarm of its session to park
// before claiming the session (the prewarm then yields instead).
const PREWARM_AWAIT_MAX_MS = 5_000;

// providerSessionId -> parked live session (insertion order = LRU order).
const warmSessions = new Map();
// providerSessionId -> in-flight prewarm promise (resolves true when parked).
const prewarmInflight = new Map();
// session id (provider or app) -> number of runs currently owning it. A
// claimed session is never prewarmed and its pool entry never LRU-evicted.
const sendClaims = new Map();
// Every live session with a running process (parked or mid-turn).
const liveSessions = new Set();
let liveSessionSeq = 0;
let exitHookInstalled = false;

// Test seam: lets unit tests replace the SDK `query` and the per-turn setup
// dependencies (model probe, Keychain, ~/.claude.json) with fakes.
let testOverrides = {};

function __setClaudeSdkTestOverrides(overrides) {
  testOverrides = overrides || {};
}

function runQuery(args) {
  return (testOverrides.query || query)(args);
}

function isWarmSessionsEnabled() {
  return process.env.CLOUDCLI_WARM_CLAUDE_SESSIONS !== '0';
}

function readWarmTtlMs() {
  const raw = process.env.CLOUDCLI_CLAUDE_WARM_TTL_MS;
  if (raw === undefined || raw === '') {
    return DEFAULT_WARM_TTL_MS;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_WARM_TTL_MS;
}

function isPrewarmEnabled() {
  return process.env.CLOUDCLI_CLAUDE_PREWARM !== '0';
}

/** Marks `ids` as owned by a run. Returns an idempotent release function. */
function claimSessionIds(...ids) {
  const claimed = [...new Set(ids.filter(Boolean))];
  for (const id of claimed) {
    sendClaims.set(id, (sendClaims.get(id) || 0) + 1);
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    for (const id of claimed) {
      const next = (sendClaims.get(id) || 0) - 1;
      if (next > 0) sendClaims.set(id, next);
      else sendClaims.delete(id);
    }
  };
}

function isSessionClaimed(...ids) {
  return ids.some((id) => id && sendClaims.has(id));
}

/** Waits (bounded) for an in-flight prewarm of `sessionId` to settle. */
async function waitForInflightPrewarm(sessionId, timeoutMs = PREWARM_AWAIT_MAX_MS) {
  const inflight = sessionId ? prewarmInflight.get(sessionId) : null;
  if (!inflight) {
    return;
  }
  let timer = null;
  await Promise.race([
    inflight.catch(() => false),
    new Promise((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
      timer.unref?.();
    }),
  ]);
  if (timer) {
    clearTimeout(timer);
  }
}

function readWarmMax() {
  const parsed = Number(process.env.CLOUDCLI_CLAUDE_WARM_MAX);
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : DEFAULT_WARM_MAX;
}

/**
 * Warm reuse is for interactive chat only: automation (unattended), relay
 * workers (their worktree can be landed/discarded underneath a parked
 * process) and callers that opt out keep the one-process-per-run model.
 */
function isWarmEligible(options = {}) {
  return isWarmSessionsEnabled()
    && readWarmTtlMs() > 0
    && Boolean(options.appSessionId)
    && !options.relayWorker
    && !options.unattended
    && options.warmSession !== false;
}

function hashValue(value) {
  if (!value) {
    return null;
  }
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 16);
}

/**
 * Everything that is baked into the CLI process at spawn time. Two runs with
 * the same fingerprint can safely share one process; any difference evicts.
 * Per-turn values (writer, images, approval budgets, session summary) are
 * read from the current turn instead and do not participate.
 */
function computeWarmFingerprint(sdkOptions, options = {}) {
  const env = sdkOptions.env || {};
  return JSON.stringify({
    appSessionId: options.appSessionId || null,
    cwd: sdkOptions.cwd || null,
    model: sdkOptions.model || null,
    effort: sdkOptions.effort || null,
    permissionMode: sdkOptions.permissionMode || 'default',
    allowedTools: [...(sdkOptions.allowedTools || [])].sort(),
    disallowedTools: [...(sdkOptions.disallowedTools || [])].sort(),
    tools: sdkOptions.tools || null,
    mcpServers: sdkOptions.mcpServers || null,
    settingSources: sdkOptions.settingSources || null,
    systemPrompt: sdkOptions.systemPrompt || null,
    sandbox: sdkOptions.sandbox || null,
    includePartialMessages: Boolean(sdkOptions.includePartialMessages),
    executable: sdkOptions.pathToClaudeCodeExecutable || null,
    baseUrl: env.ANTHROPIC_BASE_URL || null,
    oauthToken: hashValue(env.CLAUDE_CODE_OAUTH_TOKEN),
    apiKey: hashValue(env.ANTHROPIC_API_KEY),
  });
}

function isSessionAborted(...ids) {
  return ids.some((id) => id && abortedSessionIds.has(id));
}

function installWarmExitHook() {
  if (exitHookInstalled) {
    return;
  }
  exitHookInstalled = true;
  // Last-resort cleanup: 'exit' handlers must be synchronous, and close()
  // kills the CLI child synchronously so no orphaned claude/MCP processes
  // survive a server restart.
  process.once('exit', () => {
    for (const live of liveSessions) {
      try {
        live.queryInstance?.close?.();
      } catch {
        // ignore
      }
    }
  });
}

function clearLiveTimers(live) {
  if (live.drainTimer) {
    clearTimeout(live.drainTimer);
    live.drainTimer = null;
  }
  if (live.idleTimer) {
    clearTimeout(live.idleTimer);
    live.idleTimer = null;
  }
}

function removeFromWarmPool(live) {
  if (live.providerSessionId && warmSessions.get(live.providerSessionId) === live) {
    warmSessions.delete(live.providerSessionId);
  }
}

/**
 * Asks a live session's CLI to exit (stdin EOF) and hard-closes it if it is
 * still running after WARM_CLOSE_GRACE_MS. Safe to call repeatedly.
 */
function closeLiveSession(live, reason = 'closed') {
  if (!live || live.closed) {
    return;
  }
  live.closed = true;
  live.closeReason = reason;
  clearLiveTimers(live);
  removeFromWarmPool(live);
  live.channel.end();
  if (!live.loopStarted) {
    // Never started consuming: nothing will observe the exit, so close now.
    try {
      live.queryInstance?.close?.();
    } catch {
      // ignore
    }
    live.markDone();
    return;
  }
  const hardClose = setTimeout(() => {
    try {
      live.queryInstance?.close?.();
    } catch {
      // ignore
    }
  }, WARM_CLOSE_GRACE_MS);
  hardClose.unref?.();
  live.loopDone.finally(() => clearTimeout(hardClose));
}

/** Waits (bounded) for a live session's process to fully exit. */
async function waitForLiveExit(live, timeoutMs = WARM_CLOSE_GRACE_MS * 2) {
  let timer = null;
  await Promise.race([
    live.loopDone,
    new Promise((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
      timer.unref?.();
    }),
  ]);
  if (timer) {
    clearTimeout(timer);
  }
}

/**
 * LRU-evicts parked processes over the cap. Entries whose session is claimed
 * by a run (a send about to acquire it) are skipped, so the pool may exceed
 * the cap briefly rather than kill a process a turn is about to use; a
 * just-inserted prewarm is itself evicted when everything older is claimed.
 */
function enforceWarmCap() {
  const max = readWarmMax();
  if (warmSessions.size <= max) {
    return;
  }
  for (const [key, live] of [...warmSessions]) {
    if (warmSessions.size <= max) {
      break;
    }
    if (isSessionClaimed(key, live.appSessionId)) {
      continue;
    }
    closeLiveSession(live, 'lru');
  }
}

/**
 * Creates a live (streaming-input) query. The consumer loop is started
 * separately (startLiveLoop) so the first turn can be attached before any
 * message can arrive.
 */
function createLiveSession(sdkOptions, { fingerprint = null, appSessionId = null, warmEligible = false } = {}) {
  let markDone;
  const live = {
    id: ++liveSessionSeq,
    sdkOptions,
    fingerprint,
    appSessionId,
    warmEligible,
    // True while a process started by prewarmClaudeSession has not served a turn.
    prewarmed: false,
    providerSessionId: null,
    channel: null,
    queryInstance: null,
    turn: null,
    inflightTaskIds: new Set(),
    drainTimer: null,
    idleTimer: null,
    closed: false,
    closeReason: null,
    loopStarted: false,
    loopDone: new Promise((resolve) => {
      markDone = resolve;
    }),
    markDone: () => markDone(),
  };

  sdkOptions.hooks = {
    Notification: [{
      matcher: '',
      hooks: [async (input) => {
        const turn = live.turn;
        if (!turn) {
          return {};
        }
        const message = typeof input?.message === 'string' ? input.message : 'Claude requires your attention.';
        const sid = turn.capturedSessionId || turn.requestedSessionId || null;
        turn.emitNotification(createNotificationEvent({
          provider: 'claude',
          sessionId: sid,
          kind: 'action_required',
          code: 'agent.notification',
          meta: { message, sessionName: turn.sessionSummary },
          severity: 'warning',
          requiresUserAction: true,
          dedupeKey: `claude:hook:notification:${sid || 'none'}:${message}`
        }));
        return {};
      }]
    }]
  };

  sdkOptions.canUseTool = async (toolName, input, context) => {
    // While a tool is waiting on the user, never close stdin / park.
    if (live.drainTimer) {
      clearTimeout(live.drainTimer);
      live.drainTimer = null;
    }
    const turn = live.turn;
    if (!turn) {
      return { behavior: 'deny', message: 'No active run for this session' };
    }
    return handleCanUseTool(toolName, input, context, {
      sdkOptions,
      ws: turn.ws,
      capturedSessionIdRef: () => live.turn?.capturedSessionId || live.providerSessionId,
      sessionId: turn.requestedSessionId,
      sessionSummary: turn.sessionSummary,
      emitNotification: turn.emitNotification,
      unattended: Boolean(turn.options.unattended),
      approvalTimeoutMs: turn.options.approvalTimeoutMs,
      cwd: turn.options.cwd || null,
    });
  };

  const openChannel = () => {
    const channel = createInputChannel();
    // A push during post-result grace cancels the drain so the run continues.
    const rawPush = channel.push.bind(channel);
    channel.push = (message) => {
      if (live.drainTimer) {
        clearTimeout(live.drainTimer);
        live.drainTimer = null;
      }
      return rawPush(message);
    };
    return channel;
  };

  live.channel = openChannel();
  try {
    live.queryInstance = runQuery({ prompt: live.channel.iterator, options: sdkOptions });
  } catch (hookError) {
    console.warn('Failed to initialize Claude query with hooks, retrying without hooks:', hookError?.message || hookError);
    delete sdkOptions.hooks;
    live.channel = openChannel();
    live.queryInstance = runQuery({ prompt: live.channel.iterator, options: sdkOptions });
  }

  liveSessions.add(live);
  installWarmExitHook();
  return live;
}

function startLiveLoop(live) {
  if (live.loopStarted) {
    return;
  }
  live.loopStarted = true;
  (async () => {
    let error = null;
    try {
      for await (const message of live.queryInstance) {
        handleLiveMessage(live, message);
      }
    } catch (loopError) {
      error = loopError;
    }
    finishLiveSession(live, error);
  })();
}

/** The process is gone (normal exit, crash, abort, or eviction). */
function finishLiveSession(live, error) {
  live.closed = true;
  clearLiveTimers(live);
  removeFromWarmPool(live);
  live.channel.end();
  liveSessions.delete(live);

  const turn = live.turn;
  live.turn = null;
  if (turn) {
    try {
      flushStreamDeltas(turn.stream);
    } catch {
      // writer may be gone; the run still settles below
    }
    const sid = turn.capturedSessionId || turn.requestedSessionId || null;
    if (
      turn.reused
      && !turn.receivedOutput
      && !isSessionAborted(sid, live.appSessionId, turn.requestedSessionId)
    ) {
      // The warm process died before answering this turn: the caller retries
      // on a fresh process instead of surfacing a spurious failure.
      turn.settle({ kind: 'fallback', error });
    } else {
      turn.settle({ kind: 'ended', error });
    }
  } else if (error && !live.closeReason) {
    console.warn(`[Claude SDK] Warm session ${live.providerSessionId || live.id} exited while idle:`, error?.message || error);
  }
  live.markDone();
}

// ---------------------------------------------------------------------------
// Live token streaming (includePartialMessages)
//
// Contract (same as Codex): text deltas go out as `stream_delta` and the
// block end as `stream_end`, which the client finalizes into the assistant
// text bubble; the matching text block of the final `assistant` message is
// then dropped so the bubble is not duplicated. Thinking deltas go out as
// `thinking` (the client's buffered reasoning block) and the final thinking
// block is dropped the same way. Subagent partials (parent_tool_use_id set)
// are ignored — their final messages still arrive grouped under the tool.
// After `complete` the client reloads the persisted transcript, so a
// streamed/final mismatch only ever affects the live view.
// ---------------------------------------------------------------------------

/**
 * Streaming is for interactive chat only; automation (unattended) and relay
 * workers collect whole `text` messages and gain nothing from deltas.
 */
function shouldStreamPartialMessages(options = {}) {
  return Boolean(options.appSessionId)
    && !options.unattended
    && !options.relayWorker
    && process.env.CLOUDCLI_CLAUDE_STREAM_PARTIAL !== '0';
}

// Text deltas are coalesced for this long before being forwarded: the client
// already batches renders at 100ms, and one frame per token would multiply
// websocket frames, run-registry buffer entries (capped per run) and
// persisted run events for no visible gain.
const STREAM_DELTA_FLUSH_MS = 40;

function createStreamState(ws) {
  // blocks: content-block index -> segment for the current API message.
  // segments: streamed blocks awaiting their final assistant counterpart.
  return { ws, blocks: new Map(), segments: [], pendingText: '', pendingSid: null, flushTimer: null };
}

function flushStreamDeltas(state) {
  if (!state) return;
  if (state.flushTimer) {
    clearTimeout(state.flushTimer);
    state.flushTimer = null;
  }
  if (!state.pendingText) return;
  const text = state.pendingText;
  state.pendingText = '';
  const event = { type: 'content_block_delta', delta: { type: 'text_delta', text } };
  for (const msg of sessionsService.normalizeMessage('claude', event, state.pendingSid)) {
    state.ws.send(msg);
  }
}

function queueStreamDelta(state, text, sid) {
  state.pendingText += text;
  state.pendingSid = sid;
  if (!state.flushTimer) {
    state.flushTimer = setTimeout(() => {
      state.flushTimer = null;
      try {
        flushStreamDeltas(state);
      } catch (error) {
        console.warn('[Claude SDK] Failed to forward stream delta:', error?.message || error);
      }
    }, STREAM_DELTA_FLUSH_MS);
  }
}

function pruneStreamSegments(state) {
  state.segments = state.segments.filter((segment) => !(segment.stopped && segment.consumed));
}

function forwardStreamEvent(state, message, sid, ws) {
  if (message.parent_tool_use_id) {
    return;
  }
  const event = message.event;
  if (!event || typeof event !== 'object') {
    return;
  }
  switch (event.type) {
    case 'message_start':
      state.blocks.clear();
      break;
    case 'content_block_start': {
      const blockType = event.content_block?.type;
      if (blockType === 'text' || blockType === 'thinking') {
        const segment = { kind: blockType, text: '', stopped: false, consumed: false };
        state.blocks.set(event.index, segment);
        state.segments.push(segment);
      }
      break;
    }
    case 'content_block_delta': {
      const segment = state.blocks.get(event.index);
      if (!segment) break;
      if (segment.kind === 'text' && event.delta?.type === 'text_delta' && event.delta.text) {
        segment.text += event.delta.text;
        queueStreamDelta(state, event.delta.text, sid);
      } else if (segment.kind === 'thinking' && event.delta?.type === 'thinking_delta' && event.delta.thinking) {
        segment.text += event.delta.thinking;
        flushStreamDeltas(state);
        ws.send(createNormalizedMessage({ kind: 'thinking', content: event.delta.thinking, sessionId: sid, provider: 'claude' }));
      }
      break;
    }
    case 'content_block_stop': {
      const segment = state.blocks.get(event.index);
      if (!segment) break;
      state.blocks.delete(event.index);
      segment.stopped = true;
      if (!segment.text) {
        // Nothing was streamed: the final message must render normally.
        state.segments = state.segments.filter((entry) => entry !== segment);
        break;
      }
      if (segment.kind === 'text') {
        flushStreamDeltas(state);
        for (const msg of sessionsService.normalizeMessage('claude', event, sid)) {
          ws.send(msg);
        }
      }
      pruneStreamSegments(state);
      break;
    }
    default:
      break;
  }
}

/** Removes final-message blocks whose content was already streamed live. */
function dropStreamedBlocks(state, normalized) {
  if (state.segments.length === 0) {
    return normalized;
  }
  const kept = normalized.filter((msg) => {
    const kind = msg.kind === 'text' && msg.role !== 'user'
      ? 'text'
      : msg.kind === 'thinking' ? 'thinking' : null;
    if (!kind) return true;
    const segment = state.segments.find((entry) => entry.kind === kind && !entry.consumed && entry.text);
    if (!segment) return true;
    segment.consumed = true;
    return false;
  });
  pruneStreamSegments(state);
  return kept;
}

function handleLiveMessage(live, message) {
  trackBackgroundTask(message, live.inflightTaskIds);
  const turn = live.turn;

  if (!turn) {
    // Parked: trailing bookkeeping frames are expected and dropped. Model
    // activity with nobody listening means the CLI woke itself up; retire
    // the process so the next send starts clean instead of racing it.
    if (isTurnActivityMessage(message) && !live.closed) {
      console.warn(`[Claude SDK] Warm session ${live.providerSessionId || live.id} produced output while idle; retiring it`);
      closeLiveSession(live, 'idle-activity');
    }
    return;
  }

  turn.receivedOutput = true;
  const ws = turn.ws;

  // The CLI resumed on its own (e.g. a task notification woke the model):
  // the pending drain belongs to a turn that is no longer the last one, so
  // let the next `result` reschedule it.
  if (live.drainTimer && isTurnActivityMessage(message)) {
    clearTimeout(live.drainTimer);
    live.drainTimer = null;
  }

  if (message.session_id && !turn.capturedSessionId) {
    turn.capturedSessionId = message.session_id;
    live.providerSessionId = message.session_id;
    addSession(turn.capturedSessionId, live.queryInstance, ws, turn.extras);
    registerAppSessionAlias(live.appSessionId, turn.capturedSessionId, live.channel);

    if (ws.setSessionId && typeof ws.setSessionId === 'function') {
      ws.setSessionId(turn.capturedSessionId);
    }

    if (!turn.requestedSessionId && !turn.sessionCreatedSent) {
      turn.sessionCreatedSent = true;
      ws.send(createNormalizedMessage({ kind: 'session_created', newSessionId: turn.capturedSessionId, sessionId: turn.capturedSessionId, provider: 'claude' }));
    }
  }

  const sid = turn.capturedSessionId || turn.requestedSessionId || null;

  // Partial-message frames (includePartialMessages) are live-only: they are
  // forwarded as stream_delta / stream_end / thinking and never go through
  // the transcript normalizer as rows of their own.
  if (message.type === 'stream_event') {
    forwardStreamEvent(turn.stream, message, sid, ws);
    return;
  }

  // Keep ordering: buffered deltas go out before any other frame.
  flushStreamDeltas(turn.stream);

  const transformedMessage = transformMessage(message);
  let normalized = sessionsService.normalizeMessage('claude', transformedMessage, sid);
  if (message.type === 'assistant' && !message.parent_tool_use_id) {
    normalized = dropStreamedBlocks(turn.stream, normalized);
  }
  for (const msg of normalized) {
    if (transformedMessage.parentToolUseId && !msg.parentToolUseId) {
      msg.parentToolUseId = transformedMessage.parentToolUseId;
    }
    ws.send(msg);
  }

  const tokenBudgetData = extractTokenBudget(message);
  if (tokenBudgetData) {
    ws.send(createNormalizedMessage({ kind: 'status', text: 'token_budget', tokenBudget: tokenBudgetData, sessionId: sid, provider: 'claude' }));
  }

  // Finish the turn only after a `result` *and* no pending UI tool approvals
  // or background tasks. `complete` is emitted by queryClaudeSDK once the
  // turn settles — premature complete during tool_use is what previously
  // triggered ede_diagnostic failures.
  if (message.type === 'result' && !live.channel.ended) {
    scheduleTurnDrain(live);
  }
}

function scheduleTurnDrain(live) {
  if (live.drainTimer) {
    clearTimeout(live.drainTimer);
  }
  live.drainTimer = setTimeout(() => {
    live.drainTimer = null;
    const turn = live.turn;
    if (!turn || live.channel.ended) {
      return;
    }
    const sid = turn.capturedSessionId || turn.requestedSessionId || null;
    if (countPendingApprovalsForSession(sid) > 0 || live.inflightTaskIds.size > 0) {
      scheduleTurnDrain(live);
      return;
    }
    if (isSessionAborted(sid, live.appSessionId)) {
      return;
    }
    if (live.warmEligible && isWarmSessionsEnabled() && readWarmTtlMs() > 0 && live.providerSessionId && !live.closed) {
      parkLiveSession(live);
    } else {
      // Old behaviour: close stdin so the CLI exits; the loop end settles
      // the turn.
      live.channel.end();
    }
  }, readDrainGraceMs());
  live.drainTimer.unref?.();
}

/**
 * Detaches the finished turn from the process and parks the process in the
 * warm pool. Synchronously removes the run's activeSessions entries so no
 * inject can land on a process that has nobody listening.
 */
function parkLiveSession(live) {
  const turn = live.turn;
  live.turn = null;
  flushStreamDeltas(turn.stream);
  dropSessionKeys(turn.capturedSessionId, live.appSessionId);
  if (live.appSessionId) {
    appSessionAliases.delete(live.appSessionId);
    pendingInjections.delete(live.appSessionId);
  }

  const key = live.providerSessionId;
  const existing = warmSessions.get(key);
  if (existing && existing !== live) {
    closeLiveSession(existing, 'replaced');
  }
  warmSessions.delete(key);
  warmSessions.set(key, live);
  live.idleTimer = setTimeout(() => closeLiveSession(live, 'idle-ttl'), readWarmTtlMs());
  live.idleTimer.unref?.();
  enforceWarmCap();

  turn.settle({ kind: 'parked' });
}

/**
 * Attaches a turn (one run) to a live session and pushes its first message.
 * Returns null when the process can no longer accept input.
 */
function startLiveTurn(live, init, firstMessage) {
  let settle;
  const promise = new Promise((resolve) => {
    let settled = false;
    settle = (outcome) => {
      if (settled) return;
      settled = true;
      resolve(outcome);
    };
  });
  const turn = {
    ws: init.ws,
    options: init.options,
    sessionSummary: init.options.sessionSummary,
    requestedSessionId: init.options.sessionId || null,
    capturedSessionId: init.options.sessionId || null,
    emitNotification: init.emitNotification,
    reused: Boolean(init.reused),
    receivedOutput: false,
    sessionCreatedSent: false,
    stream: createStreamState(init.ws),
    extras: {
      channel: live.channel,
      sdkOptions: live.sdkOptions,
      appSessionId: live.appSessionId,
      donePromise: init.donePromise || null,
    },
    promise,
    settle,
  };

  live.turn = turn;
  if (turn.capturedSessionId && !live.providerSessionId) {
    live.providerSessionId = turn.capturedSessionId;
  }
  if (live.appSessionId) {
    addSession(live.appSessionId, live.queryInstance, turn.ws, turn.extras);
  }
  if (turn.capturedSessionId) {
    addSession(turn.capturedSessionId, live.queryInstance, turn.ws, turn.extras);
    registerAppSessionAlias(live.appSessionId, turn.capturedSessionId, live.channel);
  }

  if (live.closed || !live.channel.push(firstMessage)) {
    live.turn = null;
    dropSessionKeys(turn.capturedSessionId, live.appSessionId);
    return null;
  }
  return turn;
}

/**
 * Takes the parked warm session for `sessionId` if its fingerprint matches;
 * otherwise evicts it (and waits for the process to exit so two CLIs never
 * resume the same transcript at once). Returns the live session or null.
 */
async function acquireWarmSession(sessionId, fingerprint) {
  const warm = sessionId ? warmSessions.get(sessionId) : null;
  if (!warm) {
    return null;
  }
  if (fingerprint && !warm.closed && !warm.channel.ended && warm.fingerprint === fingerprint) {
    warmSessions.delete(sessionId);
    if (warm.idleTimer) {
      clearTimeout(warm.idleTimer);
      warm.idleTimer = null;
    }
    return warm;
  }
  closeLiveSession(warm, fingerprint ? 'options-changed' : 'not-eligible');
  await waitForLiveExit(warm);
  return null;
}

// Effort validation needs the Claude model catalog. The provider-models
// service deliberately bypasses its cache for Claude (and the probe memo with
// it), which spawned a CLI probe on every turn; one lookup a minute is enough.
const EFFORT_MODELS_TTL_MS = 60_000;
let effortModelsCache = null;

async function loadEffortModels() {
  if (testOverrides.loadEffortModels) {
    return testOverrides.loadEffortModels();
  }
  if (effortModelsCache && effortModelsCache.expiresAt > Date.now()) {
    return effortModelsCache.models;
  }
  try {
    const models = (await providerModelsService.getProviderModels('claude')).models;
    effortModelsCache = { models, expiresAt: Date.now() + EFFORT_MODELS_TTL_MS };
    return models;
  } catch (error) {
    console.warn('[Claude SDK] Unable to load provider models for effort validation:', error);
    return CLAUDE_FALLBACK_MODELS;
  }
}

/**
 * Per-run setup shared by queryClaudeSDK and prewarmClaudeSession: resolves
 * the model, builds SDK options, auth env and the MCP server set. The
 * independent lookups run concurrently.
 */
async function prepareClaudeSdkOptions(options = {}) {
  const resolveModel = testOverrides.resolveResumeModel
    || ((sessionId, model) => providerModelsService.resolveResumeModel('claude', sessionId, model));
  const loadMcp = testOverrides.loadMcpConfig || loadMcpConfig;
  const applyAuth = testOverrides.applyClaudeSpawnAuthEnv || applyClaudeSpawnAuthEnv;

  const [resolvedModel, effortModels, loadedMcpServers] = await Promise.all([
    resolveModel(options.sessionId, options.model),
    loadEffortModels(),
    loadMcp(options.cwd),
  ]);

  const sdkOptions = mapCliOptionsToSDK({
    ...options,
    model: resolvedModel || options.model,
    effortModels,
  });
  // LaunchAgent / non-TTY SDK children cannot use Claude's native keychain
  // library even when `security` can read the same item. Copy the live
  // access token so the session shell authenticates like the Terminal TUI.
  await applyAuth(sdkOptions);

  let mcpServers = filterMcpServersForRun(loadedMcpServers, options);
  if (options.botGatewayStrict) {
    // Bot runtime gateway: the CLI must not merge in
    // user/project MCP config or account connectors on top of the filtered set.
    sdkOptions.extraArgs = { ...(sdkOptions.extraArgs || {}), 'strict-mcp-config': null };
  }
  if (options.botGatewayStrict && typeof options.builtinToolGate === 'function') {
    installBuiltinToolGate(sdkOptions, options.builtinToolGate);
  }
  if (mcpServers) {
    sdkOptions.mcpServers = stampLeadSessionOnMcpServers(mcpServers, options.appSessionId, options.botGatewaySecret);
  }
  // Token-level streaming for interactive chat (only the inject/live path
  // handles `stream_event` frames; it is enabled exactly when appSessionId
  // is set, which also selects that path).
  if (shouldStreamPartialMessages(options)) {
    sdkOptions.includePartialMessages = true;
  }
  return sdkOptions;
}

/**
 * Executes a Claude query using the SDK
 * @param {string} command - User prompt/command
 * @param {Object} options - Query options
 * @param {Object} ws - WebSocket connection
 * @returns {Promise<void>}
 */
async function queryClaudeSDK(command, options = {}, ws) {
  const { sessionId, sessionSummary } = options;
  let capturedSessionId = sessionId;
  let sessionCreatedSent = false;
  // Mid-run inject only for chat (appSessionId). Headless/git keep one-shot path.
  const injectMode = shouldEnableMidRunInject(options);
  let settleDone = null;
  // Live session owned by this run until it parks or exits.
  let ownedLive = null;
  let parked = false;
  let releaseClaim = null;

  const emitNotification = (event) => {
    notifyUserIfEnabled({
      userId: ws?.userId || null,
      writer: ws,
      event
    });
  };

  try {
    // Start the per-run setup right away; it overlaps with the prewarm wait.
    const sdkOptionsPromise = prepareClaudeSdkOptions(options);
    sdkOptionsPromise.catch(() => {}); // observed below; avoid an unhandled rejection meanwhile

    // A prewarm for this session may be booting: let it park first (bounded)
    // so this run can reuse the booting process, then claim the session so
    // no later prewarm can spawn a second CLI on the same transcript.
    await waitForInflightPrewarm(sessionId);
    releaseClaim = claimSessionIds(sessionId, options.appSessionId);

    const sdkOptions = await sdkOptionsPromise;

    // One-shot path (headless/git): string or single-yield image generator.
    // Inject path (chat): open channel so follow-ups can push without respawn.
    const createOneShotPrompt = () => buildPromptPayload(command, options.images, options.cwd);

    if (injectMode) {
      // Wait for a prior run on the same provider session to fully unwind so
      // two CLI processes never resume the same transcript at once.
      const previousSession = sessionId ? getSession(sessionId) : null;
      if (previousSession?.donePromise) {
        try {
          await previousSession.donePromise;
        } catch {
          // ignore prior outcome
        }
        removeSession(sessionId);
      }

      const donePromise = new Promise((resolve) => {
        settleDone = resolve;
      });

      const warmEligible = isWarmEligible(options);
      const fingerprint = warmEligible ? computeWarmFingerprint(sdkOptions, options) : null;
      const firstMessage = await buildSDKUserMessage(command, options.images, options.cwd);
      const turnInit = { ws, options, emitNotification, donePromise };

      let turn = null;
      let outcome = null;

      // Warm path: reuse the parked process for this provider session.
      const warm = await acquireWarmSession(sessionId, fingerprint);
      if (warm) {
        ownedLive = warm;
        turn = startLiveTurn(warm, { ...turnInit, reused: true }, firstMessage);
        if (turn) {
          console.log(`Reusing ${warm.prewarmed ? 'prewarmed' : 'warm'} Claude process for session:`, sessionId, '(inject mode)');
          warm.prewarmed = false;
          outcome = await turn.promise;
        } else {
          closeLiveSession(warm, 'push-failed');
          await waitForLiveExit(warm);
        }
        if (outcome?.kind === 'fallback') {
          console.warn(`[Claude SDK] Warm session ${sessionId} died before responding; starting a fresh process`, outcome.error?.message || '');
          await waitForLiveExit(warm);
          outcome = null;
        }
      }

      if (!outcome) {
        const live = createLiveSession(sdkOptions, {
          fingerprint,
          appSessionId: options.appSessionId || null,
          warmEligible,
        });
        ownedLive = live;
        turn = startLiveTurn(live, { ...turnInit, reused: false }, firstMessage);
        if (!turn) {
          throw new Error('Claude input channel closed before the first message');
        }
        console.log('Starting async generator loop for session:', capturedSessionId || 'NEW', '(inject mode)');
        startLiveLoop(live);
        outcome = await turn.promise;
      }

      capturedSessionId = turn.capturedSessionId || capturedSessionId;
      if (outcome.kind === 'ended' && outcome.error) {
        throw outcome.error;
      }
      parked = outcome.kind === 'parked';

      dropSessionKeys(capturedSessionId, options.appSessionId);

      const wasAborted = consumeAbortedFlag(capturedSessionId, options.appSessionId, sessionId);
      if (!wasAborted) {
        ws.send(createCompleteMessage({ provider: 'claude', sessionId: capturedSessionId || sessionId || null, exitCode: 0 }));
      }
      notifyRunStopped({
        userId: ws?.userId || null,
        provider: 'claude',
        sessionId: capturedSessionId || sessionId || null,
        sessionName: sessionSummary,
        stopReason: wasAborted ? 'aborted' : 'completed'
      });
    } else {
      // --- Classic one-shot path (unchanged contract) ---
      // Never run alongside a parked chat process resuming the same
      // transcript: retire it first.
      if (sessionId && warmSessions.has(sessionId)) {
        await acquireWarmSession(sessionId, null);
      }
      sdkOptions.hooks = {
        Notification: [{
          matcher: '',
          hooks: [async (input) => {
            const message = typeof input?.message === 'string' ? input.message : 'Claude requires your attention.';
            emitNotification(createNotificationEvent({
              provider: 'claude',
              sessionId: capturedSessionId || sessionId || null,
              kind: 'action_required',
              code: 'agent.notification',
              meta: { message, sessionName: sessionSummary },
              severity: 'warning',
              requiresUserAction: true,
              dedupeKey: `claude:hook:notification:${capturedSessionId || sessionId || 'none'}:${message}`
            }));
            return {};
          }]
        }]
      };

      sdkOptions.canUseTool = async (toolName, input, context) => handleCanUseTool(toolName, input, context, {
        sdkOptions,
        ws,
        capturedSessionIdRef: () => capturedSessionId,
        sessionId,
        sessionSummary,
        emitNotification,
        unattended: Boolean(options.unattended),
        approvalTimeoutMs: options.approvalTimeoutMs,
        cwd: options.cwd || null,
      });

      let queryInstance;
      try {
        queryInstance = runQuery({
          prompt: await createOneShotPrompt(),
          options: sdkOptions
        });
      } catch (hookError) {
        console.warn('Failed to initialize Claude query with hooks, retrying without hooks:', hookError?.message || hookError);
        delete sdkOptions.hooks;
        queryInstance = runQuery({
          prompt: await createOneShotPrompt(),
          options: sdkOptions
        });
      }

      if (options.appSessionId) {
        addSession(options.appSessionId, queryInstance, ws, {
          sdkOptions,
          appSessionId: options.appSessionId || null,
        });
      }
      if (capturedSessionId) {
        addSession(capturedSessionId, queryInstance, ws, {
          sdkOptions,
          appSessionId: options.appSessionId || null,
        });
      }

      console.log('Starting async generator loop for session:', capturedSessionId || 'NEW');
      for await (const message of queryInstance) {
        if (message.session_id && !capturedSessionId) {
          capturedSessionId = message.session_id;
          addSession(capturedSessionId, queryInstance, ws, {
            sdkOptions,
            appSessionId: options.appSessionId || null,
          });

          if (ws.setSessionId && typeof ws.setSessionId === 'function') {
            ws.setSessionId(capturedSessionId);
          }

          if (!sessionId && !sessionCreatedSent) {
            sessionCreatedSent = true;
            ws.send(createNormalizedMessage({ kind: 'session_created', newSessionId: capturedSessionId, sessionId: capturedSessionId, provider: 'claude' }));
          }
        }

        const transformedMessage = transformMessage(message);
        const sid = capturedSessionId || sessionId || null;
        const normalized = sessionsService.normalizeMessage('claude', transformedMessage, sid);
        for (const msg of normalized) {
          if (transformedMessage.parentToolUseId && !msg.parentToolUseId) {
            msg.parentToolUseId = transformedMessage.parentToolUseId;
          }
          ws.send(msg);
        }

        const tokenBudgetData = extractTokenBudget(message);
        if (tokenBudgetData) {
          ws.send(createNormalizedMessage({ kind: 'status', text: 'token_budget', tokenBudget: tokenBudgetData, sessionId: capturedSessionId || sessionId || null, provider: 'claude' }));
        }
      }

      dropSessionKeys(capturedSessionId, options.appSessionId);

      const wasAborted = consumeAbortedFlag(capturedSessionId, options.appSessionId, sessionId);
      if (!wasAborted) {
        ws.send(createCompleteMessage({ provider: 'claude', sessionId: capturedSessionId || sessionId || null, exitCode: 0 }));
      }
      notifyRunStopped({
        userId: ws?.userId || null,
        provider: 'claude',
        sessionId: capturedSessionId || sessionId || null,
        sessionName: sessionSummary,
        stopReason: wasAborted ? 'aborted' : 'completed'
      });
    }

  } catch (error) {
    console.error('SDK query error:', error);
    // A failed run may be an auth problem: re-resolve credentials next time.
    invalidateClaudeSpawnAuthEnvCache();

    dropSessionKeys(capturedSessionId, options.appSessionId);

    const wasAborted = consumeAbortedFlag(capturedSessionId, options.appSessionId, sessionId);
    if (wasAborted) {
      return;
    }

    const installed = await providerAuthService.isProviderInstalled('claude');
    const errorContent = !installed
      ? 'Claude Code is not installed. Please install it first: https://docs.anthropic.com/en/docs/claude-code'
      : error.message;

    ws.send(createNormalizedMessage({ kind: 'error', content: errorContent, sessionId: capturedSessionId || sessionId || null, provider: 'claude' }));
    ws.send(createCompleteMessage({ provider: 'claude', sessionId: capturedSessionId || sessionId || null, exitCode: 1 }));
    notifyRunFailed({
      userId: ws?.userId || null,
      provider: 'claude',
      sessionId: capturedSessionId || sessionId || null,
      sessionName: sessionSummary,
      error
    });
  } finally {
    releaseClaim?.();
    // A parked process stays alive in the warm pool; anything else this run
    // owned must not outlive it.
    if (ownedLive && !parked) {
      if (ownedLive.turn) {
        ownedLive.turn = null;
      }
      closeLiveSession(ownedLive, 'run-ended');
    }
    if (options.appSessionId) {
      appSessionAliases.delete(options.appSessionId);
      pendingInjections.delete(options.appSessionId);
    }
    if (settleDone) {
      settleDone();
    }
  }
}

/**
 * Starts (or keeps) a warm Claude process for `sessionId` before the user
 * sends, so the first message of a resumed session skips process + MCP
 * startup too. `options` must be the runtime options the next chat.send will
 * produce (the chat websocket `chat.prewarm` handler builds them through the
 * same helpers as chat.send) — a fingerprint mismatch simply evicts the
 * prewarmed process on send. Never sends a message, so no model call is
 * made: the CLI boots in streaming-input mode and waits on stdin.
 *
 * Resolves true when a matching warm process is (now) parked. No-op (false)
 * when prewarm/warm sessions are disabled, the session is not warm-eligible,
 * a run is live or claimed for it, or a send claims it mid-setup. Concurrent
 * calls for one session share a single in-flight attempt.
 */
function prewarmClaudeSession(sessionId, options = {}) {
  if (!sessionId || !isPrewarmEnabled()) {
    return Promise.resolve(false);
  }
  const inflight = prewarmInflight.get(sessionId);
  if (inflight) {
    return inflight;
  }
  const attempt = runPrewarm(sessionId, options)
    .catch((error) => {
      console.warn(`[Claude SDK] Prewarm for session ${sessionId} failed:`, error?.message || error);
      return false;
    })
    .finally(() => {
      if (prewarmInflight.get(sessionId) === attempt) {
        prewarmInflight.delete(sessionId);
      }
    });
  prewarmInflight.set(sessionId, attempt);
  return attempt;
}

async function runPrewarm(sessionId, options) {
  const runOptions = { ...options, sessionId, resume: true };
  const appSessionId = runOptions.appSessionId || null;
  const blocked = () => !isPrewarmEnabled()
    || !isWarmEligible(runOptions)
    || isSessionClaimed(sessionId, appSessionId)
    || Boolean(getSession(sessionId))
    || Boolean(appSessionId && getSession(appSessionId));

  if (blocked()) {
    return false; // a run is live (it parks itself when done) or prewarm is off
  }
  const sdkOptions = await prepareClaudeSdkOptions(runOptions);
  const fingerprint = computeWarmFingerprint(sdkOptions, runOptions);
  const isUsable = (live) => Boolean(live) && !live.closed && !live.channel.ended && live.fingerprint === fingerprint;

  if (blocked()) {
    return false;
  }
  const existing = warmSessions.get(sessionId);
  if (isUsable(existing)) {
    // Refresh LRU position + TTL: the user is looking at this session.
    warmSessions.delete(sessionId);
    warmSessions.set(sessionId, existing);
    if (existing.idleTimer) clearTimeout(existing.idleTimer);
    existing.idleTimer = setTimeout(() => closeLiveSession(existing, 'idle-ttl'), readWarmTtlMs());
    existing.idleTimer.unref?.();
    return true;
  }
  if (existing) {
    // Stale options (e.g. model switched since the last turn): the next send
    // would evict it anyway, so replace it now while the user types.
    closeLiveSession(existing, 'prewarm-replaced');
    await waitForLiveExit(existing);
  }
  // Re-check after the awaits: a send may have claimed the session meanwhile.
  // Everything from here to the pool insert is synchronous, so a run either
  // sees this process in the pool or has already blocked this prewarm.
  if (blocked()) {
    return false;
  }
  if (warmSessions.has(sessionId)) {
    return isUsable(warmSessions.get(sessionId));
  }
  const live = createLiveSession(sdkOptions, {
    fingerprint,
    appSessionId,
    warmEligible: true,
  });
  live.providerSessionId = sessionId;
  live.prewarmed = true;
  warmSessions.set(sessionId, live);
  live.idleTimer = setTimeout(() => closeLiveSession(live, 'idle-ttl'), readWarmTtlMs());
  live.idleTimer.unref?.();
  startLiveLoop(live);
  console.log('Prewarmed Claude process for session:', sessionId);
  enforceWarmCap();
  return warmSessions.get(sessionId) === live;
}

/**
 * Closes every parked warm process (call from graceful shutdown), including
 * prewarmed ones; in-flight prewarms are allowed to settle first (bounded) so
 * none parks after the sweep. Processes still serving a run are left to
 * finish; the process 'exit' hook hard-closes whatever remains.
 * @returns {Promise<void>} resolves once the parked processes exited (bounded)
 */
async function closeAllWarmClaudeSessions() {
  await Promise.all([...prewarmInflight.keys()].map((sessionId) => waitForInflightPrewarm(sessionId)));
  const parkedLives = [...warmSessions.values()];
  for (const live of parkedLives) {
    closeLiveSession(live, 'shutdown');
  }
  await Promise.all(parkedLives.map((live) => waitForLiveExit(live)));
}

/**
 * Retires the parked (or still booting) warm process for one provider session
 * so another client can resume the same transcript, e.g. Agent CLI starting
 * `claude --resume`. Processes serving a run are not in the pool and are left
 * alone.
 * @param {string} sessionId - provider session id
 * @returns {Promise<void>} resolves once the parked process exited (bounded)
 */
async function releaseWarmClaudeSession(sessionId) {
  if (!sessionId) {
    return;
  }
  await waitForInflightPrewarm(sessionId);
  const live = warmSessions.get(sessionId);
  if (!live) {
    return;
  }
  closeLiveSession(live, 'released');
  await waitForLiveExit(live);
}

/** Diagnostics / tests: current warm pool state. */
function getWarmClaudeSessionStats() {
  return {
    parked: [...warmSessions.keys()],
    prewarming: [...prewarmInflight.keys()],
    live: liveSessions.size,
    enabled: isWarmSessionsEnabled(),
    ttlMs: readWarmTtlMs(),
    max: readWarmMax(),
  };
}

/**
 * Shared canUseTool handler for inject and one-shot paths.
 */
async function handleCanUseTool(toolName, input, context, ctx) {
  const {
    sdkOptions,
    ws,
    capturedSessionIdRef,
    sessionId,
    sessionSummary,
    emitNotification,
    unattended = false,
    approvalTimeoutMs,
    cwd = null,
  } = ctx;
  const capturedSessionId = capturedSessionIdRef();
  const requiresInteraction = TOOLS_REQUIRING_INTERACTION.has(toolName);

  // Checked even for interactive tools (AskUserQuestion/ExitPlanMode): a
  // caller that explicitly disallows one is telling us nobody can ever
  // answer it, so deny immediately instead of sending a permission_request
  // that will just sit unanswered for the full approval-wait budget (up to
  // 10 minutes for unattended runs, forever for attended chat).
  const isDisallowed = (sdkOptions.disallowedTools || []).some(entry =>
    matchesToolPermission(entry, toolName, input)
  );
  if (isDisallowed) {
    return { behavior: 'deny', message: 'Tool disallowed by settings' };
  }

  // Bot gateway runs: the bot's built-in tool gate decides everything except the interactive
  // tools, which keep the normal path below (they are disallowed for unattended bot runs).
  const builtinToolGate = builtinToolGates.get(sdkOptions);
  if (builtinToolGate && !requiresInteraction) {
    try {
      const verdict = await builtinToolGate(toolName, input);
      return verdict.behavior === 'allow'
        ? { behavior: 'allow', updatedInput: input }
        : { behavior: 'deny', message: verdict.message || 'Blocked by the bot tool gate' };
    } catch (error) {
      return { behavior: 'deny', message: `Bot tool gate failed, call refused: ${error?.message || error}` };
    }
  }

  if (!requiresInteraction) {
    if (sdkOptions.permissionMode === 'bypassPermissions') {
      return { behavior: 'allow', updatedInput: input };
    }

    const isAllowed = (sdkOptions.allowedTools || []).some(entry =>
      matchesToolPermission(entry, toolName, input)
    );
    if (isAllowed) {
      return { behavior: 'allow', updatedInput: input };
    }
  }

  const requestId = createRequestId();
  ws.send(createNormalizedMessage({
    kind: 'permission_request',
    requestId,
    toolName,
    input,
    sessionId: capturedSessionId || sessionId || null,
    provider: 'claude',
    cwd,
    paths: extractPermissionPaths(input),
    unattended,
  }));
  emitNotification(createNotificationEvent({
    provider: 'claude',
    sessionId: capturedSessionId || sessionId || null,
    kind: 'action_required',
    code: 'permission.required',
    meta: { toolName, sessionName: sessionSummary },
    severity: 'warning',
    requiresUserAction: true,
    dedupeKey: `claude:permission:${capturedSessionId || sessionId || 'none'}:${requestId}`
  }));

  // Unattended runs get a bounded wait for EVERY request — including the
  // interactive tools (e.g. ExitPlanMode), which would otherwise wait
  // forever with nobody attached. The permission broker answers within the
  // budget or the request is denied. Interactive chat is unchanged.
  const unattendedWaitMs = resolveApprovalTimeoutMs({ unattended, approvalTimeoutMs });
  const decision = await waitForToolApproval(requestId, {
    timeoutMs: unattended
      ? unattendedWaitMs
      : (TOOL_APPROVAL_TIMEOUT_MS > 0 && !requiresInteraction
        ? TOOL_APPROVAL_TIMEOUT_MS
        : 0),
    signal: context?.signal,
    metadata: {
      _sessionId: capturedSessionId || sessionId || null,
      _toolName: toolName,
      _input: input,
      _receivedAt: new Date(),
    },
    onCancel: (reason) => {
      ws.send(createNormalizedMessage({ kind: 'permission_cancelled', requestId, reason, sessionId: capturedSessionId || sessionId || null, provider: 'claude' }));
    }
  });
  if (!decision) {
    if (unattended) {
      console.warn(`[claude-sdk] session=${capturedSessionId || sessionId || 'none'} unattended approval for "${toolName}" timed out after ${unattendedWaitMs}ms — denying`);
    }
    return { behavior: 'deny', message: 'Permission request timed out' };
  }

  if (decision.cancelled) {
    return { behavior: 'deny', message: 'Permission request cancelled' };
  }

  if (decision.allow) {
    if (decision.rememberEntry && typeof decision.rememberEntry === 'string') {
      if (!sdkOptions.allowedTools.includes(decision.rememberEntry)) {
        sdkOptions.allowedTools.push(decision.rememberEntry);
      }
      if (Array.isArray(sdkOptions.disallowedTools)) {
        sdkOptions.disallowedTools = sdkOptions.disallowedTools.filter(entry => entry !== decision.rememberEntry);
      }
    }
    return { behavior: 'allow', updatedInput: decision.updatedInput ?? input };
  }

  return { behavior: 'deny', message: decision.message ?? 'User denied tool use' };
}

/**
 * Aborts an active SDK session
 * @param {string} sessionId - Session identifier
 * @returns {boolean} True if session was aborted, false if not found
 */
async function abortClaudeSDKSession(sessionId) {
  const aliased = appSessionAliases.get(sessionId);
  const session = getSession(sessionId) || (aliased ? getSession(aliased) : null);

  if (!session) {
    console.log(`Session ${sessionId} not found`);
    return false;
  }

  try {
    console.log(`Aborting SDK session: ${sessionId}`);

    // Mark before interrupting so the run loop knows not to emit its own
    // terminal complete (the abort handler sends the aborted one).
    abortedSessionIds.add(sessionId);
    if (session.appSessionId) {
      abortedSessionIds.add(session.appSessionId);
    }
    if (aliased) {
      abortedSessionIds.add(aliased);
    }

    if (session.channel) {
      session.channel.end();
    }
    if (session.appSessionId) {
      pendingInjections.delete(session.appSessionId);
    }

    // Call interrupt() on the query instance
    await session.instance.interrupt();

    // Update session status
    session.status = 'aborted';

    // Clean up session (app-id alias and provider-native id may both be keyed)
    removeSession(sessionId);
    if (session.appSessionId) {
      removeSession(session.appSessionId);
    }
    if (aliased) {
      removeSession(aliased);
    }

    return true;
  } catch (error) {
    console.error(`Error aborting session ${sessionId}:`, error);
    // The run keeps going; let it emit its own terminal complete.
    abortedSessionIds.delete(sessionId);
    return false;
  }
}

/**
 * Injects a follow-up user message into a live chat run (same process).
 * Returns false when no open inject-mode channel exists so the caller can
 * fall back to RUN_IN_PROGRESS.
 *
 * @param {string} command
 * @param {Object} options - sessionId / appSessionId / images / cwd
 * @returns {Promise<boolean>}
 */
async function injectClaudeMessage(command, options = {}) {
  const providerSessionId = options.sessionId
    || (options.appSessionId ? appSessionAliases.get(options.appSessionId) : null);
  let session = providerSessionId ? getSession(providerSessionId) : null;

  // Resolve via appSessionId when provider id is not mapped yet.
  if ((!session || !session.channel) && options.appSessionId) {
    for (const entry of activeSessions.values()) {
      if (
        entry.appSessionId === options.appSessionId
        && entry.status === 'active'
        && entry.channel
        && !entry.channel.ended
      ) {
        session = entry;
        break;
      }
    }
  }

  if (session && session.status === 'active' && session.channel && !session.channel.ended) {
    const message = await buildSDKUserMessage(command, options.images, options.cwd);
    return session.channel.push(message);
  }

  // Live inject-mode run exists for this app session but provider id not
  // captured yet (first turn) — buffer until registerAppSessionAlias flushes.
  if (options.appSessionId) {
    let liveWithoutId = false;
    for (const entry of activeSessions.values()) {
      if (
        entry.appSessionId === options.appSessionId
        && entry.status === 'active'
        && entry.channel
        && !entry.channel.ended
      ) {
        liveWithoutId = true;
        break;
      }
    }
    // Also allow buffer during the brief window before addSession (channel
    // not registered yet) only when alias is already expected: no — without a
    // live session we must return false so RUN_IN_PROGRESS is correct.
    if (liveWithoutId) {
      const message = await buildSDKUserMessage(command, options.images, options.cwd);
      const buffered = pendingInjections.get(options.appSessionId) || [];
      buffered.push(message);
      pendingInjections.set(
        options.appSessionId,
        buffered.length > 5 ? buffered.slice(-5) : buffered,
      );
      return true;
    }
  }

  return false;
}

/**
 * Checks if an SDK session is currently active
 * @param {string} sessionId - Session identifier
 * @returns {boolean} True if session is active
 */
function isClaudeSDKSessionActive(sessionId) {
  const session = getSession(sessionId);
  return session && session.status === 'active';
}

/**
 * Gets all active SDK session IDs
 * @returns {Array<string>} Array of active session IDs
 */
function getActiveClaudeSDKSessions() {
  return getAllSessions();
}

/**
 * Get pending tool approvals for a specific session.
 * @param {string} sessionId - The session ID
 * @returns {Array} Array of pending permission request objects
 */
function getPendingApprovalsForSession(sessionId) {
  const pending = [];
  for (const [requestId, resolver] of pendingToolApprovals.entries()) {
    if (resolver._sessionId === sessionId) {
      pending.push({
        requestId,
        toolName: resolver._toolName || 'UnknownTool',
        input: resolver._input,
        context: resolver._context,
        sessionId,
        receivedAt: resolver._receivedAt || new Date(),
      });
    }
  }
  return pending;
}

/**
 * Reconnect a session's WebSocketWriter to a new raw WebSocket.
 * Called when client reconnects (e.g. page refresh) while SDK is still running.
 * @param {string} sessionId - The session ID
 * @param {Object} newRawWs - The new raw WebSocket connection
 * @returns {boolean} True if writer was successfully reconnected
 */
function reconnectSessionWriter(sessionId, newRawWs) {
  const session = getSession(sessionId);
  if (!session?.writer?.updateWebSocket) return false;
  session.writer.updateWebSocket(newRawWs);
  console.log(`[RECONNECT] Writer swapped for session ${sessionId}`);
  return true;
}

// Export public API
export {
  queryClaudeSDK,
  injectClaudeMessage,
  abortClaudeSDKSession,
  isClaudeSDKSessionActive,
  getActiveClaudeSDKSessions,
  resolveToolApproval,
  getPendingApprovalsForSession,
  reconnectSessionWriter,
  waitForToolApproval,
  resolveApprovalTimeoutMs,
  extractPermissionPaths,
  extractTokenBudget,
  createRequestId,
  mapCliOptionsToSDK,
  prepareClaudeSdkOptions,
  handleCanUseTool,
  installBuiltinToolGate,
  stampLeadSessionOnMcpServers,
  applyPlanModeAllowedTools,
  trackBackgroundTask,
  isTurnActivityMessage,
  prewarmClaudeSession,
  closeAllWarmClaudeSessions,
  releaseWarmClaudeSession,
  getWarmClaudeSessionStats,
  computeWarmFingerprint,
  readJsonFileCached,
  __setClaudeSdkTestOverrides,
};
