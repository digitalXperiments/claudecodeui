import fsSync from 'node:fs';

import crossSpawn from 'cross-spawn';
import Database from 'better-sqlite3';

import { appendImagesInputTag } from './shared/image-attachments.js';
import { createRequestId, extractPermissionPaths, resolveApprovalTimeoutMs, waitForToolApproval } from './claude-sdk.js';
import { sessionsService } from './modules/providers/services/sessions.service.js';
import { providerAuthService } from './modules/providers/services/provider-auth.service.js';
import { providerModelsService } from './modules/providers/services/provider-models.service.js';
import { notifyRunFailed, notifyRunStopped } from './services/notification-orchestrator.js';
import { createAcpJsonRpcClient } from './shared/acp-rpc.js';
import { createCompleteMessage, createNormalizedMessage, getOpenCodeDatabasePath } from './shared/utils.js';

// cross-spawn resolves .cmd shims/PATHEXT on Windows and delegates to
// child_process.spawn everywhere else.
const spawnFunction = crossSpawn;

// OpenCode's Agent Client Protocol server (`opencode acp`), spoken over stdio
// as newline-delimited JSON-RPC 2.0. Verified live against opencode 1.18.11
// (2026-08-11, scripts/probe-opencode-acp.mjs):
//   - initialize -> { agentCapabilities: { loadSession: true, ... } }
//   - session/new  { cwd, mcpServers } -> { sessionId, configOptions }
//   - session/load { sessionId, cwd, mcpServers } -> resumes a prior session
//   - session/set_config_option { sessionId, configId, value } -> the session's
//     full configOptions back. `model` and `mode` (build|plan) always exist;
//     `effort` (low|high|max) only appears once a model that supports it is
//     selected, exactly like Kimi's `thinking` option.
//   - session/prompt { sessionId, prompt: [{type:'text', text}] } -> streams
//     session/update notifications, resolves with { stopReason, usage }.
//   - session/cancel { sessionId } as a NOTIFICATION aborts the in-flight turn.
//   - session/request_permission is a REQUEST *from* the agent (carries its own
//     id) that must be answered with
//     { outcome: { outcome: 'selected', optionId } } using one of the offered
//     options (once / always / reject).
//
// This replaced the previous one-shot `opencode run --format json` runtime. That
// mode is non-interactive: it *auto-rejects* every permission it would have to
// ask about, printing "permission requested: …; auto-rejecting" to stderr, so
// unattended runs (agent swarm, Mission Control, Kanban) silently lost access
// to anything gated and CloudCLI's permission broker never got a say. ACP is
// the only opencode entry point that relays the ask to its client.
const acpSessions = new Map();

const IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const SETUP_TIMEOUT_MS = 30_000;
const FINAL_REPORT_NUDGE_TIMEOUT_MS = 2 * 60 * 1000;
const UNATTENDED_FINAL_REPORT_NUDGE =
  'Your previous turn ended without an assistant-facing answer. Return the final response required by the original prompt now. Do not call tools. Output only that final response.';

/**
 * Permission types OpenCode understands in `OPENCODE_PERMISSION` (merged into
 * `config.permission`). `write`/`edit`/`patch` all collapse onto `edit` inside
 * OpenCode itself. `read` is deliberately left alone: asking on every file read
 * would produce a round-trip per read, and reads outside the workspace are
 * already covered by `external_directory`.
 */
const RELAYED_PERMISSIONS = { edit: 'ask', bash: 'ask', webfetch: 'ask', external_directory: 'ask' };

/**
 * Maps the UI permission mode onto OpenCode's ACP controls.
 *
 * `mode` is the session's agent (`plan` is OpenCode's built-in read-only one).
 * `env` forces the permission types we want *relayed* to "ask", which under ACP
 * means "send session/request_permission to the client" — under the old `run`
 * runtime the very same rules meant "auto-reject".
 *
 * `autoApprove` answers those asks locally without troubling a human: it is the
 * headless/bypass posture, and it is also what stops an unattended run from
 * hanging when the user's own opencode.json carries an `ask` rule we did not
 * put there.
 *
 * `bypassPermissions` remains a legacy alias for `auto`.
 */
