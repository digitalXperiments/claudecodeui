import type { WebSocket } from 'ws';

import { projectsDb, sessionsDb } from '@/modules/database/index.js';
import { interruptsService } from '@/modules/interrupt-queue/index.js';
import { recordNormalizedRunEvent, runService } from '@/modules/runs/index.js';
import { workspaceService } from '@/modules/workspaces/index.js';
import { TERMINAL_RUN_STATUSES } from '@/shared/run-events.js';
import { chatRunRegistry } from '@/modules/websocket/services/chat-run-registry.service.js';
import {
  filterImagesToUploadStore,
  startProviderRun,
  type ProviderSpawnFn,
} from '@/modules/websocket/services/chat-run-starter.service.js';
import { connectedClients, WS_OPEN_STATE } from '@/modules/websocket/services/websocket-state.service.js';
import type {
  AnyRecord,
  AuthenticatedWebSocketRequest,
  LLMProvider,
} from '@/shared/types.js';
import { parseIncomingJsonObject } from '@/shared/utils.js';

// Re-exported so existing tests (and callers) keep importing it from here.
export { filterImagesToUploadStore };

type ChatWebSocketDependencies = {
  /** Provider runtimes keyed by provider id. */
  spawnFns: Record<LLMProvider, ProviderSpawnFn>;
  /**
   * Optional mid-run injection hooks keyed by provider id (Claude today).
   * When a session already has a running run, the message is offered to this
   * hook — attaching it to the live run — instead of rejecting the send
   * with RUN_IN_PROGRESS.
   */
  injectFns?: Partial<Record<LLMProvider, (command: string, options: AnyRecord) => Promise<boolean>>>;
  /**
   * Abort functions keyed by provider id. They are addressed with the
   * provider-native session id (that is how runtimes key their process maps).
   * The Claude abort is async; the rest are sync — both shapes are accepted.
   */
  abortFns: Record<LLMProvider, (providerSessionId: string) => boolean | Promise<boolean>>;
  resolveToolApproval: (
    requestId: string,
    payload: {
      allow: boolean;
      updatedInput?: unknown;
      message?: string;
      rememberEntry?: unknown;
    }
  ) => void;
  /** Claude-only today: pending tool approvals included in `chat_subscribed`. */
  getPendingApprovalsForSession: (providerSessionId: string) => unknown[];
};

const MAX_DELEGATED_REQUEST_CHARS = 8000;

/**
 * Extracts the authenticated request user id in the formats currently produced
 * by platform and OSS auth code paths.
 */
function readRequestUserId(
  request: AuthenticatedWebSocketRequest | undefined
): string | number | null {
  const user = request?.user;
  if (!user) {
    return null;
  }

  if (typeof user.id === 'string' || typeof user.id === 'number') {
    return user.id;
  }

  if (typeof user.userId === 'string' || typeof user.userId === 'number') {
    return user.userId;
  }

  return null;
}

function sendJson(ws: WebSocket, payload: unknown): void {
  if (ws.readyState === WS_OPEN_STATE) {
    ws.send(JSON.stringify(payload));
  }
}

/**
 * Reports a protocol-level failure to the requesting client.
 *
 * Protocol errors deliberately use their own `kind` (instead of the provider
 * `error` message kind) so the frontend can distinguish "your request was
 * invalid" from "the model run produced an error" without inspecting text.
 */
function sendProtocolError(
  ws: WebSocket,
  code: string,
  error: string,
  sessionId?: string
): void {
  sendJson(ws, {
    kind: 'protocol_error',
    code,
    error,
    sessionId: sessionId ?? null,
    timestamp: new Date().toISOString(),
  });
}

function readRequiredSessionId(data: AnyRecord): string | null {
  const sessionId = typeof data.sessionId === 'string' ? data.sessionId.trim() : '';
  return sessionId.length > 0 ? sessionId : null;
}

/**
 * Handles `chat.send`: resolves the session row (provider, project path, and
 * provider-native id all come from the database — never from the client),
 * registers the run, and dispatches to the provider runtime.
 */
