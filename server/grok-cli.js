import fs from 'node:fs';
import readline from 'node:readline';

import crossSpawn from 'cross-spawn';

import { createRequestId, waitForToolApproval } from './claude-sdk.js';
import { notifyRunFailed, notifyRunStopped } from './services/notification-orchestrator.js';
import { sessionsService } from './modules/providers/services/sessions.service.js';
import { providerAuthService } from './modules/providers/services/provider-auth.service.js';
import { providerModelsService } from './modules/providers/services/provider-models.service.js';
import { mcpCatalogService } from './modules/providers/services/mcp-catalog.service.js';
import { appendImagesInputTag } from './shared/image-attachments.js';
import {
  readGrokSessionTokenUsage,
  resolveGrokSessionDir,
} from './modules/providers/list/grok/grok-sessions.provider.js';
import {
  buildGrokPriorSessionContextHint,
  seedGrokSessionTranscript,
  shouldPreferGrokAcpSessionLoad,
  toGrokAcpMcpServers,
} from './modules/providers/list/grok/grok-acp-managed-mcp.js';
import { createCompleteMessage, createNormalizedMessage } from './shared/utils.js';
import { ensureManagedGrokHome } from './shared/grok-home.js';

// cross-spawn resolves .cmd shims/PATHEXT on Windows and delegates to
// child_process.spawn everywhere else.
const spawnFunction = crossSpawn;

// Grok's Agent Client Protocol server, spoken over stdio as newline-delimited
// JSON-RPC 2.0. Verified live (grok 0.2.106) against `grok agent stdio`:
//   - initialize -> { agentCapabilities: { loadSession: true, ... } }
//   - session/new { cwd, mcpServers } -> { sessionId, models, _meta }.
//     Config.toml MCP servers auto-load; grok.com managed connectors attach
//     via the managed gateway catalog a few seconds later (not via the empty
//     mcpServers array). CloudCLI waits for `_x.ai/mcp_initialized` + a short
//     grace so the first chat turn sees those tools (Leong Associates, etc.).
//   - session/load { sessionId, cwd, mcpServers } -> resumes history but does
//     NOT attach grok.com managed MCPs (verified 0.2.112). Chat defaults to
//     session/new so the chat bar always gets managed gateway tools. When that
//     forks a Grok id we persist the mapping (ws.setSessionId), seed the new
//     transcript from the prior session for UI history, and inject a compact
//     prior-context hint on the first prompt. Opt into load-first with
//     CLOUDCLI_GROK_ACP_SESSION_LOAD=1 (sync/history-native, no managed MCPs).
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

// Grok ACP attaches config.toml MCP servers asynchronously and signals
// readiness with `_x.ai/mcp_initialized`. grok.com managed connectors (team
// MCPs such as Leong Associates) only attach on `session/new` — not on
// `session/load` (verified grok 0.2.112: start_type=resumed never runs
// "Fetched managed MCP gateway tool catalog") — and arrive a few seconds
// *after* local mcp_initialized with no client JSON-RPC notification. The
// agent logs `Fetched managed MCP gateway tool catalog` on stderr when ready
// (typically ~2–6s after local init). Interactive Shell loads them the same
// way; chat must wait so the first turn can search_tool those tools.
const MCP_LOCAL_READY_TIMEOUT_MS = 45_000;
// Fallback only — we finish early when stderr shows the managed catalog line.
const MCP_MANAGED_GATEWAY_GRACE_MS = 20_000;
const MCP_MANAGED_CATALOG_STDERR_RE = /Fetched managed MCP gateway tool catalog/i;

/**
 * Prepended once on the first prompt of a freshly opened ACP child so the
 * model does not treat config.toml-only MCP names (Composio, x-mcp, …) as the
 * full tool surface. Managed gateway tools (team-specific connectors configured
 * on grok.com) show up via search_tool after the catalog fetch, not as local
 * server entries.
 */
const GROK_MANAGED_MCP_FIRST_PROMPT_HINT = [
  '<system-reminder>',
  'Grok may expose team MCP tools from the grok.com managed gateway in addition',
  'to any local config.toml MCP servers listed in session setup. Those managed',
  'tools are discovered with the built-in search_tool and invoked with',
  'use_tool — do not conclude they are missing solely because only local',
  'servers appear in the MCP connecting list. If a user task needs a managed',
  'team/client integration, search for the tool first before saying it is',
  'unavailable.',
  '</system-reminder>',
  '',
].join('\n');