export function resolveOpenCodePermissionPolicy(permissionMode) {
  switch (permissionMode) {
    case 'plan':
      return {
        mode: 'plan',
        autoApprove: false,
        env: { OPENCODE_PERMISSION: JSON.stringify(RELAYED_PERMISSIONS) },
      };
    case 'auto':
    case 'bypassPermissions':
      // The user's own config still governs; anything it asks about is approved
      // locally rather than relayed, so nothing blocks.
      return { mode: 'build', autoApprove: true, env: {} };
    case 'acceptEdits':
      return {
        mode: 'build',
        autoApprove: false,
        env: { OPENCODE_PERMISSION: JSON.stringify({ ...RELAYED_PERMISSIONS, edit: 'allow' }) },
      };
    default:
      return {
        mode: 'build',
        autoApprove: false,
        env: { OPENCODE_PERMISSION: JSON.stringify(RELAYED_PERMISSIONS) },
      };
  }
}

function resolveOpenCodeEffort(model, effort, modelsDefinition) {
  const selectedModel = modelsDefinition?.OPTIONS?.find((option) => option.value === model);
  const allowedEfforts = selectedModel?.effort?.values?.map((value) => value.value) || [];
  return typeof effort === 'string' && effort !== 'default' && allowedEfforts.includes(effort)
    ? effort
    : undefined;
}

function readOpenCodeTokenUsage(sessionId) {
  const dbPath = getOpenCodeDatabasePath();
  if (!sessionId || !fsSync.existsSync(dbPath)) {
    return null;
  }

  let db = null;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const columns = db.prepare('PRAGMA table_info(session)').all();
    const columnNames = new Set(columns.map((column) => column.name));
    const requiredColumns = ['tokens_input', 'tokens_output', 'tokens_reasoning', 'tokens_cache_read', 'tokens_cache_write'];
    if (!requiredColumns.every((column) => columnNames.has(column))) {
      return null;
    }

    const row = db.prepare(`
      SELECT
        tokens_input AS inputTokens,
        tokens_output AS outputTokens,
        tokens_reasoning AS reasoningTokens,
        tokens_cache_read AS cacheReadTokens,
        tokens_cache_write AS cacheWriteTokens
      FROM session
      WHERE id = ?
    `).get(sessionId);

    if (!row) {
      return null;
    }

    const inputTokens = Number(row.inputTokens || 0) + Number(row.cacheReadTokens || 0);
    const outputTokens = Number(row.outputTokens || 0);
    const used = Number(row.inputTokens || 0)
      + outputTokens
      + Number(row.reasoningTokens || 0)
      + Number(row.cacheReadTokens || 0)
      + Number(row.cacheWriteTokens || 0);
    if (used <= 0) {
      return null;
    }

    return {
      used,
      inputTokens,
      outputTokens,
      breakdown: {
        input: inputTokens,
        output: outputTokens,
      },
    };
  } catch {
    return null;
  } finally {
    if (db) {
      db.close();
    }
  }
}

/** Kill a child that ignored SIGTERM rather than leave it running invisibly. */
function killChild(child) {
  try {
    child.kill('SIGTERM');
    const timer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        try {
          child.kill('SIGKILL');
        } catch {
          // Already gone.
        }
      }
    }, 5000);
    timer.unref?.();
  } catch {
    // Already gone.
  }
}

async function createAcpSession(workingDir, resumeSessionId, permissionEnv) {
  const child = spawnFunction('opencode', ['acp', '--cwd', workingDir], {
    cwd: workingDir,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...permissionEnv },
  });

  const rpc = createAcpJsonRpcClient(child, { label: 'OpenCode ACP' });

  // Kept only for the setup window: an opencode too old to have the `acp`
  // command exits immediately, and "process exited" alone would send whoever
  // hits it hunting in the wrong place.
  let setupStderr = '';
  const collectSetupStderr = (data) => {
    setupStderr = `${setupStderr}${data.toString()}`.slice(-2000);
  };
  child.stderr.on('data', collectSetupStderr);

  let sessionResult;
  try {
    await rpc.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
      clientInfo: { name: 'cloudcli', version: '1.0.0' },
    }, SETUP_TIMEOUT_MS);

    if (resumeSessionId) {
      try {
        sessionResult = await rpc.request('session/load', {
          sessionId: resumeSessionId,
          cwd: workingDir,
          mcpServers: [],
        }, SETUP_TIMEOUT_MS);
        sessionResult = { ...sessionResult, sessionId: sessionResult?.sessionId || resumeSessionId };
      } catch {
        // A session that predates this ACP runtime (or was pruned) can't be
        // loaded — start a fresh one rather than failing the whole message.
        sessionResult = await rpc.request('session/new', { cwd: workingDir, mcpServers: [] }, SETUP_TIMEOUT_MS);
      }
    } else {
      sessionResult = await rpc.request('session/new', { cwd: workingDir, mcpServers: [] }, SETUP_TIMEOUT_MS);
    }
  } catch (error) {
    // A setup call that timed out means the process is stuck, not merely slow.
    rpc.close();
    killChild(child);
    if (/unknown (command|argument)|not a valid command/i.test(setupStderr)) {
      throw new Error(
        'This OpenCode CLI has no `acp` command — CloudCLI needs OpenCode 1.18 or newer. Run `opencode upgrade`.',
      );
    }
    throw error;
  } finally {
    child.stderr.off('data', collectSetupStderr);
  }

  return {
    child,
    rpc,
    opencodeSessionId: sessionResult.sessionId,
    permissionEnvKey: JSON.stringify(permissionEnv ?? {}),
    currentModel: null,
    currentEffort: null,
    currentMode: null,
    idleTimer: null,
    promptInFlight: false,
    aborted: false,
  };
}

