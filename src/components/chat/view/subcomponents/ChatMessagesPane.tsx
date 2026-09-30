import { useTranslation } from 'react-i18next';
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Dispatch, RefObject, SetStateAction } from 'react';
import { Link } from 'react-router-dom';

import type { ChatMessage } from '../../types/types';
import type { StudioPrototype, StudioPrototypeDetail } from '../../../studio/types';
import { studioApi } from '../../../studio/api/studioApi';
import StudioPreviewPane from '../../../studio/view/StudioPreviewPane';
import type {
  Project,
  ProjectSession,
  LLMProvider,
  ProviderModelsDefinition,
} from '../../../../types/app';
import { getIntrinsicMessageKey } from '../../utils/messageKeys';
import { groupConsecutiveTools, isToolGroupItem } from '../../utils/toolGrouping';
import { getRowHeightCache } from '../../utils/rowHeightCache';
import { COLLAPSED_TOOL_GROUP_ESTIMATE_PX, estimateMessageRowHeight } from '../../utils/rowHeightEstimate';
import { buildTranscriptRowModel, INITIAL_MOUNTED_TAIL_ROWS } from '../../utils/transcriptRowModel';
import { useLazyRowObserver } from '../../hooks/useLazyRowObserver';
import type { HistoryLoadError } from '../../hooks/useChatSessionState';
import { useTranscriptMessages } from '../../hooks/useTranscriptMessages';
import type { SessionStore } from '../../../../stores/useSessionStore';
import type { RowHeightCache } from '../../utils/rowHeightCache';
import type { LazyRowObserver } from '../../hooks/useLazyRowObserver';
import type { ToolGroupItem } from '../../utils/toolGrouping';

import MessageComponent from './MessageComponent';
import ProviderSelectionEmptyState from './ProviderSelectionEmptyState';
import ToolGroupContainer from './ToolGroupContainer';
import LoadAllMessagesOverlay from './LoadAllMessagesOverlay';
import LazyMessageRow from './LazyMessageRow';
import ChatExportMenu from './ChatExportMenu';

// INITIAL_MOUNTED_TAIL_ROWS (transcriptRowModel): trailing rows mount their
// real content on first commit so the initial scroll-to-bottom measures real
// heights. While a provider run is in flight the same tail stays
// force-mounted so growing rows are never swapped for placeholders.

/**
 * Rows that are still growing or awaiting interaction must never lazy-unmount:
 * a streaming assistant reply, a tool call whose result has not arrived yet
 * (including one waiting on a permission prompt), an interactive prompt, or a
 * subagent container that is still collecting child tools.
 */
function isLiveMessage(message: ChatMessage): boolean {
  return Boolean(
    message.isStreaming
    || message.isInteractivePrompt
    || (message.isToolUse && !message.toolResult)
    || (message.isSubagentContainer && message.subagentState && !message.subagentState.isComplete),
  );
}

type SharedRowProps = {
  rowKey: string;
  heightKeys: string[];
  heightCache: RowHeightCache | null;
  lazyRows: LazyRowObserver | null;
  /** Only read on the row's first mount (LazyMessageRow initial state). */
  initiallyNearViewport: boolean;
  forceMounted: boolean;
  createDiff: any;
  onFileOpen?: (filePath: string, diffInfo?: unknown) => void;
  onShowSettings?: () => void;
  onGrantToolPermission: (suggestion: { entry: string; toolName: string }) => { success: boolean };
  showRawParameters?: boolean;
  showThinking?: boolean;
  selectedProject: Project;
  provider: LLMProvider;
};

