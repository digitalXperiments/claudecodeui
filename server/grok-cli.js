import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

import crossSpawn from 'cross-spawn';

import { createRequestId, waitForToolApproval } from './claude-sdk.js';
import { notifyRunFailed, notifyRunStopped } from './services/notification-orchestrator.js';
import { sessionsService } from './modules/providers/services/sessions.service.js';
import { providerAuthService } from './modules/providers/services/provider-auth.service.js';
import { providerModelsService } from './modules/providers/services/provider-models.service.js';
import { isInteractiveTool } from './shared/interactive-tools.js';
import { appendImagesInputTag } from './shared/image-attachments.js';
import { createCompleteMessage, createNormalizedMessage } from './shared/utils.js';

// cross-spawn resolves .cmd shims/PATHEXT on Windows and delegates to
// child_process.spawn everywhere else.
const spawnFunction = crossSpawn;

// Grok's Agent Client Protocol server, spoken over stdio as newline-delimited
// JSON-RPC 2.0. Verified live (grok 0.2.106) against `grok agent stdio`:
//   - initialize -> { agentCapabilities: { loadSession: true, ... } }
//   - session/new { cwd, mcpServers } -> { sessionId, models, _meta } (MCP
//     servers configured in ~/.claude.json / .mcp.json auto-load).
//   - session/load { sessionId, cwd, mcpServers } -> resumes a prior session
//     (loadSession capability advertised in initialize).
//   - session/prompt { sessionId, prompt: [{type:"text", text}] } -> streams
//     session/update notifications, resolves with { stopReason }.
//   - session/cancel { sessionId } sent as a NOTIFICATION -> the in-flight
//     session/prompt resolves with a cancelled stopReason. Mirrors Kimi's ACP
//     abort mechanism.
//   - session/request_permission is a REQUEST *from* the agent when a tool
//     needs approval; answered with { outcome: { outcome: "selected",
//     optionId } } using one of the offered optionIds. Fires when the effective
//     permission mode is not always-approve / bypassPermissions (verified live
//     with a CloudCLI-managed GROK_HOME that sets [ui] permission_mode).
//
// Why ACP and not the old `-p --output-format streaming-json` path: that
// headless wire only ever emitted `text`/`thought`/`end` (no tool events at
// all — confirmed against Grok's own docs, README streaming-json schema), so
// the chat UI could never show live tool cards, results, or permission
// prompts. ACP streams `tool_call`/`tool_call_update`/`agent_thought_chunk`/
// `plan`/`turn_completed` live, bringing Grok to parity with Claude/Kimi.
//
// Note: Grok ACP advertises promptCapabilities.image=false, so true image
// content blocks aren't accepted; images ride along as the same text-based
// <images_input> path list the rest of the adapters use (appendImagesInputTag),
// which the session-history reader strips back out.

/** CloudCLI-supported permission modes for Grok (cycle order matches capabilities). */
const GROK_PERMISSION_MODES = new Set([
  'default',
  'acceptEdits',
  'auto',
  'bypassPermissions',
  'plan',
]);

/**
 * Map CloudCLI permission modes onto Grok config `[ui] permission_mode` values
 * and whether to pass `--always-approve` on `grok agent`.
 *
 * `grok agent` only exposes `--always-approve` (not `--permission-mode`), so
 * non-bypass modes are applied via a managed GROK_HOME config.toml. That also
 * isolates us from a user's personal `~/.grok/config.toml` which may force
 * always-approve and would otherwise make every mode look like Bypass.
 */
function resolveGrokPermissionRuntime(permissionMode) {
  const mode = GROK_PERMISSION_MODES.has(permissionMode) ? permissionMode : 'default';
  if (mode === 'bypassPermissions') {
    return {
      mode,
      configPermissionMode: 'always-approve',
      alwaysApprove: true,
    };
  }
  // Grok config.toml uses the same identifiers as --permission-mode for these.
  return {
    mode,
    configPermissionMode: mode,
    alwaysApprove: false,
  };
}

/**
 * Force `[ui] permission_mode` / `yolo` in a TOML blob without a full parser.
 * Replaces existing keys when present; otherwise inserts them under `[ui]`.
 * Keeps MCP servers, marketplace, models, and other user settings intact.
 */
