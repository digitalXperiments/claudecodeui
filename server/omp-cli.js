import { StringDecoder } from 'node:string_decoder';

import crossSpawn from 'cross-spawn';

import { buildPiPromptPayload } from './shared/image-attachments.js';
import { notifyRunFailed, notifyRunStopped } from './services/notification-orchestrator.js';
import { sessionsService } from './modules/providers/services/sessions.service.js';
import { providerAuthService } from './modules/providers/services/provider-auth.service.js';
import { providerModelsService } from './modules/providers/services/provider-models.service.js';
import { createCompleteMessage, createNormalizedMessage } from './shared/utils.js';
import { leadSessionEnv } from './shared/lead-session-env.js';

// cross-spawn resolves .cmd shims/PATHEXT on Windows and delegates to
// child_process.spawn everywhere else.
const spawnFunction = crossSpawn;

// Oh My Pi RPC mode (`omp --mode rpc`): JSONL over stdin/stdout. Oh My Pi is a
// fork of the Pi coding agent and speaks the same protocol (see server/pi-cli.js):
//   - Commands: { id?, type: "prompt"|"abort"|"set_model"|... }
//   - Responses: { type: "response", command, success, data?, error? }
//   - Events: ready (startup handshake), message_update (text/thinking deltas),
//     tool_execution_*, agent_settled / agent_end
//   - Framing: split on `\n` only — Node `readline` is NOT protocol-safe.
//
// One persistent `omp --mode rpc` child per cloudcli session, reused across
// messages. Session id comes from get_state after spawn (or --resume).

const rpcSessions = new Map();
const IDLE_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Plan mode maps to Oh My Pi's read-only tool allowlist. Everything else explicitly
 * enables every built-in coding tool (Oh My Pi has no built-in permission popups).
 */
export function buildOmpSpawnArgs({ model, permissionMode, resumeSessionId, thinkingLevel }) {
  const args = ['--mode', 'rpc'];

  if (resumeSessionId) {
    args.push('--resume', resumeSessionId);
  }

  if (model) {
    // Oh My Pi accepts `provider/id` or bare ids via --model.
    args.push('--model', model);
  }

  if (thinkingLevel) {
    args.push('--thinking', thinkingLevel);
  }

  args.push(
    '--tools',
    permissionMode === 'plan'
      ? 'read,grep,glob'
      : 'read,bash,edit,write,grep,glob',
  );

  // Headless / non-interactive: don't block on project-trust or tool prompts.
  args.push('--auto-approve');

  return args;
}

function parseModelRef(model) {
  if (!model || typeof model !== 'string') {
    return null;
  }
  const slash = model.indexOf('/');
  if (slash <= 0) {
    return { provider: undefined, modelId: model };
  }
  return {
    provider: model.slice(0, slash),
    modelId: model.slice(slash + 1),
  };
}

/**
 * Strict LF JSONL reader (Oh My Pi forbids generic readline because U+2028/U+2029
 * are valid inside JSON strings).
 */
function attachJsonlReader(stream, onLine) {
  const decoder = new StringDecoder('utf8');
  let buffer = '';

  stream.on('data', (chunk) => {
    buffer += typeof chunk === 'string' ? chunk : decoder.write(chunk);

    while (true) {
      const newlineIndex = buffer.indexOf('\n');
      if (newlineIndex === -1) break;

      let line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (line.trim()) onLine(line);
    }
  });

  stream.on('end', () => {
    buffer += decoder.end();
    if (buffer.length > 0) {
      onLine(buffer.endsWith('\r') ? buffer.slice(0, -1) : buffer);
    }
  });
}

