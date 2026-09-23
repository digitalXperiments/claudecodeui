/**
 * Per-session replay cursor for `chat.subscribe { lastSeq }`.
 *
 * `seq` is scoped to ONE provider run (the server restarts it at 1 for every
 * run in the same session). The cursor is therefore reset at the terminal
 * `complete`, and stays frozen until the next run's first frame (seq 1)
 * arrives: a straggler of the finished run (late telemetry, seq N+1) must not
 * push the cursor ahead of the next run, or a later re-subscribe would ask
 * for `lastSeq = N+1` and the new run's first N+1 frames would never be
 * replayed. While frozen the cursor reads as absent (0), which only makes a
 * replay overlap — and overlapping replays are deduped by event id.
 */
export type RunSeqCursor = {
  lastSeq: Map<string, number>;
  /** Sessions whose run completed and whose next run has not started yet. */
  awaitingRunStart: Set<string>;
};

export function createRunSeqCursor(): RunSeqCursor {
  return { lastSeq: new Map(), awaitingRunStart: new Set() };
}

/** Records one sequenced live frame for `sessionId`. */
export function trackRunSeq(
  cursor: Pick<RunSeqCursor, 'lastSeq' | 'awaitingRunStart'>,
  sessionId: string,
  kind: unknown,
  seq: number,
): void {
  if (kind === 'complete') {
    cursor.lastSeq.delete(sessionId);
    cursor.awaitingRunStart.add(sessionId);
    return;
  }

  if (cursor.awaitingRunStart.has(sessionId)) {
    if (seq !== 1) {
      return;
    }
    cursor.awaitingRunStart.delete(sessionId);
  }

  if (seq > (cursor.lastSeq.get(sessionId) ?? 0)) {
    cursor.lastSeq.set(sessionId, seq);
  }
}