function applyPermissionModeToConfigToml(tomlText, configPermissionMode) {
  let next = typeof tomlText === 'string' ? tomlText : '';

  if (/^\s*permission_mode\s*=/m.test(next)) {
    next = next.replace(
      /^\s*permission_mode\s*=\s*.*$/m,
      `permission_mode = "${configPermissionMode}"`,
    );
  } else if (/^\[ui\]/m.test(next)) {
    next = next.replace(/^\[ui\][ \t]*$/m, `[ui]\npermission_mode = "${configPermissionMode}"`);
  } else {
    next = `${next.trimEnd()}\n\n[ui]\npermission_mode = "${configPermissionMode}"\n`;
  }

  if (/^\s*yolo\s*=/m.test(next)) {
    next = next.replace(/^\s*yolo\s*=\s*.*$/m, 'yolo = false');
  } else if (/^\[ui\]/m.test(next)) {
    next = next.replace(
      /^\[ui\][ \t]*\n(?:permission_mode\s*=\s*.*\n)?/m,
      (match) => `${match}yolo = false\n`,
    );
  }

  const banner = '# CloudCLI-managed permission_mode overlay — regenerated each spawn.\n';
  if (!next.includes('CloudCLI-managed permission_mode overlay')) {
    next = banner + next;
  }
  return next.endsWith('\n') ? next : `${next}\n`;
}

/**
 * Build a per-mode GROK_HOME that reuses the user's real auth/credentials and
 * most of their config, but forces CloudCLI's chosen permission mode. That
 * isolation is required because a personal `~/.grok/config.toml` with
 * `permission_mode = "always-approve"` would otherwise make every chatbar mode
 * behave like Bypass Permissions.
 */
function ensureManagedGrokHome(configPermissionMode) {
  const userGrokHome = process.env.GROK_HOME || path.join(os.homedir(), '.grok');
  // If CloudCLI is already nested under a managed home, use the original user
  // home for sources (avoid stacking overlays).
  const sourceHome = userGrokHome.includes(`${path.sep}.cloudcli${path.sep}grok-runtime${path.sep}`)
    ? path.join(os.homedir(), '.grok')
    : userGrokHome;

  const managedRoot = path.join(os.homedir(), '.cloudcli', 'grok-runtime');
  const managedHome = path.join(managedRoot, configPermissionMode);

  fs.mkdirSync(managedHome, { recursive: true });

  // Auth + credentials + trust. `trusted_folders.toml` is required so project-
  // scoped MCP (e.g. Obsidian memory from `.mcp.json` / `.grok/config.toml`)
  // is not blocked as "folder untrusted" under the managed GROK_HOME.
  const shareNames = [
    'auth.json',
    'mcp_credentials.json',
    'models_cache.json',
    'trusted_folders.toml',
  ];
  for (const name of shareNames) {
    const src = path.join(sourceHome, name);
    const dest = path.join(managedHome, name);
    if (!fs.existsSync(src)) {
      continue;
    }
    try {
      if (fs.existsSync(dest)) {
        fs.unlinkSync(dest);
      }
      fs.linkSync(src, dest);
    } catch {
      try {
        fs.copyFileSync(src, dest);
      } catch {
        // Auth may still work from default paths; non-fatal.
      }
    }
  }

  // Reuse heavyweight caches without full duplication.
  for (const dirName of ['marketplace-cache', 'sessions', 'skills', 'bundled', 'docs']) {
    const userDir = path.join(sourceHome, dirName);
    const linkPath = path.join(managedHome, dirName);
    if (!fs.existsSync(userDir)) {
      continue;
    }
    try {
      if (fs.existsSync(linkPath) || fs.lstatSync(linkPath).isSymbolicLink()) {
        // Already linked/copied.
      } else {
        fs.symlinkSync(userDir, linkPath, 'dir');
      }
    } catch {
      try {
        if (!fs.existsSync(linkPath)) {
          fs.symlinkSync(userDir, linkPath, 'dir');
        }
      } catch {
        // Optional.
      }
    }
  }

  let userConfig = '';
  const userConfigPath = path.join(sourceHome, 'config.toml');
  try {
    userConfig = fs.readFileSync(userConfigPath, 'utf8');
  } catch {
    userConfig = '';
  }

  const configPath = path.join(managedHome, 'config.toml');
  fs.writeFileSync(
    configPath,
    applyPermissionModeToConfigToml(userConfig, configPermissionMode),
    'utf8',
  );

  return managedHome;
}