/**
 * Arm MCP-ready tracking before session/new|load so we cannot miss early
 * `_x.ai/mcp_initialized` notifications that fire during the create call.
 *
 * @param {ReturnType<typeof createJsonRpcClient>} rpc
 * @param {import('node:child_process').ChildProcessWithoutNullStreams} [child]
 * @param {{ waitManagedGateway?: boolean, localTimeoutMs?: number, managedGraceMs?: number }} [options]
 * @returns {{ bindSession: (sessionId: string) => void, promise: Promise<void> }}
 */
function armGrokMcpReadyWait(rpc, child, options = {}) {
  // Back-compat: older call sites used armGrokMcpReadyWait(rpc, options).
  if (child && typeof child === 'object' && !child.stderr && !child.stdout && child.waitManagedGateway !== undefined) {
    options = child;
    child = undefined;
  } else if (child && typeof child === 'object' && child.localTimeoutMs !== undefined && !child.stderr) {
    options = child;
    child = undefined;
  }

  const waitManagedGateway = options.waitManagedGateway !== false;
  const localTimeoutMs = options.localTimeoutMs ?? MCP_LOCAL_READY_TIMEOUT_MS;
  const managedGraceMs = options.managedGraceMs ?? MCP_MANAGED_GATEWAY_GRACE_MS;

  let targetSessionId = null;
  let settled = false;
  let localReady = false;
  let managedCatalogSeen = false;
  let graceTimer = null;
  let localTimer = null;
  let resolvePromise = () => {};
  /** @type {(() => void) | null} */
  let detachStderr = null;

  const promise = new Promise((resolve) => {
    resolvePromise = resolve;
  });

  const finish = (reason) => {
    if (settled) return;
    settled = true;
    if (localTimer) clearTimeout(localTimer);
    if (graceTimer) clearTimeout(graceTimer);
    if (detachStderr) {
      try { detachStderr(); } catch { /* ignore */ }
      detachStderr = null;
    }
    unsubscribe();
    if (reason) {
      console.info(`[grok-cli] MCP ready wait ended (${reason}) session=${targetSessionId || '?'} localReady=${localReady} managedCatalog=${managedCatalogSeen}`);
    }
    resolvePromise();
  };

  const maybeFinishAfterLocal = () => {
    if (!localReady) return;
    if (!waitManagedGateway) {
      finish('local-only');
      return;
    }
    if (managedCatalogSeen) {
      finish('managed-catalog');
      return;
    }
    if (graceTimer) return;
    // Catalog often lands 2–6s after local mcp_initialized; cap wait so chat
    // is not blocked forever when the team has no managed connectors.
    graceTimer = setTimeout(() => finish('managed-grace-timeout'), managedGraceMs);
  };

  const onLocalReady = () => {
    if (localReady) return;
    localReady = true;
    if (localTimer) {
      clearTimeout(localTimer);
      localTimer = null;
    }
    maybeFinishAfterLocal();
  };

  const onManagedCatalog = () => {
    if (managedCatalogSeen) return;
    managedCatalogSeen = true;
    maybeFinishAfterLocal();
    // Catalog can arrive before local handshakes finish — still wait for local
    // so the first turn has both surfaces. If local already ready, finish now.
  };

  // Managed gateway has no ACP notification — detect the agent log line.
  if (waitManagedGateway && child?.stderr) {
    let stderrBuf = '';
    const onStderr = (chunk) => {
      stderrBuf += chunk.toString();
      if (stderrBuf.length > 64_000) {
        stderrBuf = stderrBuf.slice(-16_000);
      }
      if (MCP_MANAGED_CATALOG_STDERR_RE.test(stderrBuf)) {
        onManagedCatalog();
      }
    };
    child.stderr.on('data', onStderr);
    detachStderr = () => {
      child.stderr.off('data', onStderr);
    };
  }

  const unsubscribe = rpc.onMessage((message, isRequest) => {
    if (isRequest || !message || typeof message.method !== 'string') return;
    const method = message.method;
    const params = message.params || {};
    // Once we know the session id, ignore notifications for other sessions
    // (a process can host more than one during probes).
    if (targetSessionId && params.sessionId && params.sessionId !== targetSessionId) {
      return;
    }

    if (method === '_x.ai/mcp_initialized' || method === 'x.ai/mcp_initialized') {
      onLocalReady();
      return;
    }

    // init_progress with connected===total and total>0 is a backup signal
    // when mcp_initialized is missed (older agents / dropped notifs).
    if (
      (method === '_x.ai/mcp/init_progress' || method === 'x.ai/mcp/init_progress')
      && typeof params.total === 'number'
      && typeof params.connected === 'number'
      && params.total > 0
      && params.connected >= params.total
    ) {
      onLocalReady();
    }
  });

  localTimer = setTimeout(() => {
    // No local MCP servers (or notifications never arrived): still allow the
    // managed-gateway grace so grok.com-only setups can attach.
    onLocalReady();
  }, localTimeoutMs);

  return {
    bindSession(sessionId) {
      targetSessionId = sessionId || null;
    },
    promise,
  };
}

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
  // Writing to stdin after the child has already exited (e.g. a request racing
  // its own idle-cleanup kill) raises EPIPE on the stream itself, not on
  // `child`'s 'error' event above. Unhandled, that crashes the whole Node
  // process and drops every session, not just this one.
  child.stdin.on('error', (error) => {
    console.error('[grok-cli] stdin write failed (process likely exited):', error?.message || error);
  });

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

