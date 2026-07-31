import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useWebSocket, type ServerEvent } from '../../../contexts/WebSocketContext';
import { useSessionStore, type NormalizedMessage } from '../../../stores/useSessionStore';
import { authenticatedFetch } from '../../../utils/api';
import type { LLMProvider } from '../../../types/app';
import {
  buildWizardBrief,
  extractSkillDraft,
  type SkillWizardDraft,
} from '../lib/skillWizardPrompt';

export interface UseSkillWizardSession {
  /** Conversation for the wizard thread, WITHOUT the hidden brief. */
  messages: NormalizedMessage[];
  streaming: boolean;
  /** True once a session id has been assigned by a `start()` call that wasn't superseded. */
  ready: boolean;
  draft: SkillWizardDraft | null;
  error: string | null;
  start(opts: { provider: string; projectPath?: string; transcript?: string }): Promise<void>;
  send(text: string): void;
  reset(): void;
}

const EMPTY_MESSAGES: NormalizedMessage[] = [];

/**
 * Self-contained chat session for the skill wizard — same protocol the chat
 * UI uses (`POST /api/providers/sessions` + `chat.subscribe` + `chat.send`),
 * routed into a per-hook session store like useTaskSessionStream, minus the
 * chat-only side effects. The skill-author brief goes out as the first
 * message but is filtered out of the exposed `messages`.
 *
 * `send` reuses the same session id; the server resumes the provider session,
 * so the wizard is genuinely multi-turn.
 */
