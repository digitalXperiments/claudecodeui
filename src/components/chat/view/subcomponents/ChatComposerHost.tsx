import { memo, useCallback, useEffect, useImperativeHandle, useMemo, useState } from 'react';
import type { ComponentProps, Dispatch, Ref, RefObject, SetStateAction } from 'react';
import { useTranslation } from 'react-i18next';

import type { MarkSessionProcessing, SessionActivity } from '../../../../hooks/useSessionProtection';
import type {
  LLMProvider,
  Project,
  ProjectSession,
  ProviderModelOption,
} from '../../../../types/app';
import type { SessionStore } from '../../../../stores/useSessionStore';
import type {
  ChatMessage,
  PendingPermissionRequest,
  PermissionMode,
  SessionEstablishedContext,
  SessionNavigationOptions,
} from '../../types/types';
import { useChatComposerState } from '../../hooks/useChatComposerState';
import { usePrewarmSession } from '../../hooks/usePrewarmSession';
import { guardWhenReadOnly } from '../../utils/workerSessionAccess';
import { providerMessageTypeLabel } from '../../utils/providerLabels';

import ChatComposer from './ChatComposer';
import ContinuityControl from './ContinuityControl';
import CommandResultModal from './CommandResultModal';
import type { SessionSwitchRequest } from './CommandResultModal';

type CommandResultModalProps = ComponentProps<typeof CommandResultModal>;

/**
 * The composer's imperative surface for the rest of the chat view. The
 * transcript's empty state fills the input from here, and ChatInterface's
 * permission banner/context calls the same decision handlers the composer uses.
 */
export type ChatComposerHandle = {
  setInput: Dispatch<SetStateAction<string>>;
};

type ChatComposerHostProps = {
  composerRef: Ref<ChatComposerHandle>;
  textareaRef: RefObject<HTMLTextAreaElement>;
  readOnly: boolean;
  studioMode: boolean;
  selectedProject: Project;
  selectedSession: ProjectSession | null;
  currentSessionId: string | null;
  provider: LLMProvider;
  permissionMode: PermissionMode | string;
  onCyclePermissionMode: () => void;
  currentProviderModel: string;
  currentProviderEffort: string;
  currentProviderEffortOptions: NonNullable<ProviderModelOption['effort']>['values'];
  selectProviderEffort: (provider: LLMProvider, effort: string, sessionId: string | null) => void;
  fastMode: boolean;
  supportsFastMode: boolean;
  selectCodexFastMode: (enabled: boolean) => void;
  modelLabel: string;
  persistSessionModelEffort: (
    provider: LLMProvider,
    sessionId: string | null | undefined,
    model: string,
    effort: string,
  ) => void;
  activity: SessionActivity | null;
  isProcessing: boolean;
  canAbortSession: boolean;
  tokenBudget: Record<string, unknown> | null;
  sendMessage: (message: unknown) => boolean;
  sendByCtrlEnter?: boolean;
  onSessionProcessing?: MarkSessionProcessing;
  onSessionEstablished: (sessionId: string, context: SessionEstablishedContext) => void;
  onInputFocusChange?: (focused: boolean) => void;
  onFileOpen?: (filePath: string, diffInfo?: unknown) => void;
  onShowSettings?: () => void;
  onNavigateToSession?: (targetSessionId: string, options?: SessionNavigationOptions) => void;
  scrollToBottom: () => void;
  addMessage: (msg: ChatMessage, targetSessionId?: string, targetProvider?: LLMProvider) => void;
  setIsUserScrolledUp: (isScrolledUp: boolean) => void;
  pendingPermissionRequests: PendingPermissionRequest[];
  handlePermissionDecision: (
    requestIds: string | string[],
    decision: { allow?: boolean; message?: string; rememberEntry?: string | null; updatedInput?: unknown },
  ) => void;
  handleGrantToolPermission: (suggestion: { entry: string; toolName: string }) => { success: boolean };
  resolvePermissionModeForProvider: (provider: LLMProvider, requestedMode: PermissionMode | string) => PermissionMode;
  supportsImages?: boolean;
  supportsFiles?: boolean;
  onSaveAsSkill: () => void;
  sessionStore: SessionStore;
  // Command result modal (help / models / cost / status).
  providerModelCatalog: CommandResultModalProps['providerModelCatalog'];
  providerModelCacheCatalog: CommandResultModalProps['providerModelCacheCatalog'];
  providerModelsRefreshing: CommandResultModalProps['providerModelsRefreshing'];
  providerModelErrors: CommandResultModalProps['providerModelErrors'];
  providerAuthStatus: CommandResultModalProps['providerAuthStatus'];
  /** Lazily loads provider auth status the first time the model picker opens. */
  onModelPickerOpen?: () => void;
  onHardRefreshProviderModels: CommandResultModalProps['onHardRefreshProviderModels'];
  modalPermissionMode: CommandResultModalProps['currentPermissionMode'];
  getPermissionModesForProvider: CommandResultModalProps['getPermissionModesForProvider'];
  getDefaultPermissionModeForProvider: CommandResultModalProps['getDefaultPermissionModeForProvider'];
  onSelectPermissionMode: CommandResultModalProps['onSelectPermissionMode'];
  onSelectProviderModel: CommandResultModalProps['onSelectProviderModel'];
  onSwitchSessionTarget: (request: SessionSwitchRequest) => Promise<void>;
};

