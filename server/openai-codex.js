/**
 * OpenAI Codex app-server Integration
 * =============================
 *
 * This module provides integration with the OpenAI Codex app-server for
 * interactive chat sessions. It mirrors the normalized message and approval
 * bridge used in claude-sdk.js for consistency.
 *
 * ## Usage
 *
 * - queryCodex(command, options, ws) - Execute a prompt with streaming via WebSocket
 * - abortCodexSession(sessionId) - Cancel an active session
 * - isCodexSessionActive(sessionId) - Check if a session is running
 * - getActiveCodexSessions() - List all active sessions
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildCodexInputItems, normalizeImageDescriptors } from './shared/image-attachments.js';
import { createCodexAppServer, resolveCodexLauncher } from './codex-app-server.js';
import {
  createNotificationEvent,
  notifyUserIfEnabled,
  notifyRunFailed,
  notifyRunStopped,
} from './services/notification-orchestrator.js';
import { createRequestId, extractPermissionPaths, resolveApprovalTimeoutMs, waitForToolApproval } from './claude-sdk.js';
import { sessionsService } from './modules/providers/services/sessions.service.js';
import { providerAuthService } from './modules/providers/services/provider-auth.service.js';
import { providerModelsService } from './modules/providers/services/provider-models.service.js';
import { obsidianSettingsService } from './modules/providers/services/obsidian-settings.service.js';
import {
  buildObsidianCodexRuntimeConfig,
  OBSIDIAN_MCP_SERVER_NAME,
} from './modules/providers/shared/memory/obsidian-mcp.config.js';
import { resolveCodexServiceTier } from './modules/providers/list/codex/codex-service-tier.js';
import { createCompleteMessage, createNormalizedMessage } from './shared/utils.js';
import { buildCodexTokenUsage } from './modules/providers/list/codex/codex-token-usage.js';
import { leadSessionEnv } from './shared/lead-session-env.js';
import { mapPermissionModeToCodexOptions } from './modules/providers/list/codex/codex-permission-mode.js';
import { codexSandboxConfig, workerGitGuardEnv } from './shared/worker-sandbox.js';
import { appServerItemToLegacy } from './modules/providers/list/codex/codex-app-server-items.js';
import {
  CODEX_STRICT_PROFILE,
  assertStrictRunInputs,
  buildStrictCodexConfig,
  buildStrictCodexEnv,
  decideStrictApproval,
  prepareStrictCodexHome,
  resolveStrictPolicy,
  strictAllowReadPaths,
  strictDenyReadPaths,
} from './modules/providers/list/codex/codex-gateway-strict.js';

const activeCodexSessions = new Map();

// ---------------------------------------------------------------------------
// Warm Codex app-server pool (mirrors the warm Claude pool in claude-sdk.js)
//
// An interactive chat turn used to spawn `codex app-server`, initialize it,
// `thread/resume` the thread and close the process in `finally`. When warm
// sessions are enabled, a cleanly finished interactive turn instead parks the
// process keyed by its thread id; the next turn of the same thread skips
// spawn + initialize + thread/resume and goes straight to `turn/start`.
//
//   - Only process-level settings (spawn cwd, full env incl. auth/identity,
//     `--config` overrides incl. MCP servers, launcher, sandbox mode, Codex
//     auth file) participate in the fingerprint. model / effort / approval
//     policy / reviewer / service tier are `turn/start` params and are sent
//     explicitly every turn. Because an omitted turn/start override means
//     "keep the thread's current value", a turn that *clears* an override the
//     warm process was given (effort -> default, tier -> none) respawns.
//   - Each run subscribes its own message handler and unsubscribes it before
//     parking. While parked an idle guard drops harmless notifications and
//     retires the process on any turn/item activity or server request.
//     Notifications carrying a turn id from an earlier run are dropped.
//   - Abort, errors, or an unclean turn end retire the process (never reused).
//   - A warm process that died (or rejects turn/start) falls back to a fresh
//     spawn transparently.
//
// Flags: CLOUDCLI_WARM_CODEX_SESSIONS=0 disables (old behaviour);
// CLOUDCLI_CODEX_WARM_TTL_MS idle TTL (default 10 min, 0 disables);
// CLOUDCLI_CODEX_WARM_MAX parked-process cap (default 3, LRU eviction).
// ---------------------------------------------------------------------------

const DEFAULT_CODEX_WARM_TTL_MS = 10 * 60_000;
const DEFAULT_CODEX_WARM_MAX = 3;
const CODEX_WARM_EXIT_WAIT_MS = 3_000;
// Server notifications that mean a parked (idle) process is doing turn work
// nobody is listening to; the process is retired when one arrives.
const CODEX_IDLE_ACTIVITY_METHODS = new Set([
  'turn/started',
  'turn/completed',
  'turn/diff/updated',
  'turn/plan/updated',
  'thread/closed',
  'thread/deleted',
  'thread/archived',
  'error',
]);

// threadId -> parked warm entry (insertion order = LRU order).
const warmCodexSessions = new Map();
// Every app-server client this module spawned that has not exited yet.
const liveCodexServers = new Set();
let codexExitHookInstalled = false;
let codexTestOverrides = {};

/** Test seam: replace spawn / model lookups / runtime helpers with fakes. */
export function __setCodexTestOverrides(overrides) {
  codexTestOverrides = overrides || {};
}

function isCodexWarmEnabled() {
  return process.env.CLOUDCLI_WARM_CODEX_SESSIONS !== '0';
}

function readCodexWarmTtlMs() {
  const raw = process.env.CLOUDCLI_CODEX_WARM_TTL_MS;
  if (raw === undefined || raw === '') {
    return DEFAULT_CODEX_WARM_TTL_MS;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_CODEX_WARM_TTL_MS;
}

function readCodexWarmMax() {
  const parsed = Number(process.env.CLOUDCLI_CODEX_WARM_MAX);
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : DEFAULT_CODEX_WARM_MAX;
}

/**
 * Warm reuse is for interactive chat only: automation (unattended), relay
 * workers (their worktree can be landed/discarded underneath a parked
 * process) and callers that opt out keep the one-process-per-run model.
 */
function isCodexWarmEligible(options = {}) {
  return isCodexWarmEnabled()
    && readCodexWarmTtlMs() > 0
    && Boolean(options.appSessionId)
    && !options.relayWorker
    && !options.unattended
    // A gateway-bound run owns a throwaway CODEX_HOME that is deleted when the run ends.
    && !options.botGatewayStrict
    && options.warmSession !== false;
}

function hashJson(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);
}

