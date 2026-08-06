import { useEffect, useRef } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';

import type { ServerEvent } from '../../../contexts/WebSocketContext';
import { showCompletionTitleIndicator } from '../../../utils/pageTitleNotification';
import { playChatCompletionSound, playNotificationSound } from '../../../utils/notificationSound';
import type { MarkSessionIdle, MarkSessionProcessing } from '../../../hooks/useSessionProtection';
import type { PendingPermissionRequest } from '../types/types';
import type { ProjectSession, LLMProvider } from '../../../types/app';
import type { SessionStore, NormalizedMessage } from '../../../stores/useSessionStore';

const isActionablePermissionRequest = (request: { toolName?: unknown } | null | undefined): boolean => {
  return request?.toolName !== 'ExitPlanMode' && request?.toolName !== 'exit_plan_mode';
};

const hasActionablePermissionRequests = (requests: Array<{ toolName?: unknown }> | null | undefined): boolean => {
  return Array.isArray(requests) && requests.some((request) => isActionablePermissionRequest(request));
};

interface UseChatRealtimeHandlersArgs {
  subscribe: (listener: (event: ServerEvent) => void) => () => void;
  provider: LLMProvider;
  selectedSession: ProjectSession | null;
  currentSessionId: string | null;
  setTokenBudget: (budget: Record<string, unknown> | null) => void;
  pendingPermissionRequests: PendingPermissionRequest[];
  setPendingPermissionRequests: Dispatch<SetStateAction<PendingPermissionRequest[]>>;
  // Per-session accumulation buffers. The chat view subscribes to every
  // in-progress session at once, so streaming text MUST be keyed by the
  // frame's own session id — a single shared buffer would stamp background
  // session A's text into viewed session B.
  streamBuffersRef: MutableRefObject<Map<string, { text: string; timer: number | null }>>;
  thinkingBuffersRef: MutableRefObject<Map<string, { text: string; timer: number | null }>>;
  /**
   * Highest live `seq` observed per session. Essential for reconnect catch-up:
   * `chat.subscribe` sends this value as `lastSeq` so the server replays only
   * the events this client actually missed. Written here on every sequenced
   * frame; read wherever a `chat.subscribe` is sent (session open, reconnect).
   */
  lastSeqRef: MutableRefObject<Map<string, number>>;
  /** When each session's `chat.subscribe` was last sent; guards stale idle acks. */
  statusCheckSentAtRef: MutableRefObject<Map<string, number>>;
  onSessionProcessing?: MarkSessionProcessing;
  onSessionIdle?: MarkSessionIdle;
  onWebSocketReconnect?: () => void;
  sessionStore: SessionStore;
}

/* ------------------------------------------------------------------ */
/*  Hook                                                              */
/* ------------------------------------------------------------------ */

/**
 * Routes server events into the session store and processing-state map.
 *
 * This is intentionally a thin reducer over the unified `kind`-based
 * protocol: every frame is keyed by the stable app session id, so there is
 * no session-id handoff, no provider branching, and no navigation here.
 * Sidebar events (`session_upserted`, `loading_progress`) are handled by
 * `useProjectsState`, not in this hook.
 */