function disposeSession(handle) {
  if (handle.idleTimer) {
    clearTimeout(handle.idleTimer);
    handle.idleTimer = null;
  }
  try {
    handle.rpc.close();
  } catch {
    // Already closed.
  }
  killChild(handle.child);
}

function scheduleIdleCleanup(handle, key) {
  if (handle.idleTimer) {
    clearTimeout(handle.idleTimer);
  }
  handle.idleTimer = setTimeout(() => {
    // A long agentic turn can outlive the idle window; killing the child
    // mid-prompt fails the run while opencode keeps working on disk. Not idle —
    // check again later.
    if (handle.promptInFlight) {
      scheduleIdleCleanup(handle, key);
      return;
    }
    if (acpSessions.get(key) === handle) {
      acpSessions.delete(key);
    }
    disposeSession(handle);
  }, IDLE_TIMEOUT_MS);
  // An idle ACP child must never be the reason the process stays alive.
  handle.idleTimer.unref?.();
}

/** Tear down every live ACP child (server shutdown, test teardown). */
function disposeOpenCodeSessions() {
  for (const [key, handle] of acpSessions.entries()) {
    acpSessions.delete(key);
    disposeSession(handle);
  }
}

/** Apply a session config option, optionally treating rejection as fatal. */
async function setConfigOption(handle, configId, value, { required = false } = {}) {
  try {
    await handle.rpc.request('session/set_config_option', {
      sessionId: handle.opencodeSessionId,
      configId,
      value,
    }, SETUP_TIMEOUT_MS);
    return true;
  } catch (error) {
    if (required) {
      throw new Error(
        `OpenCode ACP rejected required ${configId}=${value}: ${error?.message || error}`,
        { cause: error },
      );
    }
    console.warn(`[opencode-cli] could not set ${configId}=${value}:`, error?.message || error);
    return false;
  }
}