function createOmpRpcClient(child) {
  const pending = new Map();
  let nextId = 1;
  const eventHandlers = new Set();

  const rejectAllPending = (error) => {
    for (const [id, waiter] of pending.entries()) {
      pending.delete(id);
      waiter.reject(error);
    }
  };

  child.on('error', rejectAllPending);
  child.on('exit', () => rejectAllPending(new Error('Oh My Pi RPC process exited')));
  // Writing to stdin after the child has already exited raises EPIPE on the
  // stream itself, not on `child`'s 'error' event above. Unhandled, that
  // crashes the whole Node process and drops every session, not just this one.
  child.stdin.on('error', (error) => {
    console.error('[omp-cli] stdin write failed (process likely exited):', error?.message || error);
  });

  attachJsonlReader(child.stdout, (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }

    if (message && message.type === 'response' && message.id != null) {
      const waiter = pending.get(message.id);
      if (waiter) {
        pending.delete(message.id);
        if (message.success === false) {
          waiter.reject(new Error(message.error || `Oh My Pi RPC command "${message.command}" failed`));
        } else {
          waiter.resolve(message);
        }
        return;
      }
    }

    for (const handler of eventHandlers) {
      handler(message);
    }
  });

  return {
    request(command, extra = {}, timeoutMs = 30000) {
      const id = String(nextId++);
      const payload = { id, type: command, ...extra };
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
              reject(new Error(`Oh My Pi RPC "${command}" timed out after ${timeoutMs}ms`));
            }
          }, timeoutMs);
        }
        try {
          child.stdin.write(`${JSON.stringify(payload)}\n`);
        } catch (error) {
          settle(reject, error);
        }
      });
    },
    notify(command, extra = {}) {
      try {
        child.stdin.write(`${JSON.stringify({ type: command, ...extra })}\n`);
      } catch {
        // Process may already be dead.
      }
    },
    onEvent(handler) {
      eventHandlers.add(handler);
      return () => eventHandlers.delete(handler);
    },
    close() {
      pending.forEach((waiter) => waiter.reject(new Error('Oh My Pi RPC connection closed')));
      pending.clear();
      eventHandlers.clear();
    },
  };
}

/**
 * Resolve on the RPC host's startup `ready` frame, or after `timeoutMs` if it
 * never arrives — the handshake is advisory, so a missing frame must not block
 * the spawn.
 */
function waitForReadyFrame(rpc, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      unsubscribe();
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    const unsubscribe = rpc.onEvent((event) => {
      if (event?.type === 'ready') finish();
    });
  });
}

