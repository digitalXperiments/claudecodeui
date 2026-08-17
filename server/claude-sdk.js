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
import { buildClaudeTokenBudgetFromUsage } from './modules/providers/list/claude/claude-token-usage.js';

const activeSessions = new Map();
const pendingToolApprovals = new Map();
// Sessions cancelled via abort-session. The abort handler already sent the
// terminal `complete` (aborted: true) to the client, so the run loop must not
// emit a second one when its generator winds down.
const abortedSessionIds = new Set();
// app session id -> provider session id (chat mid-run inject addressing).
const appSessionAliases = new Map();
// app session id -> SDKUserMessage[] buffered before provider id is known.
const pendingInjections = new Map();
// After a successful `result`, wait this long for a late inject before closing
// stdin so the CLI process can exit. Only used on chat runs (appSessionId set).
const RUN_DRAIN_GRACE_MS = 750;

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

function mapCliOptionsToSDK(options = {}) {
  const { sessionId, cwd, toolsSettings, permissionMode, effort } = options;

  const sdkOptions = {};

  // Forward all host env vars (e.g. ANTHROPIC_BASE_URL) to the subprocess.
  // Since SDK 0.2.113, options.env replaces process.env instead of overlaying it.
  sdkOptions.env = { ...process.env };

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

  let allowedTools = [...(settings.allowedTools || [])];

  if (permissionMode === 'plan') {
    const planModeTools = ['Read', 'Task', 'exit_plan_mode', 'TodoRead', 'TodoWrite', 'WebFetch', 'WebSearch'];
    for (const tool of planModeTools) {
      if (!allowedTools.includes(tool)) {
        allowedTools.push(tool);
      }
    }
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

  sdkOptions.settingSources = ['project', 'user', 'local'];

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
async function loadMcpConfig(cwd) {
  try {
    const claudeConfigPath = path.join(os.homedir(), '.claude.json');

    // Check if config file exists
    try {
      await fs.access(claudeConfigPath);
    } catch (error) {
      // File doesn't exist, return null
      // No config file
      return null;
    }

    // Read and parse config file
    let claudeConfig;
    try {
      const configContent = await fs.readFile(claudeConfigPath, 'utf8');
      claudeConfig = JSON.parse(configContent);
    } catch (error) {
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
        const projectMcp = JSON.parse(await fs.readFile(projectMcpPath, 'utf8'));
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
              const raw = JSON.parse(await fs.readFile(candidate, 'utf8'));
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
    return mcpServers;
  } catch (error) {
    console.error('Error loading MCP config:', error.message);
    return null;
  }
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
  let channel = null;
  let settleDone = null;
  let drainTimer = null;

  const emitNotification = (event) => {
    notifyUserIfEnabled({
      userId: ws?.userId || null,
      writer: ws,
      event
    });
  };

  try {
    const resolvedModel = await providerModelsService.resolveResumeModel(
      'claude',
      sessionId,
      options.model,
    );
    let effortModels = CLAUDE_FALLBACK_MODELS;
    try {
      effortModels = (await providerModelsService.getProviderModels('claude')).models;
    } catch (error) {
      console.warn('[Claude SDK] Unable to load provider models for effort validation:', error);
    }

    const sdkOptions = mapCliOptionsToSDK({
      ...options,
      model: resolvedModel || options.model,
      effortModels,
    });

    const mcpServers = await loadMcpConfig(options.cwd);
    if (mcpServers) {
      sdkOptions.mcpServers = mcpServers;
    }

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

      channel = createInputChannel();
      const firstMessage = await buildSDKUserMessage(command, options.images, options.cwd);
      channel.push(firstMessage);

      // A push during post-result grace cancels drain so the run continues.
      const rawPush = channel.push.bind(channel);
      channel.push = (message) => {
        if (drainTimer) {
          clearTimeout(drainTimer);
          drainTimer = null;
        }
        return rawPush(message);
      };

      // Re-bind sessionExtras with real donePromise
      const injectExtras = {
        channel,
        appSessionId: options.appSessionId || null,
        donePromise,
      };

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

      sdkOptions.canUseTool = async (toolName, input, context) => {
        // While a tool is waiting on the user, never close stdin (drain).
        if (drainTimer) {
          clearTimeout(drainTimer);
          drainTimer = null;
        }
        return handleCanUseTool(toolName, input, context, {
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
      };

      const prevStreamTimeout = process.env.CLAUDE_CODE_STREAM_CLOSE_TIMEOUT;
      process.env.CLAUDE_CODE_STREAM_CLOSE_TIMEOUT = '300000';

      let queryInstance;
      try {
        queryInstance = query({
          prompt: channel.iterator,
          options: sdkOptions
        });
      } catch (hookError) {
        console.warn('Failed to initialize Claude query with hooks, retrying without hooks:', hookError?.message || hookError);
        delete sdkOptions.hooks;
        channel = createInputChannel();
        channel.push(firstMessage);
        const rawPushRetry = channel.push.bind(channel);
        channel.push = (message) => {
          if (drainTimer) {
            clearTimeout(drainTimer);
            drainTimer = null;
          }
          return rawPushRetry(message);
        };
        injectExtras.channel = channel;
        queryInstance = query({
          prompt: channel.iterator,
          options: sdkOptions
        });
      }

      if (prevStreamTimeout !== undefined) {
        process.env.CLAUDE_CODE_STREAM_CLOSE_TIMEOUT = prevStreamTimeout;
      } else {
        delete process.env.CLAUDE_CODE_STREAM_CLOSE_TIMEOUT;
      }

      if (capturedSessionId) {
        addSession(capturedSessionId, queryInstance, ws, injectExtras);
        registerAppSessionAlias(options.appSessionId, capturedSessionId, channel);
      }

      console.log('Starting async generator loop for session:', capturedSessionId || 'NEW', '(inject mode)');
      for await (const message of queryInstance) {
        if (message.session_id && !capturedSessionId) {
          capturedSessionId = message.session_id;
          addSession(capturedSessionId, queryInstance, ws, injectExtras);
          registerAppSessionAlias(options.appSessionId, capturedSessionId, channel);

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

        // Close stdin only after a turn result *and* no pending UI tool approvals.
        // Do not emit `complete` here — that still happens when the loop ends
        // (same contract as the one-shot path). Premature complete+channel.end
        // during tool_use is what previously triggered ede_diagnostic failures.
        if (message.type === 'result' && channel && !channel.ended) {
          if (drainTimer) {
            clearTimeout(drainTimer);
          }
          const scheduleDrain = () => {
            drainTimer = setTimeout(() => {
              drainTimer = null;
              if (channel.ended) {
                return;
              }
              if (countPendingApprovalsForSession(capturedSessionId || sessionId || null) > 0) {
                scheduleDrain();
                return;
              }
              if (capturedSessionId && abortedSessionIds.has(capturedSessionId)) {
                return;
              }
              channel.end();
            }, RUN_DRAIN_GRACE_MS);
            drainTimer.unref?.();
          };
          scheduleDrain();
        }
      }

      if (capturedSessionId) {
        removeSession(capturedSessionId);
      }

      const wasAborted = capturedSessionId ? abortedSessionIds.delete(capturedSessionId) : false;
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

      const prevStreamTimeout = process.env.CLAUDE_CODE_STREAM_CLOSE_TIMEOUT;
      process.env.CLAUDE_CODE_STREAM_CLOSE_TIMEOUT = '300000';

      let queryInstance;
      try {
        queryInstance = query({
          prompt: await createOneShotPrompt(),
          options: sdkOptions
        });
      } catch (hookError) {
        console.warn('Failed to initialize Claude query with hooks, retrying without hooks:', hookError?.message || hookError);
        delete sdkOptions.hooks;
        queryInstance = query({
          prompt: await createOneShotPrompt(),
          options: sdkOptions
        });
      }

      if (prevStreamTimeout !== undefined) {
        process.env.CLAUDE_CODE_STREAM_CLOSE_TIMEOUT = prevStreamTimeout;
      } else {
        delete process.env.CLAUDE_CODE_STREAM_CLOSE_TIMEOUT;
      }

      if (capturedSessionId) {
        addSession(capturedSessionId, queryInstance, ws);
      }

      console.log('Starting async generator loop for session:', capturedSessionId || 'NEW');
      for await (const message of queryInstance) {
        if (message.session_id && !capturedSessionId) {
          capturedSessionId = message.session_id;
          addSession(capturedSessionId, queryInstance, ws);

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

      if (capturedSessionId) {
        removeSession(capturedSessionId);
      }

      const wasAborted = capturedSessionId ? abortedSessionIds.delete(capturedSessionId) : false;
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

    if (capturedSessionId) {
      removeSession(capturedSessionId);
    }

    const wasAborted = capturedSessionId ? abortedSessionIds.delete(capturedSessionId) : false;
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
    if (drainTimer) {
      clearTimeout(drainTimer);
      drainTimer = null;
    }
    if (channel) {
      channel.end();
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

  if (!requiresInteraction) {
    if (sdkOptions.permissionMode === 'bypassPermissions') {
      return { behavior: 'allow', updatedInput: input };
    }

    const isDisallowed = (sdkOptions.disallowedTools || []).some(entry =>
      matchesToolPermission(entry, toolName, input)
    );
    if (isDisallowed) {
      return { behavior: 'deny', message: 'Tool disallowed by settings' };
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
  const session = getSession(sessionId);

  if (!session) {
    console.log(`Session ${sessionId} not found`);
    return false;
  }

  try {
    console.log(`Aborting SDK session: ${sessionId}`);

    // Mark before interrupting so the run loop knows not to emit its own
    // terminal complete (the abort handler sends the aborted one).
    abortedSessionIds.add(sessionId);

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

    // Clean up session
    removeSession(sessionId);

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
  createRequestId
};