function sortedEntries(object) {
  return Object.keys(object || {}).sort().map((key) => [key, object[key]]);
}

/** mtime of the Codex auth file, so a re-login respawns the warm process. */
function readCodexAuthStamp(env) {
  if (codexTestOverrides.authStamp) {
    return codexTestOverrides.authStamp(env);
  }
  try {
    const codexHome = env?.CODEX_HOME || path.join(os.homedir(), '.codex');
    return fs.statSync(path.join(codexHome, 'auth.json')).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * Everything baked into the app-server process at spawn time. Two runs with
 * the same fingerprint can share one process; any difference respawns.
 */
function computeCodexWarmFingerprint(spawnOptions, { appSessionId = null, sandbox = null } = {}) {
  let launcher = null;
  try {
    launcher = resolveCodexLauncher();
  } catch {
    launcher = null;
  }
  return JSON.stringify({
    appSessionId,
    cwd: spawnOptions.cwd || null,
    sandbox: sandbox || null,
    config: hashJson(spawnOptions.config || {}),
    env: hashJson(sortedEntries(spawnOptions.env)),
    launcher,
    auth: readCodexAuthStamp(spawnOptions.env),
  });
}

function installCodexExitHook() {
  if (codexExitHookInstalled) {
    return;
  }
  codexExitHookInstalled = true;
  // Last resort: 'exit' handlers must be synchronous; close() SIGTERMs the
  // child synchronously so no orphaned app-server survives a restart.
  process.once('exit', () => {
    for (const rpc of liveCodexServers) {
      try {
        rpc.close();
      } catch {
        // ignore
      }
    }
  });
}

function spawnCodexServer(spawnOptions) {
  const create = codexTestOverrides.createCodexAppServer || createCodexAppServer;
  const rpc = create({
    ...spawnOptions,
    ...(codexTestOverrides.spawn ? { spawnFn: codexTestOverrides.spawn } : {}),
  });
  installCodexExitHook();
  liveCodexServers.add(rpc);
  rpc.onExit?.(() => liveCodexServers.delete(rpc));
  return rpc;
}

/** A process wrapper that may outlive one run by being parked. */
function createCodexLive(rpc, { fingerprint = null, appSessionId = null } = {}) {
  const live = {
    rpc,
    fingerprint,
    appSessionId,
    threadId: null,
    closed: false,
    closeReason: null,
    idleTimer: null,
    idleUnsubscribe: null,
    // Turn ids already finished on this process: their stragglers are dropped.
    finishedTurnIds: new Set(),
    // Last explicit turn/start overrides (sticky in the app-server thread).
    model: null,
    activeModel: null,
    effort: null,
    serviceTier: undefined,
    turns: 0,
  };
  live.exitUnsubscribe = rpc.onExit?.(() => {
    retireCodexLive(live, live.closed ? live.closeReason : 'exited');
  }) || null;
  return live;
}

function clearCodexIdleState(live) {
  if (live.idleTimer) {
    clearTimeout(live.idleTimer);
    live.idleTimer = null;
  }
  if (live.idleUnsubscribe) {
    live.idleUnsubscribe();
    live.idleUnsubscribe = null;
  }
}

/**
 * Removes a process from the pool, drops every listener this module attached
 * and closes the app-server (stdio pipes destroyed, SIGTERM then SIGKILL).
 * Safe to call repeatedly.
 */
function retireCodexLive(live, reason = 'closed') {
  if (!live) {
    return;
  }
  clearCodexIdleState(live);
  if (live.threadId && warmCodexSessions.get(live.threadId) === live) {
    warmCodexSessions.delete(live.threadId);
  }
  if (live.closed) {
    return;
  }
  live.closed = true;
  live.closeReason = reason;
  live.exitUnsubscribe?.();
  live.exitUnsubscribe = null;
  try {
    live.rpc.close();
  } catch {
    // ignore
  }
}

async function waitForCodexExit(live, timeoutMs = CODEX_WARM_EXIT_WAIT_MS) {
  if (!live?.rpc?.exited) {
    return;
  }
  let timer = null;
  await Promise.race([
    live.rpc.exited,
    new Promise((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
      timer.unref?.();
    }),
  ]);
  if (timer) {
    clearTimeout(timer);
  }
}

function enforceCodexWarmCap() {
  const max = readCodexWarmMax();
  while (warmCodexSessions.size > max) {
    const [, oldest] = warmCodexSessions.entries().next().value;
    retireCodexLive(oldest, 'lru');
  }
}

function codexMessageTurnId(params) {
  return params?.turnId || params?.turn?.id || null;
}

/** Guard installed while parked: nobody is listening, so any work retires. */
function createCodexIdleGuard(live) {
  return (message) => {
    if (!message || typeof message !== 'object') {
      return;
    }
    if (typeof message.id !== 'undefined' && typeof message.method === 'string') {
      // A server request while idle: nobody can answer it. Reply empty so
      // the app-server does not wait, then retire the process.
      try {
        live.rpc.respond(message.id, {});
      } catch {
        // ignore
      }
      retireCodexLive(live, 'idle-request');
      return;
    }
    const method = typeof message.method === 'string' ? message.method : '';
    const turnId = codexMessageTurnId(message.params);
    if (turnId && live.finishedTurnIds.has(turnId) && method !== 'turn/started') {
      return; // straggler from the turn that just finished
    }
    if (CODEX_IDLE_ACTIVITY_METHODS.has(method) || method.startsWith('item/')) {
      console.warn(`[Codex] Warm app-server for ${live.threadId} emitted "${method}" while idle — retiring`);
      retireCodexLive(live, 'idle-activity');
    }
  };
}

function parkCodexLive(live, threadId) {
  live.threadId = threadId;
  const existing = warmCodexSessions.get(threadId);
  if (existing && existing !== live) {
    retireCodexLive(existing, 'replaced');
  }
  warmCodexSessions.delete(threadId);
  warmCodexSessions.set(threadId, live);
  live.idleUnsubscribe = live.rpc.onMessage(createCodexIdleGuard(live));
  live.idleTimer = setTimeout(() => retireCodexLive(live, 'idle-ttl'), readCodexWarmTtlMs());
  live.idleTimer.unref?.();
  enforceCodexWarmCap();
}

/**
 * The app-server treats an omitted turn/start override as "keep the thread's
 * current value". A cold process re-reads the thread from disk, so clearing an
 * override (back to default) is only faithful on a fresh process.
 */
function turnOverridesCompatible(live, { model, effort, serviceTier }) {
  if (live.model && !model) return false;
  if (live.effort && !effort) return false;
  if (live.serviceTier !== undefined && serviceTier === undefined) return false;
  return true;
}

/**
 * Takes the parked process for `threadId` when it is alive and its
 * fingerprint matches; otherwise retires it and waits (bounded) for it to
 * exit so two app-servers never drive the same thread at once.
 */
async function acquireWarmCodexSession(threadId, fingerprint, turnOverrides) {
  const warm = threadId ? warmCodexSessions.get(threadId) : null;
  if (!warm) {
    return null;
  }
  if (
    fingerprint
    && !warm.closed
    && warm.rpc.alive !== false
    && warm.fingerprint === fingerprint
    && turnOverridesCompatible(warm, turnOverrides)
  ) {
    warmCodexSessions.delete(threadId);
    clearCodexIdleState(warm);
    return warm;
  }
  retireCodexLive(warm, fingerprint ? 'options-changed' : 'not-eligible');
  await waitForCodexExit(warm);
  return null;
}

/**
 * Closes every parked warm app-server (call from graceful shutdown).
 * Processes still serving a run are left to finish; the process 'exit' hook
 * closes whatever remains.
 */
export async function closeAllWarmCodexSessions() {
  const parked = [...warmCodexSessions.values()];
  for (const live of parked) {
    retireCodexLive(live, 'shutdown');
  }
  await Promise.all(parked.map((live) => waitForCodexExit(live)));
}

/**
 * Retires the parked app-server for one thread so another client can resume
 * it, e.g. Agent CLI starting `codex resume`.
 */
export async function releaseWarmCodexSession(threadId) {
  const live = threadId ? warmCodexSessions.get(threadId) : null;
  if (!live) {
    return;
  }
  retireCodexLive(live, 'released');
  await waitForCodexExit(live);
}

/** Diagnostics / tests: current warm pool state. */
export function getWarmCodexSessionStats() {
  return {
    parked: [...warmCodexSessions.keys()],
    live: liveCodexServers.size,
    enabled: isCodexWarmEnabled(),
    ttlMs: readCodexWarmTtlMs(),
    max: readCodexWarmMax(),
  };
}

/**
 * Resolve CloudCLI's managed Obsidian MCP into the environment/configuration
 * used by the Codex CLI child process. Codex's standalone config is still
 * honored for every other MCP server; this explicit overlay also covers runs
 * whose HOME/project config is not the one CloudCLI used to fan out MCPs.
 */
function loadManagedObsidianCodexRuntime() {
  try {
    const settings = obsidianSettingsService.getSettings();
    if (!settings.restApiKey || !settings.restApiKey.trim()) {
      return null;
    }

    return buildObsidianCodexRuntimeConfig(settings);
  } catch (error) {
    console.warn(
      `[Codex app-server] Could not inject managed ${OBSIDIAN_MCP_SERVER_NAME} MCP:`,
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}

function buildCodexAppServerInput(command, images, workingDirectory) {
  const sdkInput = normalizeImageDescriptors(images).length > 0
    ? buildCodexInputItems(command, images, workingDirectory)
    : [{ type: 'text', text: command }];

  return sdkInput.map((item) => (
    item.type === 'local_image'
      ? { type: 'localImage', path: item.path }
      : item
  ));
}

function extractAppServerTokenBudget(tokenUsage, model) {
  return buildCodexTokenUsage({
    total: tokenUsage?.total,
    last: tokenUsage?.last,
    modelContextWindow: tokenUsage?.modelContextWindow,
    model,
  });
}

function codexApprovalDecision(decision) {
  if (!decision || decision.cancelled) {
    return 'cancel';
  }
  if (!decision.allow) {
    return 'decline';
  }
  return decision.rememberEntry ? 'acceptForSession' : 'accept';
}

function codexLegacyApprovalDecision(decision) {
  if (!decision || decision.cancelled) {
    return 'abort';
  }
  if (!decision.allow) {
    return 'denied';
  }
  return decision.rememberEntry ? 'approved_for_session' : 'approved';
}

function normalizeCodexQuestionInput(questions) {
  return Array.isArray(questions)
    ? questions.map((question) => ({
      question: question.question || '',
      header: question.header || undefined,
      multiSelect: false,
      options: Array.isArray(question.options)
        ? question.options.map((option) => ({
          label: option.label || '',
          description: option.description || undefined,
        }))
        : [],
    }))
    : [];
}

function toCodexQuestionAnswers(questions, answers) {
  if (!answers || typeof answers !== 'object') {
    return {};
  }

  const result = {};
  for (const question of Array.isArray(questions) ? questions : []) {
    const answer = answers[question.question];
    if (typeof answer !== 'string' || !answer.trim()) {
      continue;
    }
    result[question.id] = { answers: answer.split(',').map((part) => part.trim()).filter(Boolean) };
  }
  return result;
}

async function waitForCodexApproval({
  rpc,
  request,
  ws,
  sessionId,
  sessionSummary,
  abortSignal,
  toolName,
  input,
  providerRequest,
  unattended = false,
  approvalWaitMs = 0,
  cwd = null,
}) {
  const requestId = createRequestId();
  sendMessage(ws, createNormalizedMessage({
    kind: 'permission_request',
    requestId,
    toolName,
    input,
    sessionId,
    provider: 'codex',
    cwd,
    paths: extractPermissionPaths(input),
    unattended,
  }));

  notifyUserIfEnabled({
    userId: ws?.userId || null,
    event: createNotificationEvent({
      provider: 'codex',
      sessionId,
      kind: 'action_required',
      code: 'permission.required',
      meta: { toolName, sessionName: sessionSummary },
      severity: 'warning',
      requiresUserAction: true,
      dedupeKey: `codex:permission:${sessionId || 'none'}:${requestId}`,
    }),
  });

  // Interactive chat waits indefinitely (timeoutMs 0); unattended (swarm)
  // runs wait a bounded window for the permission broker to answer.
  let decision = await waitForToolApproval(requestId, {
    timeoutMs: unattended ? approvalWaitMs : 0,
    signal: abortSignal,
    metadata: {
      _sessionId: sessionId,
      _toolName: toolName,
      _input: input,
      _receivedAt: new Date(),
    },
    onCancel: (reason) => {
      sendMessage(ws, createNormalizedMessage({
        kind: 'permission_cancelled',
        requestId,
        reason,
        sessionId,
        provider: 'codex',
      }));
    },
  });

  // A null decision (timeout) would map to 'cancel'/'abort' in the decision
  // translators and kill the whole turn; an unattended expiry should instead
  // take the normal deny path so the agent can continue without the tool.
  if (unattended && !decision) {
    console.warn(`[Codex] session=${sessionId} unattended approval for "${toolName}" timed out after ${approvalWaitMs}ms — denying`);
    decision = { allow: false, message: 'Unattended permission request timed out' };
  }

  await providerRequest(decision, request, rpc);
}

/**
 * Execute a Codex query with streaming
 * @param {string} command - The prompt to send
 * @param {object} options - Options including cwd, sessionId, model, permissionMode
 * @param {WebSocket|object} ws - WebSocket connection or response writer
 */
export async function queryCodex(command, options = {}, ws) {
  const {
    sessionId,
    sessionSummary,
    cwd,
    projectPath,
    model,
    effort,
    serviceTier: requestedServiceTier,
    fastMode,
    images,
    permissionMode = 'default',
    unattended = false,
    approvalTimeoutMs,
    relayWorker = false,
    relaySandbox = null,
    appSessionId,
    botGatewayStrict = false,
    botGatewaySecret,
    codexGatewayMcp,
  } = options;
  // Enforced Tool Gateway run (bots/gateway/providers/codex.ts): the gateway is the only MCP
  // server, Codex asks for every command/patch, and the built-in gate answers each request.
  const gatewayStrict = botGatewayStrict === true;
  const builtinToolGate = gatewayStrict && typeof options.builtinToolGate === 'function'
    ? options.builtinToolGate
    : null;

  const resolveResumeModel = codexTestOverrides.resolveResumeModel
    || ((id, requested) => providerModelsService.resolveResumeModel('codex', id, requested));
  const resolvedModel = await resolveResumeModel(sessionId, model);

  const workingDirectory = cwd || projectPath || process.cwd();
  // Bounded approval wait for unattended (swarm) runs; 0 = wait forever (chat).
  const approvalWaitMs = resolveApprovalTimeoutMs({ unattended, approvalTimeoutMs });
  const strictPolicy = gatewayStrict ? resolveStrictPolicy(permissionMode) : null;
  const mapped = strictPolicy
    ? {
      // The strict permission profile (below) replaces the thread's sandbox mode.
      sandbox: strictPolicy.baseProfile === ':read-only' ? 'read-only' : 'workspace-write',
      approvalPolicy: strictPolicy.approvalPolicy,
      approvalsReviewer: strictPolicy.approvalsReviewer,
    }
    : mapPermissionModeToCodexOptions(permissionMode, { unattended });
  const { sandbox, approvalsReviewer } = mapped;
  // A sandboxed relay writer runs everything inside workspace-write without
  // asking ("on-request": Codex only asks to *leave* the sandbox), instead of
  // "untrusted", which asked about nearly every command.
  const relaySandboxedWriter = Boolean(relayWorker && relaySandbox?.mode === 'isolated_write' && sandbox === 'workspace-write');
  const approvalPolicy = relaySandboxedWriter && !gatewayStrict ? 'on-request' : mapped.approvalPolicy;
  // Codex does not support per-task MCP grants on this app-server path. A
  // relay worker therefore gets no managed or inherited CloudCLI MCPs; the
  // lead can select a provider with explicit grant support when MCP is needed.
  const loadObsidianRuntime = codexTestOverrides.loadManagedObsidianCodexRuntime || loadManagedObsidianCodexRuntime;
  const managedObsidianRuntime = relayWorker || gatewayStrict ? null : loadObsidianRuntime();
  const getProviderModels = codexTestOverrides.getProviderModels
    || (() => providerModelsService.getProviderModels('codex'));
  const catalog = (await getProviderModels()).models;
  const selectedModel = catalog.OPTIONS.find((option) => option.value === resolvedModel) || null;
  const allowedEfforts = selectedModel?.effort?.values?.map((value) => value.value) || [];
  const resolvedEffort = typeof effort === 'string' && effort !== 'default' && allowedEfforts.includes(effort)
    ? effort
    : undefined;
  let activeModel = resolvedModel;
  const serviceTier = resolveCodexServiceTier({
    serviceTier: requestedServiceTier,
    fastMode,
  });
  const serviceTierOverride = serviceTier === undefined ? {} : { serviceTier };

  const warmEligible = isCodexWarmEligible(options);
  let appServer;
  let managedHomeCleanup = null;
  let live = null;
  let reusedWarm = false;
  let rpcUnsubscribe;
  let exitUnsubscribe;
  let turnSettled = false;
  let runFailed = false;
  let capturedSessionId = sessionId;
  let turnId = null;
  let sessionCreatedSent = false;
  let terminalFailure = null;
  const abortController = new AbortController();
  const streamedMessageItems = new Set();
  const streamedMessageText = new Map();
  const agentMessagePhases = new Map();
  const completedStreamedMessageItems = new Set();
  let resolveTurn;
  let rejectTurn;
  const turnFinished = new Promise((resolve, reject) => {
    resolveTurn = (turn) => {
      turnSettled = true;
      resolve(turn);
    };
    rejectTurn = (error) => {
      turnSettled = true;
      reject(error);
    };
  });
  // Keep an unobserved early rejection (e.g. exit before turn/start) from
  // surfacing as an unhandled rejection; the run awaits it below.
  turnFinished.catch(() => {});

  const getSessionRecord = () => capturedSessionId && activeCodexSessions.get(capturedSessionId);
  const sendNormalized = (raw) => {
    const normalized = sessionsService.normalizeMessage('codex', raw, capturedSessionId || sessionId || null);
    for (const message of normalized) {
      if (message.kind !== 'complete') {
        sendMessage(ws, message);
      }
    }
  };

  // v2 file-change approvals carry no paths; they arrive on the preceding item/started
  // (and item/fileChange/patchUpdated) notifications, keyed by item id.
  const fileChangeItems = new Map();
  const trackFileChanges = (itemId, changes) => {
    if (typeof itemId === 'string' && Array.isArray(changes)) {
      fileChangeItems.set(itemId, changes);
    }
  };

  /**
   * Gateway-bound runs: every capability request is answered by the built-in tool gate (or
   * declined). Never auto-approves. Returns false when the request is not one of ours to answer
   * (it then follows the normal human-approval flow).
   */
  const answerStrictRequest = async (request) => {
    const { method } = request;
    const legacy = method === 'execCommandApproval' || method === 'applyPatchApproval';
    const gated = legacy
      || method === 'item/commandExecution/requestApproval'
      || method === 'item/fileChange/requestApproval';
    if (gated && builtinToolGate) {
      const verdict = await decideStrictApproval({
        method,
        params: request.params || {},
        gate: builtinToolGate,
        fileChangeItems,
        cwd: workingDirectory,
      });
      if (!verdict.allow) {
        console.warn(`[Codex] gateway-bound run declined ${method}: ${verdict.message}`);
      }
      const decision = legacy
        ? (verdict.allow ? 'approved' : 'denied')
        : (verdict.allow ? 'accept' : 'decline');
      appServer.respond(request.id, { decision });
      return true;
    }
    if (method === 'item/permissions/requestApproval') {
      // Broader sandbox permissions are never granted to a gateway-bound run.
      appServer.respond(request.id, { permissions: {}, scope: 'turn', strictAutoReview: false });
      return true;
    }
    if (method === 'mcpServer/elicitation/request') {
      appServer.respond(request.id, { action: 'decline' });
      return true;
    }
    if (method === 'item/tool/call') {
      appServer.respond(request.id, {
        success: false,
        contentItems: [{ type: 'inputText', text: 'This tool is not available on a gateway-bound run.' }],
      });
      return true;
    }
    return false;
  };

  const handleApprovalRequest = async (request) => {
    const params = request.params || {};
    const requestSessionId = params.threadId
      || params.conversationId
      || capturedSessionId
      || sessionId
      || null;

    if (gatewayStrict) {
      const handled = await answerStrictRequest(request);
      if (handled) {
        return;
      }
    }

    if (request.method === 'execCommandApproval') {
      await waitForCodexApproval({
        rpc: appServer,
        request,
        ws,
        sessionId: requestSessionId,
        sessionSummary,
        abortSignal: abortController.signal,
        unattended,
        approvalWaitMs,
        cwd: workingDirectory,
        toolName: 'Bash',
        input: {
          command: Array.isArray(params.command)
            ? params.command.join(' ')
            : params.command || '',
          cwd: params.cwd || workingDirectory,
          reason: params.reason || undefined,
        },
        providerRequest: async (decision, approvalRequest, rpc) => {
          rpc.respond(approvalRequest.id, {
            decision: codexLegacyApprovalDecision(decision),
          });
        },
      });
      return;
    }

    if (request.method === 'applyPatchApproval') {
      await waitForCodexApproval({
        rpc: appServer,
        request,
        ws,
        sessionId: requestSessionId,
        sessionSummary,
        abortSignal: abortController.signal,
        unattended,
        approvalWaitMs,
        cwd: workingDirectory,
        toolName: 'FileChanges',
        input: {
          changes: params.fileChanges,
          reason: params.reason || undefined,
          grantRoot: params.grantRoot || undefined,
        },
        providerRequest: async (decision, approvalRequest, rpc) => {
          rpc.respond(approvalRequest.id, {
            decision: codexLegacyApprovalDecision(decision),
          });
        },
      });
      return;
    }

    if (request.method === 'item/commandExecution/requestApproval') {
      await waitForCodexApproval({
        rpc: appServer,
        request,
        ws,
        sessionId: requestSessionId,
        sessionSummary,
        abortSignal: abortController.signal,
        unattended,
        approvalWaitMs,
        cwd: workingDirectory,
        toolName: 'Bash',
        input: {
          command: params.command || '',
          cwd: params.cwd || workingDirectory,
          reason: params.reason || undefined,
          additionalPermissions: params.additionalPermissions || undefined,
        },
        providerRequest: async (decision, approvalRequest, rpc) => {
          rpc.respond(approvalRequest.id, { decision: codexApprovalDecision(decision) });
        },
      });
      return;
    }

    if (request.method === 'item/fileChange/requestApproval') {
      await waitForCodexApproval({
        rpc: appServer,
        request,
        ws,
        sessionId: requestSessionId,
        sessionSummary,
        abortSignal: abortController.signal,
        unattended,
        approvalWaitMs,
        cwd: workingDirectory,
        toolName: 'FileChanges',
        input: {
          reason: params.reason || undefined,
          grantRoot: params.grantRoot || undefined,
        },
        providerRequest: async (decision, approvalRequest, rpc) => {
          rpc.respond(approvalRequest.id, { decision: codexApprovalDecision(decision) });
        },
      });
      return;
    }

    if (request.method === 'item/permissions/requestApproval') {
      await waitForCodexApproval({
        rpc: appServer,
        request,
        ws,
        sessionId: requestSessionId,
        sessionSummary,
        abortSignal: abortController.signal,
        unattended,
        approvalWaitMs,
        cwd: workingDirectory,
        toolName: 'CodexPermissions',
        input: {
          cwd: params.cwd || workingDirectory,
          reason: params.reason || undefined,
          permissions: params.permissions,
        },
        providerRequest: async (decision, approvalRequest, rpc) => {
          const approved = Boolean(decision?.allow) && !decision.cancelled;
          rpc.respond(approvalRequest.id, {
            permissions: approved ? approvalRequest.params?.permissions || {} : {},
            scope: decision?.rememberEntry ? 'session' : 'turn',
            strictAutoReview: false,
          });
        },
      });
      return;
    }

    if (request.method === 'item/tool/requestUserInput') {
      const questions = normalizeCodexQuestionInput(params.questions);
      await waitForCodexApproval({
        rpc: appServer,
        request,
        ws,
        sessionId: requestSessionId,
        sessionSummary,
        abortSignal: abortController.signal,
        unattended,
        approvalWaitMs,
        cwd: workingDirectory,
        toolName: 'AskUserQuestion',
        input: { questions },
        providerRequest: async (decision, approvalRequest, rpc) => {
          const answers = decision?.allow
            ? toCodexQuestionAnswers(params.questions, decision.updatedInput?.answers)
            : {};
          rpc.respond(approvalRequest.id, { answers });
        },
      });
      return;
    }

    // Do not leave an unsupported Codex request hanging forever. An empty
    // response lets the app-server turn fail normally and surfaces its error.
    console.warn(`[Codex] Unsupported app-server request: ${request.method}`);
    appServer.respond(request.id, {});
  };

  const handleAppServerMessage = (message) => {
    if (!message || typeof message !== 'object') {
      return;
    }

    if (typeof message.id !== 'undefined' && typeof message.method === 'string') {
      void handleApprovalRequest(message).catch((error) => {
        console.error('[Codex] Approval request handler failed:', error);
        try {
          appServer.respond(message.id, {});
        } catch {
          // The app-server may already be shutting down after the failure.
        }
      });
      return;
    }

    const params = message.params || {};
    if (params.threadId && capturedSessionId && params.threadId !== capturedSessionId) {
      return;
    }
    // A reused process: drop stragglers from turns of earlier runs so they
    // can never reach this run's writer.
    const messageTurnId = codexMessageTurnId(params);
    if (messageTurnId && live?.finishedTurnIds.has(messageTurnId)) {
      return;
    }

    switch (message.method) {
      case 'item/started': {
        const item = params.item;
        if (item?.type === 'agentMessage' && typeof item.id === 'string') {
          agentMessagePhases.set(item.id, item.phase || null);
        }
        if (item?.type === 'fileChange') {
          trackFileChanges(item.id, item.changes);
        }
        break;
      }
      case 'item/fileChange/patchUpdated':
        trackFileChanges(params.itemId, params.changes);
        break;
      case 'item/agentMessage/delta':
        if (params.itemId && params.delta) {
          streamedMessageItems.add(params.itemId);
          streamedMessageText.set(
            params.itemId,
            `${streamedMessageText.get(params.itemId) || ''}${params.delta}`,
          );
          sendMessage(ws, createNormalizedMessage({
            kind: agentMessagePhases.get(params.itemId) === 'commentary'
              ? 'thinking'
              : 'stream_delta',
            content: params.delta,
            sessionId: capturedSessionId || sessionId || null,
            provider: 'codex',
          }));
        }
        break;
      case 'item/reasoning/summaryTextDelta':
        if (params.delta) {
          sendMessage(ws, createNormalizedMessage({
            kind: 'thinking',
            content: params.delta,
            sessionId: capturedSessionId || sessionId || null,
            provider: 'codex',
          }));
        }
        break;
      case 'item/completed': {
        const item = params.item;
        if (!item) break;
        if (item.type === 'agentMessage') {
          const itemId = typeof item.id === 'string'
            ? item.id
            : typeof params.itemId === 'string'
              ? params.itemId
              : null;
          if (itemId && completedStreamedMessageItems.has(itemId)) {
            break;
          }
          const itemPhase = item.phase || (itemId ? agentMessagePhases.get(itemId) : null);
          const streamedItemIds = [...streamedMessageItems];
          const matchingStreamedItemId = itemId && streamedMessageItems.has(itemId)
            ? itemId
            : streamedItemIds.find((streamedItemId) =>
              typeof item.text === 'string'
              && streamedMessageText.get(streamedItemId) === item.text,
            ) || (streamedItemIds.length === 1 ? streamedItemIds[0] : null);

          if (matchingStreamedItemId) {
            const matchingPhase = agentMessagePhases.get(matchingStreamedItemId) || itemPhase;
            streamedMessageItems.delete(matchingStreamedItemId);
            streamedMessageText.delete(matchingStreamedItemId);
            agentMessagePhases.delete(matchingStreamedItemId);
            if (!completedStreamedMessageItems.has(matchingStreamedItemId)) {
              completedStreamedMessageItems.add(matchingStreamedItemId);
              if (matchingPhase !== 'commentary') {
                sendMessage(ws, createNormalizedMessage({
                  kind: 'stream_end',
                  sessionId: capturedSessionId || sessionId || null,
                  provider: 'codex',
                }));
              }
            }
            break;
          }
        }
        if (item.type === 'reasoning') break;
        const legacy = appServerItemToLegacy(item);
        if (legacy) sendNormalized(legacy);
        break;
      }
      case 'thread/tokenUsage/updated': {
        const tokenBudget = extractAppServerTokenBudget(params.tokenUsage, activeModel);
        if (tokenBudget) {
          sendMessage(ws, createNormalizedMessage({
            kind: 'status',
            text: 'token_budget',
            tokenBudget,
            sessionId: capturedSessionId || sessionId || null,
            provider: 'codex',
          }));
        }
        break;
      }
      case 'turn/completed': {
        const turn = params.turn || {};
        if (turn.status === 'failed') {
          terminalFailure = new Error(turn.error?.message || 'Turn failed');
        }
        resolveTurn(turn);
        break;
      }
      case 'error': {
        if (params.willRetry) break;
        terminalFailure = new Error(params.error?.message || 'Codex turn failed');
        rejectTurn(terminalFailure);
        break;
      }
      default:
        break;
    }
  };

  try {
    let strictHome = null;
    if (gatewayStrict) {
      assertStrictRunInputs({ gateway: codexGatewayMcp, appSessionId, bindingSecret: botGatewaySecret });
      strictHome = prepareStrictCodexHome({ appSessionId });
      managedHomeCleanup = strictHome.cleanup;
    }
    const strictDeny = strictPolicy ? strictDenyReadPaths() : [];
    const managedConfig = strictPolicy
      ? buildStrictCodexConfig({
        gateway: codexGatewayMcp,
        appSessionId,
        policy: strictPolicy,
        cwd: workingDirectory,
        denyReadPaths: strictDeny,
        allowReadPaths: strictAllowReadPaths({ launcherCommand: resolveCodexLauncher().command, denyReadPaths: strictDeny }),
      })
      : relayWorker
      ? { mcp_servers: {}, ...(relaySandboxedWriter ? codexSandboxConfig(relaySandbox) : {}) }
      : managedObsidianRuntime?.config
      ? {
        ...managedObsidianRuntime.config,
        ...(sandbox === 'workspace-write'
          ? { sandbox_workspace_write: { network_access: true } }
          : {}),
      }
      : {};
    // Peer mailbox identity: the codex app-server subprocess inherits this
    // into any MCP server it spawns from its own config (including
    // cloudcli-session-mailbox). createCodexAppServer treats `env` as the
    // full child environment (not a merge), so build a full copy here too.
    const identityEnv = appSessionId
      ? {
        CLOUDCLI_SESSION_ID: appSessionId,
        CLOUDCLI_PROVIDER: 'codex',
        CLOUDCLI_PROJECT_PATH: workingDirectory,
      }
      : {};
    const strictEnv = strictHome
      ? buildStrictCodexEnv({
        baseEnv: process.env,
        home: strictHome.home,
        appSessionId,
        bindingSecret: botGatewaySecret,
        gateway: codexGatewayMcp,
      })
      : null;
    const spawnOptions = {
      cwd: workingDirectory,
      env: strictEnv ?? {
        ...(managedObsidianRuntime?.env ?? process.env),
        ...identityEnv,
        ...leadSessionEnv(options.appSessionId),
        // Codex runs in-sandbox commands without asking, so a push can never
        // reach the relay broker: make git itself refuse every push.
        ...(relayWorker ? workerGitGuardEnv(managedObsidianRuntime?.env ?? process.env) : {}),
      },
      config: managedConfig,
    };
    const fingerprint = warmEligible
      ? computeCodexWarmFingerprint(spawnOptions, { appSessionId: appSessionId || null, sandbox })
      : null;
    const turnOverrides = { model: resolvedModel || null, effort: resolvedEffort || null, serviceTier };

    const attach = (nextLive) => {
      live = nextLive;
      appServer = nextLive.rpc;
      rpcUnsubscribe = appServer.onMessage(handleAppServerMessage);
      // A crash mid-turn must end the run instead of hanging on turnFinished.
      exitUnsubscribe = appServer.onExit?.((info) => {
        if (!turnSettled) {
          rejectTurn(new Error(`Codex app-server exited (${info?.signal || `code ${info?.code ?? 1}`})`));
        }
      });
    };
    const detach = () => {
      rpcUnsubscribe?.();
      rpcUnsubscribe = null;
      exitUnsubscribe?.();
      exitUnsubscribe = null;
    };

    const startColdServer = async () => {
      attach(createCodexLive(spawnCodexServer(spawnOptions), {
        fingerprint,
        appSessionId: appSessionId || null,
      }));
      await appServer.request('initialize', {
        clientInfo: { name: 'cloudcli', title: 'CloudCLI', version: '0.1.0' },
        capabilities: { experimentalApi: true },
      });
      appServer.notify('initialized');

      const threadMethod = sessionId ? 'thread/resume' : 'thread/start';
      // A gateway-bound thread names the strict permission profile instead of a sandbox mode
      // (the two cannot be combined).
      const sandboxParams = gatewayStrict ? { permissions: CODEX_STRICT_PROFILE } : { sandbox };
      const threadParams = sessionId
        ? {
          threadId: sessionId,
          cwd: workingDirectory,
          model: resolvedModel,
          approvalPolicy,
          approvalsReviewer,
          ...sandboxParams,
          ...serviceTierOverride,
        }
        : {
          cwd: workingDirectory,
          model: resolvedModel,
          approvalPolicy,
          approvalsReviewer,
          ...sandboxParams,
          ...serviceTierOverride,
        };
      const threadResult = await appServer.request(threadMethod, threadParams);
      const thread = threadResult?.thread || {};
      if (typeof thread.model === 'string' && thread.model.trim()) {
        activeModel = thread.model.trim();
      }
      capturedSessionId = thread.id || thread.sessionId || capturedSessionId;
      if (!capturedSessionId) {
        throw new Error('Codex app-server did not return a thread id');
      }
      live.threadId = capturedSessionId;
      live.activeModel = activeModel;
    };

    // Warm path: the thread is already loaded in a parked process, so skip
    // spawn + initialize + thread/resume entirely.
    const warm = warmEligible || warmCodexSessions.has(sessionId)
      ? await acquireWarmCodexSession(sessionId, fingerprint, turnOverrides)
      : null;
    if (warm) {
      reusedWarm = true;
      attach(warm);
      capturedSessionId = warm.threadId;
      activeModel = resolvedModel || warm.activeModel || activeModel;
    } else {
      await startColdServer();
    }

    activeCodexSessions.set(capturedSessionId, {
      rpc: appServer,
      status: 'running',
      abortController,
      startedAt: new Date().toISOString(),
      ws,
      turnId: null,
      appSessionId: appSessionId || null,
      workingDirectory,
    });
    if (ws.setSessionId && typeof ws.setSessionId === 'function') {
      ws.setSessionId(capturedSessionId);
    }
    if (!sessionId && !sessionCreatedSent) {
      sessionCreatedSent = true;
      sendMessage(ws, createNormalizedMessage({
        kind: 'session_created',
        newSessionId: capturedSessionId,
        sessionId: capturedSessionId,
        provider: 'codex',
      }));
    }

    const turnStartParams = {
      threadId: capturedSessionId,
      input: buildCodexAppServerInput(command, images, workingDirectory),
      model: resolvedModel,
      effort: resolvedEffort || null,
      approvalPolicy,
      approvalsReviewer,
      ...serviceTierOverride,
    };
    let turnResult;
    try {
      turnResult = await appServer.request('turn/start', turnStartParams);
    } catch (error) {
      // A parked process that died or no longer holds the thread: no turn
      // started, so fall back to a fresh spawn transparently.
      if (!reusedWarm || abortController.signal.aborted || turnSettled) {
        throw error;
      }
      console.warn(`[Codex] Warm app-server for ${capturedSessionId} failed turn/start (${error?.message || error}) — respawning`);
      detach();
      retireCodexLive(live, 'warm-failed');
      reusedWarm = false;
      await startColdServer();
      const record = getSessionRecord();
      if (record) record.rpc = appServer;
      turnResult = await appServer.request('turn/start', turnStartParams);
    }
    turnId = turnResult?.turn?.id || null;
    live.turns += 1;
    live.model = resolvedModel || live.model;
    live.activeModel = activeModel;
    live.effort = resolvedEffort || null;
    live.serviceTier = serviceTier;
    const session = getSessionRecord();
    if (session) session.turnId = turnId;
    await turnFinished;

    if (terminalFailure) {
      sendMessage(ws, createNormalizedMessage({
        kind: 'error',
        content: terminalFailure.message,
        sessionId: capturedSessionId || sessionId || null,
        provider: 'codex',
      }));
    }

    // Send the terminal completion event — skipped for aborted runs, whose
    // terminal `complete` (aborted: true) was already sent by abort-session.
    const runSession = capturedSessionId ? activeCodexSessions.get(capturedSessionId) : null;
    const runAborted = runSession?.status === 'aborted' || abortController.signal.aborted;
    if (!runAborted) {
      sendMessage(ws, createCompleteMessage({
        provider: 'codex',
        sessionId: capturedSessionId || sessionId || null,
        actualSessionId: capturedSessionId || sessionId || null,
        exitCode: terminalFailure ? 1 : 0,
      }));
      if (terminalFailure) {
        notifyRunFailed({
          userId: ws?.userId || null,
          provider: 'codex',
          sessionId: capturedSessionId || sessionId || null,
          sessionName: sessionSummary,
          error: terminalFailure,
        });
      } else {
        notifyRunStopped({
          userId: ws?.userId || null,
          provider: 'codex',
          sessionId: capturedSessionId || sessionId || null,
          sessionName: sessionSummary,
          stopReason: 'completed'
        });
      }
    }

  } catch (error) {
    runFailed = true;
    const session = capturedSessionId ? activeCodexSessions.get(capturedSessionId) : null;
    const wasAborted =
      session?.status === 'aborted' ||
      error?.name === 'AbortError' ||
      String(error?.message || '').toLowerCase().includes('aborted');

    if (!wasAborted) {
      console.error('[Codex] Error:', error);

      // Check if Codex CLI is available for a clearer error message
      const isInstalled = codexTestOverrides.isProviderInstalled
        || (() => providerAuthService.isProviderInstalled('codex'));
      const installed = await isInstalled();
      const errorContent = !installed
        ? 'Codex CLI is not configured. Please set up authentication first.'
        : error.message;

      sendMessage(ws, createNormalizedMessage({ kind: 'error', content: errorContent, sessionId: capturedSessionId || sessionId || null, provider: 'codex' }));
      sendMessage(ws, createCompleteMessage({
        provider: 'codex',
        sessionId: capturedSessionId || sessionId || null,
        exitCode: 1,
      }));
      notifyRunFailed({
        userId: ws?.userId || null,
        provider: 'codex',
        sessionId: capturedSessionId || sessionId || null,
        sessionName: sessionSummary,
        error,
      });
    }

  } finally {
    rpcUnsubscribe?.();
    exitUnsubscribe?.();
    const record = capturedSessionId ? activeCodexSessions.get(capturedSessionId) : null;
    const aborted = record?.status === 'aborted' || abortController.signal.aborted;
    if (live) {
      // Remember every turn id this run saw so stragglers are dropped later.
      if (turnId) live.finishedTurnIds.add(turnId);
      if (record?.turnId) live.finishedTurnIds.add(record.turnId);
      const canPark = warmEligible
        && isCodexWarmEnabled()
        && readCodexWarmTtlMs() > 0
        && !runFailed
        && !aborted
        && turnSettled
        && Boolean(turnId)
        && Boolean(capturedSessionId)
        && !live.closed
        && live.rpc.alive !== false;
      if (canPark) {
        parkCodexLive(live, capturedSessionId);
      } else {
        retireCodexLive(live, aborted ? 'aborted' : runFailed ? 'failed' : 'per-turn');
      }
    } else {
      appServer?.close();
    }
    if (managedHomeCleanup) {
      // The managed CODEX_HOME can only go once the app-server is gone.
      await waitForCodexExit(live || { rpc: appServer });
      managedHomeCleanup();
    }
    // Update session status (a parked process is never shown as processing).
    if (record) {
      record.status = record.status === 'aborted' ? 'aborted' : 'completed';
    }
  }
}

/**
 * Abort an active Codex session
 * @param {string} sessionId - Session ID to abort
 * @returns {boolean} - Whether abort was successful
 */
export function abortCodexSession(sessionId) {
  const session = activeCodexSessions.get(sessionId);

  if (!session) {
    return false;
  }

  session.status = 'aborted';
  try {
    session.abortController?.abort();
    if (session.turnId && session.rpc) {
      void session.rpc.request('turn/interrupt', {
        threadId: sessionId,
        turnId: session.turnId,
      }).catch((error) => {
        console.warn(`[Codex] Failed to interrupt session ${sessionId}:`, error?.message || error);
      });
    }
  } catch (error) {
    console.warn(`[Codex] Failed to abort session ${sessionId}:`, error);
  }

  return true;
}

/**
 * Steers a follow-up message into the active Codex turn (app-server
 * `turn/steer`), so chat sends during a running turn attach to it instead of
 * being rejected with RUN_IN_PROGRESS.
 * @param {string} command - Follow-up user message
 * @param {Object} options - Runtime options (sessionId, appSessionId, images, cwd)
 * @returns {Promise<boolean>} Whether the message reached the live turn
 */
export async function injectCodexMessage(command, options = {}) {
  let threadId = options.sessionId || null;
  let session = threadId ? activeCodexSessions.get(threadId) : null;
  if (!session && options.appSessionId) {
    for (const [id, entry] of activeCodexSessions.entries()) {
      if (entry.appSessionId === options.appSessionId && entry.status === 'running') {
        threadId = id;
        session = entry;
        break;
      }
    }
  }
  if (!session || session.status !== 'running' || !session.turnId || !session.rpc) {
    return false;
  }

  try {
    const result = await session.rpc.request('turn/steer', {
      threadId,
      input: buildCodexAppServerInput(
        command,
        options.images,
        options.cwd || session.workingDirectory || process.cwd(),
      ),
      expectedTurnId: session.turnId,
    });
    if (result?.turnId) {
      session.turnId = result.turnId;
    }
    return true;
  } catch (error) {
    // Turn already finished (or ids raced): the caller retries the run lock.
    console.warn(`[Codex] turn/steer failed for ${threadId}:`, error?.message || error);
    return false;
  }
}

/**
 * Check if a session is active
 * @param {string} sessionId - Session ID to check
 * @returns {boolean} - Whether session is active
 */
export function isCodexSessionActive(sessionId) {
  const session = activeCodexSessions.get(sessionId);
  return session?.status === 'running';
}

/**
 * Get all active sessions
 * @returns {Array} - Array of active session info
 */
export function getActiveCodexSessions() {
  const sessions = [];

  for (const [id, session] of activeCodexSessions.entries()) {
    if (session.status === 'running') {
      sessions.push({
        id,
        status: session.status,
        startedAt: session.startedAt
      });
    }
  }

  return sessions;
}

/**
 * Helper to send message via WebSocket or writer
 * @param {WebSocket|object} ws - WebSocket or response writer
 * @param {object} data - Data to send
 */
function sendMessage(ws, data) {
  try {
    if (ws.isSSEStreamWriter || ws.isWebSocketWriter) {
      // Writer handles stringification (SSEStreamWriter or WebSocketWriter)
      ws.send(data);
    } else if (typeof ws.send === 'function') {
      // Raw WebSocket - stringify here
      ws.send(JSON.stringify(data));
    }
  } catch (error) {
    console.error('[Codex] Error sending message:', error);
  }
}

// Clean up old completed sessions periodically
setInterval(() => {
  const now = Date.now();
  const maxAge = 30 * 60 * 1000; // 30 minutes

  for (const [id, session] of activeCodexSessions.entries()) {
    if (session.status !== 'running') {
      const startedAt = new Date(session.startedAt).getTime();
      if (now - startedAt > maxAge) {
        activeCodexSessions.delete(id);
      }
    }
  }
}, 5 * 60 * 1000).unref?.(); // Every 5 minutes; never keeps the process alive