function sameKeys(left: readonly string[] | undefined, right: readonly string[] | undefined): boolean {
  if (left === right) return true;
  if (!left || !right || left.length !== right.length) return false;
  for (let index = 0; index < left.length; index++) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function sameSharedRowProps(prev: SharedRowProps, next: SharedRowProps): boolean {
  // initiallyNearViewport is deliberately ignored: it only seeds the row's
  // initial mount state, so a later change would re-render for nothing.
  return prev.rowKey === next.rowKey
    && sameKeys(prev.heightKeys, next.heightKeys)
    && prev.heightCache === next.heightCache
    && prev.lazyRows === next.lazyRows
    && prev.forceMounted === next.forceMounted
    && prev.createDiff === next.createDiff
    && prev.onFileOpen === next.onFileOpen
    && prev.onShowSettings === next.onShowSettings
    && prev.onGrantToolPermission === next.onGrantToolPermission
    && prev.showRawParameters === next.showRawParameters
    && prev.showThinking === next.showThinking
    // Project objects are rebuilt on every sidebar upsert; rows only care
    // about which project (MessageComponent compares the same way).
    && prev.selectedProject?.projectId === next.selectedProject?.projectId
    && prev.provider === next.provider;
}

type TranscriptMessageRowProps = SharedRowProps & {
  message: ChatMessage;
  prevMessage: ChatMessage | null;
};

/**
 * One transcript row. Takes the row's data (not pre-built children) so the
 * memo can hold: projected ChatMessage objects are identity-stable across
 * store updates (normalizedToChatMessages caches them), so on a stream flush
 * only the growing row re-renders.
 */
const TranscriptMessageRow = memo(function TranscriptMessageRow({
  rowKey,
  heightKeys,
  heightCache,
  lazyRows,
  initiallyNearViewport,
  forceMounted,
  message,
  prevMessage,
  createDiff,
  onFileOpen,
  onShowSettings,
  onGrantToolPermission,
  showRawParameters,
  showThinking,
  selectedProject,
  provider,
}: TranscriptMessageRowProps) {
  return (
    <LazyMessageRow
      rowKey={rowKey}
      heightKeys={heightKeys}
      heightCache={heightCache}
      // Force-mounted rows never show a placeholder, so skip the estimate
      // (an O(length) scan of a reply that is still growing).
      estimatedHeight={forceMounted ? undefined : estimateMessageRowHeight(message, prevMessage)}
      lazyRows={lazyRows}
      timestamp={message.timestamp}
      initiallyNearViewport={initiallyNearViewport}
      forceMounted={forceMounted}
    >
      <MessageComponent
        message={message}
        prevMessage={prevMessage}
        createDiff={createDiff}
        onFileOpen={onFileOpen}
        onShowSettings={onShowSettings}
        onGrantToolPermission={onGrantToolPermission}
        showRawParameters={showRawParameters}
        showThinking={showThinking}
        selectedProject={selectedProject}
        provider={provider}
      />
    </LazyMessageRow>
  );
}, (prev, next) => (
  prev.message === next.message
  && prev.prevMessage === next.prevMessage
  && sameSharedRowProps(prev, next)
));

type TranscriptToolGroupRowProps = SharedRowProps & {
  memberKeys: string[];
  group: ToolGroupItem;
  prevMessage: ChatMessage | null;
  getMessageKey: (message: ChatMessage) => string;
};

function sameGroupMembers(prev: ToolGroupItem, next: ToolGroupItem): boolean {
  if (prev === next) return true;
  if (prev.toolName !== next.toolName || prev.timestamp !== next.timestamp) return false;
  if (prev.messages.length !== next.messages.length) return false;
  for (let index = 0; index < prev.messages.length; index++) {
    if (prev.messages[index] !== next.messages[index]) return false;
  }
  return true;
}

const TranscriptToolGroupRow = memo(function TranscriptToolGroupRow({
  rowKey,
  memberKeys,
  heightKeys,
  heightCache,
  lazyRows,
  initiallyNearViewport,
  forceMounted,
  group,
  prevMessage,
  createDiff,
  getMessageKey,
  onFileOpen,
  onShowSettings,
  onGrantToolPermission,
  showRawParameters,
  showThinking,
  selectedProject,
  provider,
}: TranscriptToolGroupRowProps) {
  return (
    <LazyMessageRow
      rowKey={rowKey}
      memberKeys={memberKeys}
      heightKeys={heightKeys}
      heightCache={heightCache}
      estimatedHeight={COLLAPSED_TOOL_GROUP_ESTIMATE_PX}
      lazyRows={lazyRows}
      timestamp={group.timestamp}
      initiallyNearViewport={initiallyNearViewport}
      forceMounted={forceMounted}
    >
      <ToolGroupContainer
        group={group}
        prevMessage={prevMessage}
        createDiff={createDiff}
        getMessageKey={getMessageKey}
        onFileOpen={onFileOpen}
        onShowSettings={onShowSettings}
        onGrantToolPermission={onGrantToolPermission}
        showRawParameters={showRawParameters}
        showThinking={showThinking}
        selectedProject={selectedProject}
        provider={provider}
      />
    </LazyMessageRow>
  );
}, (prev, next) => (
  // getMessageKey is rebuilt on every transcript change; member keys (the
  // only thing it is used for here) are compared directly instead.
  sameGroupMembers(prev.group, next.group)
  && prev.prevMessage === next.prevMessage
  && sameKeys(prev.memberKeys, next.memberKeys)
  && sameSharedRowProps(prev, next)
));

interface ChatMessagesPaneProps {
  /**
   * True for an Agent Relay worker transcript opened for observation only.
   * Forwarded to the empty state so it never offers a provider/model picker
   * for a session that cannot be started from here.
   */
  readOnly?: boolean;
  scrollContainerRef: RefObject<HTMLDivElement>;
  isLoadingSessionMessages: boolean;
  /** Set when the first history load failed or history was never available. */
  historyLoadError?: HistoryLoadError | null;
  onRetryHistoryLoad?: () => void;
  /** True while the viewed session has an active provider run in flight. */
  isProcessing?: boolean;
  /** True while ChatComposer's floating activity/stop tab is rendered above the input. */
  hasActivityIndicator?: boolean;
  /**
   * The pane subscribes to the transcript rows itself (useTranscriptMessages)
   * so stream flushes re-render only this subtree, not ChatInterface.
   */
  sessionStore: Pick<SessionStore, 'subscribeSession' | 'getSessionSlot'>;
  transcriptSessionId: string | null;
  pendingUserMessage: ChatMessage | null;
  viewHiddenCount: number;
  /** Called after every transcript commit (scroll follow/anchor correction). */
  onTranscriptCommit?: () => void;
  selectedSession: ProjectSession | null;
  currentSessionId: string | null;
  provider: LLMProvider;
  setProvider: (provider: LLMProvider) => void;
  textareaRef: RefObject<HTMLTextAreaElement>;
  claudeModel: string;
  setClaudeModel: (model: string) => void;
  cursorModel: string;
  setCursorModel: (model: string) => void;
  codexModel: string;
  setCodexModel: (model: string) => void;
  opencodeModel: string;
  setOpenCodeModel: (model: string) => void;
  kiloModel: string;
  setKiloModel: (model: string) => void;
  grokModel: string;
  setGrokModel: (model: string) => void;
  kimiModel: string;
  setKimiModel: (model: string) => void;
  qwencodeModel: string;
  setQwenCodeModel: (model: string) => void;
  piModel: string;
  setPiModel: (model: string) => void;
  ompModel: string;
  setOmpModel: (model: string) => void;
  antigravityModel: string;
  setAntigravityModel: (model: string) => void;
  providerModelCatalog: Partial<Record<LLMProvider, ProviderModelsDefinition>>;
  providerModelsLoading: boolean;
  providerModelsRefreshing?: boolean;
  onRefreshProviderModels?: () => void;
  tasksEnabled: boolean;
  isTaskMasterInstalled: boolean | null;
  onShowAllTasks?: (() => void) | null;
  setInput: Dispatch<SetStateAction<string>>;
  isLoadingMoreMessages: boolean;
  hasMoreMessages: boolean;
  totalMessages: number;
  sessionMessagesCount: number;
  loadAllMessages: () => void;
  allMessagesLoaded: boolean;
  isLoadingAllMessages: boolean;
  loadAllJustFinished: boolean;
  showLoadAllOverlay: boolean;
  createDiff: any;
  onFileOpen?: (filePath: string, diffInfo?: unknown) => void;
  onShowSettings?: () => void;
  onGrantToolPermission: (suggestion: { entry: string; toolName: string }) => { success: boolean };
  onPrepareExport?: () => Promise<ChatMessage[]>;
  showRawParameters?: boolean;
  showThinking?: boolean;
  selectedProject: Project;
  linkedPrototypes?: StudioPrototype[];
}

function ChatMessagesPane({
  readOnly = false,
  scrollContainerRef,
  isLoadingSessionMessages,
  historyLoadError = null,
  onRetryHistoryLoad,
  isProcessing = false,
  hasActivityIndicator = false,
  sessionStore,
  transcriptSessionId,
  pendingUserMessage,
  viewHiddenCount,
  onTranscriptCommit,
  selectedSession,
  currentSessionId,
  provider,
  setProvider,
  textareaRef,
  claudeModel,
  setClaudeModel,
  cursorModel,
  setCursorModel,
  codexModel,
  setCodexModel,
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
  providerModelCatalog,
  providerModelsLoading,
  providerModelsRefreshing,
  onRefreshProviderModels,
  tasksEnabled,
  isTaskMasterInstalled,
  onShowAllTasks,
  setInput,
  isLoadingMoreMessages,
  hasMoreMessages,
  totalMessages,
  sessionMessagesCount,
  loadAllMessages,
  allMessagesLoaded,
  isLoadingAllMessages,
  loadAllJustFinished,
  showLoadAllOverlay,
  createDiff,
  onFileOpen,
  onShowSettings,
  onGrantToolPermission,
  onPrepareExport,
  showRawParameters,
  showThinking,
  selectedProject,
  linkedPrototypes = [],
}: ChatMessagesPaneProps) {
  const { t } = useTranslation('chat');
  const chatMessages = useTranscriptMessages(sessionStore, transcriptSessionId, pendingUserMessage, viewHiddenCount);
  // Every row renders: LazyMessageRow keeps off-screen rows cheap.
  const visibleMessages = chatMessages;
  // One shared IntersectionObserver for every LazyMessageRow; null where
  // IntersectionObserver is unavailable (tests), which keeps rows mounted.
  const lazyRows = useLazyRowObserver(scrollContainerRef);
  const groupedVisibleMessages = useMemo(
    () => groupConsecutiveTools(visibleMessages, Boolean(showThinking)),
    [visibleMessages, showThinking],
  );
  const ignorePreviewSelection = useCallback(() => undefined, []);
  const [previewDetails, setPreviewDetails] = useState<Record<string, StudioPrototypeDetail>>({});

  useEffect(() => {
    let cancelled = false;
    if (linkedPrototypes.length === 0) {
      setPreviewDetails({});
      return () => { cancelled = true; };
    }
    void Promise.all(linkedPrototypes.map(async (prototype) => {
      try {
        return await studioApi.get(prototype.projectId, prototype.id);
      } catch {
        return null;
      }
    })).then((details) => {
      if (cancelled) return;
      setPreviewDetails(Object.fromEntries(details.filter((detail): detail is StudioPrototypeDetail => Boolean(detail)).map((detail) => [detail.id, detail])));
    });
    return () => { cancelled = true; };
  }, [linkedPrototypes]);

  // Stable, deterministic keys for the messages rendered this pass.
  //
  // `normalizedToChatMessages` rebuilds fresh ChatMessage objects on every store
  // update, so caching keys by object identity (or via a cross-render allocation
  // Set) minted a brand-new key for the *same* logical message on each prepend —
  // remounting the whole list, which disconnects the scroll-restore anchor and
  // reflows heights, jumping the viewport to the bottom. Deriving keys purely
  // from this render's ordered messages (intrinsic key, disambiguated by
  // occurrence index on collision) yields the same key for the same message
  // order, so React preserves existing DOM nodes and component state on prepend.
  const messageKeyMap = useMemo(() => {
    const keys = new WeakMap<ChatMessage, string>();
    const occurrences = new Map<string, number>();
    const assign = (message: ChatMessage) => {
      const intrinsicKey = getIntrinsicMessageKey(message) ?? 'message-generated';
      const seen = occurrences.get(intrinsicKey) ?? 0;
      occurrences.set(intrinsicKey, seen + 1);
      keys.set(message, seen === 0 ? intrinsicKey : `${intrinsicKey}__${seen}`);
    };
    for (const item of groupedVisibleMessages) {
      if (isToolGroupItem(item)) {
        item.messages.forEach(assign);
      } else {
        assign(item);
      }
    }
    return keys;
  }, [groupedVisibleMessages]);

  const getMessageKey = useCallback(
    (message: ChatMessage) =>
      messageKeyMap.get(message) ?? getIntrinsicMessageKey(message) ?? 'message-generated',
    [messageKeyMap],
  );

  // Row keys that survive prepends (tool groups keep the key they were first
  // rendered with) and first-commit mount hints for newly prepended rows.
  // Both refs describe the last *committed* render.
  const groupKeyByMemberRef = useRef<ReadonlyMap<string, string>>(new Map());
  const committedRowKeysRef = useRef<ReadonlySet<string>>(new Set());
  const rowModel = useMemo(
    () => buildTranscriptRowModel(
      groupedVisibleMessages,
      getMessageKey,
      groupKeyByMemberRef.current,
      committedRowKeysRef.current,
    ),
    [groupedVisibleMessages, getMessageKey],
  );
  useLayoutEffect(() => {
    groupKeyByMemberRef.current = rowModel.groupKeyByMember;
    committedRowKeysRef.current = new Set(rowModel.rows.map((row) => row.key));
  }, [rowModel]);

  // This pane is memoized and owns the transcript subscription, so it only
  // re-renders when something it draws changed (rows, in-place stream/tool
  // updates, loading slots, padding). Reconcile scroll follow/anchoring after
  // exactly those commits — never on unrelated parent renders or keystrokes.
  const onTranscriptCommitRef = useRef(onTranscriptCommit);
  onTranscriptCommitRef.current = onTranscriptCommit;
  useLayoutEffect(() => {
    onTranscriptCommitRef.current?.();
  });

  // Measured row heights outlive row components (remounts, revisits).
  const heightScope = currentSessionId || selectedSession?.id || 'draft';
  const heightCache = useMemo(() => getRowHeightCache(heightScope), [heightScope]);
  const showOlderHistorySlot = !allMessagesLoaded && (hasMoreMessages || isLoadingMoreMessages);

  return (
    <div
      ref={scrollContainerRef}
      tabIndex={0}
      style={{ overflowAnchor: 'none' }}
      className={`chat-messages-pane relative min-h-0 flex-1 overflow-y-auto overflow-x-hidden pt-3 sm:pt-4 ${
        hasActivityIndicator ? 'pb-12 sm:pb-14' : 'pb-3 sm:pb-4'
      }`}
    >
      {chatMessages.length > 0 && (
        <div className="pointer-events-none sticky right-4 top-3 z-10 mb-2 flex justify-end px-4 sm:px-6">
          <div className="pointer-events-auto">
            <ChatExportMenu
              messages={chatMessages}
              sessionTitle={selectedSession?.title || selectedSession?.summary || selectedSession?.name}
              onPrepareExport={onPrepareExport}
              disabled={isLoadingAllMessages}
            />
          </div>
        </div>
      )}
      {chatMessages.length > 0 && (
        // Zero-height sticky host outside the spaced transcript content, so
        // the pill appearing/fading never changes content height.
        <LoadAllMessagesOverlay
          showLoadAllOverlay={showLoadAllOverlay}
          isLoadingAllMessages={isLoadingAllMessages}
          loadAllJustFinished={loadAllJustFinished}
          totalMessages={totalMessages}
          onLoadAllMessages={loadAllMessages}
        />
      )}
      <div data-transcript-content className="mx-auto w-full max-w-[54.25rem] space-y-3 px-4 sm:space-y-4">
      {linkedPrototypes.length > 0 && (
        <div className="mb-3 flex flex-wrap gap-2" data-testid="linked-prototypes">
          {linkedPrototypes.map((prototype) => (
            <div key={prototype.id} className="min-w-56 rounded-xl border border-border bg-card px-3 py-2 shadow-sm">
              <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="truncate text-xs font-semibold">{prototype.title}</div>
                <div className="text-[10px] capitalize text-muted-foreground">{prototype.status}</div>
              </div>
              <Link
                className="shrink-0 text-[10px] font-medium text-primary hover:underline"
                to={`/studio/${encodeURIComponent(prototype.projectId)}/${encodeURIComponent(prototype.id)}`}
              >
                Open in Studio
              </Link>
              </div>
              {previewDetails[prototype.id] ? (
                <div className="mt-2 h-64 overflow-hidden rounded-lg border border-border/70 bg-muted/20">
                  <StudioPreviewPane
                    title={previewDetails[prototype.id].title}
                    html={previewDetails[prototype.id].html}
                    frame="desktop"
                    selectMode={false}
                    onSelectElement={ignorePreviewSelection}
                  />
                </div>
              ) : null}
            </div>
          ))}
        </div>
      )}
      {historyLoadError && !isLoadingSessionMessages && chatMessages.length === 0 && selectedSession ? (
        <div className="mt-8 flex flex-col items-center gap-3 text-center text-sm text-gray-500 dark:text-gray-400" role="alert">
          <p>
            {historyLoadError === 'unavailable'
              ? t('session.loading.historyUnavailable', 'This conversation\'s history isn\'t available yet.')
              : t('session.loading.historyFailed', 'Couldn\'t load conversation history.')}
          </p>
          {onRetryHistoryLoad && (
            <button
              type="button"
              className="rounded-md border border-border px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted"
              onClick={onRetryHistoryLoad}
            >
              {t('session.loading.retry', 'Retry')}
            </button>
          )}
        </div>
      ) : isLoadingSessionMessages && chatMessages.length === 0 ? (
        <div className="mt-8 text-center text-gray-500 dark:text-gray-400">
          <div className="flex items-center justify-center space-x-2">
            <div className="h-4 w-4 animate-spin rounded-full border-b-2 border-gray-400" />
            <p>{t('session.loading.sessionMessages')}</p>
          </div>
        </div>
      ) : chatMessages.length === 0 ? (
        <ProviderSelectionEmptyState
          readOnly={readOnly}
          selectedSession={selectedSession}
          currentSessionId={currentSessionId}
          provider={provider}
          setProvider={setProvider}
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
          onRefreshProviderModels={onRefreshProviderModels}
          tasksEnabled={tasksEnabled}
          isTaskMasterInstalled={isTaskMasterInstalled}
          onShowAllTasks={onShowAllTasks}
          setInput={setInput}
        />
      ) : (
        <>
          {/* One fixed-height slot for "loading older" / "more above", so
              swapping between them never shifts the transcript. */}
          {showOlderHistorySlot && (
            <div
              data-older-history-slot
              className="flex h-10 items-center justify-center border-b border-gray-200 text-center text-sm text-gray-500 dark:border-gray-700 dark:text-gray-400"
            >
              {isLoadingMoreMessages && !isLoadingAllMessages ? (
                <div className="flex items-center justify-center space-x-2">
                  <div className="h-4 w-4 animate-spin rounded-full border-b-2 border-gray-400" />
                  <p className="text-sm">{t('session.loading.olderMessages')}</p>
                </div>
              ) : (
                <span className="truncate">
                  {/* Both counts are persisted-history rows; the rendered row
                      count differs (tool results merge, groups collapse). */}
                  {sessionMessagesCount > 0 && totalMessages > sessionMessagesCount
                    ? <>{t('session.messages.showingOf', { shown: sessionMessagesCount, total: totalMessages })}{' '}</>
                    : null}
                  <span className="text-xs">{t('session.messages.scrollToLoad')}</span>
                </span>
              )}
            </div>
          )}

          {(() => {
            let prevMessage: ChatMessage | null = null;
            const rowCount = groupedVisibleMessages.length;
            // While a run is in flight, everything in the tail band stays
            // mounted — the growing thinking/stream/tool rows all live there.
            const forcedTailStart = isProcessing
              ? rowCount - INITIAL_MOUNTED_TAIL_ROWS
              : Number.POSITIVE_INFINITY;

            return groupedVisibleMessages.map((item, index) => {
              const row = rowModel.rows[index];
              const initiallyNearViewport = row.mountInitially;
              const isInForcedTail = index >= forcedTailStart;

              if (isToolGroupItem(item)) {
                const groupPrevMessage = prevMessage;
                prevMessage = item.messages[item.messages.length - 1] || prevMessage;

                return (
                  <TranscriptToolGroupRow
                    key={row.key}
                    rowKey={row.key}
                    memberKeys={row.memberKeys}
                    heightKeys={row.heightKeys}
                    heightCache={heightCache}
                    lazyRows={lazyRows}
                    initiallyNearViewport={initiallyNearViewport}
                    forceMounted={isInForcedTail || item.messages.some(isLiveMessage)}
                    group={item}
                    prevMessage={groupPrevMessage}
                    createDiff={createDiff}
                    getMessageKey={getMessageKey}
                    onFileOpen={onFileOpen}
                    onShowSettings={onShowSettings}
                    onGrantToolPermission={onGrantToolPermission}
                    showRawParameters={showRawParameters}
                    showThinking={showThinking}
                    selectedProject={selectedProject}
                    provider={provider}
                  />
                );
              }

              const messagePrevMessage = prevMessage;
              prevMessage = item;

              // Hidden thinking rows render null; wrapping them would leave an
              // empty spacer div (space-y margins) or a phantom placeholder.
              if (item.isThinking && !showThinking) {
                return (
                  <MessageComponent
                    key={getMessageKey(item)}
                    message={item}
                    prevMessage={messagePrevMessage}
                    createDiff={createDiff}
                    onFileOpen={onFileOpen}
                    onShowSettings={onShowSettings}
                    onGrantToolPermission={onGrantToolPermission}
                    showRawParameters={showRawParameters}
                    showThinking={showThinking}
                    selectedProject={selectedProject}
                    provider={provider}
                  />
                );
              }

              return (
                <TranscriptMessageRow
                  key={row.key}
                  rowKey={row.key}
                  heightKeys={row.heightKeys}
                  heightCache={heightCache}
                  lazyRows={lazyRows}
                  initiallyNearViewport={initiallyNearViewport}
                  forceMounted={isInForcedTail || isLiveMessage(item)}
                  message={item}
                  prevMessage={messagePrevMessage}
                  createDiff={createDiff}
                  onFileOpen={onFileOpen}
                  onShowSettings={onShowSettings}
                  onGrantToolPermission={onGrantToolPermission}
                  showRawParameters={showRawParameters}
                  showThinking={showThinking}
                  selectedProject={selectedProject}
                  provider={provider}
                />
              );
            });
          })()}
        </>
      )}
      </div>
    </div>
  );
}

export default memo(ChatMessagesPane);
