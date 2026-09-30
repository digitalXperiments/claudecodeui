import { useMemo } from 'react';

import type { NormalizedMessage, SessionSlot, SessionStore } from '../../../stores/useSessionStore';
import { useSessionSlotSelector } from '../../../stores/useSessionStore';
import type { ChatMessage } from '../types/types';

import { normalizedToChatMessages } from './useChatMessages';

const EMPTY_MESSAGES: NormalizedMessage[] = [];
const selectMerged = (slot: SessionSlot | undefined) => slot?.merged ?? EMPTY_MESSAGES;

/**
 * Projects a session's merged store rows into the rendered transcript.
 *
 * - A pending user message (new conversation, before the backend allocated a
 *   session row) shows on its own while the store has nothing yet.
 * - `viewHiddenCount` hides the newest N rows (rewind preview).
 */
export function deriveTranscriptMessages(
  storeMessages: NormalizedMessage[],
  pendingUserMessage: ChatMessage | null,
  viewHiddenCount: number,
): ChatMessage[] {
  const all = normalizedToChatMessages(storeMessages);
  if (pendingUserMessage && all.length === 0) {
    return [pendingUserMessage];
  }
  if (viewHiddenCount > 0 && viewHiddenCount < all.length) return all.slice(0, -viewHiddenCount);
  return all;
}

/**
 * Subscribes to one session's rows. Only the component that renders the
 * transcript should call this: each stream flush replaces `slot.merged`, so
 * the subscriber re-renders ~10x/s while a reply streams.
 */
export function useTranscriptMessages(
  sessionStore: Pick<SessionStore, 'subscribeSession' | 'getSessionSlot'>,
  sessionId: string | null,
  pendingUserMessage: ChatMessage | null,
  viewHiddenCount: number,
): ChatMessage[] {
  const storeMessages = useSessionSlotSelector(sessionStore, sessionId, selectMerged);
  return useMemo(
    () => deriveTranscriptMessages(storeMessages, pendingUserMessage, viewHiddenCount),
    [storeMessages, pendingUserMessage, viewHiddenCount],
  );
}