async function createOmpRpcSession(workingDir, resumeSessionId, model, permissionMode, thinkingLevel, extraEnv = {}) {
  const args = buildOmpSpawnArgs({ model, permissionMode, resumeSessionId, thinkingLevel });
  const child = spawnFunction('omp', args, {
    cwd: workingDir,
    stdio: ['pipe', 'pipe', 'pipe'],
    // Oh My Pi forked Pi, so honour both marker vars — whichever the installed
    // build actually reads.
    env: {
      ...process.env,
      OMP_CODING_AGENT: 'true',
      PI_CODING_AGENT: 'true',
      ...extraEnv,
    },
  });

  const rpc = createOmpRpcClient(child);

  child.stderr?.on('data', (data) => {
    const text = data.toString().trim();
    if (text) {
      console.error('Oh My Pi RPC stderr:', text);
    }
  });

  // Wait until get_state succeeds (process ready) — bound so a stuck spawn fails fast.
  const SETUP_TIMEOUT_MS = 30000;
  let state;
  try {
    // Oh My Pi announces itself with a `ready` frame before it accepts
    // commands. Give it a short window, but never block on it: builds that
    // don't emit one answer get_state straight away.
    await waitForReadyFrame(rpc, 5000);
    const response = await rpc.request('get_state', {}, SETUP_TIMEOUT_MS);
    state = response.data || {};
  } catch (error) {
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

  const ompSessionId = state.sessionId || resumeSessionId || null;

  return {
    child,
    rpc,
    ompSessionId,
    sessionFile: state.sessionFile || null,
    currentModel: model || null,
    currentEffort: thinkingLevel || undefined,
    idleTimer: null,
    inFlight: false,
  };
}

function scheduleIdleCleanup(handle, key) {
  if (handle.idleTimer) {
    clearTimeout(handle.idleTimer);
  }
  handle.idleTimer = setTimeout(() => {
    if (rpcSessions.get(key) === handle) {
      rpcSessions.delete(key);
    }
    try {
      handle.rpc.close();
      handle.child.kill('SIGTERM');
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

async function spawnOmp(command, options = {}, ws) {
  const {
    sessionId,
    projectPath,
    cwd,
    model,
    effort,
    sessionSummary,
    permissionMode = 'bypassPermissions',
    appSessionId,
  } = options;

  const workingDir = cwd || projectPath || process.cwd();
  // Peer mailbox identity: the omp RPC child inherits this into any MCP
  // server it spawns from its own config (including cloudcli-session-mailbox).
  const identityEnv = appSessionId
    ? {
      CLOUDCLI_SESSION_ID: appSessionId,
      CLOUDCLI_PROVIDER: 'omp',
      CLOUDCLI_PROJECT_PATH: workingDir,
    }
    : {};
  const resolvedModel = await providerModelsService.resolveResumeModel('omp', sessionId, model);

  // Effort only makes sense when the selected model's catalog entry
  // advertises thinking support (surfaced by omp-models.provider from
  // `omp models`'s "thinking" column); otherwise the CLI's own
  // per-model default is used.
  const catalog = (await providerModelsService.getProviderModels('omp')).models;
  const selectedModel = catalog.OPTIONS.find((option) => option.value === resolvedModel) || null;
  const allowedEfforts = selectedModel?.effort?.values?.map((value) => value.value) || [];
  const resolvedEffort = typeof effort === 'string' && effort !== 'default' && allowedEfforts.includes(effort)
    ? effort
    : undefined;

  const processKey = sessionId || `new:${Date.now()}`;
  let handle = rpcSessions.get(processKey);
  let capturedSessionId = sessionId;

  if (!handle || handle.child.exitCode !== null || handle.child.killed) {
    handle = await createOmpRpcSession(workingDir, sessionId, resolvedModel, permissionMode, resolvedEffort, {
      ...identityEnv,
      ...leadSessionEnv(options.appSessionId),
    });
    rpcSessions.set(processKey, handle);

    if (!capturedSessionId && handle.ompSessionId) {
      capturedSessionId = handle.ompSessionId;
      rpcSessions.delete(processKey);
      rpcSessions.set(capturedSessionId, handle);
      if (ws.setSessionId && typeof ws.setSessionId === 'function') {
        ws.setSessionId(capturedSessionId);
      }
      ws.send(createNormalizedMessage({
        kind: 'session_created',
        newSessionId: capturedSessionId,
        cwd: workingDir,
        sessionId: capturedSessionId,
        provider: 'omp',
      }));
    }

    handle.child.on('exit', () => {
      if (rpcSessions.get(capturedSessionId || processKey) === handle) {
        rpcSessions.delete(capturedSessionId || processKey);
      }
    });
  } else {
    capturedSessionId = handle.ompSessionId || sessionId;
  }

  // Refresh session id from live state if we still don't have one.
  if (!capturedSessionId) {
    try {
      const response = await handle.rpc.request('get_state', {}, 10000);
      if (response.data?.sessionId) {
        capturedSessionId = response.data.sessionId;
        handle.ompSessionId = capturedSessionId;
        rpcSessions.delete(processKey);
        rpcSessions.set(capturedSessionId, handle);
        if (ws.setSessionId && typeof ws.setSessionId === 'function') {
          ws.setSessionId(capturedSessionId);
        }
        ws.send(createNormalizedMessage({
          kind: 'session_created',
          newSessionId: capturedSessionId,
          cwd: workingDir,
          sessionId: capturedSessionId,
          provider: 'omp',
        }));
      }
    } catch {
      // Continue without session id — still stream this turn.
    }
  }

  scheduleIdleCleanup(handle, capturedSessionId || processKey);

  // Mid-session model switch via RPC when the catalog selection changed.
  if (resolvedModel && handle.currentModel !== resolvedModel) {
    const ref = parseModelRef(resolvedModel);
    if (ref?.modelId) {
      try {
        const payload = { modelId: ref.modelId };
        if (ref.provider) payload.provider = ref.provider;
        await handle.rpc.request('set_model', payload, 15000);
        handle.currentModel = resolvedModel;
        // Switching models can change (or drop) thinking support, so any
        // previously applied effort must be re-applied below.
        handle.currentEffort = undefined;
      } catch (error) {
        console.error('Failed to set Oh My Pi model:', error?.message || error);
      }
    }
  }

  if (resolvedEffort && handle.currentEffort !== resolvedEffort) {
    try {
      await handle.rpc.request('set_thinking_level', { level: resolvedEffort }, 15000);
      handle.currentEffort = resolvedEffort;
    } catch (error) {
      console.error('Failed to set Oh My Pi thinking level:', error?.message || error);
    }
  }

  const finalSessionId = capturedSessionId || handle.ompSessionId || processKey;
  const toolCallsStarted = new Set();

  const unsubscribe = handle.rpc.onEvent((event) => {
    if (!event || typeof event !== 'object') return;

    // Stream text / thinking / tools through the shared normalizer.
    if (
      event.type === 'message_update'
      || event.type === 'tool_execution_start'
      || event.type === 'tool_execution_update'
      || event.type === 'tool_execution_end'
    ) {
      if (event.type === 'tool_execution_start' && event.toolCallId) {
        if (toolCallsStarted.has(event.toolCallId)) return;
        toolCallsStarted.add(event.toolCallId);
      }

      const normalized = sessionsService.normalizeMessage('omp', event, finalSessionId);
      for (const msg of normalized) {
        ws.send(msg);
      }
    }
  });

  try {
    const promptPayload = (command && command.trim()) || options.images
      ? await buildPiPromptPayload(command || '', options.images, workingDir)
      : { message: '' };

    handle.inFlight = true;

    // Prompt acceptance is acked immediately; the actual agent run streams as
    // events until the turn settles. Wait for the ack first, then for settle.
    await handle.rpc.request('prompt', promptPayload, 60000);

    await new Promise((resolve, reject) => {
      let settled = false;
      let turnError = null;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        cleanup();
        fn(value);
      };

      const onEvent = (event) => {
        // Oh My Pi reports provider failures as an assistant message_update error,
        // not as a failed prompt response. Wait for the turn to settle so the
        // persistent RPC session is reusable, then surface the failure.
        if (
          event?.type === 'message_update'
          && event.assistantMessageEvent?.type === 'error'
          && event.assistantMessageEvent?.reason === 'error'
        ) {
          const errorMessage = event.assistantMessageEvent.error?.errorMessage
            || 'Oh My Pi assistant request failed';
          turnError = new Error(errorMessage);
        }
        // `agent_settled` is Pi's terminal frame; Oh My Pi also emits
        // `agent_end`, which is only terminal when `isTerminal` is not false
        // (sub-agent / nested runs report `isTerminal: false`).
        if (
          event?.type === 'agent_settled'
          || (event?.type === 'agent_end' && event.isTerminal !== false)
        ) {
          finish(turnError ? reject : resolve, turnError || undefined);
        }
      };

      const unsub = handle.rpc.onEvent(onEvent);
      const onExit = () => finish(reject, new Error('Oh My Pi RPC process exited during prompt'));
      handle.child.once('exit', onExit);

      // Safety net: if the terminal frame never arrives, don't hang forever.
      const hangTimer = setTimeout(() => {
        finish(reject, turnError || new Error('Oh My Pi agent did not settle before timeout'));
      }, 30 * 60 * 1000);

      function cleanup() {
        clearTimeout(hangTimer);
        unsub();
        handle.child.removeListener('exit', onExit);
      }
    });

    handle.inFlight = false;

    ws.send(createCompleteMessage({ provider: 'omp', sessionId: finalSessionId, exitCode: 0 }));

    try {
      await notifyRunStopped({
        userId: ws?.userId || null,
        provider: 'omp',
        sessionId: finalSessionId,
        sessionName: sessionSummary,
        stopReason: 'completed',
      });
    } catch (notifyError) {
      console.error('Oh My Pi notifyRunStopped failed (non-fatal):', notifyError);
    }
  } catch (error) {
    handle.inFlight = false;

    const installed = await providerAuthService.isProviderInstalled('omp');
    const errorContent = !installed
      ? 'Oh My Pi CLI is not installed. Install with: curl -fsSL https://omp.sh/install | sh'
      : (error?.message || String(error));

    ws.send(createNormalizedMessage({
      kind: 'error',
      content: errorContent,
      sessionId: finalSessionId,
      provider: 'omp',
    }));
    ws.send(createCompleteMessage({ provider: 'omp', sessionId: finalSessionId, exitCode: 1 }));

    try {
      await notifyRunFailed({
        userId: ws?.userId || null,
        provider: 'omp',
        sessionId: finalSessionId,
        sessionName: sessionSummary,
        error,
      });
    } catch (notifyError) {
      console.error('Oh My Pi notifyRunFailed failed (non-fatal):', notifyError);
    }
    throw error;
  } finally {
    unsubscribe();
  }
}

function abortOmpSession(sessionId) {
  const handle = rpcSessions.get(sessionId);
  if (handle && handle.inFlight) {
    handle.rpc.notify('abort');
    return true;
  }
  return false;
}

function isOmpSessionActive(sessionId) {
  return rpcSessions.has(sessionId);
}

function getActiveOmpSessions() {
  return Array.from(rpcSessions.keys());
}

async function getOmpSessionStats(sessionId) {
  const handle = rpcSessions.get(sessionId);
  if (!handle || handle.child.exitCode !== null || handle.child.killed) {
    return null;
  }
  const response = await handle.rpc.request('get_session_stats', {}, 10000);
  return response.data || null;
}

export {
  spawnOmp,
  abortOmpSession,
  isOmpSessionActive,
  getActiveOmpSessions,
  getOmpSessionStats,
};