// Grok exposes model + reasoning effort as `grok agent`-level spawn flags.
// Permission mode is applied via managed GROK_HOME + optional --always-approve
// (see resolveGrokPermissionRuntime). The ACP permission bridge answers
// session/request_permission for non-bypass modes.
const buildSpawnArgs = ({ model, effort, alwaysApprove }) => {
  const args = ['agent'];
  if (model) {
    args.push('-m', model);
  }
  if (effort) {
    args.push('--reasoning-effort', effort);
  }
  if (alwaysApprove) {
    args.push('--always-approve');
  }
  args.push('stdio');
  return args;
};

// One persistent `grok agent stdio` child per cloudcli session, reused across
// every message in that session. Keyed by a temporary key until the real Grok
// session id is known, then re-keyed. Mirrors kimi-cli.js.
const acpSessions = new Map();

const IDLE_TIMEOUT_MS = 30 * 60 * 1000;

function createJsonRpcClient(child) {
  const pending = new Map();
  let nextId = 1;
  const rl = readline.createInterface({ input: child.stdout });
  const notificationHandlers = new Set();

  // A spawn/runtime failure on the child (e.g. ENOENT if `grok` isn't on PATH,
  // or it crashes mid-session) must reject every in-flight request rather than
  // leave callers hanging or let Node's unhandled 'error' event crash the
  // whole server process.
  const rejectAllPending = (error) => {
    for (const [id, waiter] of pending.entries()) {
      pending.delete(id);
      waiter.reject(error);
    }
  };
  child.on('error', rejectAllPending);
  child.on('exit', () => rejectAllPending(new Error('Grok ACP process exited')));

  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }

    let message;
    try {
      message = JSON.parse(trimmed);
    } catch {
      // Non-JSON-RPC noise on stdout is not expected from `grok agent stdio`;
      // drop it rather than crash the session over a stray line.
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
      // A NOTIFICATION (e.g. session/update).
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
    // `timeoutMs` is deliberately opt-in: `session/prompt` can legitimately run
    // long (a long agentic turn, or waiting on a session/request_permission
    // round-trip) and must not be auto-killed for being slow. Only the quick
    // setup calls (initialize, session/new, session/load) pass a bound.
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

async function createAcpSession(workingDir, resumeSessionId, spawnArgs, envOverrides = {}) {
  const child = spawnFunction('grok', spawnArgs, {
    cwd: workingDir,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...envOverrides },
  });

  const rpc = createJsonRpcClient(child);

  // Setup/handshake calls, unlike session/prompt, have no legitimate reason to
  // run long - bound them so a stuck `grok agent stdio` process fails fast
  // instead of hanging the session-open request indefinitely.
  const SETUP_TIMEOUT_MS = 30000;

  let sessionResult;
  try {
    // fs must be false so the agent performs its own file I/O. Declaring
    // readTextFile/writeTextFile=true makes Grok DELEGATE reads/writes back to
    // us via fs/read_text_file / fs/write_text_file requests — which this
    // client doesn't service, so writes silently no-op and the turn can stall
    // (verified live). Mirrors kimi-cli.js.
    await rpc.request('initialize', {
      protocolVersion: '1',
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
      },
    }, SETUP_TIMEOUT_MS);

    if (resumeSessionId) {
      try {
        sessionResult = await rpc.request('session/load', {
          sessionId: resumeSessionId,
          cwd: workingDir,
          mcpServers: [],
        }, SETUP_TIMEOUT_MS);
        sessionResult = sessionResult || {};
        sessionResult.sessionId = sessionResult.sessionId || resumeSessionId;
      } catch {
        // Fall back to a brand new session if the prior Grok-native session
        // can't be loaded (e.g. it predates this ACP integration and was only
        // ever created via the old headless streaming-json invocation).
        sessionResult = await rpc.request('session/new', { cwd: workingDir, mcpServers: [] }, SETUP_TIMEOUT_MS);
      }
    } else {
      sessionResult = await rpc.request('session/new', { cwd: workingDir, mcpServers: [] }, SETUP_TIMEOUT_MS);
    }
  } catch (error) {
    // A setup call that timed out means the process is stuck, not just slow to
    // start - kill it rather than leaving an unresponsive process running
    // invisibly (escalating to SIGKILL if SIGTERM alone doesn't work).
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
    grokSessionId: sessionResult.sessionId,
    idleTimer: null,
    inFlightPrompt: false,
    aborted: false,
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
    closeHandle(handle);
  }, IDLE_TIMEOUT_MS);
}

