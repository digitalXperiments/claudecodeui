import React, { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowDownIcon } from 'lucide-react';

import { useTasksSettings } from '../../../contexts/TasksSettingsContext';
import { useWebSocket } from '../../../contexts/WebSocketContext';
import PermissionContext from '../../../contexts/PermissionContext';
import { QuickSettingsPanel } from '../../quick-settings-panel';
import {
  PERMISSION_MODE_CHANGED_EVENT,
  type PermissionModeChangedDetail,
} from '../../../constants/permissionModeEvents';
import { writeProviderPermissionModePreference } from '../../../utils/providerPermissionPreference';
import type { ChatInterfaceProps, PermissionMode, Provider } from '../types/types';
import type { StudioPrototype } from '../../studio/types';
import { studioApi } from '../../studio/api/studioApi';
import { useChatProviderState } from '../hooks/useChatProviderState';
import { PROVIDER_MODEL_CHANGED_EVENT, type ProviderModelChangedDetail } from '../../../constants/providerModelEvents';
import { normalizedToChatMessages } from '../hooks/useChatMessages';
import { useChatSessionState } from '../hooks/useChatSessionState';
import { useChatRealtimeHandlers } from '../hooks/useChatRealtimeHandlers';
import { useChatPermissionHandlers } from '../hooks/useChatPermissionHandlers';
import { useWorkerSessionReadOnly } from '../hooks/useWorkerSessionReadOnly';
import { useSessionStore } from '../../../stores/useSessionStore';
import { registerSessionPrefetcher } from '../../../stores/sessionPrefetch';
import { SESSION_MESSAGES_PAGE_SIZE } from '../../../stores/sessionMessagePagination';
import { useProviderAuthStatus } from '../../provider-auth/hooks/useProviderAuthStatus';
import { authenticatedFetch, createSessionHandoff } from '../../../utils/api';
import { resolveProviderModelLabel } from '../../../utils/providerModels';
import { readProviderToolsSettings, writeQueuedMessage } from '../utils/chatStorage';
import { DEFAULT_EFFORT_VALUE } from '../constants/providerEffort';
import { guardWhenReadOnly } from '../utils/workerSessionAccess';
import { providerMessageTypeLabel } from '../utils/providerLabels';
import { flattenTranscript } from '../../skills/lib/skillWizardPrompt';
import { runAfterSessionPaint } from '../../../utils/sessionPaintGate';

import ChatMessagesPane from './subcomponents/ChatMessagesPane';
import ChatComposerHost, { type ChatComposerHandle } from './subcomponents/ChatComposerHost';
import type { SessionSwitchRequest } from './subcomponents/CommandResultModal';

// Only opened from "Save as skill"; keep it (and its dependencies) out of the
// chat view's initial chunk.
const SkillWizardDialog = lazy(() => import('../../skills/view/SkillWizardDialog'));

/** Labels for the post-switch notice (mirrors CommandResultModal's map). */
const SWITCH_PROVIDER_LABELS: Record<string, string> = {
  claude: 'Claude',
  cursor: 'Cursor',
  codex: 'Codex',
  opencode: 'OpenCode',
  kilo: 'Kilo Code',
  cline: 'Cline',
  grok: 'Grok',
  kimi: 'Kimi',
  pi: 'Pi',
};

const getSwitchProviderLabel = (targetProvider: string) =>
  SWITCH_PROVIDER_LABELS[targetProvider] || targetProvider;

/** Handoff send parked while the view navigates to the new session. */
type PendingHandoffSend = {
  sessionId: string;
  provider: Provider;
  projectId: string | null;
  model: string | null;
  prompt: string | null;
  filePath?: string;
};

