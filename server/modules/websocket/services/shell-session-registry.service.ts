import type { LLMProvider } from '@/shared/types.js';

export type RunningShellSession = {
  sessionId: string;
  provider: LLMProvider;
  startedAt: number;
};

type ShellSessionRecord = RunningShellSession;

type ChangeListener = () => void;

// A shell PTY can outlive its browser websocket for the reconnect window, so
// the registry is keyed by the PTY session key rather than the websocket.
const sessions = new Map<string, ShellSessionRecord>();
const listeners = new Set<ChangeListener>();

const notify = (): void => {
  for (const listener of listeners) {
    listener();
  }
};

export const shellSessionRegistry = {
  register(key: string, session: RunningShellSession): void {
    if (!key || !session.sessionId) {
      return;
    }
    const previous = sessions.get(key);
    sessions.set(key, session);
    if (
      !previous
      || previous.sessionId !== session.sessionId
      || previous.provider !== session.provider
      || previous.startedAt !== session.startedAt
    ) {
      notify();
    }
  },

  unregister(key: string): void {
    if (!sessions.delete(key)) {
      return;
    }
    notify();
  },

  /**
   * Subscribe to busy/idle transitions. Used to push Chatbar running-state
   * instead of waiting for the next HTTP poll.
   */
  subscribe(listener: ChangeListener): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },

  isActive(sessionId: string): boolean {
    for (const session of sessions.values()) {
      if (session.sessionId === sessionId) {
        return true;
      }
    }
    return false;
  },

  listRunning(): RunningShellSession[] {
    const unique = new Map<string, RunningShellSession>();
    for (const session of sessions.values()) {
      const existing = unique.get(session.sessionId);
      if (!existing || session.startedAt < existing.startedAt) {
        unique.set(session.sessionId, { ...session });
      }
    }
    return Array.from(unique.values());
  },

  /** Test-only cleanup. */
  clear(): void {
    sessions.clear();
  },
};