export function useSkillWizardSession(): UseSkillWizardSession {
  const { sendMessage, subscribe, isConnected } = useWebSocket();
  const store = useSessionStore();

  const [sessionId, setSessionId] = useState<string | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Refs the websocket listener reads — it subscribes once and must see the
  // current session without rebinding.
  const sessionIdRef = useRef<string | null>(null);
  const providerRef = useRef<LLMProvider>('claude');
  /** The hidden brief sent at start; filtered out of exposed messages. */
  const briefRef = useRef<string | null>(null);
  /** Mirror of `streaming` for the listener/watchdog (no state round-trip). */
  const streamingRef = useRef(false);
  /** Counts content frames seen for the active session (drives reconnect recovery). */
  const framesSeenRef = useRef(0);
  /** Silence watchdog: recovers the UI when frames stop arriving mid-turn. */
  const watchdogRef = useRef<number | null>(null);
  // Bumped by every reset()/start(); an in-flight start() checks this after
  // its awaited fetch resolves and discards its result if it no longer
  // matches. Without this, React.StrictMode's dev-mode double-invoke of the
  // dialog's mount effect (or a rapid provider switch) fires start() twice
  // back-to-back with no cleanup between them — both calls race to own
  // sessionIdRef/store state, and whichever POST resolves last silently wins,
  // leaving the other session orphaned mid-stream (stuck "streaming" dots,
  // sends going nowhere).
  const generationRef = useRef(0);

  const WATCHDOG_MS = 90_000;

  const updateStreaming = useCallback((value: boolean) => {
    streamingRef.current = value;
    setStreaming(value);
  }, []);

  const clearWatchdog = useCallback(() => {
    if (watchdogRef.current !== null) {
      window.clearTimeout(watchdogRef.current);
      watchdogRef.current = null;
    }
  }, []);

  // If a turn goes silent (socket reconnect dropped the run's attachment,
  // frames lost in flight), the registry keeps streaming to the dead socket
  // and `complete` never reaches us. Pull the persisted transcript and
  // re-enable the composer instead of hanging forever.
  const armWatchdog = useCallback(() => {
    clearWatchdog();
    watchdogRef.current = window.setTimeout(() => {
      watchdogRef.current = null;
      const activeSessionId = sessionIdRef.current;
      if (!activeSessionId || !streamingRef.current) {
        return;
      }
      updateStreaming(false);
      void store.refreshFromServer(activeSessionId);
    }, WATCHDOG_MS);
  }, [clearWatchdog, store, updateStreaming]);

  // Streaming buffers (mirrors useChatRealtimeHandlers, 100ms flush cadence).
  const streamTextRef = useRef('');
  const streamTimerRef = useRef<number | null>(null);
  const thinkTextRef = useRef('');
  const thinkTimerRef = useRef<number | null>(null);

  useEffect(() => {
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

    const unsubscribe = subscribe((event: ServerEvent) => {
      const activeSessionId = sessionIdRef.current;
      if (!activeSessionId || event.sessionId !== activeSessionId || typeof event.kind !== 'string') {
        return;
      }
      const provider = providerRef.current;

      // Subscribe ack: after a reconnect the server tells us whether the run
      // is still alive. If it isn't, recover from the persisted transcript.
      if (event.kind === 'chat_subscribed') {
        const ack = event as unknown as { isProcessing?: boolean };
        if (ack.isProcessing) {
          updateStreaming(true);
          armWatchdog();
        } else if (framesSeenRef.current > 0 && streamingRef.current) {
          updateStreaming(false);
          clearWatchdog();
          void store.refreshFromServer(activeSessionId);
        }
        return;
      }

      framesSeenRef.current += 1;
      if (streamingRef.current) {
        armWatchdog();
      }

      // Gateway-kind frame, not a provider NormalizedMessage: the run never
      // started (or was rejected), so no `complete` follows.
      if (event.kind === 'protocol_error') {
        updateStreaming(false);
        clearWatchdog();
        setError(String(event.error || 'Request failed'));
        return;
      }

      const msg = event as unknown as NormalizedMessage & { content?: unknown };

      // Close an open thinking block when any other kind arrives.
      if (msg.kind !== 'thinking' && thinkTextRef.current) {
        clearThinkTimer();
        store.updateThinkingStream(activeSessionId, thinkTextRef.current, provider);
        store.finalizeThinkingStream(activeSessionId);
        thinkTextRef.current = '';
      }

      switch (msg.kind) {
        case 'thinking': {
          const text = typeof msg.content === 'string' ? msg.content : '';
          if (!text) {
            return;
          }
          updateStreaming(true);
          thinkTextRef.current += text;
          if (!thinkTimerRef.current) {
            thinkTimerRef.current = window.setTimeout(() => {
              thinkTimerRef.current = null;
              store.updateThinkingStream(activeSessionId, thinkTextRef.current, provider);
            }, 100);
          }
          return;
        }
        case 'stream_delta': {
          const text = typeof msg.content === 'string' ? msg.content : '';
          if (!text) {
            return;
          }
          updateStreaming(true);
          streamTextRef.current += text;
          if (!streamTimerRef.current) {
            streamTimerRef.current = window.setTimeout(() => {
              streamTimerRef.current = null;
              store.updateStreaming(activeSessionId, streamTextRef.current, provider);
            }, 100);
          }
          return;
        }
        case 'stream_end': {
          clearStreamTimer();
          if (streamTextRef.current) {
            store.updateStreaming(activeSessionId, streamTextRef.current, provider);
          }
          store.finalizeStreaming(activeSessionId);
          streamTextRef.current = '';
          return;
        }
        case 'complete': {
          clearStreamTimer();
          clearWatchdog();
          if (streamTextRef.current) {
            store.updateStreaming(activeSessionId, streamTextRef.current, provider);
            store.finalizeStreaming(activeSessionId);
          }
          streamTextRef.current = '';
          updateStreaming(false);
          void store.refreshFromServer(activeSessionId);
          return;
        }
        case 'error': {
          // Informational row, not terminal — surface it but let the run end.
          const text = typeof msg.content === 'string' ? msg.content : '';
          if (text) {
            setError(text);
          }
          store.appendRealtime(activeSessionId, msg);
          return;
        }
        // Skip non-persisted control frames; the wizard never prompts for
        // tool permissions, so permission waits surface via `error` instead.
        case 'permission_request': {
          setError('The agent is waiting on a tool permission. Approve it from the main chat view, then continue here.');
          return;
        }
        case 'status':
        case 'permission_cancelled':
          return;
        default:
          store.appendRealtime(activeSessionId, msg);
      }
    });

    return () => {
      clearStreamTimer();
      clearThinkTimer();
      clearWatchdog();
      streamTextRef.current = '';
      thinkTextRef.current = '';
      unsubscribe();
    };
  }, [subscribe, store, updateStreaming, armWatchdog, clearWatchdog]);

  // Reconnect recovery: when the socket comes back, re-attach to the run and
  // reconcile with the persisted transcript. The `chat_subscribed` ack (see
  // the listener) clears a stuck `streaming` state if the run already ended.
  const prevConnectedRef = useRef(isConnected);
  useEffect(() => {
    const wasConnected = prevConnectedRef.current;
    prevConnectedRef.current = isConnected;
    const activeSessionId = sessionIdRef.current;
    if (!wasConnected && isConnected && activeSessionId) {
      void store.refreshFromServer(activeSessionId);
      sendMessage({ type: 'chat.subscribe', sessions: [{ sessionId: activeSessionId, lastSeq: 0 }] });
    }
  }, [isConnected, sendMessage, store]);

  const reset = useCallback(() => {
    // Invalidate any start() still in flight before this reset.
    generationRef.current += 1;
    // The listener stays subscribed but no-ops without an active session id;
    // the next start() allocates a fresh session.
    sessionIdRef.current = null;
    briefRef.current = null;
    framesSeenRef.current = 0;
    streamTextRef.current = '';
    thinkTextRef.current = '';
    clearWatchdog();
    store.setActiveSession(null);
    setSessionId(null);
    updateStreaming(false);
    setError(null);
  }, [store, updateStreaming, clearWatchdog]);

  const start = useCallback(async (opts: { provider: string; projectPath?: string; transcript?: string }) => {
    reset();
    const myGeneration = generationRef.current;
    providerRef.current = opts.provider as LLMProvider;

    let newSessionId: string | null = null;
    try {
      const response = await authenticatedFetch('/api/providers/sessions', {
        method: 'POST',
        body: JSON.stringify({
          provider: opts.provider,
          projectPath: opts.projectPath,
        }),
      });
      if (!response.ok) {
        // AppError responses are `{ success: false, error: { message } }` —
        // surface the server's reason instead of a bare status code.
        const errorBody: unknown = await response.json().catch(() => null);
        const detail = (
          typeof errorBody === 'object'
          && errorBody !== null
          && 'error' in errorBody
          && typeof (errorBody as { error?: { message?: unknown } }).error?.message === 'string'
        )
          ? (errorBody as { error: { message: string } }).error.message
          : null;
        throw new Error(detail ?? `Failed to create session (${response.status})`);
      }
      const body = await response.json();
      newSessionId = body?.data?.sessionId || null;
      if (!newSessionId) {
        throw new Error('Failed to start the wizard: no session id returned.');
      }
    } catch (startError) {
      if (generationRef.current !== myGeneration) {
        return;
      }
      const message = startError instanceof Error ? startError.message : 'Unknown error';
      console.error('Skill wizard session creation failed:', startError);
      setError(`Failed to start the wizard: ${message}`);
      return;
    }

    // A newer start()/reset() ran while this fetch was in flight (e.g.
    // React.StrictMode's double-invoke, or the user switched agents again
    // before this one landed) — this session is stale, abandon it silently.
    if (generationRef.current !== myGeneration) {
      return;
    }

    sessionIdRef.current = newSessionId;
    setSessionId(newSessionId);
    store.setActiveSession(newSessionId);

    sendMessage({ type: 'chat.subscribe', sessions: [{ sessionId: newSessionId, lastSeq: 0 }] });

    const brief = buildWizardBrief({ transcript: opts.transcript });
    briefRef.current = brief;
    updateStreaming(true);
    armWatchdog();
    sendMessage({
      type: 'chat.send',
      sessionId: newSessionId,
      content: brief,
      options: {},
    });
  }, [reset, sendMessage, store, updateStreaming, armWatchdog]);

  const send = useCallback((text: string) => {
    const activeSessionId = sessionIdRef.current;
    const trimmed = text.trim();
    if (!activeSessionId || !trimmed) {
      return;
    }
    setError(null);
    updateStreaming(true);
    armWatchdog();
    // Optimistic local echo; the store drops it once the persisted copy of
    // the same user text arrives on refresh.
    store.appendRealtime(activeSessionId, {
      id: `local_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      sessionId: activeSessionId,
      timestamp: new Date().toISOString(),
      provider: providerRef.current,
      kind: 'text',
      role: 'user',
      content: trimmed,
    });
    sendMessage({
      type: 'chat.send',
      sessionId: activeSessionId,
      content: trimmed,
      options: {},
    });
  }, [sendMessage, store, updateStreaming, armWatchdog]);

  // The store bumps a tick for the active session, so this component
  // re-renders whenever new frames land; `getMessages` returns a stable
  // `merged` reference until the underlying data actually changes.
  const rawMessages = sessionId ? store.getMessages(sessionId) : EMPTY_MESSAGES;

  const messages = useMemo(() => {
    const brief = briefRef.current;
    return rawMessages.filter((message) => !(
      brief
      && message.kind === 'text'
      && message.role === 'user'
      && message.content === brief
    ));
  }, [rawMessages]);

  const draft = useMemo(() => {
    for (let index = messages.length - 1; index >= 0; index--) {
      const message = messages[index];
      if (message.kind !== 'text' || message.role !== 'assistant' || !message.content) {
        continue;
      }
      const extracted = extractSkillDraft(message.content);
      if (extracted) {
        return extracted;
      }
    }
    return null;
  }, [messages]);

  return {
    messages,
    streaming,
    ready: sessionId !== null,
    draft,
    error,
    start,
    send,
    reset,
  };
}
