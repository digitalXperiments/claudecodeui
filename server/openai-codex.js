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

import { buildCodexInputItems, normalizeImageDescriptors } from './shared/image-attachments.js';
import { createCodexAppServer } from './codex-app-server.js';
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

const activeCodexSessions = new Map();

/**
 * Map permission mode to Codex app-server options
 * @param {string} permissionMode - 'default', 'auto', or 'bypassPermissions'
 * @returns {object} - app-server sandbox and approval settings
 */
function mapPermissionModeToCodexOptions(permissionMode) {
  switch (permissionMode) {
    case 'auto':
    case 'acceptEdits':
      return {
        sandbox: 'workspace-write',
        approvalPolicy: 'on-request',
        approvalsReviewer: 'auto_review',
      };
    case 'bypassPermissions':
      return {
        sandbox: 'danger-full-access',
        approvalPolicy: 'never',
        approvalsReviewer: 'user',
      };
    case 'default':
    default:
      return {
        sandbox: 'workspace-write',
        approvalPolicy: 'untrusted',
        approvalsReviewer: 'user',
      };
  }
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

function appServerItemToLegacy(item) {
  if (!item || typeof item !== 'object') {
    return null;
  }

  const base = { type: 'item', uuid: item.id };
  switch (item.type) {
    case 'agentMessage':
      // Codex uses commentary agent messages for progress/narration and
      // final_answer for the reply proper. Keep commentary on the existing
      // reasoning path so it is rendered as one collapsible thinking block
      // instead of looking like a normal assistant answer.
      if (item.phase === 'commentary') {
        return {
          ...base,
          itemType: 'reasoning',
          message: {
            role: 'assistant',
            content: item.text || '',
            isReasoning: true,
          },
        };
      }
      return {
        ...base,
        itemType: 'agent_message',
        message: { role: 'assistant', content: item.text || '' },
      };
    case 'reasoning':
      return {
        ...base,
        itemType: 'reasoning',
        message: {
          role: 'assistant',
          content: Array.isArray(item.summary) ? item.summary.join('\n') : '',
          isReasoning: true,
        },
      };
    case 'commandExecution':
      return {
        ...base,
        itemType: 'command_execution',
        command: item.command,
        output: item.aggregatedOutput,
        exitCode: item.exitCode,
        status: item.status,
      };
    case 'fileChange':
      return {
        ...base,
        itemType: 'file_change',
        changes: item.changes,
        status: item.status,
      };
    case 'mcpToolCall':
      return {
        ...base,
        itemType: 'mcp_tool_call',
        server: item.server,
        tool: item.tool,
        arguments: item.arguments,
        result: item.result,
        error: item.error,
        status: item.status,
      };
    case 'webSearch':
      return {
        ...base,
        itemType: 'web_search',
        query: item.query,
      };
    case 'plan':
      return {
        ...base,
        itemType: 'todo_list',
        items: item.text ? [{ text: item.text, completed: false }] : [],
      };
    case 'error':
      return {
        ...base,
        itemType: 'error',
        message: { role: 'error', content: item.message || 'Unknown error' },
      };
    default:
      return {
        ...base,
        itemType: item.type || 'Unknown',
        item,
      };
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
  } = options;

  const resolvedModel = await providerModelsService.resolveResumeModel(
    'codex',
    sessionId,
    model,
  );

  const workingDirectory = cwd || projectPath || process.cwd();
  // Bounded approval wait for unattended (swarm) runs; 0 = wait forever (chat).
  const approvalWaitMs = resolveApprovalTimeoutMs({ unattended, approvalTimeoutMs });
  const { sandbox, approvalPolicy, approvalsReviewer } = mapPermissionModeToCodexOptions(permissionMode);
  const managedObsidianRuntime = loadManagedObsidianCodexRuntime();
  const catalog = (await providerModelsService.getProviderModels('codex')).models;
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

  let appServer;
  let rpcUnsubscribe;
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
    resolveTurn = resolve;
    rejectTurn = reject;
  });

  const getSessionRecord = () => capturedSessionId && activeCodexSessions.get(capturedSessionId);
  const sendNormalized = (raw) => {
    const normalized = sessionsService.normalizeMessage('codex', raw, capturedSessionId || sessionId || null);
    for (const message of normalized) {
      if (message.kind !== 'complete') {
        sendMessage(ws, message);
      }
    }
  };

  const handleApprovalRequest = async (request) => {
    const params = request.params || {};
    const requestSessionId = params.threadId
      || params.conversationId
      || capturedSessionId
      || sessionId
      || null;

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

    switch (message.method) {
      case 'item/started': {
        const item = params.item;
        if (item?.type === 'agentMessage' && typeof item.id === 'string') {
          agentMessagePhases.set(item.id, item.phase || null);
        }
        break;
      }
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
    const managedConfig = managedObsidianRuntime?.config
      ? {
        ...managedObsidianRuntime.config,
        ...(sandbox === 'workspace-write'
          ? { sandbox_workspace_write: { network_access: true } }
          : {}),
      }
      : {};
    appServer = createCodexAppServer({
      cwd: workingDirectory,
      env: managedObsidianRuntime?.env,
      config: managedConfig,
    });
    rpcUnsubscribe = appServer.onMessage(handleAppServerMessage);
    await appServer.request('initialize', {
      clientInfo: { name: 'cloudcli', title: 'CloudCLI', version: '0.1.0' },
      capabilities: { experimentalApi: true },
    });
    appServer.notify('initialized');

    const threadMethod = sessionId ? 'thread/resume' : 'thread/start';
    const threadParams = sessionId
      ? {
        threadId: sessionId,
        cwd: workingDirectory,
        model: resolvedModel,
        approvalPolicy,
        approvalsReviewer,
        sandbox,
        ...serviceTierOverride,
      }
      : {
        cwd: workingDirectory,
        model: resolvedModel,
        approvalPolicy,
        approvalsReviewer,
        sandbox,
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

    activeCodexSessions.set(capturedSessionId, {
      rpc: appServer,
      status: 'running',
      abortController,
      startedAt: new Date().toISOString(),
      ws,
      turnId: null,
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

    const turnResult = await appServer.request('turn/start', {
      threadId: capturedSessionId,
      input: buildCodexAppServerInput(command, images, workingDirectory),
      model: resolvedModel,
      effort: resolvedEffort || null,
      approvalPolicy,
      approvalsReviewer,
      ...serviceTierOverride,
    });
    turnId = turnResult?.turn?.id || null;
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
    const session = capturedSessionId ? activeCodexSessions.get(capturedSessionId) : null;
    const wasAborted =
      session?.status === 'aborted' ||
      error?.name === 'AbortError' ||
      String(error?.message || '').toLowerCase().includes('aborted');

    if (!wasAborted) {
      console.error('[Codex] Error:', error);

      // Check if Codex CLI is available for a clearer error message
      const installed = await providerAuthService.isProviderInstalled('codex');
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
    appServer?.close();
    // Update session status
    if (capturedSessionId) {
      const session = activeCodexSessions.get(capturedSessionId);
      if (session) {
        session.status = session.status === 'aborted' ? 'aborted' : 'completed';
      }
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
}, 5 * 60 * 1000); // Every 5 minutes