async function spawnOpenCode(command, options = {}, ws) {
  const {
    sessionId,
    projectPath,
    cwd,
    model,
    effort,
    sessionSummary,
    images,
    permissionMode,
    unattended = false,
    approvalTimeoutMs,
  } = options;

  const workingDir = cwd || projectPath || process.cwd();
  const policy = resolveOpenCodePermissionPolicy(permissionMode);
  const resolvedModel = await providerModelsService.resolveResumeModel('opencode', sessionId, model);

  let effortModels = null;
  try {
    effortModels = (await providerModelsService.getProviderModels('opencode')).models;
  } catch (error) {
    console.warn('[OpenCode] Unable to load provider models for effort validation:', error);
  }
  const resolvedEffort = resolveOpenCodeEffort(resolvedModel, effort, effortModels);

  const processKey = sessionId || `new:${Date.now()}`;
  let handle = acpSessions.get(processKey);
  let capturedSessionId = sessionId;

  // OPENCODE_PERMISSION is read once at process start, so a permission-mode
  // change cannot be applied to a live child — retire it and resume the same
  // opencode session under the new env instead of silently using the old one.
  if (handle && handle.permissionEnvKey !== JSON.stringify(policy.env ?? {})) {
    acpSessions.delete(processKey);
    disposeSession(handle);
    handle = null;
  }

  if (!handle || handle.child.exitCode !== null || handle.child.killed) {
    handle = await createAcpSession(workingDir, sessionId, policy.env);
    acpSessions.set(processKey, handle);

    if (!capturedSessionId) {
      capturedSessionId = handle.opencodeSessionId;
      acpSessions.delete(processKey);
      acpSessions.set(capturedSessionId, handle);
      if (ws.setSessionId && typeof ws.setSessionId === 'function') {
        ws.setSessionId(capturedSessionId);
      }
      ws.send(createNormalizedMessage({
        kind: 'session_created',
        newSessionId: capturedSessionId,
        cwd: workingDir,
        sessionId: capturedSessionId,
        provider: 'opencode',
      }));
    }

    const boundKey = capturedSessionId || processKey;
    handle.child.on('exit', () => {
      if (acpSessions.get(boundKey) === handle) {
        acpSessions.delete(boundKey);
      }
    });
    handle.child.stderr.on('data', (data) => {
      // OpenCode's stderr is warnings and log lines, not the run's outcome;
      // surfacing it as chat `error` events turned routine notices into
      // failures. Log it instead — the ACP stream carries what matters.
      console.error('OpenCode ACP stderr:', data.toString());
    });
  } else {
    capturedSessionId = handle.opencodeSessionId;
  }

  scheduleIdleCleanup(handle, capturedSessionId || processKey);

  try {
    if (resolvedModel && handle.currentModel !== resolvedModel) {
      if (await setConfigOption(handle, 'model', resolvedModel, { required: true })) {
        handle.currentModel = resolvedModel;
        // Switching models re-derives the effort option from the new model.
        handle.currentEffort = null;
      }
    }

    if (resolvedEffort && handle.currentEffort !== resolvedEffort) {
      if (await setConfigOption(handle, 'effort', resolvedEffort)) {
        handle.currentEffort = resolvedEffort;
      }
    }

    if (handle.currentMode !== policy.mode) {
      if (await setConfigOption(handle, 'mode', policy.mode, { required: true })) {
        handle.currentMode = policy.mode;
      }
    }
  } catch (error) {
    // A child with rejected required configuration must never stay cached and
    // later run a prompt under a different model or permission mode.
    const key = capturedSessionId || processKey;
    if (acpSessions.get(key) === handle) {
      acpSessions.delete(key);
    }
    disposeSession(handle);
    throw error;
  }

  const finalSessionId = capturedSessionId || handle.opencodeSessionId;

  // toolCallId -> the tool's real name, captured from the initial `tool_call`
  // event. Later `tool_call_update`s retitle themselves with the command being
  // run ("echo hi" rather than "bash"), so the name has to be carried forward.
  const toolNames = new Map();
  // toolCallId -> a tool_use message was already emitted, so the repeated
  // in-progress updates don't produce duplicate chat entries.
  const toolCallsStarted = new Set();
  let sawAssistantText = false;

  // Named (not inline) so a respawned child after a mid-prompt crash can be
  // re-subscribed with the same handler; it closes over the `handle` binding,
  // so reassigning `handle` retargets respond()/session filtering too.
  const onAcpMessage = async (message, isRequest) => {
    if (isRequest && message.method === 'session/request_permission') {
      const toolCall = message.params?.toolCall || {};
      const offered = message.params?.options || [];
      const optionFor = (kind) => offered.find((option) => option.kind === kind)?.optionId;
      const rejectOption = optionFor('reject_once') || 'reject';

      if (policy.autoApprove) {
        handle.rpc.respond(message.id, {
          outcome: { outcome: 'selected', optionId: optionFor('allow_once') || offered[0]?.optionId || 'once' },
        });
        return;
      }

      const requestId = createRequestId();
      const toolName = toolNames.get(toolCall.toolCallId) || toolCall.title || toolCall.kind || 'Tool';
      const toolInput = toolCall.rawInput ?? toolCall.content;
      // ACP names the paths a tool call touches; they matter more to an
      // approver than anything inferable from the raw arguments.
      const locationPaths = Array.isArray(toolCall.locations)
        ? toolCall.locations.map((location) => location?.path).filter(Boolean)
        : [];
      const paths = Array.from(new Set([...(extractPermissionPaths(toolInput) || []), ...locationPaths]));

      ws.send(createNormalizedMessage({
        kind: 'permission_request',
        requestId,
        toolName,
        input: toolInput,
        sessionId: finalSessionId,
        provider: 'opencode',
        cwd: workingDir,
        paths,
        unattended,
      }));

      // Interactive chat waits indefinitely for chatbar approval; unattended
      // (swarm) runs wait a bounded window for the permission broker and then
      // fall through to reject, so a headless run can never hang here.
      const approvalWaitMs = resolveApprovalTimeoutMs({ unattended, approvalTimeoutMs });
      const decision = await waitForToolApproval(requestId, {
        timeoutMs: approvalWaitMs,
        metadata: {
          _sessionId: finalSessionId,
          _toolName: toolName,
          _input: toolInput,
          _receivedAt: new Date(),
        },
        onCancel: (reason) => {
          ws.send(createNormalizedMessage({ kind: 'permission_cancelled', requestId, reason, sessionId: finalSessionId, provider: 'opencode' }));
        },
      });

      if (unattended && !decision) {
        console.warn(`[opencode-cli] session=${finalSessionId} unattended approval for "${toolName}" timed out after ${approvalWaitMs}ms — denying`);
      }

      let optionId = rejectOption;
      if (decision && decision.allow) {
        optionId = (decision.rememberEntry ? optionFor('allow_always') : optionFor('allow_once'))
          || offered[0]?.optionId
          || 'once';
      }

      handle.rpc.respond(message.id, { outcome: { outcome: 'selected', optionId } });
      return;
    }

    if (message.method !== 'session/update') {
      return;
    }

    // One process can host more than one session; only forward updates for the
    // session this run is bound to.
    const boundSessionId = handle.opencodeSessionId || finalSessionId;
    const updateSessionId = message.params?.sessionId;
    if (boundSessionId && updateSessionId && updateSessionId !== boundSessionId) {
      return;
    }

    const update = message.params?.update;
    if (!update) {
      return;
    }

    if (update.sessionUpdate === 'tool_call' && update.toolCallId && update.title) {
      toolNames.set(update.toolCallId, update.title);
    }

    if (
      update.sessionUpdate === 'agent_message_chunk'
      && typeof update.content?.text === 'string'
      && update.content.text.trim()
    ) {
      sawAssistantText = true;
    }

    const terminalToolUpdate =
      update.sessionUpdate === 'tool_call_update'
      && (update.status === 'completed' || update.status === 'failed');
    if (update.sessionUpdate === 'tool_call_update' && update.rawInput && !terminalToolUpdate) {
      if (toolCallsStarted.has(update.toolCallId)) {
        return;
      }
      toolCallsStarted.add(update.toolCallId);
    }

    const enriched = update.toolCallId && toolNames.has(update.toolCallId)
      ? { ...update, toolName: toolNames.get(update.toolCallId) }
      : update;

    for (const normalized of sessionsService.normalizeMessage('opencode', enriched, finalSessionId)) {
      ws.send(normalized);
    }
  };
  let unsubscribe = handle.rpc.onMessage(onAcpMessage);

  try {
    // Image attachments ride along as an <images_input> path list appended to
    // the prompt; the session history reader strips the tag back out.
    const promptText = command && command.trim() ? appendImagesInputTag(command, images) : '';
    const sendPrompt = (text, timeoutMs) => {
      handle.promptInFlight = true;
      return handle.rpc.request('session/prompt', {
        sessionId: handle.opencodeSessionId,
        prompt: [{ type: 'text', text }],
      }, timeoutMs);
    };
    let result;
    try {
      result = await sendPrompt(promptText);
    } catch (promptError) {
      // A child that died mid-turn (crash, OOM) leaves the opencode session
      // intact on disk. Respawn once and resume that session instead of
      // failing the whole run over a transient process death — unless the
      // exit was our own abort.
      const crashed = /process exited|connection closed/i.test(promptError?.message || '');
      if (!crashed || handle.aborted) {
        throw promptError;
      }
      console.warn(`[opencode-cli] session=${finalSessionId} ACP child died mid-prompt — respawning once and retrying`);
      unsubscribe();
      const key = capturedSessionId || processKey;
      const resumeId = handle.opencodeSessionId;
      if (acpSessions.get(key) === handle) {
        acpSessions.delete(key);
      }
      disposeSession(handle);
      const fresh = await createAcpSession(workingDir, resumeId, policy.env);
      acpSessions.set(key, fresh);
      fresh.child.on('exit', () => {
        if (acpSessions.get(key) === fresh) {
          acpSessions.delete(key);
        }
      });
      fresh.child.stderr.on('data', (data) => {
        console.error('OpenCode ACP stderr:', data.toString());
      });
      // Assign before restoring required configuration so any rejection flows
      // through the outer catch/finally and disposes this replacement child.
      handle = fresh;
      if (resolvedModel && (await setConfigOption(fresh, 'model', resolvedModel, { required: true }))) {
        fresh.currentModel = resolvedModel;
      }
      if (resolvedEffort && (await setConfigOption(fresh, 'effort', resolvedEffort))) {
        fresh.currentEffort = resolvedEffort;
      }
      if (await setConfigOption(fresh, 'mode', policy.mode, { required: true })) {
        fresh.currentMode = policy.mode;
      }
      scheduleIdleCleanup(fresh, key);
      unsubscribe = handle.rpc.onMessage(onAcpMessage);
      result = await sendPrompt(promptText);
    }

    // Some otherwise capable models finish after reasoning/tool work without
    // ever producing an assistant-facing message. For a headless consumer that
    // is indistinguishable from an empty run, so give the SAME session one
    // bounded chance to emit the final report before completing. Never expose
    // private thought chunks as the answer and never start a fresh agent run.
    if (
      unattended
      && !sawAssistantText
      && (!result?.stopReason || result.stopReason === 'end_turn')
    ) {
      console.warn(`[opencode-cli] session=${finalSessionId} ended without assistant text — requesting one final report`);
      result = await sendPrompt(UNATTENDED_FINAL_REPORT_NUDGE, FINAL_REPORT_NUDGE_TIMEOUT_MS);
    }
    handle.promptInFlight = false;

    ws.send(createCompleteMessage({ provider: 'opencode', sessionId: finalSessionId, exitCode: 0 }));

    try {
      const tokenBudget = readOpenCodeTokenUsage(handle.opencodeSessionId || finalSessionId);
      if (tokenBudget) {
        ws.send(createNormalizedMessage({
          kind: 'status',
          text: 'token_budget',
          tokenBudget,
          sessionId: finalSessionId,
          provider: 'opencode',
        }));
      }
    } catch (tokenError) {
      console.warn('OpenCode token budget refresh failed (non-fatal):', tokenError?.message || tokenError);
    }

    // Isolated from the main try/catch: a notification-plumbing failure must
    // never retroactively turn an already-sent successful `complete` into a
    // false failure below.
    try {
      await notifyRunStopped({
        userId: ws?.userId || null,
        provider: 'opencode',
        sessionId: finalSessionId,
        sessionName: sessionSummary,
        stopReason: result?.stopReason === 'cancelled' ? 'cancelled' : 'completed',
      });
    } catch (notifyError) {
      console.error('OpenCode notifyRunStopped failed (non-fatal):', notifyError);
    }
  } catch (error) {
    handle.promptInFlight = false;

    const installed = await providerAuthService.isProviderInstalled('opencode');
    const errorContent = !installed
      ? 'OpenCode CLI is not installed. Install it from https://opencode.ai/docs/'
      : error.message;

    ws.send(createNormalizedMessage({ kind: 'error', content: errorContent, sessionId: finalSessionId, provider: 'opencode' }));
    ws.send(createCompleteMessage({ provider: 'opencode', sessionId: finalSessionId, exitCode: 1 }));
    try {
      await notifyRunFailed({
        userId: ws?.userId || null,
        provider: 'opencode',
        sessionId: finalSessionId,
        sessionName: sessionSummary,
        error,
      });
    } catch (notifyError) {
      console.error('OpenCode notifyRunFailed failed (non-fatal):', notifyError);
    }
    throw error;
  } finally {
    unsubscribe();
    // Headless runs (swarm, Mission Control, Kanban) are one prompt per run,
    // and each idle ACP child holds ~500MB. A retry cascade used to stack
    // several of those for the 30-minute idle window, and the resulting memory
    // pressure is exactly what kills other children mid-prompt. The session
    // itself lives on disk; a follow-up resumes it via session/load.
    if (unattended) {
      const key = capturedSessionId || processKey;
      if (acpSessions.get(key) === handle) {
        acpSessions.delete(key);
      }
      disposeSession(handle);
    }
  }
}

function abortOpenCodeSession(sessionId) {
  const handle = acpSessions.get(sessionId);
  if (handle && handle.promptInFlight) {
    handle.aborted = true;
    handle.rpc.notify('session/cancel', { sessionId: handle.opencodeSessionId });
    return true;
  }
  return false;
}

function isOpenCodeSessionActive(sessionId) {
  return acpSessions.has(sessionId);
}

function getActiveOpenCodeSessions() {
  return Array.from(acpSessions.keys());
}

export {
  spawnOpenCode,
  abortOpenCodeSession,
  isOpenCodeSessionActive,
  getActiveOpenCodeSessions,
  disposeOpenCodeSessions,
};