async function handleChatSend(
  ws: WebSocket,
  userId: string | number | null,
  data: AnyRecord,
  dependencies: ChatWebSocketDependencies
): Promise<void> {
  const sessionId = readRequiredSessionId(data);
  if (!sessionId) {
    sendProtocolError(ws, 'SESSION_ID_REQUIRED', 'chat.send requires a sessionId.');
    return;
  }

  const session = sessionsDb.getSessionById(sessionId);
  if (!session) {
    sendProtocolError(
      ws,
      'SESSION_NOT_FOUND',
      `Session "${sessionId}" was not found. Create it via POST /api/providers/sessions first.`,
      sessionId
    );
    return;
  }

  if (session.is_internal) {
    sendProtocolError(
      ws,
      'SESSION_NOT_INTERACTIVE',
      `Session "${sessionId}" belongs to an internal automation run and cannot be opened or continued in chat.`,
      sessionId,
    );
    return;
  }

  const provider = session.provider as LLMProvider;
  const project = session.project_path ? projectsDb.getProjectPath(session.project_path) : null;
  const expectedProvider = typeof data.expectedProvider === 'string' ? data.expectedProvider.trim() : '';
  const expectedProjectId = typeof data.expectedProjectId === 'string' ? data.expectedProjectId.trim() : '';
  if (expectedProvider && expectedProvider !== provider) {
    sendProtocolError(
      ws,
      'SESSION_CONTEXT_MISMATCH',
      `Refusing to send: session provider is "${provider}", but the composer expected "${expectedProvider}".`,
      sessionId,
    );
    return;
  }
  if (expectedProjectId && expectedProjectId !== project?.project_id) {
    sendProtocolError(
      ws,
      'SESSION_CONTEXT_MISMATCH',
      'Refusing to send: the selected project does not own this session.',
      sessionId,
    );
    return;
  }

  const spawnFn = dependencies.spawnFns[provider];
  if (!spawnFn) {
    sendProtocolError(ws, 'UNSUPPORTED_PROVIDER', `Provider "${provider}" is not available.`, sessionId);
    return;
  }

  const clientOptions = (data.options ?? {}) as AnyRecord;
  const command = typeof data.content === 'string' ? data.content : '';
  if (clientOptions.delegatedRequest === true) {
    if (command.length > MAX_DELEGATED_REQUEST_CHARS) {
      sendProtocolError(
        ws,
        'DELEGATED_REQUEST_TOO_LARGE',
        `Delegated requests are limited to ${MAX_DELEGATED_REQUEST_CHARS} characters.`,
        sessionId,
      );
      return;
    }

    const delegatingSessionId = typeof clientOptions.delegatingSessionId === 'string'
      ? clientOptions.delegatingSessionId.trim()
      : '';
    const delegatingSession = delegatingSessionId ? sessionsDb.getSessionById(delegatingSessionId) : null;
    if (
      !delegatingSession
      || delegatingSession.is_internal
      || delegatingSession.session_id === sessionId
      || delegatingSession.project_path !== session.project_path
    ) {
      sendProtocolError(
        ws,
        'INVALID_SESSION_DELEGATION',
        'Delegated requests must come from another interactive session in the same project.',
        sessionId,
      );
      return;
    }
  }
  const wantIsolatedWorkspace =
    clientOptions.isolatedWorkspace === true ||
    clientOptions.isolated_workspace === true ||
    clientOptions.useWorkspace === true;

  // Allocate the durable spine row before dispatching the provider. A live
  // session can accept an injected follow-up message, which belongs to the
  // existing run rather than creating a second canonical row.
  const shouldCreateCanonicalRun = !chatRunRegistry.isProcessing(sessionId);
  const canonicalRun = shouldCreateCanonicalRun
    ? runService.create({
        source: 'chat',
        projectId: project?.project_id ?? null,
        sourceRef: sessionId,
        appSessionId: sessionId,
        provider,
        model: typeof clientOptions.model === 'string' ? clientOptions.model : null,
        effort: typeof clientOptions.effort === 'string' ? clientOptions.effort : null,
        permissionMode:
          typeof clientOptions.permissionMode === 'string' ? clientOptions.permissionMode : null,
        title: command.trim().split(/\r?\n/, 1)[0]?.slice(0, 160) || 'Chat run',
        trigger: 'user',
      })
    : null;

  // PRD §5.7: optional isolated worktree for interactive chat.
  let runtimeProjectPath = session.runtime_project_path ?? session.project_path;
  const runtimeOptions: AnyRecord = { ...clientOptions };
  if (wantIsolatedWorkspace && canonicalRun && project?.project_id && session.project_path) {
    try {
      const workspace = await workspaceService.create({
        projectId: project.project_id,
        projectPath: session.project_path,
        runId: canonicalRun.run_id,
        branchName: `chat/${sessionId.slice(0, 8)}`,
      });
      runtimeProjectPath = workspace.root_path;
      runtimeOptions.cwd = workspace.root_path;
      runtimeOptions.projectPath = workspace.root_path;
      sessionsDb.updateSessionRuntimeProjectPath(sessionId, workspace.root_path);
      runService.linkWorkspace(canonicalRun.run_id, workspace.workspace_id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn('[Chat] isolated workspace create failed; falling back to project path', {
        sessionId,
        error: message,
      });
    }
  }

  const recordCanonicalEvent = canonicalRun
    ? (message: import('@/shared/types.js').NormalizedMessage) => {
        recordNormalizedRunEvent(canonicalRun.run_id, message, 'chat');
        if (message.kind === 'permission_request') {
          interruptsService.create({
            projectId: project?.project_id ?? null,
            kind: 'permission_pending',
            severity: 'warning',
            title: `Permission needed for ${message.toolName || 'tool use'}`,
            body: 'The active chat run is waiting for your decision.',
            runId: canonicalRun.run_id,
            href: `/chat?sessionId=${encodeURIComponent(sessionId)}`,
            actions: [
              { id: 'approve_permission', label: 'Approve', style: 'primary' },
              { id: 'deny_permission', label: 'Deny', style: 'destructive' },
            ],
            meta: { requestId: message.requestId ?? null, provider, toolName: message.toolName ?? null },
            dedupeKey: `permission:${message.requestId || sessionId}`,
          });
        }
        if (message.kind === 'complete' && message.success !== true && message.aborted !== true) {
          interruptsService.create({
            projectId: project?.project_id ?? null,
            kind: 'run_failed',
            severity: 'error',
            title: 'Chat run failed',
            body: message.content || 'The provider run finished unsuccessfully.',
            runId: canonicalRun.run_id,
            href: `/chat?sessionId=${encodeURIComponent(sessionId)}`,
            actions: [
              { id: 'retry_run', label: 'Retry', style: 'primary' },
              { id: 'dismiss', label: 'Dismiss', style: 'secondary' },
            ],
            meta: { provider, sessionId },
            dedupeKey: `run_failed:${canonicalRun.run_id}`,
          });
        }
      }
    : undefined;

  let result: Awaited<ReturnType<typeof startProviderRun>>;
  try {
    if (canonicalRun) {
      runService.updateStatus(canonicalRun.run_id, 'starting');
    }
    result = await startProviderRun({
      appSessionId: sessionId,
      provider,
      providerSessionId: session.provider_session_id,
      projectPath: runtimeProjectPath,
      spawnFn,
      injectFn: dependencies.injectFns?.[provider],
      content: command,
      options: runtimeOptions,
      connection: ws,
      userId,
      onEvent: recordCanonicalEvent,
    });
  } catch (error) {
    if (canonicalRun) {
      const current = runService.get(canonicalRun.run_id);
      if (current && !TERMINAL_RUN_STATUSES.has(current.status)) {
        runService.markTerminal(canonicalRun.run_id, {
          status: 'failed',
          errorSummary: error instanceof Error ? error.message : String(error),
        });
      }
    }
    throw error;
  }

  if (!result.ok) {
    if (canonicalRun) {
      runService.markTerminal(canonicalRun.run_id, {
        status: 'failed',
        errorSummary: 'A run is already in progress for this session',
      });
    }
    sendProtocolError(
      ws,
      'RUN_IN_PROGRESS',
      `Session "${sessionId}" already has a run in progress.`,
      sessionId
    );
    return;
  }

  if (canonicalRun) {
    runService.linkSession(canonicalRun.run_id, sessionId);
    const current = runService.get(canonicalRun.run_id);
    if (current && !TERMINAL_RUN_STATUSES.has(current.status)) {
      runService.updateStatus(canonicalRun.run_id, 'running');
    }
  }

  // Interactive send: await the run so this handler's promise mirrors the run
  // lifetime exactly as before the extraction.
  await result.completion;
}

/**
 * Handles `chat.abort`: cancels the run for one app session and emits the
 * terminal `complete` on its behalf (runtimes skip their own complete for
 * aborted runs, and the registry drops any duplicate).
 */
async function handleChatAbort(
  ws: WebSocket,
  data: AnyRecord,
  dependencies: ChatWebSocketDependencies
): Promise<void> {
  const sessionId = readRequiredSessionId(data);
  if (!sessionId) {
    sendProtocolError(ws, 'SESSION_ID_REQUIRED', 'chat.abort requires a sessionId.');
    return;
  }

  const session = sessionsDb.getSessionById(sessionId);
  if (!session || session.is_internal) {
    sendProtocolError(
      ws,
      'SESSION_NOT_INTERACTIVE',
      `Session "${sessionId}" is not an interactive chat session.`,
      sessionId,
    );
    return;
  }

  const run = chatRunRegistry.getRun(sessionId);
  if (!run || run.status !== 'running') {
    sendProtocolError(ws, 'NO_ACTIVE_RUN', `Session "${sessionId}" has no active run.`, sessionId);
    return;
  }

  const abortFn = dependencies.abortFns[run.provider];
  let success = false;
  if (abortFn && run.providerSessionId) {
    success = Boolean(await abortFn(run.providerSessionId));
  }

  chatRunRegistry.completeRun(sessionId, {
    exitCode: success ? 0 : 1,
    aborted: true,
  });
}

/**
 * Handles `chat.subscribe`: for each requested session, reports whether a run
 * is processing, adds this socket to the live stream's fan-out set, replays
 * missed events (seq > lastSeq) to this socket only, and includes pending
 * permission requests.
 *
 * This single message replaces the old `check-session-status`,
 * `get-pending-permissions`, and Claude-only writer reconnect flows.
 */
function handleChatSubscribe(
  ws: WebSocket,
  data: AnyRecord,
  dependencies: ChatWebSocketDependencies
): void {
  const targets = Array.isArray(data.sessions) ? data.sessions : [];

  for (const target of targets) {
    if (!target || typeof target !== 'object') {
      continue;
    }

    const sessionId = typeof (target as AnyRecord).sessionId === 'string'
      ? ((target as AnyRecord).sessionId as string).trim()
      : '';
    if (!sessionId) {
      continue;
    }

    const lastSeqRaw = (target as AnyRecord).lastSeq;
    const lastSeq = typeof lastSeqRaw === 'number' && Number.isFinite(lastSeqRaw)
      ? Math.max(0, Math.floor(lastSeqRaw))
      : 0;

    const run = chatRunRegistry.getRun(sessionId);
    const isProcessing = chatRunRegistry.isProcessing(sessionId);
    const session = sessionsDb.getSessionById(sessionId);

    // Internal swarm/automation streams are not an interactive chat surface.
    // Silently omit them from subscription fan-out even if a browser learned
    // an app-session id from stale local state or an old build.
    if (!session || session.is_internal) {
      sendJson(ws, {
        kind: 'chat_subscribed',
        sessionId,
        isProcessing: false,
        pendingPermissions: [],
      });
      continue;
    }

    // Future live events for this run should also land on the socket that
    // asked — additive fan-out, so other tabs following the run keep their
    // stream. This is what makes mid-stream page refreshes work for all
    // providers.
    if (isProcessing) {
      chatRunRegistry.attachConnection(sessionId, ws);
    }

    // Pending approvals are tracked under the provider-native id inside the
    // Claude runtime; remap their sessionId so the client only sees app ids.
    const pendingPermissions = (run?.providerSessionId
      ? dependencies.getPendingApprovalsForSession(run.providerSessionId)
      : []
    ).map((approval) =>
      approval && typeof approval === 'object'
        ? { ...(approval as AnyRecord), sessionId }
        : approval,
    );

    sendJson(ws, {
      kind: 'chat_subscribed',
      sessionId,
      isProcessing,
      lastSeq: run?.lastSeq ?? 0,
      pendingPermissions,
      timestamp: new Date().toISOString(),
    });

    // Replay only for RUNNING runs, strictly after the ack. Repeated subscribe
    // messages can therefore send an overlapping buffer, but the frontend
    // treats the stable event ids as idempotency keys before appending stream
    // text. Completed runs
    // are fully persisted to the provider transcript and served over REST —
    // replaying them (e.g. after a page reload where the client's lastSeq is
    // 0) would duplicate messages the history fetch already returned.
    if (isProcessing) {
      for (const event of chatRunRegistry.replayEvents(sessionId, lastSeq)) {
        sendJson(ws, event);
      }
    }
  }
}

/**
 * Handles `chat.permission-response`: forwards a tool-approval decision to the
 * pending approval resolver (Claude is the only provider with interactive
 * approvals today, but the message is intentionally provider-neutral).
 */
function handlePermissionResponse(data: AnyRecord, dependencies: ChatWebSocketDependencies): void {
  if (typeof data.requestId !== 'string' || data.requestId.length === 0) {
    return;
  }

  dependencies.resolveToolApproval(data.requestId, {
    allow: Boolean(data.allow),
    updatedInput: data.updatedInput,
    message: typeof data.message === 'string' ? data.message : undefined,
    rememberEntry: data.rememberEntry,
  });
}

/**
 * Handles authenticated chat websocket messages used by the main chat panel.
 *
 * Inbound protocol (client to server):
 * - `chat.send`                { sessionId, content, options? }
 * - `chat.abort`               { sessionId }
 * - `chat.subscribe`           { sessions: [{ sessionId, lastSeq? }] }
 * - `chat.permission-response` { requestId, allow, updatedInput?, message?, rememberEntry? }
 *
 * Outbound protocol (server to client): every frame is `kind`-based — either
 * a provider `NormalizedMessage` (with `seq`) or a gateway event
 * (`chat_subscribed`, `session_upserted`, `loading_progress`,
 * `protocol_error`).
 */
export function handleChatConnection(
  ws: WebSocket,
  request: AuthenticatedWebSocketRequest,
  dependencies: ChatWebSocketDependencies
): void {
  console.log('[INFO] Chat WebSocket connected');
  connectedClients.add(ws);

  const userId = readRequestUserId(request);

  ws.on('message', async (rawMessage) => {
    try {
      const parsed = parseIncomingJsonObject(rawMessage);
      if (!parsed) {
        throw new Error('Invalid websocket payload');
      }

      const data = parsed as AnyRecord;
      const messageType = typeof data.type === 'string' ? data.type : '';

      switch (messageType) {
        case 'chat.send':
          await handleChatSend(ws, userId, data, dependencies);
          return;
        case 'chat.abort':
          await handleChatAbort(ws, data, dependencies);
          return;
        case 'chat.subscribe':
          handleChatSubscribe(ws, data, dependencies);
          return;
        case 'chat.permission-response':
          handlePermissionResponse(data, dependencies);
          return;
        case 'chat.ping':
          // Application-level liveness check: the browser WebSocket API has no
          // way to send/observe protocol-level ping frames, so a client that
          // suspects its socket is half-open (e.g. after laptop sleep) needs an
          // explicit round-trip it can time out on.
          sendJson(ws, { kind: 'pong', timestamp: new Date().toISOString() });
          return;
        default:
          sendProtocolError(ws, 'UNKNOWN_MESSAGE_TYPE', `Unknown message type "${messageType}".`);
          return;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[ERROR] Chat WebSocket error:', message);
      sendProtocolError(ws, 'INTERNAL_ERROR', message);
    }
  });

  ws.on('close', () => {
    console.log('[INFO] Chat client disconnected');
    connectedClients.delete(ws);
    // Also remove the socket from every run writer's fan-out set; `ws` emits
    // `close` after `error` too, so this single hook covers both.
    chatRunRegistry.detachConnection(ws);
  });
}
