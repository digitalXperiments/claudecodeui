import readline from 'node:readline';

import crossSpawn from 'cross-spawn';

import { appendImagesInputTag } from './shared/image-attachments.js';
import { createRequestId, waitForToolApproval } from './claude-sdk.js';
import { notifyRunFailed, notifyRunStopped } from './services/notification-orchestrator.js';
import { sessionsService } from './modules/providers/services/sessions.service.js';
import { providerAuthService } from './modules/providers/services/provider-auth.service.js';
import { providerModelsService } from './modules/providers/services/provider-models.service.js';
import { createCompleteMessage, createNormalizedMessage } from './shared/utils.js';

// cross-spawn resolves .cmd shims/PATHEXT on Windows and delegates to
// child_process.spawn everywhere else.
const spawnFunction = crossSpawn;

// Kimi's real Agent Client Protocol (ACP) server, spoken over stdio as
// newline-delimited JSON-RPC 2.0. Verified live (2026-07-18) against
// kimi-code 0.27.0:
//   - initialize -> { agentCapabilities: { loadSession: true, ... } }
//   - session/new { cwd, mcpServers } -> { sessionId, configOptions }
//   - session/load { sessionId, cwd, mcpServers } -> resumes a prior session
//     (same configOptions shape) - used when reconnecting to a session this
//     process instance doesn't have a live child for.
//   - session/set_config_option { sessionId, configId, value } -> notifies
//     back a config_option_update; confirmed for configId "mode" and "model".
//   - session/prompt { sessionId, prompt: [{type:"text", text}] } -> streams
//     session/update notifications, resolves with { stopReason }.
//   - session/cancel { sessionId } sent as a NOTIFICATION (no id, no response
//     expected) -> the in-flight session/prompt then resolves with
//     stopReason "cancelled". This is the real abort mechanism (there is no
//     id-bearing session/cancel request - that returns "Method not found").
//   - session/request_permission is a REQUEST *from* the agent *to* us
//     (carries its own id) when a tool call needs approval; we must respond
//     with { result: { outcome: { outcome: "selected", optionId } } } using
//     one of the optionIds it offered (approve_once / approve_always /
//     reject seen live). This never fires in "auto"/"yolo" mode - only
//     "default"/"plan" force a real approval round-trip - proving Kimi's ACP
//     mode has genuine interactive permission gating, unlike the old `-p`
//     one-shot mode which silently auto-approved regardless of any setting.
//
// Kimi's own mode vocabulary (from session/new's "mode" configOption):
// default | plan | auto | yolo. There is no direct equivalent of cloudcli's
// "acceptEdits" - only 4 (not 5) modes are exposed for kimi, each mapping
// 1:1, rather than picking an approximate/misleading stand-in.
const KIMI_MODE_MAP = {
  default: 'default',
  plan: 'plan',
  auto: 'auto',
  bypassPermissions: 'yolo',
};

// One persistent `kimi acp` child process per cloudcli session, reused
// across every message in that session (unlike the old one-shot `-p` spawn
// per message). Keyed first by a temporary key until the real Kimi session
// id is known, then re-keyed - mirroring the old activeKimiProcesses
// re-keying pattern in captureSessionIdIfNeeded.
const acpSessions = new Map();

const IDLE_TIMEOUT_MS = 30 * 60 * 1000;

