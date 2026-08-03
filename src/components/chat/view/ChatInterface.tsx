import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowDownIcon } from 'lucide-react';

import { useTasksSettings } from '../../../contexts/TasksSettingsContext';
import { useWebSocket } from '../../../contexts/WebSocketContext';
import PermissionContext from '../../../contexts/PermissionContext';
import { QuickSettingsPanel } from '../../quick-settings-panel';
import type { ChatInterfaceProps, Provider  } from '../types/types';
import { useChatProviderState } from '../hooks/useChatProviderState';
import { useChatSessionState } from '../hooks/useChatSessionState';
import { useChatRealtimeHandlers } from '../hooks/useChatRealtimeHandlers';
import { useChatComposerState } from '../hooks/useChatComposerState';
import { useSessionStore } from '../../../stores/useSessionStore';
import { createSessionHandoff } from '../../../utils/api';
import { resolveProviderModelLabel } from '../../../utils/providerModels';
import { readProviderToolsSettings, writeQueuedMessage } from '../utils/chatStorage';
import { DEFAULT_EFFORT_VALUE } from '../constants/providerEffort';
import { flattenTranscript } from '../../skills/lib/skillWizardPrompt';
import SkillWizardDialog from '../../skills/view/SkillWizardDialog';

import ChatMessagesPane from './subcomponents/ChatMessagesPane';
import ChatComposer from './subcomponents/ChatComposer';
import CommandResultModal, { type SessionSwitchRequest } from './subcomponents/CommandResultModal';

/** Labels for the post-switch notice (mirrors CommandResultModal's map). */
const SWITCH_PROVIDER_LABELS: Record<string, string> = {
  claude: 'Claude',
  cursor: 'Cursor',
  codex: 'Codex',
  opencode: 'OpenCode',
  grok: 'Grok',
  kimi: 'Kimi',
  agy: 'Antigravity',
  pi: 'Pi',
};

const getSwitchProviderLabel = (targetProvider: string) =>
  SWITCH_PROVIDER_LABELS[targetProvider] || targetProvider;

/** Handoff send parked while the view navigates to the new session. */
type PendingHandoffSend = {
  sessionId: string;
  provider: Provider;
  model: string | null;
  prompt: string | null;
  filePath?: string;
};

