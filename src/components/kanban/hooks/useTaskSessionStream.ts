import { useEffect, useRef } from 'react';

import { useWebSocket, type ServerEvent } from '../../../contexts/WebSocketContext';
import { useSessionStore, type NormalizedMessage } from '../../../stores/useSessionStore';
import type { LLMProvider } from '../../../types/app';

/**
 * Subscribes a task's app session to the live run stream and routes events into
 * a per-instance session store — the same protocol the chat UI uses, minus the
 * chat-only side effects (sounds, permission prompts, page-title flashes).
 *
 * On open it loads the persisted transcript over REST and sends `chat.subscribe`,
 * which replays any buffered events from the run registry (headless kanban runs
 * buffer there) and then streams new ones live. Returns the merged messages;
 * the component re-renders because the store notifies for the active session.
 */
export function useTaskSessionStream(sessionId: string | null, provider: LLMProvider) {
  const { ws, sendMessage, subscribe } = useWebSocket();
  const store = useSessionStore();

  // Streaming buffers (mirrors useChatRealtimeHandlers, 100ms flush cadence).
  const streamTextRef = useRef('');
  const streamTimerRef = useRef<number | null>(null);
  const thinkTextRef = useRef('');
  const thinkTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (!sessionId) {
      return;
    }
    store.setActiveSession(sessionId);
    void store.fetchFromServer(sessionId);

    if (!ws) {
      return;
    }

    const clearStreamTimer = () => {
      if (streamTimerRef.current) {
        window.clearTimeout(streamTimerRef.current);
        streamTimerRef.current = null;
      }
    };
    const clearThinkTimer = () => {
      if (thinkTimerRef.current) {
        window.clearTimeout(thinkTimerRef.current);
        thinkTimerRef.current = null;
      }
    };

    sendMessage({ type: 'chat.subscribe', sessions: [{ sessionId, lastSeq: 0 }] });

    const unsubscribe = subscribe((event: ServerEvent) => {
      if (event.sessionId !== sessionId || typeof event.kind !== 'string') {
        return;
      }
      const msg = event as unknown as NormalizedMessage & { content?: unknown };

      // Close an open thinking block when any other kind arrives.
      if (msg.kind !== 'thinking' && thinkTextRef.current) {
        clearThinkTimer();
        store.updateThinkingStream(sessionId, thinkTextRef.current, provider);
        store.finalizeThinkingStream(sessionId);
        thinkTextRef.current = '';
      }

      switch (msg.kind) {
        case 'thinking': {
          const text = typeof msg.content === 'string' ? msg.content : '';
          if (!text) {
            return;
          }
          thinkTextRef.current += text;
          if (!thinkTimerRef.current) {
            thinkTimerRef.current = window.setTimeout(() => {
              thinkTimerRef.current = null;
              store.updateThinkingStream(sessionId, thinkTextRef.current, provider);
            }, 100);
          }
          return;
        }
        case 'stream_delta': {
          const text = typeof msg.content === 'string' ? msg.content : '';
          if (!text) {
            return;
          }
          streamTextRef.current += text;
          if (!streamTimerRef.current) {
            streamTimerRef.current = window.setTimeout(() => {
              streamTimerRef.current = null;
              store.updateStreaming(sessionId, streamTextRef.current, provider);
            }, 100);
          }
          return;
        }
        case 'stream_end': {
          clearStreamTimer();
          if (streamTextRef.current) {
            store.updateStreaming(sessionId, streamTextRef.current, provider);
          }
          store.finalizeStreaming(sessionId);
          streamTextRef.current = '';
          return;
        }
        case 'complete': {
          clearStreamTimer();
          if (streamTextRef.current) {
            store.updateStreaming(sessionId, streamTextRef.current, provider);
            store.finalizeStreaming(sessionId);
          }
          streamTextRef.current = '';
          void store.refreshFromServer(sessionId);
          return;
        }
        // Skip non-persisted control frames.
        case 'status':
        case 'permission_request':
        case 'permission_cancelled':
          return;
        default:
          store.appendRealtime(sessionId, msg);
      }
    });

    return () => {
      clearStreamTimer();
      clearThinkTimer();
      streamTextRef.current = '';
      thinkTextRef.current = '';
      unsubscribe();
    };
  }, [sessionId, provider, ws, sendMessage, subscribe, store]);

  return sessionId ? store.getMessages(sessionId) : [];
}