const EMPTY_PROPS_GETTER = (() => ({})) as (...args: unknown[]) => Record<string, unknown>;

/**
 * Owns the composer's state (draft text, slash-command/file-mention menus,
 * attachments, queued draft) so typing re-renders only this subtree — not
 * ChatInterface, its provider/session hooks, or the transcript. Everything the
 * rest of the chat view needs from the composer goes through `composerRef`.
 */
function ChatComposerHost({
  composerRef,
  textareaRef,
  readOnly,
  studioMode,
  selectedProject,
  selectedSession,
  currentSessionId,
  provider,
  permissionMode,
  onCyclePermissionMode,
  currentProviderModel,
  currentProviderEffort,
  currentProviderEffortOptions,
  selectProviderEffort,
  fastMode,
  supportsFastMode,
  selectCodexFastMode,
  modelLabel,
  persistSessionModelEffort,
  activity,
  isProcessing,
  canAbortSession,
  tokenBudget,
  sendMessage,
  sendByCtrlEnter,
  onSessionProcessing,
  onSessionEstablished,
  onInputFocusChange,
  onFileOpen,
  onShowSettings,
  onNavigateToSession,
  scrollToBottom,
  addMessage,
  setIsUserScrolledUp,
  pendingPermissionRequests,
  handlePermissionDecision,
  handleGrantToolPermission,
  resolvePermissionModeForProvider,
  supportsImages,
  supportsFiles,
  onSaveAsSkill: onSaveAsSkillProp,
  sessionStore,
  providerModelCatalog,
  providerModelCacheCatalog,
  providerModelsRefreshing,
  providerModelErrors,
  providerAuthStatus,
  onModelPickerOpen,
  onHardRefreshProviderModels,
  modalPermissionMode,
  getPermissionModesForProvider,
  getDefaultPermissionModeForProvider,
  onSelectPermissionMode,
  onSelectProviderModel,
  onSwitchSessionTarget,
}: ChatComposerHostProps) {
  const { t } = useTranslation('chat');
  // Mobile-only composer overflow — collapses the relay/collab chips and the
  // tool icon row into a single "More" toggle so the default row stays compact.
  const [mobileToolsOpen, setMobileToolsOpen] = useState(false);

  const {
    input,
    setInput,
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
    handleInputFocusChange,
    isInputFocused,
    commandModalPayload,
    closeCommandModal,
    openModelSelector,
    showCostModal,
    onSaveAsSkill,
    saveAsSkillDisabled,
    buildSendOptions,
  } = useChatComposerState({
    selectedProject,
    selectedSession,
    currentSessionId,
    provider,
    permissionMode,
    cyclePermissionMode: onCyclePermissionMode,
    currentProviderModel,
    currentProviderEffort,
    fastMode,
    persistSessionModelEffort,
    isLoading: isProcessing,
    canAbortSession,
    tokenBudget,
    sendMessage,
    sendByCtrlEnter,
    onSessionProcessing,
    onSessionEstablished,
    onInputFocusChange,
    onFileOpen,
    onShowSettings,
    scrollToBottom,
    addMessage,
    setIsUserScrolledUp,
      resolvePermissionModeForProvider,
    supportsImages,
    supportsFiles,
    onSaveAsSkill: onSaveAsSkillProp,
    sessionStore,
    textareaRef,
  });

  useImperativeHandle(composerRef, () => ({ setInput }), [setInput]);

  const commandModalKind = commandModalPayload?.kind;
  useEffect(() => {
    if (commandModalKind === 'models') onModelPickerOpen?.();
  }, [commandModalKind, onModelPickerOpen]);

  useEffect(() => {
    if (!canAbortSession || readOnly) {
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
  }, [canAbortSession, handleAbortSession, readOnly]);

  const activeSessionId = currentSessionId || selectedSession?.id || null;

  // Boot the Claude process for the open session while the user reads/types,
  // with the exact options the next chat.send would carry.
  const buildPrewarmOptions = useCallback(() => buildSendOptions(''), [buildSendOptions]);
  usePrewarmSession({
    // Same target the send path resolves (selected session first).
    sessionId: selectedSession?.id || currentSessionId || null,
    provider,
    projectId: selectedProject.projectId ?? null,
    isProcessing,
    readOnly,
    isInputFocused,
    sendMessage,
    buildOptions: buildPrewarmOptions,
  });
  const handleSelectEffort = useCallback(
    (nextEffort: string) => selectProviderEffort(provider, nextEffort, activeSessionId),
    [activeSessionId, provider, selectProviderEffort],
  );
  const handleToggleFastMode = useCallback(
    () => selectCodexFastMode(!fastMode),
    [fastMode, selectCodexFastMode],
  );
  const handleRemoveImage = useCallback((index: number) => {
    setAttachedImages((previous) => previous.filter((_, currentIndex) => currentIndex !== index));
  }, [setAttachedImages]);
  const handleToggleMobileTools = useCallback(() => setMobileToolsOpen((current) => !current), []);
  const noopModeSwitch = useCallback(() => undefined, []);

  const continuitySessionId = selectedSession?.id || currentSessionId || null;
  const continuityControl = useMemo(() => (readOnly ? null : (
    <ContinuityControl
      sessionId={continuitySessionId}
      currentProvider={provider}
      onNavigateToSession={onNavigateToSession}
    />
  )), [continuitySessionId, onNavigateToSession, provider, readOnly]);

  const placeholder = studioMode
    ? 'Describe a change to this prototype…'
    : t('input.placeholder', { provider: providerMessageTypeLabel(t, provider) });

  return (
    <>
      <ChatComposer
        readOnly={readOnly}
        pendingPermissionRequests={pendingPermissionRequests}
        handlePermissionDecision={guardWhenReadOnly(readOnly, handlePermissionDecision)}
        handleGrantToolPermission={handleGrantToolPermission}
        activity={activity}
        isLoading={isProcessing}
        onAbortSession={guardWhenReadOnly(readOnly, handleAbortSession)}
        provider={provider}
        permissionMode={permissionMode}
        onModeSwitch={studioMode || readOnly ? noopModeSwitch : onCyclePermissionMode}
        effort={currentProviderEffort}
        availableEffortOptions={currentProviderEffortOptions}
        onSelectEffort={guardWhenReadOnly(readOnly, handleSelectEffort)}
        fastMode={fastMode}
        supportsFastMode={supportsFastMode}
        onToggleFastMode={guardWhenReadOnly(readOnly, handleToggleFastMode)}
        modelLabel={modelLabel}
        onOpenModelSelector={guardWhenReadOnly(readOnly, openModelSelector)}
        tokenBudget={tokenBudget}
        onShowTokenUsage={showCostModal}
        slashCommandsCount={slashCommandsCount}
        onToggleCommandMenu={guardWhenReadOnly(readOnly, handleToggleCommandMenu)}
        onSaveAsSkill={guardWhenReadOnly(readOnly, onSaveAsSkill)}
        saveAsSkillDisabled={saveAsSkillDisabled}
        continuityControl={continuityControl}
        studioMode={studioMode}
        hasInput={!readOnly && Boolean(input.trim())}
        onClearInput={guardWhenReadOnly(readOnly, handleClearInput)}
        onSubmit={guardWhenReadOnly(readOnly, handleSubmit)}
        isDragActive={!readOnly && isDragActive}
        queuedDraft={readOnly ? null : queuedDraft}
        onEditQueuedDraft={guardWhenReadOnly(readOnly, editQueuedDraft)}
        onDeleteQueuedDraft={guardWhenReadOnly(readOnly, deleteQueuedDraft)}
        attachedImages={attachedImages}
        onRemoveImage={guardWhenReadOnly(readOnly, handleRemoveImage)}
        uploadingImages={uploadingImages}
        imageErrors={imageErrors}
        showFileDropdown={!readOnly && showFileDropdown}
        filteredFiles={filteredFiles}
        selectedFileIndex={selectedFileIndex}
        onSelectFile={guardWhenReadOnly(readOnly, selectFile)}
        filteredCommands={filteredCommands}
        selectedCommandIndex={selectedCommandIndex}
        onCommandSelect={guardWhenReadOnly(readOnly, handleCommandSelect)}
        onCloseCommandMenu={resetCommandMenuState}
        isCommandMenuOpen={!readOnly && showCommandMenu}
        frequentCommands={commandQuery ? EMPTY_COMMANDS : frequentCommands}
        getRootProps={
          readOnly
            ? EMPTY_PROPS_GETTER
            : (getRootProps as (...args: unknown[]) => Record<string, unknown>)
        }
        getInputProps={
          readOnly
            ? EMPTY_PROPS_GETTER
            : (getInputProps as (...args: unknown[]) => Record<string, unknown>)
        }
        openImagePicker={guardWhenReadOnly(readOnly, openImagePicker)}
        inputHighlightRef={inputHighlightRef}
        renderInputWithMentions={renderInputWithMentions}
        textareaRef={textareaRef}
        input={readOnly ? '' : input}
        onVoiceTranscript={readOnly ? undefined : handleVoiceTranscript}
        onInputChange={guardWhenReadOnly(readOnly, handleInputChange)}
        onTextareaClick={guardWhenReadOnly(readOnly, handleTextareaClick)}
        onTextareaKeyDown={guardWhenReadOnly(readOnly, handleKeyDown)}
        onTextareaPaste={guardWhenReadOnly(readOnly, handlePaste)}
        onTextareaScrollSync={syncInputOverlayScroll}
        onTextareaInput={guardWhenReadOnly(readOnly, handleTextareaInput)}
        isInputFocused={isInputFocused}
        onInputFocusChange={handleInputFocusChange}
        mobileToolsOpen={mobileToolsOpen}
        onToggleMobileTools={handleToggleMobileTools}
        placeholder={placeholder}
        isTextareaExpanded={isTextareaExpanded}
        sendByCtrlEnter={sendByCtrlEnter}
      />

      <CommandResultModal
        payload={commandModalPayload}
        onClose={closeCommandModal}
        providerModelCatalog={providerModelCatalog}
        providerModelCacheCatalog={providerModelCacheCatalog}
        providerModelsRefreshing={providerModelsRefreshing}
        providerModelErrors={providerModelErrors}
        providerAuthStatus={providerAuthStatus}
        onHardRefreshProviderModels={onHardRefreshProviderModels}
        currentSessionId={activeSessionId}
        currentPermissionMode={modalPermissionMode}
        getPermissionModesForProvider={getPermissionModesForProvider}
        getDefaultPermissionModeForProvider={getDefaultPermissionModeForProvider}
        onSelectPermissionMode={onSelectPermissionMode}
        onSelectProviderModel={onSelectProviderModel}
        onSwitchSessionTarget={onSwitchSessionTarget}
      />
    </>
  );
}

const EMPTY_COMMANDS: never[] = [];

export default memo(ChatComposerHost);