function ChatInterface({
  selectedProject,
  selectedSession,
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

  const sessionStore = useSessionStore();
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
    currentProviderEffort,
    currentProviderEffortOptions,
    opencodeModel,
    setOpenCodeModel,
    grokModel,
    setGrokModel,
    kimiModel,
    setKimiModel,
    agyModel,
    setAgyModel,
    piModel,
    setPiModel,
    permissionMode,
    pendingPermissionRequests,
    setPendingPermissionRequests,
    cyclePermissionMode,
    providerModelCatalog,
    providerModelCacheCatalog,
    providerModelsLoading,
    providerModelsRefreshing,
    hardRefreshProviderModels,
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
    chatMessages,
    addMessage,
    sessionActivity,
    isProcessing,
    canAbortSession,
    currentSessionId,
    setCurrentSessionId,
    isLoadingSessionMessages,
    isLoadingMoreMessages,
    hasMoreMessages,
    totalMessages,
    isUserScrolledUp,
    setIsUserScrolledUp,
    tokenBudget,
    setTokenBudget,
    visibleMessageCount,
    visibleMessages,
    loadEarlierMessages,
    loadAllMessages,
    allMessagesLoaded,
    isLoadingAllMessages,
    loadAllJustFinished,
    showLoadAllOverlay,
    createDiff,
    scrollContainerRef,
    scrollToBottom,
    scrollToBottomAndReset,
    handleScroll,
  } = useChatSessionState({
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

  const handleSaveAsSkill = useCallback(() => {
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
  }, [currentSessionId, selectedSession?.id, sessionStore]);

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

  // Handoff prompt parked while the view navigates to the new session —
  // sending before that would stamp the message onto the old session.
  const [pendingHandoffSend, setPendingHandoffSend] = useState<PendingHandoffSend | null>(null);

  // Confirm handler for the model picker's switch-options step. Runs the
  // handoff API, then re-points provider state, session state, and the URL at
  // the freshly created session. Rejections propagate so the modal shows the
  // server error and stays open.
  const handleSwitchSessionTarget = useCallback(async (request: SessionSwitchRequest) => {
    if (!selectedProject) {
      throw new Error('Select a project before switching providers.');
    }

    const data = (await createSessionHandoff(request.sourceSessionId, {
      targetProvider: request.targetProvider,
      targetModel: request.targetModel,
      mode: request.mode,
      saveToFile: request.saveToFile,
      saveToMemory: request.saveToMemory,
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
  }, [selectedProject, setProvider, handleSessionEstablished]);

  // Auto-send the handoff prompt as the new session's first message through
  // the normal WS chat.send path — but only once the view (and with it
  // `addMessage`'s active session) actually points at the new session id.
  useEffect(() => {
    if (!pendingHandoffSend) {
      return;
    }

    const viewSessionId = selectedSession?.id || currentSessionId;
    if (viewSessionId !== pendingHandoffSend.sessionId) {
      return;
    }

    const { sessionId, provider: targetProvider, model, prompt, filePath } = pendingHandoffSend;
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

    const sent = sendMessage({
      type: 'chat.send',
      sessionId,
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
    setTimeout(() => scrollToBottom(), 100);
  }, [
    pendingHandoffSend,
    selectedSession?.id,
    currentSessionId,
    sendMessage,
    resolvePermissionModeForProvider,
    permissionMode,
    persistSessionModelEffort,
    addMessage,
    onSessionProcessing,
    setIsUserScrolledUp,
    scrollToBottom,
    showHandoffNotice,
  ]);

  const {
    input,
    setInput,
    textareaRef,
    inputHighlightRef,
    isTextareaExpanded,
    slashCommandsCount,
    filteredCommands,
    frequentCommands,
    commandQuery,
    showCommandMenu,
    selectedCommandIndex,
    resetCommandMenuState,
    handleCommandSelect,
    handleToggleCommandMenu,
    showFileDropdown,
    filteredFiles,
    selectedFileIndex,
    renderInputWithMentions,
    selectFile,
    attachedImages,
    setAttachedImages,
    uploadingImages,
    imageErrors,
    getRootProps,
    getInputProps,
    isDragActive,
    openImagePicker,
    handleSubmit,
    queuedDraft,
    editQueuedDraft,
    deleteQueuedDraft,
    handleVoiceTranscript,
    handleInputChange,
    handleKeyDown,
    handlePaste,
    handleTextareaClick,
    handleTextareaInput,
    syncInputOverlayScroll,
    handleClearInput,
    handleAbortSession,
    handlePermissionDecision,
    handleGrantToolPermission,
    handleInputFocusChange,
    isInputFocused,
    commandModalPayload,
    closeCommandModal,
    openModelSelector,
    showCostModal,
    onSaveAsSkill,
    saveAsSkillDisabled,
  } = useChatComposerState({
    selectedProject,
    selectedSession,
    currentSessionId,
    provider,
    permissionMode,
    cyclePermissionMode,
    currentProviderModel,
    currentProviderEffort,
    persistSessionModelEffort,
    isLoading: isProcessing,
    canAbortSession,
    tokenBudget,
    sendMessage,
    sendByCtrlEnter,
    onSessionProcessing,
    onSessionEstablished: handleSessionEstablished,
    onInputFocusChange,
    onFileOpen,
    onShowSettings,
    scrollToBottom,
    addMessage,
    setIsUserScrolledUp,
    setPendingPermissionRequests,
    resolvePermissionModeForProvider,
    supportsImages,
    supportsFiles,
    onSaveAsSkill: handleSaveAsSkill,
    sessionStore,
  });

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
    sessionStore,
  });

  useEffect(() => {
    if (!canAbortSession) {
      return;
    }

    const handleGlobalEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.repeat || event.defaultPrevented) {
        return;
      }

      event.preventDefault();
      handleAbortSession();
    };

    document.addEventListener('keydown', handleGlobalEscape, { capture: true });
    return () => {
      document.removeEventListener('keydown', handleGlobalEscape, { capture: true });
    };
  }, [canAbortSession, handleAbortSession]);

  useEffect(() => {
    return () => {
      resetStreamingState();
    };
  }, [resetStreamingState]);

  const permissionContextValue = useMemo(() => ({
    pendingPermissionRequests,
    handlePermissionDecision,
  }), [pendingPermissionRequests, handlePermissionDecision]);

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
    const selectedProviderLabel =
      provider === 'cursor'
        ? t('messageTypes.cursor')
        : provider === 'codex'
          ? t('messageTypes.codex')
          : provider === 'opencode'
              ? t('messageTypes.opencode', { defaultValue: 'OpenCode' })
            : t('messageTypes.claude');

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
        <ChatMessagesPane
          scrollContainerRef={scrollContainerRef}
          onWheel={handleScroll}
          onTouchMove={handleScroll}
          isLoadingSessionMessages={isLoadingSessionMessages}
          isProcessing={isProcessing}
          hasActivityIndicator={hasActivityIndicator}
          chatMessages={chatMessages}
          selectedSession={selectedSession}
          currentSessionId={currentSessionId}
          provider={provider}
          setProvider={(nextProvider) => setProvider(nextProvider as Provider)}
          textareaRef={textareaRef}
          claudeModel={claudeModel}
          setClaudeModel={setClaudeModel}
          cursorModel={cursorModel}
          setCursorModel={setCursorModel}
          codexModel={codexModel}
          setCodexModel={setCodexModel}
          opencodeModel={opencodeModel}
          setOpenCodeModel={setOpenCodeModel}
          grokModel={grokModel}
          setGrokModel={setGrokModel}
          kimiModel={kimiModel}
          setKimiModel={setKimiModel}
          agyModel={agyModel}
          setAgyModel={setAgyModel}
          piModel={piModel}
          setPiModel={setPiModel}
          providerModelCatalog={providerModelCatalog}
          providerModelsLoading={providerModelsLoading}
          tasksEnabled={tasksEnabled}
          isTaskMasterInstalled={isTaskMasterInstalled}
          onShowAllTasks={onShowAllTasks}
          setInput={setInput}
          isLoadingMoreMessages={isLoadingMoreMessages}
          hasMoreMessages={hasMoreMessages}
          totalMessages={totalMessages}
          sessionMessagesCount={chatMessages.length}
          visibleMessageCount={visibleMessageCount}
          visibleMessages={visibleMessages}
          loadEarlierMessages={loadEarlierMessages}
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
        />

        <div className="relative flex-shrink-0">
          {isUserScrolledUp && chatMessages.length > 0 && (
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

          <ChatComposer
          pendingPermissionRequests={pendingPermissionRequests}
          handlePermissionDecision={handlePermissionDecision}
          handleGrantToolPermission={handleGrantToolPermission}
          activity={sessionActivity}
          isLoading={isProcessing}
          onAbortSession={handleAbortSession}
          provider={provider}
          permissionMode={permissionMode}
          onModeSwitch={cyclePermissionMode}
          effort={currentProviderEffort}
          availableEffortOptions={currentProviderEffortOptions}
          onSelectEffort={(nextEffort) =>
            selectProviderEffort(provider, nextEffort, currentSessionId || selectedSession?.id || null)
          }
          modelLabel={currentModelLabel}
          onOpenModelSelector={openModelSelector}
          tokenBudget={tokenBudget}
          onShowTokenUsage={showCostModal}
          slashCommandsCount={slashCommandsCount}
          onToggleCommandMenu={handleToggleCommandMenu}
          onSaveAsSkill={onSaveAsSkill}
          saveAsSkillDisabled={saveAsSkillDisabled}
          hasInput={Boolean(input.trim())}
          onClearInput={handleClearInput}
          onSubmit={handleSubmit}
          isDragActive={isDragActive}
          queuedDraft={queuedDraft}
          onEditQueuedDraft={editQueuedDraft}
          onDeleteQueuedDraft={deleteQueuedDraft}
          attachedImages={attachedImages}
          onRemoveImage={(index) =>
            setAttachedImages((previous) =>
              previous.filter((_, currentIndex) => currentIndex !== index),
            )
          }
          uploadingImages={uploadingImages}
          imageErrors={imageErrors}
          showFileDropdown={showFileDropdown}
          filteredFiles={filteredFiles}
          selectedFileIndex={selectedFileIndex}
          onSelectFile={selectFile}
          filteredCommands={filteredCommands}
          selectedCommandIndex={selectedCommandIndex}
          onCommandSelect={handleCommandSelect}
          onCloseCommandMenu={resetCommandMenuState}
          isCommandMenuOpen={showCommandMenu}
          frequentCommands={commandQuery ? [] : frequentCommands}
          getRootProps={getRootProps as (...args: unknown[]) => Record<string, unknown>}
          getInputProps={getInputProps as (...args: unknown[]) => Record<string, unknown>}
          openImagePicker={openImagePicker}
          inputHighlightRef={inputHighlightRef}
          renderInputWithMentions={renderInputWithMentions}
          textareaRef={textareaRef}
          input={input}
          onVoiceTranscript={handleVoiceTranscript}
          onInputChange={handleInputChange}
          onTextareaClick={handleTextareaClick}
          onTextareaKeyDown={handleKeyDown}
          onTextareaPaste={handlePaste}
          onTextareaScrollSync={syncInputOverlayScroll}
          onTextareaInput={handleTextareaInput}
          isInputFocused={isInputFocused}
          onInputFocusChange={handleInputFocusChange}
          placeholder={t('input.placeholder', {
            provider:
              provider === 'cursor'
                ? t('messageTypes.cursor')
                : provider === 'codex'
                  ? t('messageTypes.codex')
                  : provider === 'opencode'
                      ? t('messageTypes.opencode', { defaultValue: 'OpenCode' })
                    : provider === 'grok'
                      ? t('messageTypes.grok', { defaultValue: 'Grok Build' })
                      : provider === 'kimi'
                        ? t('messageTypes.kimi', { defaultValue: 'Kimi' })
                        : provider === 'agy'
                          ? t('messageTypes.agy', { defaultValue: 'Antigravity' })
                          : provider === 'pi'
                            ? t('messageTypes.pi', { defaultValue: 'Pi' })
                            : t('messageTypes.claude'),
          })}
          isTextareaExpanded={isTextareaExpanded}
          sendByCtrlEnter={sendByCtrlEnter}
        />
        </div>
      </div>

      <QuickSettingsPanel />

      <CommandResultModal
        payload={commandModalPayload}
        onClose={closeCommandModal}
        providerModelCatalog={providerModelCatalog}
        providerModelCacheCatalog={providerModelCacheCatalog}
        providerModelsRefreshing={providerModelsRefreshing}
        onHardRefreshProviderModels={hardRefreshProviderModels}
        currentSessionId={currentSessionId || selectedSession?.id || null}
        onSelectProviderModel={selectProviderModel}
        onSwitchSessionTarget={handleSwitchSessionTarget}
      />

      {handoffNotice && (
        <div
          role="status"
          className="fixed bottom-6 left-1/2 z-[11000] max-w-[min(92vw,36rem)] -translate-x-1/2 rounded-full border border-border/60 bg-popover px-4 py-2 text-center text-sm font-medium text-foreground shadow-lg"
        >
          {handoffNotice}
        </div>
      )}

      {skillWizardOpen && (
        <SkillWizardDialog
          open={skillWizardOpen}
          onOpenChange={setSkillWizardOpen}
          seedTranscript={skillWizardTranscript}
          defaultProvider={provider}
          projectPath={selectedProject.fullPath || selectedProject.path}
          defaultSaveTarget="project"
        />
      )}
    </PermissionContext.Provider>
  );
}

export default React.memo(ChatInterface);
