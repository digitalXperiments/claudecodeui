import type { LLMProvider } from '@/shared/types.js';

/** One other live session an agent can message, scoped to its own project. */
export type PeerSessionInfo = {
  sessionId: string;
  title: string;
  provider: LLMProvider;
  /** Sessions do not persist a per-session model choice today, so this is always null. */
  model: string | null;
  busy: boolean;
  lastActivity: string;
};

export type MailboxMessageStatus =
  /** Could not be delivered live (recipient busy, no inject hook available). Sits in the inbox. */
  | 'queued'
  /** Injected into the recipient's transcript (idle start, or a live inject hook accepted it). */
  | 'delivered'
  /** A queued message the recipient has read via check_peer_inbox. */
  | 'read';

export type MailboxMessage = {
  id: string;
  fromSessionId: string;
  fromTitle: string;
  fromProvider: LLMProvider;
  toSessionId: string;
  toTitle: string;
  content: string;
  createdAt: string;
  status: MailboxMessageStatus;
  /** messageId this is a reply to, or null for a fresh send. */
  inReplyTo: string | null;
};

export type SendPeerMessageResult = {
  messageId: string;
  delivered: boolean;
  queued: boolean;
  /** Populated only when a reply arrived within waitMs. */
  reply: MailboxMessage | null;
  timedOut: boolean;
};
