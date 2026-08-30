/**
 * Single source of truth for whether the chat view must render as a
 * read-only Agent Relay/internal worker transcript. Everything that hides or
 * disables a composer/header control derives from `resolveReadOnlyWorkerSession`
 * (or the `guardWhenReadOnly` no-op wrapper below) so there is exactly one
 * predicate to reason about instead of scattered `isInternal` checks.
 */

export interface WorkerSessionLike {
  id?: string | null;
  isInternal?: boolean;
}

/**
 * Carried through router navigation state by callers that already know the
 * target session is an internal worker (e.g. opening a worker's transcript
 * from the Agent Relay panel, before that session has ever loaded here).
 *
 * `workerSessionId` scopes the hint to the one session it was minted for.
 * That matters because the app synthesizes a placeholder `selectedSession`
 * for a routed id it has not heard of yet, and that placeholder reports
 * `isInternal: false` until the `/meta` fetch resolves — an unscoped hint
 * would be discarded during exactly the window it exists to cover. A hint
 * whose id matches the route is authoritative (only worker transcripts are
 * ever opened this way); one minted for a different session is ignored.
 */
export interface WorkerSessionNavigationHint {
  isInternal?: boolean;
  /** Session id this hint was minted for; absent on legacy/foreign state. */
  workerSessionId?: string | null;
}

export interface ResolveReadOnlyWorkerSessionArgs {
  /** The session currently loaded into the chat view. May still describe a
   * different (stale) session while the route is mid-transition. */
  selectedSession: WorkerSessionLike | null;
  /** The session id the route/URL currently points at. */
  routeSessionId: string | null;
  /** Same-navigation hint from `location.state`; not a source of truth. */
  navigationHint: WorkerSessionNavigationHint | null;
}

/**
 * Whether the currently viewed session must be treated as a read-only worker
 * transcript. Resolution order, most authoritative first:
 *
 * 1. A navigation hint minted for *this* route's session id — the Agent Relay
 *    panel only ever opens worker transcripts, and this outranks the loaded
 *    session because the placeholder synthesized for an unknown routed id
 *    reports `isInternal: false` until its metadata arrives.
 * 2. The loaded session, once it matches the routed id: its own `isInternal`
 *    wins outright, including flipping an unscoped hint back to interactive.
 * 3. Otherwise fail closed on a stale worker session or an unscoped hint, so
 *    controls never flicker enabled mid-navigation.
 */
export function resolveReadOnlyWorkerSession({
  selectedSession,
  routeSessionId,
  navigationHint,
}: ResolveReadOnlyWorkerSessionArgs): boolean {
  const hintIsInternal = navigationHint?.isInternal === true;
  const hintSessionId = navigationHint?.workerSessionId ?? null;
  // An id-scoped hint applies only to the exact session it names; anywhere
  // else (another session, or a brand-new draft with no routed id) it is
  // leftover state that says nothing about what is on screen now.
  const hintApplies = hintIsInternal && (hintSessionId === null || hintSessionId === routeSessionId);

  if (hintApplies && hintSessionId !== null) {
    return true;
  }

  const sessionMatchesRoute =
    Boolean(selectedSession) && Boolean(routeSessionId) && selectedSession!.id === routeSessionId;

  if (sessionMatchesRoute) {
    return selectedSession!.isInternal === true;
  }

  if (selectedSession?.isInternal === true) {
    return true;
  }

  return hintApplies;
}

const NO_OP = (() => undefined) as (...args: unknown[]) => undefined;

/**
 * Returns `handler` unchanged, or a stable no-op when `readOnly` is true.
 * Defense-in-depth: a control that is supposed to be hidden/disabled for a
 * read-only worker session cannot fire even if it still renders somehow.
 * An absent (`undefined`) handler passes through untouched either way.
 */
export function guardWhenReadOnly<T extends (...args: any[]) => any>(
  readOnly: boolean,
  handler: T,
): T | typeof NO_OP;
export function guardWhenReadOnly<T extends (...args: any[]) => any>(
  readOnly: boolean,
  handler: T | undefined,
): T | typeof NO_OP | undefined;
export function guardWhenReadOnly(
  readOnly: boolean,
  handler: ((...args: any[]) => any) | undefined,
): ((...args: any[]) => any) | undefined {
  if (!handler) {
    return handler;
  }
  return readOnly ? NO_OP : handler;
}
