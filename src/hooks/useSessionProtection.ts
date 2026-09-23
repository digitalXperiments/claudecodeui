import { useCallback, useState } from 'react';

import {
  shouldIgnoreIdle,
  shouldIgnoreShellTakeover,
  type IdleRequestOptions,
} from '../utils/sessionActivityGuards';

export interface SessionActivity {
  /** Which surface owns the live session. Shell sessions are not abortable chat runs. */
  source: 'chat' | 'shell';
  /** Provider-supplied status line; null renders the default activity label. */
  statusText: string | null;
  canInterrupt: boolean;
  /**
   * When this request was first marked as processing (client clock). Drives
   * the elapsed-time display and the stale `chat_subscribed` idle-ack guard.
   */
  startedAt: number;
  /**
   * Client clock of the latest local `chat.send` for this entry. Shields the
   * fresh send from stale `chat_subscribed` acks (see sessionActivityGuards).
   */
  localSendAt?: number;
  /** Display title from `/sessions/running` so lists do not need the project page. */
  title?: string | null;
  projectId?: string | null;
  projectDisplayName?: string | null;
  provider?: string | null;
  /**
   * Swarm members, Agent Relay workers, and automation runs. They belong in
   * the Running rail but must never be pinned into a project's session picker.
   */
  isInternal?: boolean;
}

export type SessionActivityMap = ReadonlyMap<string, SessionActivity>;

export type SessionActivitySnapshot = {
  sessionId: string;
  source?: 'chat' | 'shell';
  statusText?: string | null;
  canInterrupt?: boolean;
  startedAt?: number;
  title?: string | null;
  projectId?: string | null;
  projectDisplayName?: string | null;
  provider?: string | null;
  isInternal?: boolean;
};

export type MarkSessionProcessing = (
  sessionId?: string | null,
  activity?: {
    source?: 'chat' | 'shell';
    statusText?: string | null;
    canInterrupt?: boolean;
    /** Set by the composer when this mark is a local `chat.send`. */
    localSend?: boolean;
  },
) => void;

export type MarkSessionIdle = (
  sessionId?: string | null,
  opts?: IdleRequestOptions,
) => void;

export type SyncProcessingSessions = (
  sessions: readonly SessionActivitySnapshot[],
) => void;

const LOCAL_ACTIVITY_GRACE_MS = 10_000;

const sessionActivityMapsMatch = (
  left: ReadonlyMap<string, SessionActivity>,
  right: ReadonlyMap<string, SessionActivity>,
): boolean => {
  if (left.size !== right.size) {
    return false;
  }

  for (const [sessionId, leftActivity] of left) {
    const rightActivity = right.get(sessionId);
    if (
      !rightActivity
      || leftActivity.statusText !== rightActivity.statusText
      || leftActivity.source !== rightActivity.source
      || leftActivity.canInterrupt !== rightActivity.canInterrupt
      || leftActivity.startedAt !== rightActivity.startedAt
      || leftActivity.localSendAt !== rightActivity.localSendAt
      || leftActivity.title !== rightActivity.title
      || leftActivity.projectId !== rightActivity.projectId
      || leftActivity.projectDisplayName !== rightActivity.projectDisplayName
      || leftActivity.provider !== rightActivity.provider
      || leftActivity.isInternal !== rightActivity.isInternal
    ) {
      return false;
    }
  }

  return true;
};

/**
 * Single source of truth for which sessions are actively processing a
 * request. Everything the chat UI shows (activity indicator, abort
 * availability, status text) is derived from this map; terminal events
 * (`complete`, abort, an authoritative idle subscribe ack) delete the entry
 * atomically. Session ids are always concrete (allocated before the first
 * send), so entries are keyed by real session ids only.
 */