async function createAcpSession(workingDir, resumeSessionId, spawnArgs, envOverrides = {}, mcpServers = []) {
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
  let injectManagedMcpHint = false;
  /** @type {string} */
  let injectPriorContextHint = '';
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
      clientInfo: {
        name: 'cloudcli',
        version: '1',
      },
    }, SETUP_TIMEOUT_MS);

    // ACP clients should ack initialize; harmless if the agent ignores it.
    try {
      rpc.notify('notifications/initialized', {});
    } catch {
      // Non-fatal.
    }

    // Default: session/new so grok.com managed gateway MCPs (Leong Associates,
    // Fluxito, …) attach on every chat ACP child. session/load keeps history
    // natively but never fetches the managed catalog (verified 0.2.112).
    // Opt into load-first with CLOUDCLI_GROK_ACP_SESSION_LOAD=1.
    //
    // When session/new forks a new Grok id from a prior resume id, we seed the
    // on-disk transcript + inject prior-context on the first prompt, and
    // spawnGrok persists the new mapping so Shell follows the same id.
    const preferLoad = shouldPreferGrokAcpSessionLoad(resumeSessionId);

    let mcpReady;
    /** Prior provider session id when we intentionally forked via session/new. */
    let forkedFromSessionId = null;

    if (preferLoad) {
      mcpReady = armGrokMcpReadyWait(rpc, child, { waitManagedGateway: false });
      try {
        sessionResult = await rpc.request('session/load', {
          sessionId: resumeSessionId,
          cwd: workingDir,
          mcpServers,
        }, SETUP_TIMEOUT_MS);
        sessionResult = sessionResult || {};
        sessionResult.sessionId = sessionResult.sessionId || resumeSessionId;
      } catch {
        // Load failed (unknown/corrupt session) — fall back to session/new.
        // The forked id is persisted by the spawnGrok caller so the DB
        // mapping, Shell `--resume`, and the history reader follow the fork.
        console.warn(
          `[grok-cli] session/load failed for ${resumeSessionId}; forking a new Grok session`,
        );
        mcpReady = armGrokMcpReadyWait(rpc, child, { waitManagedGateway: true });
        injectManagedMcpHint = true;
        forkedFromSessionId = resumeSessionId;
        sessionResult = await rpc.request('session/new', {
          cwd: workingDir,
          mcpServers,
        }, SETUP_TIMEOUT_MS);
      }
    } else {
      if (resumeSessionId) {
        console.info(
          '[grok-cli] Opening ACP via session/new (managed gateway MCPs): '
          + `prior session=${resumeSessionId}`,
        );
        forkedFromSessionId = resumeSessionId;
      }
      // Arm before session/new so early mcp_initialized / catalog stderr is not missed.
      mcpReady = armGrokMcpReadyWait(rpc, child, { waitManagedGateway: true });
      injectManagedMcpHint = true;
      sessionResult = await rpc.request('session/new', {
        cwd: workingDir,
        mcpServers,
      }, SETUP_TIMEOUT_MS);
    }

    const grokSessionId = sessionResult?.sessionId || resumeSessionId;
    if (grokSessionId) {
      mcpReady.bindSession(grokSessionId);
    }
    await mcpReady.promise;

    // After a managed-MCP fork: seed UI transcript + agent prior-context.
    if (
      forkedFromSessionId
      && grokSessionId
      && forkedFromSessionId !== grokSessionId
    ) {
      const seeded = seedGrokSessionTranscript(
        workingDir,
        forkedFromSessionId,
        grokSessionId,
      );
      const priorHint = buildGrokPriorSessionContextHint(
        workingDir,
        forkedFromSessionId,
      );
      if (seeded) {
        console.info(
          `[grok-cli] Seeded transcript ${forkedFromSessionId} → ${grokSessionId}`,
        );
      }
      if (priorHint) {
        injectPriorContextHint = priorHint;
      }
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
    /** One-shot: prepend managed-MCP discovery hint on the first chat prompt. */
    pendingManagedMcpHint: injectManagedMcpHint,
    /** One-shot: prior turns after a session/new fork (managed-MCP path). */
    pendingPriorContextHint: injectPriorContextHint || '',
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
    mcpServers: requestedMcpServerNames = [],
    unattended = false,
  } = options;

  const workingDir = cwd || projectPath || process.cwd();

  const resolvedModel = await providerModelsService.resolveResumeModel('grok', sessionId, model);
  const catalog = (await providerModelsService.getProviderModels('grok')).models;
  const selectedModel = catalog.OPTIONS.find((option) => option.value === resolvedModel) || null;
  const allowedEfforts = selectedModel?.effort?.values?.map((value) => value.value) || [];
  const resolvedEffort = typeof effort === 'string' && effort !== 'default' && allowedEfforts.includes(effort)
    ? effort
    : undefined;

  // Resolve the task/section's selected MCP server names into real connection
  // defs (command/args/env or url/headers), gated by the same per-provider
  // catalog binding fan-out uses, so ACP session/new can attach them directly
  // instead of relying solely on whatever's in config.toml.
  const resolvedMcpServers = Array.isArray(requestedMcpServerNames) && requestedMcpServerNames.length > 0
    ? await mcpCatalogService.resolveForProvider('grok', requestedMcpServerNames)
    : [];
  const acpMcpServers = toGrokAcpMcpServers(resolvedMcpServers);

  const permissionRuntime = resolveGrokPermissionRuntime(permissionMode);
  const managedGrokHome = ensureManagedGrokHome(permissionRuntime.configPermissionMode);
  const spawnEnv = { GROK_HOME: managedGrokHome };
  const spawnArgs = buildSpawnArgs({
    model: resolvedModel,
    effort: resolvedEffort,
    alwaysApprove: permissionRuntime.alwaysApprove,
  });
  // Grok has no ACP config method for model/effort/permission/MCP servers, so
  // these are fixed at spawn. A reused child whose settings (including bound
  // MCP servers) changed must be recreated (with session/load to preserve
  // history) to apply the new set.
  const mcpSignature = resolvedMcpServers
    .map((s) => s.name)
    .sort()
    .join(',');
  const spawnSignature = `${spawnArgs.join(' ')}|${permissionRuntime.mode}|${managedGrokHome}|mcp:${mcpSignature}`;

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

    try {
      handle = await createAcpSession(workingDir, sessionId, spawnArgs, spawnEnv, acpMcpServers);
    } catch (setupError) {
      // createAcpSession runs before the prompt try/catch below — without this
      // the failure only hits startProviderRun's safety-net complete (exit 1)
      // with no error event, so Mission Control shows the opaque
      // `Provider "grok" run failed`.
      const installed = await providerAuthService.isProviderInstalled('grok');
      let errorContent = !installed
        ? 'Grok CLI is not installed. Please install it from https://x.ai'
        : (setupError?.message || String(setupError));
      // Surface which MCP servers we tried to attach when ACP rejects the shape
      // (Invalid params / McpServer enum) so Mission Control is actionable.
      if (
        /Invalid params|McpServer/i.test(errorContent)
        && Array.isArray(acpMcpServers)
        && acpMcpServers.length > 0
      ) {
        const names = acpMcpServers.map((s) => s?.name).filter(Boolean).join(', ');
        errorContent = `${errorContent} (ACP mcpServers: ${names || acpMcpServers.length})`;
        console.error(
          '[grok-cli] session setup failed with MCP payload:',
          JSON.stringify(acpMcpServers, null, 2),
        );
      }
      ws.send(createNormalizedMessage({
        kind: 'error',
        content: errorContent,
        sessionId: sessionId || null,
        provider: 'grok',
      }));
      ws.send(createCompleteMessage({
        provider: 'grok',
        sessionId: sessionId || null,
        exitCode: 1,
      }));
      throw setupError;
    }
    handle.spawnSignature = spawnSignature;
    acpSessions.set(processKey, handle);

    // session/load keeps the same Grok id (no-op below); session/new forks a
    // fresh one. Whenever the id differs from what the app had, persist and
    // announce the new mapping immediately so the DB row, the Shell tab's
    // `grok --resume`, and the history reader all follow the fork instead of
    // pointing at a stale transcript.
    if (handle.grokSessionId && handle.grokSessionId !== capturedSessionId) {
      capturedSessionId = handle.grokSessionId;
      // Keep the old key as an alias so a queued/concurrent run addressed to
      // the previous id reuses this live child (its prompts already target the
      // new Grok session); only throwaway `new:` keys are dropped.
      if (processKey.startsWith('new:')) {
        acpSessions.delete(processKey);
      }
      acpSessions.set(capturedSessionId, handle);
      if (ws.setSessionId && typeof ws.setSessionId === 'function') {
        ws.setSessionId(capturedSessionId);
      }
      // ACP reveals the session id at session/new|load (unlike the old
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

      // Headless runs (kanban/mission-control) have no human to answer — a
      // `timeoutMs: 0` wait would hang the run until the 30-minute idle
      // cleanup kills it. Skip the interview instead of blocking forever.
      if (unattended) {
        console.warn(`[grok-cli] session=${finalSessionId} unattended run: auto skip_interview for ask_user_question`);
        handle.rpc.respond(message.id, { outcome: 'skip_interview' });
        return;
      }

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

      // Headless runs have no human to review the plan — reject rather than
      // hang forever or silently let it proceed unreviewed.
      if (unattended) {
        console.warn(`[grok-cli] session=${finalSessionId} unattended run: auto-rejecting exit_plan_mode`);
        handle.rpc.respond(message.id, { outcome: 'rejected' });
        return;
      }

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

      // Headless runs (kanban/mission-control) have no websocket/human to
      // answer this — waiting indefinitely (timeoutMs: 0 below) used to hang
      // the run until the 30-minute idle cleanup killed it. Deny fast instead;
      // tasks that need tools to run unattended should use bypassPermissions.
      if (unattended) {
        const options_ = message.params?.options || [];
        const optionId = options_.find((o) => o.kind === 'reject_once')?.optionId || 'reject';
        console.warn(`[grok-cli] session=${finalSessionId} unattended run: auto-denying "${uiToolName}" (non-bypass permission_mode has no approver headlessly)`);
        handle.rpc.respond(message.id, { outcome: { outcome: 'selected', optionId } });
        return;
      }

      ws.send(createNormalizedMessage({
        kind: 'permission_request',
        requestId,
        toolName: uiToolName,
        input: toolInput,
        sessionId: finalSessionId,
        provider: 'grok',
      }));

      // Wait indefinitely for a chatbar decision. The shared waitForToolApproval
      // default used to be ~55s and auto-cancelled prompts before users could
      // answer — every permission shown in the UI is interactive.
      const decision = await waitForToolApproval(requestId, {
        timeoutMs: 0,
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
    let promptText = command && command.trim()
      ? appendImagesInputTag(command, options.images)
      : '';
    if (handle.pendingPriorContextHint && promptText) {
      promptText = `${handle.pendingPriorContextHint}${promptText}`;
      handle.pendingPriorContextHint = '';
    }
    if (handle.pendingManagedMcpHint && promptText) {
      promptText = `${GROK_MANAGED_MCP_FIRST_PROMPT_HINT}${promptText}`;
      handle.pendingManagedMcpHint = false;
    }
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

    // Push live context occupancy (matches Grok /context) so the composer
    // badge does not keep showing stale or cumulative-only spend.
    try {
      const projectPath = options.projectPath || options.cwd;
      if (projectPath && handle.grokSessionId) {
        const sessionDir = resolveGrokSessionDir(projectPath, handle.grokSessionId);
        if (fs.existsSync(sessionDir)) {
          const tokenBudget = readGrokSessionTokenUsage(sessionDir);
          ws.send(createNormalizedMessage({
            kind: 'status',
            text: 'token_budget',
            tokenBudget,
            sessionId: finalSessionId,
            provider: 'grok',
          }));
        }
      }
    } catch (tokenError) {
      console.warn('Grok token budget refresh failed (non-fatal):', tokenError?.message || tokenError);
    }

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