function ChatInterface({
  isActive = true,
  selectedProject,
  selectedSession,
  studioMode = false,
  ws,
  sendMessage,
  onFileOpen,
  onInputFocusChange,
  onSessionProcessing,
  onSessionIdle,
  processingSessions,
  onNavigateToSession,
  onSessionEstablished,
  onShowSettings,
  showRawParameters,
  showThinking,
  sendByCtrlEnter,
  externalMessageUpdate,
  newSessionTrigger,
  onShowAllTasks,
}: ChatInterfaceProps) {
  const { tasksEnabled, isTaskMasterInstalled } = useTasksSettings();
  const { subscribe } = useWebSocket();
  const { t } = useTranslation('chat');
  const [linkedPrototypes, setLinkedPrototypes] = useState<StudioPrototype[]>([]);

  // Non-reactive: ChatInterface must not re-render on every store change (a
  // stream flush lands every 100ms). The transcript pane subscribes to the
  // rows; this view and its hooks subscribe only to counts/flags they render.
  const sessionStore = useSessionStore({ reactive: false });
  // Per-session streaming accumulators. This view subscribes to every
  // in-progress session at once, so each session's buffered stream/thinking
  // text and its debounce timer live under that session's own id — sharing a
  // single buffer would stamp background sessions' text into the viewed one.
  const streamBuffersRef = useRef(new Map<string, { text: string; timer: number | null }>());
  const thinkingBuffersRef = useRef(new Map<string, { text: string; timer: number | null }>());
  // When each session's `chat.subscribe` was last sent; idle acks older than
  // a later local request are discarded as stale.
  const statusCheckSentAtRef = useRef(new Map<string, number>());
  // Highest live `seq` observed per session. Written by the realtime handler
  // on every sequenced frame, read whenever a `chat.subscribe` is sent so the
  // server replays only the events this client actually missed.
  const lastSeqRef = useRef(new Map<string, number>());

  const {
    provider,
    setProvider,
    cursorModel,
    setCursorModel,
    claudeModel,
    setClaudeModel,
    codexModel,
    setCodexModel,
    fastMode,
    supportsFastMode,
    selectCodexFastMode,
    currentProviderEffort,
    currentProviderEffortOptions,
  opencodeModel,
  setOpenCodeModel,
  kiloModel,
  setKiloModel,
    grokModel,
    setGrokModel,
    kimiModel,
    setKimiModel,
    qwencodeModel,
    setQwenCodeModel,
    piModel,
    setPiModel,
    ompModel,
    setOmpModel,
    antigravityModel,
    setAntigravityModel,
    permissionMode,
    setPermissionMode,
    pendingPermissionRequests,
    cyclePermissionMode,
    getPermissionModesForProvider,
    getDefaultPermissionModeForProvider,
    setPendingPermissionRequests,
    providerModelCatalog,
    providerModelCacheCatalog,
    providerModelsLoading,
    providerModelsRefreshing,
    providerModelErrors,
    hardRefreshProviderModels,
    ensureAllProviderModels,
    currentProviderModel,
    selectProviderModel,
    selectProviderEffort,
    persistSessionModelEffort,
    resolvePermissionModeForProvider,
    supportsImages,
    supportsFiles,
  } = useChatProviderState({
    selectedSession,
    selectedProject,
  });

  // Drives the model picker's per-provider auth/install gating (e.g. OMP
  // serves an unusable fallback catalog when not authenticated — the picker
  // needs to know that to keep the user from picking one of those entries).
  //
  // Fetched lazily, the first time the model picker opens — NOT on mount.
  // Each provider's auth check shells out to its CLI (1–3 s each), and firing
  // all twelve when a session opened held most of the browser's six
  // per-origin HTTP/1.1 connections for ~3 s, queueing the transcript's own
  // history request behind them (measured: rows appeared ~2.9 s after the
  // SPA navigation although the messages endpoint answers in ~10 ms). The
  // picker already treats unknown status as loading (see isOmpAuthLoading).
  const { providerAuthStatus, refreshProviderAuthStatuses } = useProviderAuthStatus();
  const providerAuthRequestedRef = useRef(false);
  const ensureProviderAuthStatuses = useCallback(() => {
    // Other providers' model catalogs are also loaded on first picker open
    // (a session open only fetches the active provider's).
    ensureAllProviderModels();
    if (providerAuthRequestedRef.current) return;
    providerAuthRequestedRef.current = true;
    void refreshProviderAuthStatuses();
  }, [ensureAllProviderModels, refreshProviderAuthStatuses]);

  // Studio iterations are trusted, focused edits to the prototype checkout.
  // Keep the normal chat's permission preference untouched everywhere else.
  const composerPermissionMode = studioMode ? 'bypassPermissions' : permissionMode;

  // Called on session switch / new session / unmount. Flush each pending
  // buffer into its OWN session's store slot (updateStreaming replaces the
  // well-known `__streaming_` row, so this matches the timer/stream_end
  // flushes) and clear its timer. The entries keep their text, so a session
  // that is still streaming keeps appending afterwards and its
  // stream_end/complete frame does the final flush — nothing is discarded
  // and nothing crosses sessions.
  const resetStreamingState = useCallback(() => {
    streamBuffersRef.current.forEach((entry, sessionId) => {
      if (entry.timer) {
        clearTimeout(entry.timer);
        entry.timer = null;
      }
      if (entry.text) {
        sessionStore.updateStreaming(sessionId, entry.text, provider);
      }
    });
    thinkingBuffersRef.current.forEach((entry, sessionId) => {
      if (entry.timer) {
        clearTimeout(entry.timer);
        entry.timer = null;
      }
      if (entry.text) {
        sessionStore.updateThinkingStream(sessionId, entry.text, provider);
      }
    });
  }, [provider, sessionStore]);

  const {
    transcriptSessionId,
    pendingUserMessage,
    viewHiddenCount,
    chatMessageCount,
    getChatMessagesSnapshot,
    reconcileScroll,
    addMessage,
    sessionActivity,
    isProcessing,
    canAbortSession,
    currentSessionId,
    setCurrentSessionId,
    isLoadingSessionMessages,
    historyLoadError,
    retryHistoryLoad,
    loadedHistoryCount,
    isLoadingMoreMessages,
    hasMoreMessages,
    totalMessages,
    isUserScrolledUp,
    setIsUserScrolledUp,
    tokenBudget,
    setTokenBudget,
    loadAllMessages,
    allMessagesLoaded,
    isLoadingAllMessages,
    loadAllJustFinished,
    showLoadAllOverlay,
    createDiff,
    scrollContainerRef,
    scrollToBottom,
    scrollToBottomAndReset,
    refreshAfterRunComplete,
  } = useChatSessionState({
    isActive,
    selectedProject,
    selectedSession,
    ws,
    sendMessage,
    externalMessageUpdate,
    newSessionTrigger,
    processingSessions,
    onSessionIdle,
    resetStreamingState,
    statusCheckSentAtRef,
    lastSeqRef,
    sessionStore,
  });

  // Sidebar hover/focus prefetch: warm the first history page of a session
  // this store has not loaded yet. Opening it then renders rows from cache
  // (the initial load still refreshes the tail in the background).
  useEffect(() => registerSessionPrefetcher((sessionId) => {
    const slot = sessionStore.getSessionSlot(sessionId);
    if (slot && (slot.serverMessages.length > 0 || slot.status === 'loading')) return;
    void sessionStore.fetchFromServer(sessionId, { limit: SESSION_MESSAGES_PAGE_SIZE, offset: 0 });
  }), [sessionStore]);

  const linkedSessionId = selectedSession?.id || currentSessionId;
  useEffect(() => {
    if (!linkedSessionId) {
      setLinkedPrototypes([]);
      return;
    }
    let cancelled = false;
    // Linked prototypes are a side affordance; fetch after the transcript paints.
    const cancelDeferred = runAfterSessionPaint(() => {
      void studioApi.listForSession(linkedSessionId)
        .then((prototypes) => {
          if (!cancelled) setLinkedPrototypes(prototypes);
        })
        .catch(() => {
          if (!cancelled) setLinkedPrototypes([]);
        });
    });
    return () => {
      cancelled = true;
      cancelDeferred();
    };
  }, [linkedSessionId]);

  const prepareChatExport = useCallback(async () => {
    if (!allMessagesLoaded) {
      await loadAllMessages();
    }
    const activeSessionId = selectedSession?.id || currentSessionId;
    return activeSessionId
      ? normalizedToChatMessages(sessionStore.getMessages(activeSessionId))
      : getChatMessagesSnapshot();
  }, [
    allMessagesLoaded,
    getChatMessagesSnapshot,
    currentSessionId,
    loadAllMessages,
    selectedSession?.id,
    sessionStore,
  ]);

  // Agent Relay/internal worker transcripts are opened for observation only —
  // this is the single predicate every composer/header control below defers
  // to; see resolveReadOnlyWorkerSession for the fail-closed navigation rules.
  const isReadOnlyWorkerSession = useWorkerSessionReadOnly(selectedSession);

  const [skillWizardOpen, setSkillWizardOpen] = useState(false);
  const [skillWizardTranscript, setSkillWizardTranscript] = useState<string | undefined>(undefined);

  // Brand-new conversation: the composer allocated a stable session id via
  // the session gateway before the first send. Record it locally and put it
  // in the URL — this id never changes again, so there is no later handoff.
  const handleSessionEstablished = useCallback<NonNullable<ChatInterfaceProps['onSessionEstablished']>>((sessionId, context) => {
    setCurrentSessionId(sessionId);
    onSessionEstablished?.(sessionId, context);
    onNavigateToSession?.(sessionId);
  }, [setCurrentSessionId, onSessionEstablished, onNavigateToSession]);

  // Post-switch notice. The app has no global toast util, so this is a
  // transient inline banner (same pattern as SkillWizardDialog's toast).
  const [handoffNotice, setHandoffNotice] = useState<string | null>(null);
  const handoffNoticeTimerRef = useRef<number | null>(null);
  const showHandoffNotice = useCallback((message: string) => {
    if (handoffNoticeTimerRef.current !== null) {
      window.clearTimeout(handoffNoticeTimerRef.current);
    }
    setHandoffNotice(message);
    handoffNoticeTimerRef.current = window.setTimeout(() => setHandoffNotice(null), 7000);
  }, []);
  useEffect(() => () => {
    if (handoffNoticeTimerRef.current !== null) {
      window.clearTimeout(handoffNoticeTimerRef.current);
    }
  }, []);

  useEffect(() => subscribe((event) => {
    if (event.kind !== 'chat_session_preferences_updated'
      || event.sessionId !== (currentSessionId || selectedSession?.id)) return;
    if (event.error) {
      showHandoffNotice(`Permission mode saved for the next turn. Live update failed: ${event.error}`);
    } else if (event.deferred) {
      showHandoffNotice('Permission mode saved. This provider applies the change on the next turn.');
    } else if (event.appliedToRunningSession) {
      showHandoffNotice('Permission mode applied to the running session.');
    }
  }), [subscribe, currentSessionId, selectedSession?.id, showHandoffNotice]);

  const handleCyclePermissionMode = useCallback(() => {
    const nextMode = cyclePermissionMode();
    writeProviderPermissionModePreference(provider, nextMode);
    const sessionId = currentSessionId || selectedSession?.id || null;
    if (!sessionId) return;

    // This frame and the next chat.send share one ordered WebSocket, so a
    // rapid toggle-then-send cannot start with the previous session policy.
    const sent = sendMessage({
      type: 'chat.session-preferences',
      sessionId,
      preferences: { permissionMode: nextMode },
    });
    if (!sent) {
      void authenticatedFetch(`/api/providers/sessions/${encodeURIComponent(sessionId)}/runtime-preferences`, {
        method: 'PUT',
        body: JSON.stringify({ permissionMode: nextMode }),
      }).then(async (response) => {
        if (!response.ok) throw new Error('Could not save permission mode');
        const result = await response.json();
        const live = result.data?.session;
        showHandoffNotice(live?.appliedToRunningSession
          ? 'Permission mode applied to the running session.'
          : 'Permission mode saved for the next turn.');
      }).catch((error) => {
        showHandoffNotice(`Permission mode could not be saved: ${error.message}`);
      });
    }
  }, [cyclePermissionMode, provider, currentSessionId, selectedSession?.id, sendMessage, showHandoffNotice]);

  const handleSelectPermissionMode = useCallback((targetMode: PermissionMode, targetSessionId?: string | null) => {
    const validModes = getPermissionModesForProvider(provider);
    if (!validModes.includes(targetMode)) {
      return;
    }
    setPermissionMode(targetMode);
    localStorage.setItem(`permissionMode-last-${provider}`, targetMode);
    writeProviderPermissionModePreference(provider, targetMode);

    const sessionId = targetSessionId || currentSessionId || selectedSession?.id || null;
    if (sessionId) {
      localStorage.setItem(`permissionMode-${sessionId}`, targetMode);
      const sent = sendMessage({
        type: 'chat.session-preferences',
        sessionId,
        preferences: { permissionMode: targetMode },
      });
      if (!sent) {
        void authenticatedFetch(`/api/providers/sessions/${encodeURIComponent(sessionId)}/runtime-preferences`, {
          method: 'PUT',
          body: JSON.stringify({ permissionMode: targetMode }),
        }).then(async (response) => {
          if (!response.ok) throw new Error('Could not save permission mode');
          const result = await response.json();
          showHandoffNotice(result.data?.session?.appliedToRunningSession
            ? 'Permission mode applied to the running session.'
            : 'Permission mode saved for the next turn.');
        }).catch((error) => {
          showHandoffNotice(`Permission mode could not be saved: ${error.message}`);
        });
      }
    }

    if (typeof window !== 'undefined') {
      window.dispatchEvent(
        new CustomEvent<PermissionModeChangedDetail>(PERMISSION_MODE_CHANGED_EVENT, {
          detail: { provider, mode: targetMode, sessionId },
        }),
      );
    }
  }, [getPermissionModesForProvider, provider, setPermissionMode, currentSessionId, selectedSession?.id, sendMessage, showHandoffNotice]);

  const handleSaveAsSkill = useCallback(() => {
    if (isReadOnlyWorkerSession) {
      return;
    }
    const activeSessionId = currentSessionId || selectedSession?.id || null;
    if (!activeSessionId) {
      return;
    }
    const transcript = flattenTranscript(sessionStore.getMessages(activeSessionId));
    if (!transcript) {
      return;
    }
    setSkillWizardTranscript(transcript);
    setSkillWizardOpen(true);
  }, [currentSessionId, isReadOnlyWorkerSession, selectedSession?.id, sessionStore]);

  // Handoff prompt parked while the view navigates to the new session —
  // sending before that would stamp the message onto the old session.
  const [pendingHandoffSend, setPendingHandoffSend] = useState<PendingHandoffSend | null>(null);

  // Mission Control "Open work chat" parks the implementer prompt in sessionStorage
  // so this view can send it after /session/:id mounts.
  useEffect(() => {
    const sessionId = selectedSession?.id || currentSessionId;
    const projectScopedKey = selectedProject?.projectId
      ? `cloudcli:pending-prompt:new:${selectedProject.projectId}`
      : null;
    const sessionKey = sessionId ? `cloudcli:pending-prompt:${sessionId}` : null;
    const sessionRaw = sessionKey ? sessionStorage.getItem(sessionKey) : null;
    // A project-scoped prompt represents an explicit NEW-chat intent. Never
    // consume it while the previous session id is still mounted during the
    // project/new-session state transition — that race sent a Studio prompt
    // into an unrelated Codex conversation.
    const projectRaw = !sessionId && projectScopedKey
      ? sessionStorage.getItem(projectScopedKey)
      : null;
    const raw = sessionRaw || projectRaw;
    if (!raw) return;
    if (sessionRaw && sessionKey) sessionStorage.removeItem(sessionKey);
    if (projectRaw && projectScopedKey) sessionStorage.removeItem(projectScopedKey);
    let cancelled = false;
    try {
      const parsed = JSON.parse(raw) as { prompt?: string; provider?: string; summary?: string };
      const prompt = typeof parsed.prompt === 'string' ? parsed.prompt.trim() : '';
      if (!prompt) return;
      const targetProvider = (parsed.provider || provider) as Provider;
      void (async () => {
        let targetSessionId = sessionId;
        if (!targetSessionId) {
          const projectPath = selectedProject?.fullPath || selectedProject?.path || '';
          if (!selectedProject || !projectPath) return;
          const response = await authenticatedFetch('/api/providers/sessions', {
            method: 'POST',
            body: JSON.stringify({
              provider: targetProvider,
              projectPath,
              permissionMode: resolvePermissionModeForProvider(targetProvider, permissionMode),
            }),
          });
          if (!response.ok) {
            throw new Error(`Failed to allocate Studio chat session (${response.status})`);
          }
          const body = await response.json();
          targetSessionId = body?.data?.sessionId || null;
          if (!targetSessionId) throw new Error('Studio chat allocation returned no session id');
          if (cancelled) return;
          handleSessionEstablished(targetSessionId, {
            provider: targetProvider,
            project: selectedProject,
            summary: parsed.summary || 'Studio ideation',
          });
        }
        if (cancelled || !targetSessionId) return;
        setPendingHandoffSend({
          sessionId: targetSessionId,
          provider: targetProvider,
          projectId: selectedProject?.projectId ?? null,
          model: localStorage.getItem(`${targetProvider}-model`) || null,
          prompt,
        });
      })().catch((error) => {
        console.error('[Chat] Failed to start parked prompt:', error);
      });
    } catch {
      // Ignore a corrupt parked prompt rather than blocking the session.
    }
    return () => {
      cancelled = true;
    };
  }, [
    selectedSession?.id,
    currentSessionId,
    provider,
    selectedProject,
    handleSessionEstablished,
    permissionMode,
    resolvePermissionModeForProvider,
  ]);

  // Confirm handler for the model picker's switch-options step. Runs the
  // handoff API, then re-points provider state, session state, and the URL at
  // the freshly created session. Rejections propagate so the modal shows the
  // server error and stays open.
  const handleSwitchSessionTarget = useCallback(async (request: SessionSwitchRequest) => {
    if (!selectedProject) {
      throw new Error('Select a project before switching providers.');
    }

    const chosenPermissionMode = request.permissionMode
      ? resolvePermissionModeForProvider(request.targetProvider, request.permissionMode)
      : resolvePermissionModeForProvider(request.targetProvider, permissionMode);

    const data = (await createSessionHandoff(request.sourceSessionId, {
      targetProvider: request.targetProvider,
      targetModel: request.targetModel,
      mode: request.mode,
      saveToFile: request.saveToFile,
      saveToMemory: request.saveToMemory,
      permissionMode: chosenPermissionMode,
    })) as {
      sessionId?: string;
      provider?: string;
      projectPath?: string;
      handoffPrompt?: string | null;
      handoffFilePath?: string;
      backupFilePath?: string;
    };

    const newSessionId = typeof data?.sessionId === 'string' ? data.sessionId : '';
    if (!newSessionId) {
      throw new Error('Handoff did not return a new session id.');
    }

    const targetProvider = (typeof data?.provider === 'string' ? data.provider : request.targetProvider) as Provider;
    const targetModel =
      typeof request.targetModel === 'string' && request.targetModel.trim().length > 0
        ? request.targetModel
        : null;

    // Provider state FIRST: the selectedSession placeholder/adoption effects
    // read these exact keys when the new session id lands, so they must
    // already point at the target provider (and its model).
    setProvider(targetProvider);
    localStorage.setItem('selected-provider', targetProvider);
    if (targetModel) {
      localStorage.setItem(`${targetProvider}-model`, targetModel);
      localStorage.setItem(`${targetProvider}-model-${newSessionId}`, targetModel);
      window.dispatchEvent(new CustomEvent<ProviderModelChangedDetail>(PROVIDER_MODEL_CHANGED_EVENT, {
        detail: { provider: targetProvider, model: targetModel, sessionId: newSessionId },
      }));
    }

    setPermissionMode(chosenPermissionMode);
    localStorage.setItem(`permissionMode-${newSessionId}`, chosenPermissionMode);
    localStorage.setItem(`permissionMode-last-${targetProvider}`, chosenPermissionMode);
    writeProviderPermissionModePreference(targetProvider, chosenPermissionMode);
    if (typeof window !== 'undefined') {
      window.dispatchEvent(
        new CustomEvent<PermissionModeChangedDetail>(PERMISSION_MODE_CHANGED_EVENT, {
          detail: { provider: targetProvider, mode: chosenPermissionMode, sessionId: newSessionId },
        }),
      );
    }

    // Same establishment path as the first-message flow: records the id
    // locally, navigates to /session/:id, and upserts the sidebar entry.
    handleSessionEstablished(newSessionId, {
      provider: targetProvider,
      project: selectedProject,
      summary: `Handoff to ${getSwitchProviderLabel(targetProvider)}`,
    });

    setPendingHandoffSend({
      sessionId: newSessionId,
      provider: targetProvider,
      projectId: selectedProject.projectId,
      model: targetModel,
      prompt:
        typeof data?.handoffPrompt === 'string' && data.handoffPrompt.trim().length > 0
          ? data.handoffPrompt
          : null,
      // backupFilePath is the always-written full-transcript safety net behind
      // an LLM-generated summary; surface it when there's no explicit saved file.
      filePath: typeof data?.handoffFilePath === 'string'
        ? data.handoffFilePath
        : (typeof data?.backupFilePath === 'string' ? data.backupFilePath : undefined),
    });
  }, [
    selectedProject,
    setProvider,
    setPermissionMode,
    handleSessionEstablished,
    permissionMode,
    resolvePermissionModeForProvider,
  ]);

  // Auto-send the handoff prompt as the new session's first message through
  // the normal WS chat.send path — but only once the view (and with it
  // `addMessage`'s active session) actually points at the new session id.
  useEffect(() => {
    if (!pendingHandoffSend) {
      return;
    }

    const viewSessionId = selectedSession?.id || currentSessionId;
    const parkedId = pendingHandoffSend.sessionId === 'pending-new'
      ? viewSessionId
      : pendingHandoffSend.sessionId;
    if (!parkedId || viewSessionId !== parkedId) {
      return;
    }

    const { provider: targetProvider, projectId, model, prompt, filePath } = pendingHandoffSend;
    const sessionId = parkedId;
    setPendingHandoffSend(null);

    const targetLabel = getSwitchProviderLabel(targetProvider);
    showHandoffNotice(
      `Switched to ${targetLabel}${model ? ` · ${model}` : ''}${filePath ? ` — handoff saved to ${filePath}` : ''}`,
    );

    if (!prompt) {
      // Fresh start: land on the empty new session.
      return;
    }

    const effort = localStorage.getItem(`${targetProvider}-effort`) || DEFAULT_EFFORT_VALUE;
    const toolsSettings = readProviderToolsSettings(targetProvider);
    const sendOptions: Record<string, unknown> = {
      effort,
      permissionMode: resolvePermissionModeForProvider(targetProvider, permissionMode),
      toolsSettings,
      skipPermissions: Boolean(toolsSettings?.skipPermissions),
      sessionSummary: `Handoff to ${targetLabel}`,
    };
    if (model) {
      sendOptions.model = model;
    }
    if (targetProvider === 'codex') {
      // Codex app-server expects the catalog service-tier id (`priority`) and
      // needs an explicit null to clear a prior Fast selection on the thread.
      sendOptions.serviceTier = fastMode ? 'priority' : null;
    }

    const sent = sendMessage({
      type: 'chat.send',
      sessionId,
      expectedProvider: targetProvider,
      expectedProjectId: projectId,
      content: prompt,
      options: { ...sendOptions, images: [] },
    });

    if (!sent) {
      // Socket down: park the prompt as the session's queued draft so the
      // composer's normal flush sends it once reconnected.
      writeQueuedMessage(sessionId, { content: prompt, options: sendOptions });
      showHandoffNotice('Not connected — the handoff prompt will send once reconnected.');
      return;
    }

    // Pin the session to the model/effort it starts with, mirror the
    // optimistic user message, and light up the activity indicator — the same
    // bookkeeping handleSubmit does for a regular first message.
    if (model) {
      persistSessionModelEffort(targetProvider, sessionId, model, effort);
    }
    addMessage({
      type: 'user',
      content: prompt,
      timestamp: new Date(),
    });
    onSessionProcessing?.(sessionId, {
      statusText: null,
      canInterrupt: true,
    });
    setIsUserScrolledUp(false);
    scrollToBottom();
  }, [
    pendingHandoffSend,
    selectedSession?.id,
    currentSessionId,
    sendMessage,
    resolvePermissionModeForProvider,
    permissionMode,
    fastMode,
    persistSessionModelEffort,
    addMessage,
    onSessionProcessing,
    setIsUserScrolledUp,
    scrollToBottom,
    showHandoffNotice,
  ]);

  // Composer state (draft text, menus, attachments) lives in ChatComposerHost
  // so keystrokes re-render only the composer. The pieces the rest of the view
  // needs are reached through these stable refs/callbacks.
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const composerRef = useRef<ChatComposerHandle>(null);
  const setComposerInput = useCallback<React.Dispatch<React.SetStateAction<string>>>((value) => {
    composerRef.current?.setInput(value);
  }, []);

  const { handlePermissionDecision, handleGrantToolPermission } = useChatPermissionHandlers({
    provider,
    sendMessage,
    setPendingPermissionRequests,
  });

  const handleSetProvider = useCallback((nextProvider: string) => {
    setProvider(nextProvider as Provider);
  }, [setProvider]);

  // On WebSocket reconnect, re-fetch the current session's messages from the
  // server so missed streaming events are shown, then re-subscribe — the
  // `chat_subscribed` ack restores or clears the activity indicator, replays
  // missed live events, and re-attaches a still-running stream to this socket.
  //
  // Every session still marked "processing" (not just the one currently open)
  // needs the same re-subscribe, or a run in another session never receives
  // its `complete` frame after a reconnect and stays "running" forever.
  const handleWebSocketReconnect = useCallback(async () => {
    const sessionIds = new Set<string>(processingSessions ? processingSessions.keys() : []);
    if (selectedSession) {
      sessionIds.add(selectedSession.id);
    }
    if (sessionIds.size === 0) {
      return;
    }

    if (selectedProject && selectedSession) {
      await sessionStore.refreshFromServer(selectedSession.id);
    }

    const now = Date.now();
    const sessions = [...sessionIds].map((sessionId) => {
      statusCheckSentAtRef.current.set(sessionId, now);
      return { sessionId, lastSeq: lastSeqRef.current.get(sessionId) ?? 0 };
    });
    sendMessage({ type: 'chat.subscribe', sessions });
  }, [processingSessions, selectedProject, selectedSession, sendMessage, sessionStore]);

  useChatRealtimeHandlers({
    subscribe,
    provider,
    selectedSession,
    currentSessionId,
    setTokenBudget,
    pendingPermissionRequests,
    setPendingPermissionRequests,
    streamBuffersRef,
    thinkingBuffersRef,
    lastSeqRef,
    statusCheckSentAtRef,
    onSessionProcessing,
    onSessionIdle,
    onWebSocketReconnect: handleWebSocketReconnect,
    // Coordinated latest refresh with retry (syncs hasMore/total/offset).
    onRunComplete: refreshAfterRunComplete,
    sessionStore,
  });

  useEffect(() => {
    return () => {
      resetStreamingState();
    };
  }, [resetStreamingState]);

  const permissionContextValue = useMemo(() => ({
    readOnly: isReadOnlyWorkerSession,
    pendingPermissionRequests,
    handlePermissionDecision: guardWhenReadOnly(isReadOnlyWorkerSession, handlePermissionDecision),
  }), [isReadOnlyWorkerSession, pendingPermissionRequests, handlePermissionDecision]);

  // Mirrors ChatComposer's own visibility check so the message pane can
  // reserve enough bottom space to keep the floating status tab from
  // overlapping the last message.
  const hasActivityIndicator = Boolean(sessionActivity && pendingPermissionRequests.length === 0);

  // Label shown on the composer's model button. Uses the effective model for
  // the open conversation (its own recorded choice, or the provider default)
  // and resolves it against the live catalog so the button reads the friendly
  // label ("Claude Sonnet 4.5") rather than the raw model id.
  const currentModelLabel = useMemo(() => {
    return resolveProviderModelLabel(providerModelCatalog[provider], currentProviderModel)
      || t('input.model', { defaultValue: 'Model' });
  }, [
    provider,
    currentProviderModel,
    providerModelCatalog,
    t,
  ]);

  if (!selectedProject) {
    const selectedProviderLabel = providerMessageTypeLabel(t, provider);

    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center text-muted-foreground">
          <p className="text-sm">
            {t('projectSelection.startChatWithProvider', {
              provider: selectedProviderLabel,
              defaultValue: 'Select a project to start chatting with {{provider}}',
            })}
          </p>
        </div>
      </div>
    );
  }

  return (
    <PermissionContext.Provider value={permissionContextValue}>
      <div className="flex h-full min-h-0 flex-col">
        <div className="chat-canvas-layout flex min-h-0 flex-1" data-testid="chat-canvas-layout">
          <div className="chat-transcript-column flex min-h-0 min-w-0 flex-1 flex-col" data-testid="chat-transcript-column">
        <ChatMessagesPane
          readOnly={isReadOnlyWorkerSession}
          scrollContainerRef={scrollContainerRef}
          isLoadingSessionMessages={isLoadingSessionMessages}
          historyLoadError={historyLoadError}
          onRetryHistoryLoad={retryHistoryLoad}
          isProcessing={isProcessing}
          hasActivityIndicator={hasActivityIndicator}
          sessionStore={sessionStore}
          transcriptSessionId={transcriptSessionId}
          pendingUserMessage={pendingUserMessage}
          viewHiddenCount={viewHiddenCount}
          onTranscriptCommit={reconcileScroll}
          selectedSession={selectedSession}
          currentSessionId={currentSessionId}
          provider={provider}
          setProvider={handleSetProvider}
          textareaRef={textareaRef}
          claudeModel={claudeModel}
          setClaudeModel={setClaudeModel}
          cursorModel={cursorModel}
          setCursorModel={setCursorModel}
          codexModel={codexModel}
          setCodexModel={setCodexModel}
          opencodeModel={opencodeModel}
          setOpenCodeModel={setOpenCodeModel}
          kiloModel={kiloModel}
          setKiloModel={setKiloModel}
          grokModel={grokModel}
          setGrokModel={setGrokModel}
          kimiModel={kimiModel}
          setKimiModel={setKimiModel}
          qwencodeModel={qwencodeModel}
          setQwenCodeModel={setQwenCodeModel}
          piModel={piModel}
          setPiModel={setPiModel}
          ompModel={ompModel}
          setOmpModel={setOmpModel}
          antigravityModel={antigravityModel}
          setAntigravityModel={setAntigravityModel}
          providerModelCatalog={providerModelCatalog}
          providerModelsLoading={providerModelsLoading}
          providerModelsRefreshing={providerModelsRefreshing}
          onRefreshProviderModels={hardRefreshProviderModels}
          tasksEnabled={tasksEnabled}
          isTaskMasterInstalled={isTaskMasterInstalled}
          onShowAllTasks={onShowAllTasks}
          setInput={setComposerInput}
          isLoadingMoreMessages={isLoadingMoreMessages}
          hasMoreMessages={hasMoreMessages}
          totalMessages={totalMessages}
          sessionMessagesCount={loadedHistoryCount}
          loadAllMessages={loadAllMessages}
          allMessagesLoaded={allMessagesLoaded}
          isLoadingAllMessages={isLoadingAllMessages}
          loadAllJustFinished={loadAllJustFinished}
          showLoadAllOverlay={showLoadAllOverlay}
          createDiff={createDiff}
          onFileOpen={onFileOpen}
          onShowSettings={onShowSettings}
          onGrantToolPermission={handleGrantToolPermission}
          showRawParameters={showRawParameters}
          showThinking={showThinking}
          selectedProject={selectedProject}
          linkedPrototypes={linkedPrototypes}
          onPrepareExport={prepareChatExport}
        />

        <div className="relative flex-shrink-0">
          {isUserScrolledUp && chatMessageCount > 0 && (
            <div className="pointer-events-none absolute -top-11 left-0 right-0 z-20 flex justify-center">
              <button
                type="button"
                onClick={scrollToBottomAndReset}
                aria-label={t('input.scrollToBottom', { defaultValue: 'Scroll to bottom' })}
                className="pointer-events-auto flex h-8 w-8 items-center justify-center rounded-full border border-border/50 bg-card text-muted-foreground shadow-sm transition-all duration-200 hover:bg-accent hover:text-foreground"
                title={t('input.scrollToBottom', { defaultValue: 'Scroll to bottom' })}
              >
                <ArrowDownIcon className="h-4 w-4" aria-hidden />
              </button>
            </div>
          )}

          <ChatComposerHost
            composerRef={composerRef}
            textareaRef={textareaRef}
            readOnly={isReadOnlyWorkerSession}
            studioMode={studioMode}
            selectedProject={selectedProject}
            selectedSession={selectedSession}
            currentSessionId={currentSessionId}
            provider={provider}
            permissionMode={composerPermissionMode}
            onCyclePermissionMode={handleCyclePermissionMode}
            currentProviderModel={currentProviderModel}
            currentProviderEffort={currentProviderEffort}
            currentProviderEffortOptions={currentProviderEffortOptions}
            selectProviderEffort={selectProviderEffort}
            fastMode={fastMode}
            supportsFastMode={supportsFastMode}
            selectCodexFastMode={selectCodexFastMode}
            modelLabel={currentModelLabel}
            persistSessionModelEffort={persistSessionModelEffort}
            activity={sessionActivity}
            isProcessing={isProcessing}
            canAbortSession={canAbortSession}
            tokenBudget={tokenBudget}
            sendMessage={sendMessage}
            sendByCtrlEnter={sendByCtrlEnter}
            onSessionProcessing={onSessionProcessing}
            onSessionEstablished={handleSessionEstablished}
            onInputFocusChange={onInputFocusChange}
            onFileOpen={onFileOpen}
            onShowSettings={onShowSettings}
            onNavigateToSession={onNavigateToSession}
            scrollToBottom={scrollToBottom}
            addMessage={addMessage}
            setIsUserScrolledUp={setIsUserScrolledUp}
            pendingPermissionRequests={pendingPermissionRequests}
            handlePermissionDecision={handlePermissionDecision}
            handleGrantToolPermission={handleGrantToolPermission}
            resolvePermissionModeForProvider={resolvePermissionModeForProvider}
            supportsImages={supportsImages}
            supportsFiles={supportsFiles}
            onSaveAsSkill={handleSaveAsSkill}
            sessionStore={sessionStore}
            providerModelCatalog={providerModelCatalog}
            providerModelCacheCatalog={providerModelCacheCatalog}
            providerModelsRefreshing={providerModelsRefreshing}
            providerModelErrors={providerModelErrors}
            providerAuthStatus={providerAuthStatus}
            onModelPickerOpen={ensureProviderAuthStatuses}
            onHardRefreshProviderModels={hardRefreshProviderModels}
            modalPermissionMode={permissionMode}
            getPermissionModesForProvider={getPermissionModesForProvider}
            getDefaultPermissionModeForProvider={getDefaultPermissionModeForProvider}
            onSelectPermissionMode={handleSelectPermissionMode}
            onSelectProviderModel={selectProviderModel}
            onSwitchSessionTarget={handleSwitchSessionTarget}
          />
        </div>
          </div>
        </div>
      </div>

      <QuickSettingsPanel />

      {handoffNotice && (
        <div
          role="status"
          className="fixed bottom-6 left-1/2 z-[11000] max-w-[min(92vw,36rem)] -translate-x-1/2 rounded-full border border-border/60 bg-popover px-4 py-2 text-center text-sm font-medium text-foreground shadow-lg"
        >
          {handoffNotice}
        </div>
      )}

      {skillWizardOpen && (
        <Suspense fallback={null}>
          <SkillWizardDialog
            open={skillWizardOpen}
            onOpenChange={setSkillWizardOpen}
            seedTranscript={skillWizardTranscript}
            defaultProvider={provider}
            projectPath={selectedProject.fullPath || selectedProject.path}
            defaultSaveTarget="project"
          />
        </Suspense>
      )}
    </PermissionContext.Provider>
  );
}

export default React.memo(ChatInterface);