export function useSessionProtection() {
  const [processingSessions, setProcessingSessions] = useState<Map<string, SessionActivity>>(
    new Map(),
  );

  const markSessionProcessing = useCallback<MarkSessionProcessing>((sessionId, activity) => {
    if (!sessionId) {
      return;
    }

    const now = Date.now();
    setProcessingSessions((prev) => {
      const existing = prev.get(sessionId);
      if (shouldIgnoreShellTakeover(existing, activity?.source, now)) {
        return prev;
      }
      const nextSource = activity?.source ?? existing?.source ?? 'chat';
      const next: SessionActivity = {
        source: nextSource,
        statusText:
          activity?.statusText !== undefined ? activity.statusText : existing?.statusText ?? null,
        canInterrupt: activity?.canInterrupt ?? existing?.canInterrupt ?? true,
        startedAt:
          existing && existing.source === nextSource
            ? existing.startedAt
            : now,
        localSendAt: nextSource === 'chat'
          ? (activity?.localSend ? now : existing?.localSendAt)
          : undefined,
        title: existing?.title,
        projectId: existing?.projectId,
        projectDisplayName: existing?.projectDisplayName,
        provider: existing?.provider,
        isInternal: existing?.isInternal,
      };

      if (
        existing
        && existing.source === next.source
        && existing.statusText === next.statusText
        && existing.canInterrupt === next.canInterrupt
        && existing.isInternal === next.isInternal
        && existing.localSendAt === next.localSendAt
      ) {
        return prev;
      }

      const updated = new Map(prev);
      updated.set(sessionId, next);
      return updated;
    });
  }, []);

  const markSessionIdle = useCallback<MarkSessionIdle>((sessionId, opts) => {
    if (!sessionId) {
      return;
    }

    const now = Date.now();
    setProcessingSessions((prev) => {
      const existing = prev.get(sessionId);
      if (!existing) {
        return prev;
      }

      // Guard against stale `chat_subscribed` idle acks: if a new request
      // started after the subscribe was sent, or a local send is only
      // moments old, the idle ack describes the older state and must not
      // clear the newer request. Terminal frames pass no ack flag.
      if (shouldIgnoreIdle(existing, opts, now)) {
        return prev;
      }

      const updated = new Map(prev);
      updated.delete(sessionId);
      return updated;
    });
  }, []);

  const syncProcessingSessions = useCallback<SyncProcessingSessions>((sessions) => {
    const now = Date.now();

    setProcessingSessions((prev) => {
      const incoming = new Map<string, SessionActivitySnapshot>();
      for (const session of sessions) {
        if (!session.sessionId) {
          continue;
        }
        incoming.set(session.sessionId, session);
      }

      const updated = new Map<string, SessionActivity>();

      for (const [sessionId, snapshot] of incoming) {
        const existing = prev.get(sessionId);
        // A poll taken mid Agent CLI -> Chat hand-off still lists the Shell.
        if (existing && shouldIgnoreShellTakeover(existing, snapshot.source, now)) {
          updated.set(sessionId, existing);
          continue;
        }
        const snapshotStartedAt =
          typeof snapshot.startedAt === 'number' && Number.isFinite(snapshot.startedAt) && snapshot.startedAt > 0
            ? snapshot.startedAt
            : undefined;

        updated.set(sessionId, {
          source: snapshot.source ?? existing?.source ?? 'chat',
          statusText:
            snapshot.statusText !== undefined ? snapshot.statusText : existing?.statusText ?? null,
          canInterrupt: snapshot.canInterrupt ?? existing?.canInterrupt ?? true,
          startedAt: snapshotStartedAt ?? existing?.startedAt ?? now,
          localSendAt: existing?.localSendAt,
          title: snapshot.title !== undefined ? snapshot.title : existing?.title ?? null,
          projectId: snapshot.projectId !== undefined ? snapshot.projectId : existing?.projectId ?? null,
          projectDisplayName:
            snapshot.projectDisplayName !== undefined
              ? snapshot.projectDisplayName
              : existing?.projectDisplayName ?? null,
          provider: snapshot.provider !== undefined ? snapshot.provider : existing?.provider ?? null,
          isInternal: snapshot.isInternal ?? existing?.isInternal ?? false,
        });
      }

      for (const [sessionId, activity] of prev) {
        if (incoming.has(sessionId)) {
          continue;
        }
        // Shell idle is server-authoritative (TUI prompt vs turn). Do not keep
        // a stale spinner via the chat optimistic-send grace window.
        if (activity.source === 'shell') {
          continue;
        }
        if (now - activity.startedAt < LOCAL_ACTIVITY_GRACE_MS) {
          updated.set(sessionId, activity);
        }
      }

      return sessionActivityMapsMatch(prev, updated) ? prev : updated;
    });
  }, []);

  return {
    processingSessions,
    markSessionProcessing,
    markSessionIdle,
    syncProcessingSessions,
  };
}