// SIGTERM, escalating to SIGKILL, on a child that ignores or survives it (e.g.
// blocked on a lock/syscall) - the same production hang class guarded against
// everywhere in this file. Used by idle cleanup and by settings-change
// recreation.
function closeHandle(handle) {
  if (handle.idleTimer) {
    clearTimeout(handle.idleTimer);
    handle.idleTimer = null;
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
}

async function spawnGrok(command, options = {}, ws) {
  const {
    sessionId,
    projectPath,
    cwd,
    model,
    effort,
    sessionSummary,
    permissionMode = 'bypassPermissions',
  } = options;

  const workingDir = cwd || projectPath || process.cwd();

  const resolvedModel = await providerModelsService.resolveResumeModel('grok', sessionId, model);
  const catalog = (await providerModelsService.getProviderModels('grok')).models;
  const selectedModel = catalog.OPTIONS.find((option) => option.value === resolvedModel) || null;
  const allowedEfforts = selectedModel?.effort?.values?.map((value) => value.value) || [];
  const resolvedEffort = typeof effort === 'string' && effort !== 'default' && allowedEfforts.includes(effort)
    ? effort
    : undefined;

  const permissionRuntime = resolveGrokPermissionRuntime(permissionMode);
  const managedGrokHome = ensureManagedGrokHome(permissionRuntime.configPermissionMode);
  const spawnEnv = { GROK_HOME: managedGrokHome };
  const spawnArgs = buildSpawnArgs({
    model: resolvedModel,
    effort: resolvedEffort,
    alwaysApprove: permissionRuntime.alwaysApprove,
  });
  // Grok has no ACP config method for model/effort/permission, so these are
  // fixed at spawn. A reused child whose settings changed must be recreated
  // (with session/load to preserve history) to apply the new flags.
  const spawnSignature = `${spawnArgs.join(' ')}|${permissionRuntime.mode}|${managedGrokHome}`;

  const processKey = sessionId || `new:${Date.now()}`;
  let handle = acpSessions.get(processKey);
  let capturedSessionId = sessionId;

  const needsNewChild =
    !handle
    || handle.child.exitCode !== null
    || handle.child.killed
    || handle.spawnSignature !== spawnSignature;

  if (needsNewChild) {
    if (handle) {
      acpSessions.delete(processKey);
      closeHandle(handle);
    }

    handle = await createAcpSession(workingDir, sessionId, spawnArgs, spawnEnv);
    handle.spawnSignature = spawnSignature;
    acpSessions.set(processKey, handle);

    if (!capturedSessionId) {
      capturedSessionId = handle.grokSessionId;
      acpSessions.delete(processKey);
      acpSessions.set(capturedSessionId, handle);
      if (ws.setSessionId && typeof ws.setSessionId === 'function') {
        ws.setSessionId(capturedSessionId);
      }
      // ACP reveals the session id at session/new (unlike the old
      // streaming-json path, which only exposed it on the terminal `end`
      // event), so a brand-new session navigates/attaches immediately instead
      // of only once the run finished.
      ws.send(createNormalizedMessage({
        kind: 'session_created',
        newSessionId: capturedSessionId,
        cwd: workingDir,
        sessionId: capturedSessionId,
        provider: 'grok',
      }));
    }

    handle.child.on('exit', () => {
      if (acpSessions.get(capturedSessionId || processKey) === handle) {
        acpSessions.delete(capturedSessionId || processKey);
      }
    });
    handle.child.stderr.on('data', (data) => {
      console.error('Grok ACP stderr:', data.toString());
    });
  } else {
    capturedSessionId = handle.grokSessionId;
  }

  scheduleIdleCleanup(handle, capturedSessionId || processKey);

  const finalSessionId = capturedSessionId || handle.grokSessionId;

  const unsubscribe = handle.rpc.onMessage(async (message, isRequest) => {
    // Grok's ask_user_question tool does NOT use session/request_permission.
    // It sends a blocking extension request `_x.ai/ask_user_question` that the
    // client must answer with { outcome, answers? }. Verified live (0.2.106):
    //   accepted variants: accepted | chat_about_this | skip_interview | cancelled
    // Surface it as CloudCLI's AskUserQuestion panel so the chatbar UI matches Claude.
    if (isRequest && (message.method === '_x.ai/ask_user_question' || message.method === 'x.ai/ask_user_question')) {
      const params = message.params || {};
      const questions = Array.isArray(params.questions) ? params.questions : [];
      const requestId = createRequestId();
      const toolName = 'AskUserQuestion';
      const toolInput = {
        questions: questions.map((q) => ({
          question: typeof q?.question === 'string' ? q.question : '',
          header: typeof q?.header === 'string' ? q.header : undefined,
          multiSelect: Boolean(q?.multiSelect),
          options: Array.isArray(q?.options)
            ? q.options.map((opt) => ({
              label: typeof opt?.label === 'string' ? opt.label : String(opt ?? ''),
              description: typeof opt?.description === 'string' ? opt.description : undefined,
            }))
            : [],
        })),
      };

      ws.send(createNormalizedMessage({
        kind: 'permission_request',
        requestId,
        toolName,
        input: toolInput,
        sessionId: finalSessionId,
        provider: 'grok',
      }));

      const decision = await waitForToolApproval(requestId, {
        // Wait indefinitely — same as Claude's AskUserQuestion path.
        timeoutMs: 0,
        metadata: {
          _sessionId: finalSessionId,
          _toolName: toolName,
          _input: toolInput,
          _receivedAt: new Date(),
        },
        onCancel: (reason) => {
          ws.send(createNormalizedMessage({ kind: 'permission_cancelled', requestId, reason, sessionId: finalSessionId, provider: 'grok' }));
        },
      });

      let response;
      if (!decision || decision.cancelled || decision.allow === false) {
        response = { outcome: 'cancelled' };
      } else {
        const updated = decision.updatedInput && typeof decision.updatedInput === 'object'
          ? decision.updatedInput
          : {};
        const answers = updated.answers && typeof updated.answers === 'object'
          ? updated.answers
          : {};
        // Skip (empty answers) maps to Grok's skip_interview outcome.
        if (!answers || Object.keys(answers).length === 0) {
          response = { outcome: 'skip_interview' };
        } else {
          response = { outcome: 'accepted', answers };
        }
      }

      handle.rpc.respond(message.id, response);
      return;
    }

    // Exit-plan approval: Grok uses `_x.ai/exit_plan_mode` (mirrors Claude's
    // ExitPlanMode interactive tool). The PlanDisplay component already keys
    // off toolName ExitPlanMode / exit_plan_mode.
    if (isRequest && (message.method === '_x.ai/exit_plan_mode' || message.method === 'x.ai/exit_plan_mode')) {
      const params = message.params || {};
      const requestId = createRequestId();
      const toolName = 'ExitPlanMode';
      const toolInput = {
        plan: typeof params.plan === 'string'
          ? params.plan
          : (typeof params.planContent === 'string' ? params.planContent : params),
      };

      ws.send(createNormalizedMessage({
        kind: 'permission_request',
        requestId,
        toolName,
        input: toolInput,
        sessionId: finalSessionId,
        provider: 'grok',
      }));

      const decision = await waitForToolApproval(requestId, {
        timeoutMs: 0,
        metadata: {
          _sessionId: finalSessionId,
          _toolName: toolName,
          _input: toolInput,
          _receivedAt: new Date(),
        },
        onCancel: (reason) => {
          ws.send(createNormalizedMessage({ kind: 'permission_cancelled', requestId, reason, sessionId: finalSessionId, provider: 'grok' }));
        },
      });

      // ExitPlanModeExtResponse is a 2-field shape; accepted/rejected via outcome.
      // Verified variant names from the binary match permission-style outcomes.
      const response = (decision && decision.allow && !decision.cancelled)
        ? { outcome: 'accepted' }
        : { outcome: 'rejected' };

      handle.rpc.respond(message.id, response);
      return;
    }

    if (isRequest && message.method === 'session/request_permission') {
      const toolCall = message.params?.toolCall || {};
      const requestId = createRequestId();
      const rawToolName = toolCall.title || toolCall.name || 'Tool';
      // Prefer the structured Grok tool name when present so interactive tools
      // map cleanly onto CloudCLI panel ids.
      const metaToolName = toolCall._meta?.['x.ai/tool']?.name;
      const toolName = (typeof metaToolName === 'string' && metaToolName)
        || rawToolName;
      const uiToolName = toolName === 'ask_user_question'
        ? 'AskUserQuestion'
        : toolName === 'exit_plan_mode'
          ? 'ExitPlanMode'
          : toolName;
      const toolInput = toolCall.rawInput ?? toolCall.content;
      const requiresInteraction = isInteractiveTool(toolName) || isInteractiveTool(uiToolName);

      ws.send(createNormalizedMessage({
        kind: 'permission_request',
        requestId,
        toolName: uiToolName,
        input: toolInput,
        sessionId: finalSessionId,
        provider: 'grok',
      }));

      const decision = await waitForToolApproval(requestId, {
        timeoutMs: requiresInteraction ? 0 : undefined,
        metadata: {
          _sessionId: finalSessionId,
          _toolName: uiToolName,
          _input: toolInput,
          _receivedAt: new Date(),
        },
        onCancel: (reason) => {
          ws.send(createNormalizedMessage({ kind: 'permission_cancelled', requestId, reason, sessionId: finalSessionId, provider: 'grok' }));
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

    const normalized = sessionsService.normalizeMessage('grok', update, finalSessionId);
    for (const msg of normalized) {
      ws.send(msg);
    }
  });

  try {
    // Image/file attachments ride along as an <images_input> path list appended
    // to the prompt text (Grok ACP doesn't accept true image content blocks -
    // promptCapabilities.image=false); the session history reader strips it out.
    const promptText = command && command.trim()
      ? appendImagesInputTag(command, options.images)
      : '';
    handle.inFlightPrompt = true;
    handle.aborted = false;
    const result = await handle.rpc.request('session/prompt', {
      sessionId: handle.grokSessionId,
      prompt: [{ type: 'text', text: promptText }],
    });
    handle.inFlightPrompt = false;

    const aborted = handle.aborted || result?.stopReason === 'cancelled';
    ws.send(createCompleteMessage({
      provider: 'grok',
      sessionId: finalSessionId,
      exitCode: aborted ? 1 : 0,
      aborted,
    }));
    // Isolated from the main try/catch: a notification-plumbing failure must
    // never retroactively turn an already-sent successful `complete` into a
    // false failure below.
    try {
      await notifyRunStopped({
        userId: ws?.userId || null,
        provider: 'grok',
        sessionId: finalSessionId,
        sessionName: sessionSummary,
        stopReason: aborted ? 'cancelled' : 'completed',
      });
    } catch (notifyError) {
      console.error('Grok notifyRunStopped failed (non-fatal):', notifyError);
    }
  } catch (error) {
    handle.inFlightPrompt = false;

    const installed = await providerAuthService.isProviderInstalled('grok');
    const errorContent = !installed
      ? 'Grok CLI is not installed. Please install it from https://x.ai'
      : error.message;

    ws.send(createNormalizedMessage({ kind: 'error', content: errorContent, sessionId: finalSessionId, provider: 'grok' }));
    ws.send(createCompleteMessage({ provider: 'grok', sessionId: finalSessionId, exitCode: 1 }));
    try {
      await notifyRunFailed({
        userId: ws?.userId || null,
        provider: 'grok',
        sessionId: finalSessionId,
        sessionName: sessionSummary,
        error,
      });
    } catch (notifyError) {
      console.error('Grok notifyRunFailed failed (non-fatal):', notifyError);
    }
    throw error;
  } finally {
    unsubscribe();
  }
}

function abortGrokSession(sessionId) {
  const handle = acpSessions.get(sessionId);
  if (handle && handle.inFlightPrompt) {
    handle.aborted = true;
    handle.rpc.notify('session/cancel', { sessionId: handle.grokSessionId });
    return true;
  }
  return false;
}

function isGrokSessionActive(sessionId) {
  return acpSessions.has(sessionId);
}

function getActiveGrokSessions() {
  return Array.from(acpSessions.keys());
}

export {
  spawnGrok,
  abortGrokSession,
  isGrokSessionActive,
  getActiveGrokSessions
};