export function useChatRealtimeHandlers({
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
  onWebSocketReconnect,
  sessionStore,
}: UseChatRealtimeHandlersArgs) {
  // Session switches can send `chat.subscribe` before this effect has a chance
  // to rebind the websocket listener. Read the visible session id from a ref
  // so a fast `chat_subscribed` ack is matched against the current view, not
  // the previous render's closed-over selection.
  const activeViewSessionIdRef = useRef<string | null>(selectedSession?.id || currentSessionId || null);
  activeViewSessionIdRef.current = selectedSession?.id || currentSessionId || null;

  // Keep the latest pending-permission snapshot available to the websocket
  // listener so back-to-back permission events can dedupe and re-arm the
  // notification sound before React finishes a rerender.
  const pendingPermissionRequestsRef = useRef(pendingPermissionRequests);
  // Replayed run frames keep their original normalized id. Tracking those ids
  // lets a remounted chat recover missed frames while dropping an overlapping
  // replay from another subscription, without treating a later run's seq=1
  // as stale merely because an earlier run used the same session id.
  const processedEventIdsRef = useRef(new Map<string, Set<string>>());

  useEffect(() => {
    pendingPermissionRequestsRef.current = pendingPermissionRequests;
  }, [pendingPermissionRequests]);

  useEffect(() => {
    const handleEvent = (msg: ServerEvent) => {
      if (!msg.kind) {
        return;
      }

      const activeViewSessionId = activeViewSessionIdRef.current;
      // The server tags every run frame with its app session id. Never fall
      // back to the viewed session here — an untagged frame must not be
      // routed into whatever session happens to be on screen.
      const sid = (typeof msg.sessionId === 'string' && msg.sessionId) || null;

      // Every live run frame is sequenced. Reconnects and periodic status
      // refreshes can replay a frame that this socket already received, so
      // delivery must be idempotent before any stream text is appended.
      if (sid && typeof msg.seq === 'number' && Number.isFinite(msg.seq)) {
        const known = lastSeqRef.current.get(sid) ?? 0;
        const eventId = typeof msg.id === 'string' && msg.id ? msg.id : null;
        if (eventId) {
          let processedIds = processedEventIdsRef.current.get(sid);
          if (!processedIds) {
            processedIds = new Set<string>();
            processedEventIdsRef.current.set(sid, processedIds);
          }
          if (processedIds.has(eventId)) {
            return;
          }
          processedIds.add(eventId);
          if (processedIds.size > 5000) {
            const oldest = processedIds.values().next().value;
            if (typeof oldest === 'string') {
              processedIds.delete(oldest);
            }
          }
        } else if (msg.seq <= known) {
          // Older providers may omit ids; keep the sequence fallback for
          // those frames only.
          return;
        }
        if (msg.seq > known) {
          lastSeqRef.current.set(sid, msg.seq);
        }
      }

      switch (msg.kind) {
        case 'websocket_reconnected':
          onWebSocketReconnect?.();
          return;

        case 'chat_subscribed': {
          // Ack for chat.subscribe: authoritative processing state plus any
          // pending tool-permission prompts for the run.
          if (!sid) return;

          if (msg.isProcessing) {
            onSessionProcessing?.(sid);
          } else {
            // Idle ack: ignore it if a newer request started after the
            // subscribe was sent — the ack describes the older state.
            onSessionIdle?.(sid, {
              ifStartedBefore: statusCheckSentAtRef.current.get(sid),
            });
          }

          const isViewedSession = sid === activeViewSessionId;
          if (isViewedSession && Array.isArray(msg.pendingPermissions)) {
            const nextPendingPermissionRequests = msg.pendingPermissions as PendingPermissionRequest[];
            const hadActionablePermissionRequests = hasActionablePermissionRequests(pendingPermissionRequestsRef.current);
            const hasPendingActionablePermissionRequests = hasActionablePermissionRequests(nextPendingPermissionRequests);

            pendingPermissionRequestsRef.current = nextPendingPermissionRequests;
            setPendingPermissionRequests(nextPendingPermissionRequests);

            if (hasPendingActionablePermissionRequests && !hadActionablePermissionRequests) {
              void playNotificationSound();
            }
          }
          return;
        }

        case 'protocol_error': {
          console.error('[Chat] Protocol error:', msg.code, msg.error);
          if (sid) {
            // Surface the failure in the conversation and stop the spinner —
            // the run never started (or was rejected), so no `complete` follows.
            onSessionIdle?.(sid);
            sessionStore.appendRealtime(sid, {
              id: `protocol_error_${Date.now()}`,
              sessionId: sid,
              timestamp: new Date().toISOString(),
              provider,
              kind: 'error',
              content: String(msg.error || 'Request failed'),
            } as NormalizedMessage);
          }
          return;
        }

        // Sidebar/global events — owned by useProjectsState.
        case 'session_upserted':
        case 'loading_progress':
          return;

        default:
          break;
      }

      /* -------------------------------------------------------------- */
      /*  Provider NormalizedMessage handling                            */
      /* -------------------------------------------------------------- */

      // A live `thinking` burst (see below) ends the moment any other kind
      // of message arrives for THAT SAME session - a tool call starting, the
      // reply text starting, or the turn completing. Close out only the
      // incoming frame's own session buffer; another session's burst keeps
      // accumulating untouched.
      if (msg.kind !== 'thinking' && sid) {
        const thinkingEntry = thinkingBuffersRef.current.get(sid);
        if (thinkingEntry && thinkingEntry.text) {
          if (thinkingEntry.timer) {
            clearTimeout(thinkingEntry.timer);
            thinkingEntry.timer = null;
          }
          sessionStore.updateThinkingStream(sid, thinkingEntry.text, provider);
          sessionStore.finalizeThinkingStream(sid);
          thinkingBuffersRef.current.delete(sid);
        }
      }

      // --- Thinking: buffer token-by-token reasoning into one growing block ---
      if (msg.kind === 'thinking') {
        const text = (msg.content as string) || '';
        if (!text || !sid) return;
        let thinkingEntry = thinkingBuffersRef.current.get(sid);
        if (!thinkingEntry) {
          thinkingEntry = { text: '', timer: null };
          thinkingBuffersRef.current.set(sid, thinkingEntry);
        }
        thinkingEntry.text += text;
        if (!thinkingEntry.timer) {
          const entry = thinkingEntry;
          entry.timer = window.setTimeout(() => {
            entry.timer = null;
            sessionStore.updateThinkingStream(sid, entry.text, provider);
          }, 100);
        }
        return;
      }

      // --- Streaming: buffer for performance ---
      if (msg.kind === 'stream_delta') {
        const text = (msg.content as string) || '';
        if (!text || !sid) return;
        let streamEntry = streamBuffersRef.current.get(sid);
        if (!streamEntry) {
          streamEntry = { text: '', timer: null };
          streamBuffersRef.current.set(sid, streamEntry);
        }
        streamEntry.text += text;
        if (!streamEntry.timer) {
          const entry = streamEntry;
          entry.timer = window.setTimeout(() => {
            entry.timer = null;
            sessionStore.updateStreaming(sid, entry.text, provider);
          }, 100);
        }
        return;
      }

      if (msg.kind === 'stream_end') {
        if (sid) {
          const streamEntry = streamBuffersRef.current.get(sid);
          if (streamEntry) {
            if (streamEntry.timer) {
              clearTimeout(streamEntry.timer);
              streamEntry.timer = null;
            }
            if (streamEntry.text) {
              sessionStore.updateStreaming(sid, streamEntry.text, provider);
            }
            streamBuffersRef.current.delete(sid);
          }
          sessionStore.finalizeStreaming(sid);
        }
        return;
      }

      // --- All other messages: route to store ---
      const shouldPersist =
        msg.kind !== 'complete'
        && msg.kind !== 'status'
        && msg.kind !== 'permission_request'
        && msg.kind !== 'permission_cancelled';

      if (sid && shouldPersist) {
        sessionStore.appendRealtime(sid, msg as unknown as NormalizedMessage);
      }

      // --- UI side effects for specific kinds ---
      switch (msg.kind) {
        case 'complete': {
          // Sequence numbers belong to one provider run. A later message in
          // the same conversation starts a fresh run, so do not let the old
          // cursor suppress its seq=1 stream after this terminal frame.
          if (sid) {
            lastSeqRef.current.delete(sid);
            processedEventIdsRef.current.delete(sid);
          }

          // Flush any remaining streaming state for this session only.
          if (sid) {
            const streamEntry = streamBuffersRef.current.get(sid);
            if (streamEntry) {
              if (streamEntry.timer) {
                clearTimeout(streamEntry.timer);
                streamEntry.timer = null;
              }
              streamBuffersRef.current.delete(sid);
              if (streamEntry.text) {
                sessionStore.updateStreaming(sid, streamEntry.text, provider);
                sessionStore.finalizeStreaming(sid);
              }
            }
          }

          // `complete` is the unified terminal event — every provider run ends
          // with exactly one, regardless of success, failure, or abort. The
          // indicator derives from the processing map, so deleting the entry
          // hides it immediately and atomically.
          onSessionIdle?.(sid);
          if (sid === activeViewSessionId) {
            pendingPermissionRequestsRef.current = [];
            setPendingPermissionRequests([]);
          }

          if (msg.aborted) {
            // Abort was requested — the complete event confirms it. No
            // further UI action is needed beyond clearing the entry above.
            break;
          }

          // Celebrate only successful runs (failed runs end with success: false).
          if (msg.success !== false) {
            showCompletionTitleIndicator();
            void playChatCompletionSound();
          }

          // The session id is stable for the whole conversation (allocated
          // before the first send), so the only follow-up is syncing the
          // viewed conversation with the now-persisted transcript.
          if (sid && sid === activeViewSessionId) {
            void sessionStore.refreshFromServer(sid);
          }

          break;
        }

        // 'error' is an informational message row, not a terminal event —
        // providers emit it for mid-run stderr output too. Run teardown is
        // always signalled by the unified 'complete' that follows.

        case 'permission_request': {
          if (!msg.requestId) break;
          if (isActionablePermissionRequest({ toolName: msg.toolName })) {
            void playNotificationSound();
          }

          if (sid === activeViewSessionId) {
            const previousPendingPermissionRequests = pendingPermissionRequestsRef.current;
            if (!previousPendingPermissionRequests.some((request) => request.requestId === msg.requestId)) {
              const nextPendingPermissionRequests = [...previousPendingPermissionRequests, {
                requestId: msg.requestId as string,
                toolName: (msg.toolName as string) || 'UnknownTool',
                input: msg.input,
                context: msg.context,
                sessionId: sid || null,
                provider: (msg.provider as LLMProvider) || provider,
                receivedAt: new Date(),
              }];

              pendingPermissionRequestsRef.current = nextPendingPermissionRequests;
              setPendingPermissionRequests(nextPendingPermissionRequests);
            }
          }
          if (sid) {
            onSessionProcessing?.(sid);
          }
          break;
        }

        case 'permission_cancelled': {
          if (msg.requestId && sid === activeViewSessionId) {
            const nextPendingPermissionRequests = pendingPermissionRequestsRef.current.filter(
              (request: PendingPermissionRequest) => request.requestId !== msg.requestId,
            );

            pendingPermissionRequestsRef.current = nextPendingPermissionRequests;
            setPendingPermissionRequests(nextPendingPermissionRequests);
          }
          break;
        }

        case 'status': {
          // Token telemetry is stored for the currently visible session only;
          // a background run must not replace the modal's usage numbers.
          if (msg.text === 'token_budget' && msg.tokenBudget && sid === activeViewSessionId) {
            setTokenBudget(msg.tokenBudget as Record<string, unknown>);
          } else if (msg.text && sid) {
            onSessionProcessing?.(sid, {
              statusText: msg.text as string,
              canInterrupt: msg.canInterrupt !== false,
            });
          }
          break;
        }

        // text, tool_use, tool_result, thinking, interactive_prompt, task_notification
        // → already routed to store above, no UI side effects needed
        default:
          break;
      }
    };

    return subscribe(handleEvent);
  }, [
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
    onWebSocketReconnect,
    sessionStore,
  ]);
}