function createJsonRpcClient(child) {
  const pending = new Map();
  let nextId = 1;
  const rl = readline.createInterface({ input: child.stdout });
  const notificationHandlers = new Set();

  // A spawn/runtime failure on the child (e.g. ENOENT if `kimi` isn't on
  // PATH, or it crashes mid-session) must reject every in-flight request
  // rather than leave callers hanging or let Node's unhandled 'error' event
  // on the ChildProcess crash the whole server process.
  const rejectAllPending = (error) => {
    for (const [id, waiter] of pending.entries()) {
      pending.delete(id);
      waiter.reject(error);
    }
  };
  child.on('error', rejectAllPending);
  child.on('exit', () => rejectAllPending(new Error('Kimi ACP process exited')));

  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }

    let message;
    try {
      message = JSON.parse(trimmed);
    } catch {
      // Non-JSON-RPC noise on stdout is not expected from `kimi acp`; drop it
      // rather than crash the session over a stray line.
      return;
    }

    if (typeof message.id !== 'undefined' && typeof message.method === 'string') {
      // A REQUEST from the agent to us (e.g. session/request_permission).
      for (const handler of notificationHandlers) {
        handler(message, true);
      }
      return;
    }

    if (typeof message.method === 'string') {
      // A NOTIFICATION (e.g. session/update, or our own session/cancel echoed
      // back is never sent to us - this is purely agent-originated).
      for (const handler of notificationHandlers) {
        handler(message, false);
      }
      return;
    }

    // A RESPONSE to one of our own requests.
    const waiter = pending.get(message.id);
    if (waiter) {
      pending.delete(message.id);
      if (message.error) {
        waiter.reject(new Error(message.error.message || 'ACP request failed'));
      } else {
        waiter.resolve(message.result);
      }
    }
  });

  return {
    // `timeoutMs` is deliberately opt-in, not a blanket default: `session/
    // prompt` can legitimately take a long time (a long agentic turn, or
    // genuinely waiting on the user to answer a `session/request_permission`
    // round-trip) and must not be auto-killed just for being slow. Only the
    // quick setup/config calls (initialize, session/new, session/load,
    // session/set_config_option) have no legitimate reason to hang, so those
    // call sites pass a bound - guards against the same class of issue as
    // the production incident (a stuck external process holding a lock
    // this one then blocks on), without risking killing a real in-flight
    // conversation.
    request(method, params, timeoutMs) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        let timer = null;
        const settle = (fn, value) => {
          if (timer) clearTimeout(timer);
          pending.delete(id);
          fn(value);
        };
        pending.set(id, {
          resolve: (value) => settle(resolve, value),
          reject: (error) => settle(reject, error),
        });
        if (timeoutMs) {
          timer = setTimeout(() => {
            if (pending.delete(id)) {
              reject(new Error(`ACP request "${method}" timed out after ${timeoutMs}ms`));
            }
          }, timeoutMs);
        }
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      });
    },
    notify(method, params) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
    },
    respond(id, result) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
    },
    onMessage(handler) {
      notificationHandlers.add(handler);
      return () => notificationHandlers.delete(handler);
    },
    close() {
      rl.close();
      pending.forEach((waiter) => waiter.reject(new Error('ACP connection closed')));
      pending.clear();
    },
  };
}

async function createAcpSession(workingDir, resumeSessionId) {
  const child = spawnFunction('kimi', ['acp'], {
    cwd: workingDir,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env },
  });

  // createJsonRpcClient attaches child 'error'/'exit' handlers that reject
  // every in-flight request (including this one) rather than letting a spawn
  // failure (e.g. ENOENT if `kimi` isn't on PATH) crash the server via
  // Node's unhandled 'error' event - mirrors the old one-shot code's own
  // `kimiProcess.on('error', ...)` handler.
  const rpc = createJsonRpcClient(child);

  // Setup/handshake calls, unlike session/prompt, have no legitimate reason
  // to run long - bound them so a stuck `kimi acp` process (e.g. blocked on
  // a lock, the same class of issue that caused a real production hang)
  // fails fast instead of hanging the session-open request indefinitely.
  const SETUP_TIMEOUT_MS = 30000;

  let sessionResult;
  try {
    await rpc.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
    }, SETUP_TIMEOUT_MS);

    if (resumeSessionId) {
      try {
        sessionResult = await rpc.request('session/load', {
          sessionId: resumeSessionId,
          cwd: workingDir,
          mcpServers: [],
        }, SETUP_TIMEOUT_MS);
        sessionResult.sessionId = sessionResult.sessionId || resumeSessionId;
      } catch {
        // Fall back to a brand new session if the prior Kimi-native session
        // can't be loaded (e.g. it predates this ACP integration and was only
        // ever created via the old one-shot `-p` mode).
        sessionResult = await rpc.request('session/new', { cwd: workingDir, mcpServers: [] }, SETUP_TIMEOUT_MS);
      }
    } else {
      sessionResult = await rpc.request('session/new', { cwd: workingDir, mcpServers: [] }, SETUP_TIMEOUT_MS);
    }
  } catch (error) {
    // A setup call that timed out means the process is stuck, not just
    // slow to start - kill it rather than leaving an unresponsive `kimi
    // acp` process running invisibly (escalating to SIGKILL if SIGTERM
    // alone doesn't work, same reasoning as everywhere else in this file).
    try {
      rpc.close();
      child.kill('SIGTERM');
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          try {
            child.kill('SIGKILL');
          } catch {
            // Already gone.
          }
        }
      }, 5000);
    } catch {
      // Already gone.
    }
    throw error;
  }

  return {
    child,
    rpc,
    kimiSessionId: sessionResult.sessionId,
    isNewKimiSession: !resumeSessionId,
    currentMode: null,
    currentModel: null,
    idleTimer: null,
    inFlightPromptId: null,
  };
}

