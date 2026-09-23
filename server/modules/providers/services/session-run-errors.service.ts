/**
 * Durable provider run errors.
 *
 * A provider run reports failures to the browser as live `kind: 'error'`
 * frames, but most provider transcripts never record them: a Codex turn
 * rejected for an unsupported model leaves only the user prompt in its
 * rollout. The client keeps live rows only until history reloads, so the
 * error disappeared on reload / reopen / a fresh session slot and the turn
 * showed just the user bubble. Claude looked fine only because its SDK also
 * writes the failure text ("Not logged in") into the JSONL.
 *
 * The chat run registry records every live error row here, and history reads
 * merge them back in chronological position for every provider. The row keeps
 * its live id, so the client's realtime/server reconciliation dedupes it.
 */

import { sessionRunErrorsDb } from '@/modules/database/index.js';
import type { SessionRunErrorRow } from '@/modules/database/index.js';
import type { LLMProvider, NormalizedMessage } from '@/shared/types.js';

/** Persists one outbound live error row. Never throws into the live stream. */
export function recordRunError(message: NormalizedMessage): void {
  if (message.kind !== 'error' || !message.sessionId || !message.id) return;
  try {
    sessionRunErrorsDb.record({
      message_id: message.id,
      session_id: message.sessionId,
      provider: String(message.provider || ''),
      content: typeof message.content === 'string' ? message.content : String(message.content ?? ''),
      timestamp: message.timestamp || new Date().toISOString(),
    });
  } catch (error) {
    console.error('[SessionRunErrors] failed to persist run error', {
      sessionId: message.sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export function runErrorRowToMessage(row: SessionRunErrorRow): NormalizedMessage {
  return {
    id: row.message_id,
    sessionId: row.session_id,
    timestamp: row.timestamp,
    provider: row.provider as LLMProvider,
    kind: 'error',
    content: row.content,
  };
}

/** Persisted run errors for an app session, oldest first ([] on failure). */
export function listRunErrorMessages(sessionId: string): NormalizedMessage[] {
  try {
    return sessionRunErrorsDb.listBySession(sessionId).map(runErrorRowToMessage);
  } catch (error) {
    console.error('[SessionRunErrors] failed to read run errors', {
      sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

export function deleteRunErrors(sessionId: string): void {
  try {
    sessionRunErrorsDb.deleteBySession(sessionId);
  } catch {
    // Best effort: orphaned rows are harmless (never listed without a session).
  }
}

function readTime(message: NormalizedMessage): number | null {
  const time = Date.parse(message.timestamp);
  return Number.isFinite(time) ? time : null;
}

/**
 * Inserts error rows into provider history by timestamp: each error lands
 * after the last dated row not newer than it, so it follows the prompt of the
 * turn that failed. Errors whose id the history already carries are skipped.
 * Provider order is never re-sorted.
 */
export function mergeRunErrorsIntoHistory(
  history: NormalizedMessage[],
  errors: NormalizedMessage[],
): NormalizedMessage[] {
  if (errors.length === 0) return history;
  const knownIds = new Set(history.map((message) => message.id));
  const pending = errors
    .filter((error) => !knownIds.has(error.id))
    .sort((a, b) => (readTime(a) ?? 0) - (readTime(b) ?? 0));
  if (pending.length === 0) return history;

  const merged: NormalizedMessage[] = [];
  let next = 0;
  for (const message of history) {
    const time = readTime(message);
    while (time !== null && next < pending.length && (readTime(pending[next]) ?? 0) < time) {
      merged.push(pending[next++]);
    }
    merged.push(message);
  }
  merged.push(...pending.slice(next));
  return merged;
}
