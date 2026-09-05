import path from 'node:path';

import { sessionsDb } from '@/modules/database/index.js';
import { normalizeSessionName } from '@/shared/utils.js';
import type { IProviderSessionSynchronizer } from '@/shared/interfaces.js';

import {
  antigravityConversationsDir,
  antigravityTitleFromPrompt,
  listAntigravityConversations,
  readAntigravityConversation,
  type AntigravityConversationSummary,
} from './antigravity-conversation-store.js';

/**
 * Session indexer for Antigravity conversations.
 *
 * Antigravity has no transcript file to walk and no useful name to ask for:
 * ACP `session/list` titles every row `"Session <id-prefix>"`, so a sidebar fed
 * from the agent shows nothing but ids (rendered as "New Session" once the
 * frontend falls back). The real name — the first user prompt — is in the
 * conversation store on disk, which `antigravity-conversation-store.ts` reads
 * without spawning the ~500MB agent.
 *
 * This walks `<GEMINI_HOME>/antigravity-acp/conversations/*.db`, which is both
 * the naming source and the enumeration source, so sessions started outside
 * CloudCLI now appear too.
 *
 * Titles are re-read on every pass rather than written once, so a session that
 * was indexed before its first prompt reached disk still picks its name up on
 * the next sweep. A row that already carries a name keeps it — see
 * `indexConversation`.
 */
export class AntigravitySessionSynchronizer implements IProviderSessionSynchronizer {
  private readonly provider = 'antigravity' as const;

  async synchronize(since?: Date): Promise<number> {
    const conversations = listAntigravityConversations(process.env, { since: since ?? null });

    let processed = 0;
    for (const conversation of conversations) {
      if (this.indexConversation(conversation)) processed += 1;
    }
    return processed;
  }

  /**
   * The watcher hands us whichever file changed — `<id>.db`, its `-wal`/`-shm`
   * siblings, or the `.meta` sidecar. All of them identify the same session.
   */
  async synchronizeFile(filePath: string): Promise<string | null> {
    if (path.dirname(filePath) !== antigravityConversationsDir()) return null;

    const sessionId = path.basename(filePath).replace(/\.(db(-wal|-shm)?|meta)$/, '');
    if (!sessionId || sessionId === path.basename(filePath)) return null;

    const conversation = readAntigravityConversation(sessionId, process.env);
    if (!conversation) return null;

    return this.indexConversation(conversation) ? sessionId : null;
  }

  /**
   * Upserts one conversation, binding it onto a pending app row when CloudCLI
   * started the session itself.
   *
   * Returns false for a conversation with no recorded working directory: the
   * sessions table keys rows by project, and guessing a project for an
   * unlocatable session would file it under the wrong one.
   */
  private indexConversation(conversation: AntigravityConversationSummary): boolean {
    if (!conversation.cwd) return false;

    let existing = sessionsDb.getSessionByProviderSessionId(conversation.sessionId, this.provider)
      ?? sessionsDb.getSessionById(conversation.sessionId);
    if (!existing) {
      const pendingInternal = sessionsDb.findLatestPendingInternalAppSession(
        this.provider,
        conversation.cwd,
      );
      if (pendingInternal) {
        sessionsDb.assignProviderSessionId(pendingInternal.session_id, conversation.sessionId);
        existing = sessionsDb.getSessionByProviderSessionId(conversation.sessionId, this.provider);
      }
    }

    // Only supply a name when the row has none. `createSession` COALESCEs the
    // incoming name over the stored one, so re-sending the first prompt on
    // every sweep would silently undo a rename the user made.
    const title = existing?.custom_name?.trim()
      ? null
      : antigravityTitleFromPrompt(conversation.firstPrompt);

    sessionsDb.createSession(
      conversation.sessionId,
      this.provider,
      conversation.cwd,
      title ? normalizeSessionName(title, 'Untitled Antigravity Session') : undefined,
      conversation.createdAt.toISOString(),
      conversation.updatedAt.toISOString(),
      // There is no JSONL transcript; history is replayed through ACP
      // `session/load` (see antigravity-history.ts).
      undefined,
    );

    return true;
  }
}