function scheduleIdleCleanup(handle, key) {
  if (handle.idleTimer) {
    clearTimeout(handle.idleTimer);
  }
  handle.idleTimer = setTimeout(() => {
    if (acpSessions.get(key) === handle) {
      acpSessions.delete(key);
    }
    try {
      handle.rpc.close();
      handle.child.kill('SIGTERM');
      // A `kimi acp` process that ignores or survives SIGTERM (e.g. blocked
      // on a lock/syscall) would otherwise keep running indefinitely,
      // invisible to cloudcli, holding onto whatever resources it had open -
      // exactly the failure mode that caused a real production hang (a
      // stuck grok process holding an MCP auth lock that a later grok
      // invocation blocked on). Escalate to SIGKILL if it's still alive a
      // grace period later.
      setTimeout(() => {
        if (handle.child.exitCode === null && handle.child.signalCode === null) {
          try {
            handle.child.kill('SIGKILL');
          } catch {
            // Already gone.
          }
        }
      }, 5000);
    } catch {
      // Already gone.
    }
  }, IDLE_TIMEOUT_MS);
}

async function spawnKimi(command, options = {}, ws) {
  const {
    sessionId,
    projectPath,
    cwd,
    model,
    sessionSummary,
    permissionMode = 'bypassPermissions',
  } = options;

  const workingDir = cwd || projectPath || process.cwd();
  const resolvedModel = await providerModelsService.resolveResumeModel('kimi', sessionId, model);
  const kimiMode = KIMI_MODE_MAP[permissionMode] || 'yolo';

  const processKey = sessionId || `new:${Date.now()}`;
  let handle = acpSessions.get(processKey);
  let capturedSessionId = sessionId;

  if (!handle || handle.child.exitCode !== null || handle.child.killed) {
    handle = await createAcpSession(workingDir, sessionId);
    acpSessions.set(processKey, handle);

    if (!capturedSessionId) {
      capturedSessionId = handle.kimiSessionId;
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
        provider: 'kimi',
      }));
    }

    handle.child.on('exit', () => {
      if (acpSessions.get(capturedSessionId || processKey) === handle) {
        acpSessions.delete(capturedSessionId || processKey);
      }
    });
    handle.child.stderr.on('data', (data) => {
      console.error('Kimi ACP stderr:', data.toString());
    });
  } else {
    capturedSessionId = handle.kimiSessionId;
  }

  scheduleIdleCleanup(handle, capturedSessionId || processKey);

  if (handle.currentModel !== resolvedModel && resolvedModel) {
    try {
      await handle.rpc.request('session/set_config_option', {
        sessionId: handle.kimiSessionId,
        configId: 'model',
        value: resolvedModel,
      });
      handle.currentModel = resolvedModel;
    } catch (error) {
      console.error('Failed to set Kimi model:', error);
    }
  }

  if (handle.currentMode !== kimiMode) {
    try {
      await handle.rpc.request('session/set_config_option', {
        sessionId: handle.kimiSessionId,
        configId: 'mode',
        value: kimiMode,
      });
      handle.currentMode = kimiMode;
    } catch (error) {
      console.error('Failed to set Kimi permission mode:', error);
    }
  }

  const finalSessionId = capturedSessionId || handle.kimiSessionId;

  // toolCallId -> whether a tool_use normalized message has already been
  // emitted for it, so the (possibly many) tool_call_update fragments used to
  // stream partial JSON args don't produce duplicate/garbled chat messages.
  const toolCallsStarted = new Set();

  const unsubscribe = handle.rpc.onMessage(async (message, isRequest) => {
    if (isRequest && message.method === 'session/request_permission') {
      const toolCall = message.params?.toolCall || {};
      const requestId = createRequestId();
      const toolName = toolCall.title || 'Tool';
      const toolInput = toolCall.rawInput ?? toolCall.content;

      ws.send(createNormalizedMessage({
        kind: 'permission_request',
        requestId,
        toolName,
        input: toolInput,
        sessionId: finalSessionId,
        provider: 'kimi',
      }));

      const decision = await waitForToolApproval(requestId, {
        metadata: {
          _sessionId: finalSessionId,
          _toolName: toolName,
          _input: toolInput,
          _receivedAt: new Date(),
        },
        onCancel: (reason) => {
          ws.send(createNormalizedMessage({ kind: 'permission_cancelled', requestId, reason, sessionId: finalSessionId, provider: 'kimi' }));
        },
      });

      const options_ = message.params?.options || [];
      let optionId = options_.find((o) => o.kind === 'reject_once')?.optionId || 'reject';
      if (decision && decision.allow) {
        const wantsAlways = Boolean(decision.rememberEntry);
        optionId = (wantsAlways
          ? options_.find((o) => o.kind === 'allow_always')?.optionId
          : options_.find((o) => o.kind === 'allow_once')?.optionId)
          || options_[0]?.optionId
          || 'approve_once';
      }

      handle.rpc.respond(message.id, { outcome: { outcome: 'selected', optionId } });
      return;
    }

    if (message.method !== 'session/update') {
      return;
    }

    const update = message.params?.update;
    if (!update) {
      return;
    }

    const kind = update.sessionUpdate;

    if (kind === 'tool_call_update' && update.rawInput) {
      if (toolCallsStarted.has(update.toolCallId)) {
        return;
      }
      toolCallsStarted.add(update.toolCallId);
    }

    const normalized = sessionsService.normalizeMessage('kimi', update, finalSessionId);
    for (const msg of normalized) {
      ws.send(msg);
    }
  });

  try {
    // Image and file attachments ride along as an <images_input> path list
    // appended to the prompt; the session history reader strips the tag back
    // out for display.
    const promptText = command && command.trim() ? appendImagesInputTag(command, options.images) : '';
    handle.inFlightPromptId = true;
    const result = await handle.rpc.request('session/prompt', {
      sessionId: handle.kimiSessionId,
      prompt: [{ type: 'text', text: promptText }],
    });
    handle.inFlightPromptId = null;

    ws.send(createCompleteMessage({ provider: 'kimi', sessionId: finalSessionId, exitCode: 0 }));
    // Isolated from the main try/catch: a notification-plumbing failure
    // (e.g. a bad user-preferences row) must never retroactively turn an
    // already-sent successful `complete` into a false failure below.
    try {
      await notifyRunStopped({
        userId: ws?.userId || null,
        provider: 'kimi',
        sessionId: finalSessionId,
        sessionName: sessionSummary,
        stopReason: result?.stopReason === 'cancelled' ? 'cancelled' : 'completed',
      });
    } catch (notifyError) {
      console.error('Kimi notifyRunStopped failed (non-fatal):', notifyError);
    }
  } catch (error) {
    handle.inFlightPromptId = null;

    const installed = await providerAuthService.isProviderInstalled('kimi');
    const errorContent = !installed
      ? 'Kimi Code CLI is not installed. Please install it with: npm install -g @moonshot-ai/kimi-code'
      : error.message;

    ws.send(createNormalizedMessage({ kind: 'error', content: errorContent, sessionId: finalSessionId, provider: 'kimi' }));
    ws.send(createCompleteMessage({ provider: 'kimi', sessionId: finalSessionId, exitCode: 1 }));
    try {
      await notifyRunFailed({
        userId: ws?.userId || null,
        provider: 'kimi',
        sessionId: finalSessionId,
        sessionName: sessionSummary,
        error,
      });
    } catch (notifyError) {
      console.error('Kimi notifyRunFailed failed (non-fatal):', notifyError);
    }
    throw error;
  } finally {
    unsubscribe();
  }
}

function abortKimiSession(sessionId) {
  const handle = acpSessions.get(sessionId);
  if (handle && handle.inFlightPromptId) {
    handle.rpc.notify('session/cancel', { sessionId: handle.kimiSessionId });
    return true;
  }
  return false;
}

function isKimiSessionActive(sessionId) {
  return acpSessions.has(sessionId);
}

function getActiveKimiSessions() {
  return Array.from(acpSessions.keys());
}

export {
  spawnKimi,
  abortKimiSession,
  isKimiSessionActive,
  getActiveKimiSessions,
};
